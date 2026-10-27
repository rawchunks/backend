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
