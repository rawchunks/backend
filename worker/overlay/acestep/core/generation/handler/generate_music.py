"""Top-level ``generate_music`` orchestration mixin.

This module provides the public ``generate_music`` entry point extracted from
``AceStepHandler`` so orchestration stays separate from lower-level helpers.
"""

import gc
import os
import time
import traceback
from typing import Any, Dict, List, Optional, Tuple, Union

import torch
from loguru import logger

from acestep.constants import DEFAULT_DIT_INSTRUCTION
from acestep.core.generation.handler.repaint_waveform_splice import (
    apply_repaint_waveform_splice,
)
from acestep.gpu_config import (
    DIT_INFERENCE_VRAM_PER_BATCH,
    VRAM_SAFETY_MARGIN_GB,
    get_dit_type_from_path,
    get_effective_free_vram_gb,
)


def _resolve_repaint_config(
    mode: str = "balanced",
    strength: float = 0.5,
) -> tuple:
    """Convert repaint mode and strength into concrete numeric parameters.

    Higher *strength* means more aggressive repainting (less source preservation).

    Args:
        mode: One of ``"conservative"``, ``"balanced"``, or ``"aggressive"``.
        strength: 0.0 = conservative (max preservation), 1.0 = aggressive
            (pure diffusion).  Only effective in balanced mode.

    Returns:
        Tuple of ``(injection_ratio, crossfade_frames, wav_crossfade_sec)``.
    """
    strength = max(0.0, min(1.0, strength))
    if mode == "aggressive":
        return 0.0, 0, 0.0
    if mode == "conservative":
        return 1.0, 25, 0.05
    inv = 1.0 - strength
    return inv, round(25 * inv), 0.05 * inv


class GenerateMusicMixin:
    """Coordinate request prep, service execution, decode, and payload assembly.

    The host class is expected to implement helper methods invoked by this
    orchestration flow.
    """

    def _verify_decoder_device_dtype(self) -> None:
        """Ensure all decoder parameters are on ``self.device`` and ``self.dtype``.

        CPU-offload round-trips can leave PEFT/LoRA adapter weights on the
        wrong device or in the wrong dtype, which silently produces NaN/Inf
        during the diffusion forward pass.  This method detects and fixes
        such mismatches before generation begins.
        """
        decoder = getattr(self.model, "decoder", None)
        if decoder is None:
            return

        wrong_device = []
        wrong_dtype = []
        for name, param in decoder.named_parameters():
            if not self._is_on_target_device(param, self.device):
                wrong_device.append(name)
            if param.is_floating_point() and param.dtype != self.dtype:
                wrong_dtype.append(name)

        if wrong_device or wrong_dtype:
            if wrong_device:
                logger.warning(
                    f"[generate_music] LoRA sanity check: {len(wrong_device)} decoder "
                    f"parameters on wrong device (expected {self.device}), fixing: "
                    f"{wrong_device[:5]}{'...' if len(wrong_device) > 5 else ''}"
                )
            if wrong_dtype:
                logger.warning(
                    f"[generate_music] LoRA sanity check: {len(wrong_dtype)} decoder "
                    f"parameters have wrong dtype (expected {self.dtype}), fixing: "
                    f"{wrong_dtype[:5]}{'...' if len(wrong_dtype) > 5 else ''}"
                )
            decoder.to(device=self.device, dtype=self.dtype)

        # Final verification — use recursive move if simple .to() wasn't enough
        still_wrong = [
            name for name, p in decoder.named_parameters()
            if not self._is_on_target_device(p, self.device)
        ]
        if still_wrong:
            logger.warning(
                f"[generate_music] {len(still_wrong)} params still on wrong device "
                f"after decoder.to(), using recursive move"
            )
            self._recursive_to_device(decoder, self.device, self.dtype)

    def _vram_preflight_check(
        self,
        actual_batch_size: int,
        audio_duration: Optional[float],
        guidance_scale: float,
    ) -> Optional[Dict[str, Any]]:
        """Check free VRAM headroom before attempting service_generate.

        Model weights are already resident in GPU memory at this point.  We
        only need to verify there is enough room for the diffusion-pass
        activations (intermediate attention maps, FFN buffers, noise tensors)
        plus a project-standard safety margin.

        Args:
            actual_batch_size: Number of samples being generated.
            audio_duration: Requested audio length in seconds, or None for default.
            guidance_scale: CFG guidance value; values > 1.0 indicate CFG is active
                and the DiT runs two forward passes per step (doubling activation memory).

        Returns:
            An error payload dict when VRAM is insufficient, or None when the
            check passes or no CUDA device is present (CPU/MPS/XPU fall through).
        """
        if not torch.cuda.is_available():
            return None

        if getattr(self, "offload_to_cpu", False):
            logger.debug(
                "[generate_music] VRAM pre-flight: skipping check "
                "(offload_to_cpu=True, models loaded one-at-a-time)"
            )
            return None

        duration_s = audio_duration or 60.0
        # Determine actual model size (XL vs standard) and CFG mode.
        config_path = ""
        if getattr(self, "last_init_params", None):
            config_path = self.last_init_params.get("config_path", "")
        dit_type = get_dit_type_from_path(config_path)
        is_xl = dit_type.startswith("xl_")
        # CFG doubles forward-pass memory: two DiT evaluations per step.
        if guidance_scale > 1.0:
            dit_key = "xl_base" if is_xl else "base"
        else:
            dit_key = "xl_turbo" if is_xl else "turbo"
        per_batch_gb = DIT_INFERENCE_VRAM_PER_BATCH.get(dit_key, 0.6)
        # Longer audio = more latent frames (5 Hz rate) = more memory.
        duration_factor = max(1.0, duration_s / 60.0)
        needed_gb = per_batch_gb * actual_batch_size * duration_factor + VRAM_SAFETY_MARGIN_GB

        free_gb = get_effective_free_vram_gb()
        logger.info(
            "[generate_music] VRAM pre-flight: {:.2f} GB free, ~{:.2f} GB needed "
            "(batch={}, duration={:.0f}s, mode={}).",
            free_gb, needed_gb, actual_batch_size, duration_s, dit_key,
        )

        if free_gb >= needed_gb:
            return None

        msg = (
            f"Insufficient free VRAM: need ~{needed_gb:.1f} GB, "
            f"only {free_gb:.1f} GB available. "
            f"Reduce batch size (currently {actual_batch_size}) "
            f"or audio duration (currently {duration_s:.0f}s)."
        )
        logger.warning("[generate_music] VRAM pre-flight failed: {}", msg)
        return {
            "audios": [],
            "status_message": f"Error: {msg}",
            "extra_outputs": {},
            "success": False,
            "error": msg,
        }

    def _resolve_dcw_enabled(self, dcw_enabled: Optional[bool]) -> bool:
        """Resolve an explicit or model-aware DCW setting.

        Args:
            dcw_enabled: Explicit caller choice, or ``None`` for the model
                family default.

        Returns:
            The explicit choice, or the loaded configuration's Turbo setting.
        """
        if dcw_enabled is not None:
            return bool(dcw_enabled)
        return bool(self.is_turbo_model())

    def _decode_generate_music_pred_latents(
        self,
        pred_latents: torch.Tensor,
        progress: Any,
        use_tiled_decode: bool,
        time_costs: Dict[str, Any],
    ) -> Tuple[torch.Tensor, Optional[torch.Tensor], Dict[str, Any]]:
        """Fast GPU-resident VAE decode without redundant CPU copies or cache flushes."""
        if progress:
            progress(0.8, desc="Decoding audio...")
        logger.info("[generate_music] Decoding latents with VAE...")
        start_time = time.time()
        offload = bool(getattr(self, "offload_to_cpu", False))
        with torch.inference_mode():
            with self._load_model_context("vae"):
                pred_latents_for_decode = pred_latents.transpose(1, 2).contiguous().to(self.vae.dtype)
                del pred_latents
                if offload:
                    self._empty_cache()

                using_mlx_vae = getattr(self, "use_mlx_vae", False) and getattr(self, "mlx_vae", None) is not None
                vae_cpu = False
                vae_device = None
                if not using_mlx_vae:
                    vae_cpu = os.environ.get("ACESTEP_VAE_ON_CPU", "0").lower() in ("1", "true", "yes")
                    if vae_cpu:
                        vae_device = next(self.vae.parameters()).device
                        self.vae = self.vae.cpu()
                        pred_latents_for_decode = pred_latents_for_decode.cpu()
                        self._empty_cache()
                try:
                    if use_tiled_decode:
                        pred_wavs = self.tiled_decode(pred_latents_for_decode, offload_wav_to_cpu=False)
                    elif using_mlx_vae:
                        try:
                            pred_wavs = self._mlx_vae_decode(pred_latents_for_decode)
                        except Exception as exc:
                            logger.warning(
                                f"[generate_music] MLX direct decode failed ({exc}), falling back to PyTorch"
                            )
                            decoder_output = self.vae.decode(pred_latents_for_decode)
                            pred_wavs = decoder_output.sample
                            del decoder_output
                    else:
                        decoder_output = self.vae.decode(pred_latents_for_decode)
                        pred_wavs = decoder_output.sample
                        del decoder_output
                finally:
                    if vae_cpu and vae_device is not None:
                        self.vae = self.vae.to(vae_device)
                    if offload:
                        self._empty_cache()
                del pred_latents_for_decode
                peak = pred_wavs.abs().amax(dim=[1, 2], keepdim=True)
                if torch.any(peak > 1.0):
                    pred_wavs = pred_wavs / peak.clamp(min=1.0)
                if pred_wavs.dtype != torch.float32:
                    pred_wavs = pred_wavs.float()
        if offload:
            gc.collect()
            self._empty_cache()
        end_time = time.time()
        time_costs["vae_decode_time_cost"] = end_time - start_time
        time_costs["total_time_cost"] = time_costs["total_time_cost"] + time_costs["vae_decode_time_cost"]
        time_costs["offload_time_cost"] = self.current_offload_cost
        return pred_wavs, None, time_costs

    def generate_music(
        self,
        captions: str,
        global_caption: str = "",
        lyrics: str = "",
        bpm: Optional[int] = None,
        key_scale: str = "",
        time_signature: str = "",
        vocal_language: str = "en",
        inference_steps: int = 8,
        guidance_scale: float = 7.0,
        use_random_seed: bool = True,
        seed: Optional[Union[str, float, int]] = -1,
        reference_audio=None,
        audio_duration: Optional[float] = None,
        batch_size: Optional[int] = None,
        src_audio=None,
        audio_code_string: Union[str, List[str]] = "",
        repainting_start: float = 0.0,
        repainting_end: Optional[float] = None,
        instruction: str = DEFAULT_DIT_INSTRUCTION,
        audio_cover_strength: float = 1.0,
        cover_noise_strength: float = 0.0,
        task_type: str = "text2music",
        use_adg: bool = False,
        cfg_interval_start: float = 0.0,
        cfg_interval_end: float = 1.0,
        shift: float = 1.0,
        infer_method: str = "ode",
        sampler_mode: str = "euler",
        velocity_norm_threshold: float = 0.0,
        velocity_ema_factor: float = 0.0,
        dcw_enabled: Optional[bool] = None,
        dcw_mode: str = "double",
        dcw_scaler: float = 0.05,
        dcw_high_scaler: float = 0.02,
        dcw_wavelet: str = "haar",
        use_tiled_decode: bool = True,
        timesteps: Optional[List[float]] = None,
        latent_shift: float = 0.0,
        latent_rescale: float = 1.0,
        chunk_mask_mode: str = "auto",
        repaint_latent_crossfade_frames: int = 10,
        repaint_wav_crossfade_sec: float = 0.0,
        repaint_mode: str = "balanced",
        repaint_strength: float = 0.5,
        source_repaint_latents: Optional[torch.Tensor] = None,
        retake_seed: Optional[Union[str, float, int]] = None,
        retake_variance: float = 0.0,
        flow_edit_morph: bool = False,
        flow_edit_source_caption: str = "",
        flow_edit_source_lyrics: str = "",
        flow_edit_n_min: float = 0.0,
        flow_edit_n_max: float = 1.0,
        flow_edit_n_avg: int = 1,
        progress=None,
    ) -> Dict[str, Any]:
        """Generate audio from text/reference inputs and return response payload.

        Args:
            captions: Text prompt describing requested music.
            lyrics: Lyric text used for conditioning.
            reference_audio: Optional reference-audio payload.
            src_audio: Optional source audio for repaint/cover.
            inference_steps: Diffusion step count.
            guidance_scale: CFG guidance value.
            seed: Optional explicit seed from caller/UI.
            infer_method: Diffusion method name.
            dcw_enabled: Enable Differential Correction in Wavelet domain.
                ``None`` selects the default for the loaded model family.
            dcw_mode: DCW mode — ``"low"`` / ``"high"`` / ``"double"`` / ``"pix"``.
            dcw_scaler: Low-band (or single-band) correction strength; modulated
                by ``t_curr`` inside the sampler, so the effective strength decays
                from ``dcw_scaler`` at ``t=1`` to 0 at ``t=0``.
            dcw_high_scaler: High-band strength — only used in ``"double"`` mode.
            dcw_wavelet: PyWavelets basis, e.g. ``"haar"`` / ``"db4"`` / ``"sym8"``.
                On the MLX path only ``"haar"`` is implemented natively; other
                bases warn once and fall back to Haar.
            timesteps: Optional custom timestep schedule.
            use_tiled_decode: Whether tiled VAE decode is used.
            latent_shift: Additive latent post-processing value.
            latent_rescale: Multiplicative latent post-processing value.
            source_repaint_latents: Optional cached source latents used for
                generated-source repaint instead of repaint-time VAE encoding.
            progress: Optional callback taking ``(ratio, desc=...)``.

        Returns:
            Dict[str, Any]: Standard payload with generated audio tensors, status,
            intermediate outputs, success flag, and optional error text.

        Raises:
            No exceptions are re-raised. Runtime failures are converted into the
            returned error payload.
        """
        progress = self._resolve_generate_music_progress(progress)
        if self.model is None or self.vae is None or self.text_tokenizer is None or self.text_encoder is None:
            readiness_error = self._validate_generate_music_readiness()
            return readiness_error

        task_type, instruction = self._resolve_generate_music_task(
            task_type=task_type,
            audio_code_string=audio_code_string,
            instruction=instruction,
        )

        # Preserve explicit reference conditioning strength for text2music;
        # neutralize stale cover state when no reference audio was supplied.
        audio_cover_strength, cover_noise_strength = self._neutralize_cover_only_params(
            task_type=task_type,
            audio_cover_strength=audio_cover_strength,
            cover_noise_strength=cover_noise_strength,
            reference_audio=reference_audio,
        )
        if (
            cover_noise_strength > 0.0
            and getattr(getattr(self, "model", None), "config", None) is not None
            and int(getattr(self.model.config, "hidden_size", 0) or 0) >= 2048
        ):
            logger.info(
                "[generate_music] XL model detected: clamping cover_noise_strength {:.2f} -> 0.0 "
                "to prevent out-of-distribution renoise energy collapse (issue #1329).",
                cover_noise_strength,
            )
            cover_noise_strength = 0.0

        # Turbo models bake guidance into the distillation process and do not
        # use CFG.  Forcing guidance_scale to 1.0 avoids double-application of
        # guidance that produces noise or NaN/Inf on float16 (see issue #927).
        if self.is_turbo_model() and guidance_scale != 1.0:
            logger.info(
                "[generate_music] Turbo model detected: overriding "
                "guidance_scale {:.1f} -> 1.0 (turbo does not use CFG).",
                guidance_scale,
            )
            guidance_scale = 1.0
        elif not self.is_turbo_model() and guidance_scale > 1.0 and cfg_interval_start <= 0.0 and cfg_interval_end >= 1.0:
            _os = __import__("os")
            cfg_interval_start = float(_os.environ.get("ACESTEP_CFG_INTERVAL_START", "0.0"))
            cfg_interval_end = float(_os.environ.get("ACESTEP_CFG_INTERVAL_END", "1.0"))
        dcw_enabled = self._resolve_dcw_enabled(dcw_enabled)

        # When LoRA is active, verify all decoder parameters are on the
        # expected device and dtype.  CPU-offload round-trips can leave PEFT
        # adapter weights on the wrong device, causing NaN in the diffusion
        # forward pass.  The check is cheap and prevents a hard-to-debug
        # generation failure.
        if getattr(self, "lora_loaded", False) and getattr(self, "use_lora", False):
            self._verify_decoder_device_dtype()

        logger.info("[generate_music] Starting generation...")
        if progress:
            progress(0.51, desc="Preparing inputs...")
        logger.info("[generate_music] Preparing inputs...")

        runtime = self._prepare_generate_music_runtime(
            batch_size=batch_size,
            audio_duration=audio_duration,
            repainting_end=repainting_end,
            seed=seed,
            use_random_seed=use_random_seed,
            retake_seed=retake_seed,
            retake_variance=retake_variance,
        )
        actual_batch_size = runtime["actual_batch_size"]
        actual_seed_list = runtime["actual_seed_list"]
        seed_value_for_ui = runtime["seed_value_for_ui"]
        actual_retake_seed_list = runtime["actual_retake_seed_list"]
        retake_seed_value_for_ui = runtime["retake_seed_value_for_ui"]
        audio_duration = runtime["audio_duration"]
        repainting_end = runtime["repainting_end"]

        try:
            refer_audios, processed_src_audio, audio_error = self._prepare_reference_and_source_audio(
                reference_audio=reference_audio,
                src_audio=src_audio,
                audio_code_string=audio_code_string,
                actual_batch_size=actual_batch_size,
                task_type=task_type,
                flow_edit_morph=flow_edit_morph,
            )
            if audio_error is not None:
                return audio_error

            # Cover/repaint/lego/extract + text2music+morph: lock duration to source audio.
            _windowed_full_src: Optional[torch.Tensor] = None
            _win_start_idx: int = 0
            _win_end_idx: int = 0
            if processed_src_audio is not None and (
                task_type in ("cover", "cover-nofsq", "repaint", "lego", "extract", "complete")
                or (task_type == "text2music" and flow_edit_morph)
            ):
                full_src_samples = int(processed_src_audio.shape[-1])
                full_src_duration = full_src_samples / self.sample_rate
                audio_duration = full_src_duration
                if (
                    task_type in ("repaint", "lego")
                    and repainting_start is not None
                    and repainting_end is not None
                ):
                    req_start = float(repainting_start)
                    req_end = float(repainting_end)
                    if 0.0 <= req_start < req_end <= full_src_duration + 0.05:
                        pad_sec = float(__import__("os").environ.get("ACESTEP_REPAINT_CONTEXT_PAD_SEC", "8.0"))
                        frame_samples = max(1, int(self.sample_rate // 25))
                        win_start_samples = (int(max(0.0, req_start - pad_sec) * self.sample_rate) // frame_samples) * frame_samples
                        win_end_samples = min(
                            full_src_samples,
                            ((int(min(full_src_duration, req_end + pad_sec) * self.sample_rate) + frame_samples - 1) // frame_samples) * frame_samples,
                        )
                        if (win_end_samples - win_start_samples) < (full_src_samples - int(4.0 * self.sample_rate)):
                            _windowed_full_src = processed_src_audio
                            _win_start_idx = win_start_samples
                            _win_end_idx = win_end_samples
                            win_start_sec = _win_start_idx / self.sample_rate
                            processed_src_audio = _windowed_full_src[..., _win_start_idx:_win_end_idx]
                            audio_duration = (_win_end_idx - _win_start_idx) / self.sample_rate
                            repainting_start = max(0.0, req_start - win_start_sec)
                            repainting_end = min(audio_duration, req_end - win_start_sec)
                            logger.info(
                                "[generate_music] Context-windowed {} edit: cropped {:.2f}s track to [{:.2f}s, {:.2f}s] ({:.2f}s window, local region [{:.2f}s, {:.2f}s])",
                                task_type,
                                full_src_duration,
                                win_start_sec,
                                _win_end_idx / self.sample_rate,
                                audio_duration,
                                repainting_start,
                                repainting_end,
                            )

            # Flow-edit overlay v1: text2music (silence-context) and
            # cover / cover-nofsq (shared LM-codes context). Repaint /
            # extract / lego need paired-CFG derivation per task shape
            # and are left for follow-up.
            if flow_edit_morph and task_type not in ("text2music", "cover", "cover-nofsq"):
                logger.warning(
                    "[generate_music] flow_edit_morph=True but task_type={!r}; "
                    "v1 overlay only applies to text2music / cover / cover-nofsq, ignoring.",
                    task_type,
                )

            service_inputs = self._prepare_generate_music_service_inputs(
                actual_batch_size=actual_batch_size,
                processed_src_audio=processed_src_audio,
                audio_duration=audio_duration,
                captions=captions,
                global_caption=global_caption,
                lyrics=lyrics,
                vocal_language=vocal_language,
                instruction=instruction,
                bpm=bpm,
                key_scale=key_scale,
                time_signature=time_signature,
                task_type=task_type,
                audio_code_string=audio_code_string,
                repainting_start=repainting_start,
                repainting_end=repainting_end,
                chunk_mask_mode=chunk_mask_mode,
            )
            if torch.cuda.is_available():
                skip_preflight = os.environ.get(
                    "ACESTEP_SKIP_VRAM_PREFLIGHT", "",
                ).lower() in ("1", "true", "yes")
                if skip_preflight:
                    logger.warning(
                        "[generate_music] VRAM pre-flight check skipped via "
                        "ACESTEP_SKIP_VRAM_PREFLIGHT=1. If generation OOMs, "
                        "unset this variable to re-enable the safety check."
                    )
                else:
                    vram_error = self._vram_preflight_check(
                        actual_batch_size=actual_batch_size,
                        audio_duration=audio_duration,
                        guidance_scale=guidance_scale,
                    )
                    if vram_error is not None:
                        gc.collect()
                        torch.cuda.empty_cache()
                        vram_error = self._vram_preflight_check(
                            actual_batch_size=actual_batch_size,
                            audio_duration=audio_duration,
                            guidance_scale=guidance_scale,
                        )
                        if vram_error is not None:
                            return vram_error

            if task_type == "repaint":
                injection_ratio, resolved_cf_frames, resolved_wav_cf = (
                    _resolve_repaint_config(repaint_mode, repaint_strength)
                )
            else:
                injection_ratio, resolved_cf_frames, resolved_wav_cf = (
                    0.0, 0, 0.0
                )

            service_run = self._run_generate_music_service_with_progress(
                progress=progress,
                actual_batch_size=actual_batch_size,
                audio_duration=audio_duration,
                inference_steps=inference_steps,
                timesteps=timesteps,
                service_inputs=service_inputs,
                refer_audios=refer_audios,
                guidance_scale=guidance_scale,
                actual_seed_list=actual_seed_list,
                audio_cover_strength=audio_cover_strength,
                cover_noise_strength=cover_noise_strength,
                use_adg=use_adg,
                cfg_interval_start=cfg_interval_start,
                cfg_interval_end=cfg_interval_end,
                shift=shift,
                infer_method=infer_method,
                sampler_mode=sampler_mode,
                velocity_norm_threshold=velocity_norm_threshold,
                velocity_ema_factor=velocity_ema_factor,
                dcw_enabled=dcw_enabled,
                dcw_mode=dcw_mode,
                dcw_scaler=dcw_scaler,
                dcw_high_scaler=dcw_high_scaler,
                dcw_wavelet=dcw_wavelet,
                repaint_crossfade_frames=resolved_cf_frames,
                repaint_injection_ratio=injection_ratio,
                source_repaint_latents=source_repaint_latents,
                task_type=task_type,
                actual_retake_seed_list=actual_retake_seed_list,
                retake_variance=retake_variance,
                flow_edit_morph=flow_edit_morph,
                flow_edit_source_caption=flow_edit_source_caption,
                flow_edit_source_lyrics=flow_edit_source_lyrics,
                flow_edit_n_min=flow_edit_n_min,
                flow_edit_n_max=flow_edit_n_max,
                flow_edit_n_avg=flow_edit_n_avg,
            )
            outputs = service_run["outputs"]
            infer_steps_for_progress = service_run["infer_steps_for_progress"]

            pred_latents, time_costs = self._prepare_generate_music_decode_state(
                outputs=outputs,
                infer_steps_for_progress=infer_steps_for_progress,
                actual_batch_size=actual_batch_size,
                audio_duration=audio_duration,
                latent_shift=latent_shift,
                latent_rescale=latent_rescale,
            )
            pred_wavs, pred_latents_cpu, time_costs = self._decode_generate_music_pred_latents(
                pred_latents=pred_latents,
                progress=progress,
                use_tiled_decode=use_tiled_decode,
                time_costs=time_costs,
            )
            repainting_start_batch = service_inputs.get("repainting_start_batch")
            repainting_end_batch = service_inputs.get("repainting_end_batch")
            do_wav_splice = (
                task_type == "repaint"
                and repaint_mode != "aggressive"
                and repainting_start_batch is not None
                and repainting_end_batch is not None
            )
            if do_wav_splice:
                pred_wavs = apply_repaint_waveform_splice(
                    pred_wavs=pred_wavs,
                    src_wavs=service_inputs["target_wavs_tensor"],
                    repainting_starts=repainting_start_batch,
                    repainting_ends=repainting_end_batch,
                    sample_rate=self.sample_rate,
                    crossfade_duration=resolved_wav_cf,
                )
            elif (
                task_type in ("lego", "extract")
                and repainting_start_batch is not None
                and repainting_end_batch is not None
            ):
                total_samples = pred_wavs.shape[-1]
                fade_samples = max(1, int(0.015 * self.sample_rate))
                isolated = torch.zeros_like(pred_wavs)
                for b_idx in range(pred_wavs.shape[0]):
                    s_sec = repainting_start_batch[b_idx] if b_idx < len(repainting_start_batch) else 0.0
                    e_sec = repainting_end_batch[b_idx] if b_idx < len(repainting_end_batch) else None
                    s_idx = max(0, min(total_samples, int(round(float(s_sec or 0.0) * self.sample_rate))))
                    e_idx = total_samples if e_sec is None or float(e_sec) < 0 else max(s_idx, min(total_samples, int(round(float(e_sec) * self.sample_rate))))
                    if e_idx > s_idx:
                        seg = pred_wavs[b_idx, :, s_idx:e_idx].clone()
                        seg_len = e_idx - s_idx
                        f_len = min(fade_samples, seg_len // 4)
                        if f_len > 1:
                            t = torch.linspace(0.0, 1.0, f_len, device=seg.device, dtype=seg.dtype)
                            fade_in = 0.5 * (1.0 - torch.cos(t * 3.141592653589793))
                            fade_out = 0.5 * (1.0 + torch.cos(t * 3.141592653589793))
                            seg[:, :f_len] = seg[:, :f_len] * fade_in
                            seg[:, -f_len:] = seg[:, -f_len:] * fade_out
                        isolated[b_idx, :, s_idx:e_idx] = seg
                pred_wavs = isolated
            if _windowed_full_src is not None:
                full_samples = int(_windowed_full_src.shape[-1])
                win_len = min(int(pred_wavs.shape[-1]), max(0, full_samples - _win_start_idx))
                if task_type == "lego":
                    full_pred = torch.zeros(
                        (pred_wavs.shape[0], pred_wavs.shape[1], full_samples),
                        device=pred_wavs.device,
                        dtype=pred_wavs.dtype,
                    )
                else:
                    base_src = _windowed_full_src.to(device=pred_wavs.device, dtype=pred_wavs.dtype)
                    if base_src.dim() == 2:
                        base_src = base_src.unsqueeze(0)
                    full_pred = base_src.expand(pred_wavs.shape[0], -1, -1).clone()
                if win_len > 0:
                    full_pred[:, :, _win_start_idx : _win_start_idx + win_len] = pred_wavs[:, :, :win_len]
                pred_wavs = full_pred
                del _windowed_full_src
            # Clear GPU tensor references from the mutable outputs dict before
            # building payload so intermediate GPU tensors are not copied to CPU.
            _gpu_keys = (
                "src_latents", "target_latents_input", "chunk_masks",
                "latent_masks", "encoder_hidden_states",
                "encoder_attention_mask", "context_latents",
                "lyric_token_idss",
            )
            for _k in _gpu_keys:
                outputs.pop(_k, None)
            del pred_latents_cpu
            result = self._build_generate_music_success_payload(
                outputs=outputs,
                pred_wavs=pred_wavs,
                pred_latents_cpu=None,
                time_costs=time_costs,
                seed_value_for_ui=seed_value_for_ui,
                actual_batch_size=actual_batch_size,
                progress=progress,
                retake_seed_value_for_ui=retake_seed_value_for_ui,
                retake_variance=retake_variance,
            )
            del outputs, pred_wavs
            if getattr(self, "offload_to_cpu", False):
                gc.collect()
                self._empty_cache()
            return result
        except Exception as exc:
            error_msg = f"Error: {exc!s}\n{traceback.format_exc()}"
            logger.exception("[generate_music] Generation failed")
            return {
                "audios": [],
                "status_message": error_msg,
                "extra_outputs": {},
                "success": False,
                "error": f"{exc!s}",
            }
