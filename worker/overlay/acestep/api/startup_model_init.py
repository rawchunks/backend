"""Startup model initialization orchestration for API server lifespan."""

from __future__ import annotations

import os
import sys
import types
from typing import Any, Callable, Optional

try:
    import torch
    import torch.nn.functional as F
    _compile_dynamic = torch.compile(dynamic=True)
except ImportError:
    torch = None  # type: ignore[assignment]
    F = None  # type: ignore[assignment]
    _compile_dynamic = lambda fn: fn

from acestep.model_downloader import get_checkpoints_dir
from acestep.gpu_config import (
    VRAM_AUTO_OFFLOAD_THRESHOLD_GB,
    get_gpu_config,
    set_global_gpu_config,
)
from acestep.api.startup_llm_init import initialize_llm_at_startup


@_compile_dynamic
def _fused_pre_self_attn(
    hidden_states: torch.Tensor,
    scale_shift_table: torch.Tensor,
    temb: torch.Tensor,
    weight: torch.Tensor,
    eps: float = 1e-6,
):
    shift_msa, scale_msa, gate_msa, c_shift_msa, c_scale_msa, c_gate_msa = (
        scale_shift_table + temb
    ).chunk(6, dim=1)
    input_dtype = hidden_states.dtype
    variance = hidden_states.to(torch.float32).pow(2).mean(-1, keepdim=True)
    norm_hs = weight * (hidden_states * torch.rsqrt(variance + eps)).to(input_dtype)
    modulated = (norm_hs * (1.0 + scale_msa) + shift_msa).type_as(hidden_states)
    return modulated, gate_msa, c_shift_msa, c_scale_msa, c_gate_msa


@_compile_dynamic
def _fused_post_self_pre_cross(
    hidden_states: torch.Tensor,
    attn_output: torch.Tensor,
    gate_msa: torch.Tensor,
    weight: torch.Tensor,
    eps: float = 1e-6,
):
    hs = (hidden_states + attn_output * gate_msa).type_as(hidden_states)
    input_dtype = hs.dtype
    variance = hs.to(torch.float32).pow(2).mean(-1, keepdim=True)
    norm_hs = (weight * (hs * torch.rsqrt(variance + eps)).to(input_dtype)).type_as(hs)
    return hs, norm_hs


@_compile_dynamic
def _fused_post_cross_pre_mlp(
    hidden_states: torch.Tensor,
    cross_attn_output: torch.Tensor,
    c_shift_msa: torch.Tensor,
    c_scale_msa: torch.Tensor,
    weight: torch.Tensor,
    eps: float = 1e-6,
):
    hs = hidden_states + cross_attn_output
    input_dtype = hs.dtype
    variance = hs.to(torch.float32).pow(2).mean(-1, keepdim=True)
    norm_hs = weight * (hs * torch.rsqrt(variance + eps)).to(input_dtype)
    modulated = (norm_hs * (1.0 + c_scale_msa) + c_shift_msa).type_as(hs)
    return hs, modulated


@_compile_dynamic
def _fused_final_add(
    hidden_states: torch.Tensor,
    ff_output: torch.Tensor,
    c_gate_msa: torch.Tensor,
) -> torch.Tensor:
    return (hidden_states + ff_output * c_gate_msa).type_as(hidden_states)


@_compile_dynamic
def _fused_rms_norm(
    x: torch.Tensor,
    weight: torch.Tensor,
    eps: float = 1e-6,
) -> torch.Tensor:
    input_dtype = x.dtype
    variance = x.to(torch.float32).pow(2).mean(-1, keepdim=True)
    x = x * torch.rsqrt(variance + eps)
    return weight * x.to(input_dtype)


@_compile_dynamic
def _fused_swiglu(gate: torch.Tensor, up: torch.Tensor) -> torch.Tensor:
    return F.silu(gate) * up


def _prepopulate_cross_attn_cache(
    decoder: Any,
    past_key_values: Any,
    encoder_hidden_states: Optional[torch.Tensor],
) -> None:
    """Pre-populate cross-attention K/V cache for all DiT layers before layer execution.

    Ensuring ``len(cross_attention_cache) == num_layers`` and ``is_updated[layer_idx] = True``
    on step 0 prevents duplicate K/V concatenation and prevents TorchDynamo from specializing
    step 0 on ``is_updated`` (False) and recompiling on step 1 when ``is_updated`` becomes True.
    """
    if past_key_values is None or encoder_hidden_states is None:
        return
    cross_cache = getattr(past_key_values, "cross_attention_cache", None)
    is_updated = getattr(past_key_values, "is_updated", None)
    if cross_cache is None or len(cross_cache) > 0:
        return
    layers = getattr(decoder, "layers", None)
    if not layers or not hasattr(decoder, "condition_embedder"):
        return
    embedded_enc = decoder.condition_embedder(encoder_hidden_states)
    bsz, tgt_len = embedded_enc.shape[:-1]
    for layer in layers:
        if not getattr(layer, "use_cross_attention", False) or not hasattr(layer, "cross_attn"):
            continue
        cross_attn = layer.cross_attn
        target_shape = (bsz, tgt_len, -1, cross_attn.head_dim)
        key_states = cross_attn.k_norm(cross_attn.k_proj(embedded_enc).view(target_shape)).transpose(1, 2)
        value_states = cross_attn.v_proj(embedded_enc).view(target_shape).transpose(1, 2)
        cross_cache.update(key_states, value_states, cross_attn.layer_idx)
        if is_updated is not None:
            is_updated[cross_attn.layer_idx] = True


def _install_windowed_cfg_acceleration(model: Any) -> None:
    """Skip unconditional CFG half-batch evaluation on timesteps outside [cfg_interval_start, cfg_interval_end]."""
    if torch is None:
        return
    decoder = getattr(model, "decoder", None)
    if decoder is None or getattr(decoder, "_windowed_cfg_installed", False):
        return
    if not hasattr(model, "generate_audio") or not hasattr(decoder, "forward"):
        return

    orig_generate_audio = model.generate_audio
    orig_decoder_forward = decoder.forward

    def _fast_decoder_forward(
        self_decoder: Any,
        hidden_states: torch.Tensor,
        timestep: torch.Tensor,
        timestep_r: torch.Tensor,
        attention_mask: Optional[torch.Tensor],
        encoder_hidden_states: Optional[torch.Tensor],
        encoder_attention_mask: Optional[torch.Tensor],
        context_latents: Optional[torch.Tensor],
        use_cache: Optional[bool] = None,
        past_key_values: Optional[Any] = None,
        **kwargs: Any,
    ) -> Any:
        from transformers.cache_utils import DynamicCache, EncoderDecoderCache
        effective_use_cache = use_cache if use_cache is not None else getattr(self_decoder.config, "use_cache", True)
        cfg_window = getattr(self_decoder, "_cfg_window", None)
        if cfg_window is not None and hidden_states.shape[0] >= 2 and hidden_states.shape[0] % 2 == 0:
            cfg_start, cfg_end = cfg_window
            t_val = float(timestep[0].item()) if torch.is_tensor(timestep) else float(timestep)
            if t_val < cfg_start or t_val > cfg_end:
                half = hidden_states.shape[0] // 2
                if effective_use_cache:
                    main_kv_id = id(past_key_values) if past_key_values is not None else None
                    if (
                        getattr(self_decoder, "_cond_kv_cache", None) is None
                        or getattr(self_decoder, "_last_main_kv_id", None) != main_kv_id
                    ):
                        self_decoder._cond_kv_cache = EncoderDecoderCache(DynamicCache(), DynamicCache())
                        self_decoder._last_main_kv_id = main_kv_id
                    cond_kv = self_decoder._cond_kv_cache
                else:
                    cond_kv = EncoderDecoderCache(DynamicCache(), DynamicCache())
                sliced_enc = encoder_hidden_states[:half] if encoder_hidden_states is not None else None
                if effective_use_cache:
                    _prepopulate_cross_attn_cache(self_decoder, cond_kv, sliced_enc)
                cond_out = orig_decoder_forward(
                    hidden_states=hidden_states[:half],
                    timestep=timestep[:half] if torch.is_tensor(timestep) else timestep,
                    timestep_r=timestep_r[:half] if torch.is_tensor(timestep_r) else timestep_r,
                    attention_mask=attention_mask[:half] if attention_mask is not None else None,
                    encoder_hidden_states=sliced_enc,
                    encoder_attention_mask=encoder_attention_mask[:half] if encoder_attention_mask is not None else None,
                    context_latents=context_latents[:half] if context_latents is not None else None,
                    use_cache=use_cache,
                    past_key_values=cond_kv,
                    **kwargs,
                )
                vt_cond = cond_out[0]
                return (torch.cat([vt_cond, vt_cond], dim=0), past_key_values) + cond_out[2:]
        if effective_use_cache:
            if past_key_values is None:
                past_key_values = EncoderDecoderCache(DynamicCache(), DynamicCache())
            _prepopulate_cross_attn_cache(self_decoder, past_key_values, encoder_hidden_states)
        return orig_decoder_forward(
            hidden_states=hidden_states,
            timestep=timestep,
            timestep_r=timestep_r,
            attention_mask=attention_mask,
            encoder_hidden_states=encoder_hidden_states,
            encoder_attention_mask=encoder_attention_mask,
            context_latents=context_latents,
            use_cache=use_cache,
            past_key_values=past_key_values,
            **kwargs,
        )

    def _fast_generate_audio(self_model: Any, *args: Any, **kwargs: Any) -> Any:
        cfg_start = float(kwargs.get("cfg_interval_start", 0.0))
        cfg_end = float(kwargs.get("cfg_interval_end", 1.0))
        guidance = float(kwargs.get("diffusion_guidance_scale", kwargs.get("diffusion_guidance_sale", 7.0)))
        if guidance > 1.0 and (cfg_start > 0.0 or cfg_end < 1.0):
            self_model.decoder._cfg_window = (cfg_start, cfg_end)
            self_model.decoder._cond_kv_cache = None
            self_model.decoder._last_main_kv_id = None
        else:
            self_model.decoder._cfg_window = None
        try:
            return orig_generate_audio(*args, **kwargs)
        finally:
            self_model.decoder._cfg_window = None
            self_model.decoder._cond_kv_cache = None
            self_model.decoder._last_main_kv_id = None

    decoder.forward = types.MethodType(_fast_decoder_forward, decoder)
    model.generate_audio = types.MethodType(_fast_generate_audio, model)
    if hasattr(model, "prepare_condition") and not getattr(model, "_fast_prepare_condition_installed", False):
        orig_prepare_condition = model.prepare_condition

        @torch.no_grad()
        def _fast_prepare_condition(
            self_model: Any,
            text_hidden_states: torch.Tensor,
            text_attention_mask: torch.Tensor,
            lyric_hidden_states: torch.Tensor,
            lyric_attention_mask: torch.Tensor,
            refer_audio_acoustic_hidden_states_packed: torch.Tensor,
            refer_audio_order_mask: torch.Tensor,
            hidden_states: torch.Tensor,
            attention_mask: torch.Tensor,
            silence_latent: torch.Tensor,
            src_latents: torch.Tensor,
            chunk_masks: torch.Tensor,
            is_covers: torch.Tensor,
            precomputed_lm_hints_25Hz: Optional[torch.Tensor] = None,
            audio_codes: Optional[torch.Tensor] = None,
        ) -> Any:
            if (
                precomputed_lm_hints_25Hz is None
                and audio_codes is None
                and is_covers is not None
                and not bool((is_covers > 0).any())
                and hasattr(self_model, "encoder")
            ):
                dtype = hidden_states.dtype
                encoder_hidden_states, encoder_attention_mask = self_model.encoder(
                    text_hidden_states=text_hidden_states,
                    text_attention_mask=text_attention_mask,
                    lyric_hidden_states=lyric_hidden_states,
                    lyric_attention_mask=lyric_attention_mask,
                    refer_audio_acoustic_hidden_states_packed=refer_audio_acoustic_hidden_states_packed,
                    refer_audio_order_mask=refer_audio_order_mask,
                )
                context_latents = torch.cat([src_latents, chunk_masks.to(dtype)], dim=-1)
                return encoder_hidden_states, encoder_attention_mask, context_latents
            return orig_prepare_condition(
                text_hidden_states=text_hidden_states,
                text_attention_mask=text_attention_mask,
                lyric_hidden_states=lyric_hidden_states,
                lyric_attention_mask=lyric_attention_mask,
                refer_audio_acoustic_hidden_states_packed=refer_audio_acoustic_hidden_states_packed,
                refer_audio_order_mask=refer_audio_order_mask,
                hidden_states=hidden_states,
                attention_mask=attention_mask,
                silence_latent=silence_latent,
                src_latents=src_latents,
                chunk_masks=chunk_masks,
                is_covers=is_covers,
                precomputed_lm_hints_25Hz=precomputed_lm_hints_25Hz,
                audio_codes=audio_codes,
            )

        model.prepare_condition = types.MethodType(_fast_prepare_condition, model)
        model._fast_prepare_condition_installed = True
    decoder._windowed_cfg_installed = True


def _install_fused_dit_kernels(model: Any) -> None:
    """Compile whole DiT layers with dynamic=True and pre-populated cross-attention cache."""
    if torch is None or not torch.cuda.is_available():
        return
    decoder = getattr(model, "decoder", None)
    if decoder is None or getattr(decoder, "_fused_dit_kernels_installed", False):
        return
    layers = getattr(decoder, "layers", None)
    if not layers:
        return
    try:
        torch._dynamo.config.cache_size_limit = 256
        if hasattr(torch._dynamo.config, "accumulated_cache_size_limit"):
            torch._dynamo.config.accumulated_cache_size_limit = 1024

        mod = sys.modules.get(decoder.__class__.__module__)
        if mod is not None and hasattr(mod, "apply_rotary_pos_emb") and not getattr(mod, "_rope_compiled", False):
            orig_rope = mod.apply_rotary_pos_emb
            mod.apply_rotary_pos_emb = torch.compile(orig_rope, dynamic=True)
            mod._rope_compiled = True

        def _norm_forward(self_norm: Any, x: torch.Tensor) -> torch.Tensor:
            return _fused_rms_norm(x, self_norm.weight, self_norm.variance_epsilon)

        for layer in layers:
            if not getattr(layer, "_layer_compiled", False):
                layer.forward = torch.compile(layer.forward, dynamic=True)
                layer._layer_compiled = True
        if hasattr(decoder, "norm_out") and getattr(decoder.norm_out, "weight", None) is not None:
            decoder.norm_out.forward = types.MethodType(_norm_forward, decoder.norm_out)

        decoder._fused_dit_kernels_installed = True
        print("[API Server] Whole-layer DiT Triton kernels installed (dynamic=True)")
    except Exception as exc:
        print(f"[API Server] Warning: DiT fused kernel compilation skipped: {exc}")


def do_model_initialization(
    *,
    app: Any,
    handler: Any,
    llm_handler: Any,
    handler2: Any,
    handler3: Any,
    config_path2: str,
    config_path3: str,
    get_project_root: Callable[[], str],
    get_model_name: Callable[[str], str],
    ensure_model_downloaded: Callable[[str, str], str],
    env_bool: Callable[[str, bool], bool],
) -> None:
    """Download and load DiT, VAE, and optional LLM models.

    This is the actual model initialization logic, callable both at startup
    (when ``ACESTEP_NO_INIT=false``) and lazily on first request.
    """

    gpu_config = app.state.gpu_config
    gpu_memory_gb = gpu_config.gpu_memory_gb
    auto_offload = gpu_memory_gb > 0 and gpu_memory_gb < VRAM_AUTO_OFFLOAD_THRESHOLD_GB

    print("[API Server] Initializing models...")
    if auto_offload:
        print("[API Server] Auto-enabling CPU offload (GPU < 16GB)")
    elif gpu_memory_gb > 0:
        print("[API Server] CPU offload disabled by default (GPU >= 16GB)")
    else:
        print("[API Server] No GPU detected, running on CPU")

    project_root = get_project_root()
    config_path = os.getenv("ACESTEP_CONFIG_PATH", "acestep-v15-turbo")
    device = os.getenv("ACESTEP_DEVICE", "auto")
    use_flash_attention = env_bool("ACESTEP_USE_FLASH_ATTENTION", True)

    offload_to_cpu_env = os.getenv("ACESTEP_OFFLOAD_TO_CPU")
    if offload_to_cpu_env is not None:
        offload_to_cpu = env_bool("ACESTEP_OFFLOAD_TO_CPU", False)
    else:
        offload_to_cpu = auto_offload
        if auto_offload:
            print("[API Server] Auto-setting offload_to_cpu=True based on GPU memory")

    offload_dit_to_cpu = env_bool("ACESTEP_OFFLOAD_DIT_TO_CPU", False)
    compile_model = env_bool("ACESTEP_COMPILE_MODEL", False)

    checkpoint_dir = str(get_checkpoints_dir())
    os.makedirs(checkpoint_dir, exist_ok=True)

    init_kwargs = {
        "project_root": project_root,
        "device": device,
        "use_flash_attention": use_flash_attention,
        "compile_model": compile_model,
        "offload_to_cpu": offload_to_cpu,
        "offload_dit_to_cpu": offload_dit_to_cpu,
    }
    slots = [(handler, config_path, ""), (handler2, config_path2, "2"), (handler3, config_path3, "3")]
    for slot_handler, slot_config, suffix in slots:
        if not slot_config:
            continue
        initialized_attr = f"_initialized{suffix}"
        error_attr = f"_init_error{suffix}"
        setattr(app.state, initialized_attr, False)
        setattr(app.state, error_attr, None)
        model_name = get_model_name(slot_config)
        print(f"[API Server] Loading DiT slot {suffix or '1'}: {model_name}")
        try:
            if slot_handler is None:
                raise RuntimeError(f"No handler for configured model {slot_config}")
            if model_name:
                ensure_model_downloaded(model_name, checkpoint_dir)
            if not suffix:
                ensure_model_downloaded("vae", checkpoint_dir)
            status_msg, ok = slot_handler.initialize_service(config_path=slot_config, **init_kwargs)
            if not ok:
                raise RuntimeError(status_msg)
            slot_handler._lora_hot_cache_enabled = env_bool("ACESTEP_LORA_HOT_CACHE", True)
            if suffix and handler is not None:
                if getattr(handler, "vae", None) is not None and getattr(slot_handler, "vae", None) is not None:
                    slot_handler.vae = handler.vae
                if getattr(handler, "text_encoder", None) is not None and getattr(slot_handler, "text_encoder", None) is not None:
                    slot_handler.text_encoder = handler.text_encoder
                if getattr(handler, "text_tokenizer", None) is not None and getattr(slot_handler, "text_tokenizer", None) is not None:
                    slot_handler.text_tokenizer = handler.text_tokenizer
        except Exception as exc:
            setattr(app.state, error_attr, str(exc))
            raise
        setattr(app.state, initialized_attr, True)
        print(f"[API Server] DiT slot {suffix or '1'} loaded: {model_name}")

    app.state._service_init_kwargs = init_kwargs
    app.state._checkpoint_dir = checkpoint_dir
    app.state._ensure_model_downloaded = ensure_model_downloaded

    initialize_llm_at_startup(
        app=app,
        llm_handler=llm_handler,
        gpu_config=gpu_config,
        device=device,
        offload_to_cpu=offload_to_cpu,
        checkpoint_dir=checkpoint_dir,
        get_model_name=get_model_name,
        ensure_model_downloaded=ensure_model_downloaded,
        env_bool=env_bool,
    )

    if env_bool("ACESTEP_INIT_DEMUCS", False):
        try:
            from acestep.api.http.separate import get_separator
            get_separator()
            print("[API Server] Demucs htdemucs separator warm-loaded")
        except Exception as exc:
            print(f"[API Server] Warning: Demucs warm-load skipped: {exc}")

    print("[API Server] All models initialized successfully!")


def initialize_models_at_startup(
    *,
    app: Any,
    handler: Any,
    llm_handler: Any,
    handler2: Any,
    handler3: Any,
    config_path2: str,
    config_path3: str,
    get_project_root: Callable[[], str],
    get_model_name: Callable[[str], str],
    ensure_model_downloaded: Callable[[str, str], str],
    env_bool: Callable[[str, bool], bool],
) -> None:
    """Detect GPU configuration and optionally initialize models at startup.

    By default models are NOT loaded at startup (lazy-loaded on first request).
    Set ``ACESTEP_NO_INIT=false`` to force eager loading at startup.
    """

    no_init = env_bool("ACESTEP_NO_INIT", True)
    gpu_config = get_gpu_config()
    set_global_gpu_config(gpu_config)
    app.state.gpu_config = gpu_config

    gpu_memory_gb = gpu_config.gpu_memory_gb

    print(f"\n{'='*60}")
    print("[API Server] GPU Configuration Detected:")
    print(f"{'='*60}")
    print(f"  GPU Memory: {gpu_memory_gb:.2f} GB")
    print(f"  Configuration Tier: {gpu_config.tier}")
    print(f"  Max Duration (with LM): {gpu_config.max_duration_with_lm}s")
    print(f"  Max Duration (without LM): {gpu_config.max_duration_without_lm}s")
    print(f"  Max Batch Size (with LM): {gpu_config.max_batch_size_with_lm}")
    print(f"  Max Batch Size (without LM): {gpu_config.max_batch_size_without_lm}")
    print(f"  Default LM Init: {gpu_config.init_lm_default}")
    print(f"  Available LM Models: {gpu_config.available_lm_models or 'None'}")
    print(f"{'='*60}\n")

    # Store init kwargs on app.state so lazy initialization can reuse them
    app.state._model_init_kwargs = dict(
        handler=handler,
        llm_handler=llm_handler,
        handler2=handler2,
        handler3=handler3,
        config_path2=config_path2,
        config_path3=config_path3,
        get_project_root=get_project_root,
        get_model_name=get_model_name,
        ensure_model_downloaded=ensure_model_downloaded,
        env_bool=env_bool,
    )

    if no_init:
        print("[API Server] Models will be lazy-loaded on first request")
        print("[API Server] Set ACESTEP_NO_INIT=false to load models at startup")
        print("[API Server] Server is ready to accept requests (models not loaded yet)")
        return

    print("[API Server] Eager model loading enabled (ACESTEP_NO_INIT=false)")
    do_model_initialization(
        app=app,
        **app.state._model_init_kwargs,
    )
