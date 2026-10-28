"""Role-aware, durable training and dataset jobs; all GPU work uses one gate."""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Literal, Optional
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, ConfigDict, model_validator

from acestep.api.gpu import run_gpu
from acestep.api.jobs.durable import QueueFull

TRAINING_MODELS = ("acestep-v15-xl-turbo", "acestep-v15-xl-sft")
ADAPTER_FILES = {"manifest.json": "application/json", "adapter_config.json": "application/json",
                 "adapter_model.safetensors": "application/octet-stream", "lokr_weights.safetensors": "application/octet-stream"}


class TrainingConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lora_rank: int = Field(64, ge=1, le=256)
    lora_alpha: int = Field(128, ge=1, le=512)
    lora_dropout: float = Field(.1, ge=0, lt=1)
    learning_rate: float = Field(1e-4, gt=0, le=1)
    train_epochs: int = Field(10, ge=1, le=10000)
    train_batch_size: int = Field(1, ge=1, le=32)
    gradient_accumulation: int = Field(4, ge=1, le=1024)
    save_every_n_epochs: int = Field(5, ge=1)
    training_seed: int = 42
    gradient_checkpointing: Literal[True] = True
    # These are supplied from the selected checkpoint and checked at admission.
    timestep_mu: Optional[float] = None
    timestep_sigma: Optional[float] = None
    data_proportion: Optional[float] = None

    @model_validator(mode="after")
    def finite(self):
        for value in self.model_dump().values():
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError("Training configuration must be finite")
        return self


class StartTrainingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: Literal["acestep-v15-xl-turbo", "acestep-v15-xl-sft"]
    source_audio_url: Optional[str] = None
    tensor_dir: Optional[str] = None
    sample_metadata: dict[str, Any] = Field(default_factory=dict)
    training_config: TrainingConfig = Field(default_factory=TrainingConfig)
    checkpoint_fingerprint: Optional[str] = Field(None, pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def source(self):
        if bool(self.source_audio_url) == bool(self.tensor_dir):
            raise ValueError("Exactly one source_audio_url or tensor_dir is required")
        if self.source_audio_url:
            parsed = urlparse(self.source_audio_url)
            if parsed.scheme not in ("http", "https") or not parsed.netloc:
                raise ValueError("source_audio_url must be an HTTP URL")
        json.dumps(self.sample_metadata, allow_nan=False)
        return self


def role() -> str:
    value = os.getenv("ACESTEP_ROLE", "generation")
    if value not in ("generation", "training"):
        raise RuntimeError("ACESTEP_ROLE must be generation or training")
    return value


def checkpoint_root() -> Path:
    from acestep.model_downloader import get_checkpoints_dir
    return Path(get_checkpoints_dir())


def training_options(state) -> dict:
    models = []
    for model in TRAINING_MODELS:
        info = state.training_checkpoints[model]
        config = TrainingConfig(**info["timetable"]).model_dump()
        models.append({"model": model, "checkpoint_fingerprint": info["fingerprint"], "training_config": config})
    return {"role": "training", "models": models, "max_audio_duration": 240.0}


def initialize_training_runtime(state):
    """Validate exact phase components without loading generation handlers."""
    from acestep.api.adapters import checkpoint_fingerprint
    from acestep.api.model_download import ensure_model_downloaded
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("Training role requires a CUDA GPU")
    root = checkpoint_root()
    state._checkpoint_dir = str(root)
    state.training_checkpoints = {}
    state.checkpoint_fingerprints = {}
    for model in TRAINING_MODELS:
        directory = Path(ensure_model_downloaded(model, str(root)))
        if not (directory / "silence_latent.pt").is_file():
            raise RuntimeError(f"Exact model silence_latent.pt is missing: {model}")
        cfg = json.loads((directory / "config.json").read_text())
        if cfg.get("hidden_size") != 2560 or cfg.get("model_version") != ("turbo" if model.endswith("turbo") else "base"):
            raise RuntimeError(f"Unexpected XL checkpoint config: {model}")
        timetable = {key: cfg[key] for key in ("timestep_mu", "timestep_sigma", "data_proportion")}
        if any(not math.isfinite(float(x)) for x in timetable.values()):
            raise RuntimeError(f"Nonfinite checkpoint timetable: {model}")
        fingerprint = checkpoint_fingerprint(directory)
        state.training_checkpoints[model] = {"fingerprint": fingerprint, "timetable": timetable}
        state.checkpoint_fingerprints[model] = fingerprint
    for component in ("vae", "Qwen3-Embedding-0.6B", os.getenv("ACESTEP_LM_MODEL_PATH", "acestep-5Hz-lm-4B")):
        ensure_model_downloaded(component, str(root))
    from acestep.training.path_safety import set_safe_root
    set_safe_root(state.training_artifact_root)
    state.training_ready = True


_POD_AUDIO_ORIGIN: Optional[str] = None
_POD_AUDIO_ORIGIN_RESOLVED: bool = False


def _pod_audio_origin() -> Optional[str]:
    global _POD_AUDIO_ORIGIN, _POD_AUDIO_ORIGIN_RESOLVED
    if _POD_AUDIO_ORIGIN_RESOLVED:
        return _POD_AUDIO_ORIGIN
    try:
        import socket
        ip = socket.gethostbyname(socket.gethostname())
        if not ip or ip.startswith("127."):
            _POD_AUDIO_ORIGIN = None
        else:
            port = int(os.getenv("ACESTEP_API_PORT", "8001"))
            _POD_AUDIO_ORIGIN = f"http://{ip}:{port}"
    except Exception:
        _POD_AUDIO_ORIGIN = None
    _POD_AUDIO_ORIGIN_RESOLVED = True
    return _POD_AUDIO_ORIGIN


def cache_audio_file(store, file_path: str | Path, ttl_seconds: int = 900) -> None:
    try:
        client = getattr(store, "client", None)
        path = Path(file_path)
        if client is None or not path.is_file():
            return
        file_size = path.stat().st_size
        origin = _pod_audio_origin()
        if origin:
            try:
                client.set(f"rawchunks:worker:audio-owner:{path.name}", f"{origin}|{path}", ex=ttl_seconds)
            except Exception:
                pass

        def _write_valkey() -> None:
            if file_size > 64 * 1024 * 1024:
                return
            try:
                import base64
                raw = path.read_bytes()
                encoded = base64.b64encode(raw).decode("ascii")
                client.set(f"rawchunks:worker:audio:{path.name}", encoded, ex=ttl_seconds)
            except Exception:
                pass

        if file_size <= 256 * 1024:
            _write_valkey()
        else:
            import threading
            threading.Thread(target=_write_valkey, daemon=True).start()
    except Exception:
        pass


def fetch_cached_audio_bytes(store, target_path: str | Path) -> Optional[bytes]:
    client = getattr(store, "client", None)
    name = Path(target_path).name
    if not name or client is None:
        return None
    try:
        owner_entry = client.get(f"rawchunks:worker:audio-owner:{name}")
        if owner_entry and "|" in str(owner_entry):
            owner_origin, owner_path = str(owner_entry).split("|", 1)
            local_origin = _pod_audio_origin()
            if owner_origin and owner_origin != local_origin:
                import httpx
                api_key = os.getenv("ACESTEP_API_KEY", "").strip()
                headers = {"x-rawchunks-peer-hop": "1"}
                if api_key:
                    headers["Authorization"] = f"Bearer {api_key}"
                resp = httpx.get(
                    f"{owner_origin}/v1/audio",
                    params={"path": owner_path},
                    headers=headers,
                    timeout=15.0,
                )
                if resp.status_code == 200 and resp.content:
                    return resp.content
    except Exception:
        pass
    try:
        import base64
        encoded = client.get(f"rawchunks:worker:audio:{name}")
        if encoded:
            return base64.b64decode(encoded)
    except Exception:
        pass
    return None


def register_role_middleware(app):
    """Forward the original bytes once. Missing training service fails closed."""
    @app.middleware("http")
    async def dispatch(request: Request, call_next):
        path = request.url.path
        is_training = path.startswith(("/v1/dataset/", "/v1/training/"))
        current = role()
        if current == "generation" and is_training:
            url = os.getenv("ACESTEP_TRAINING_URL", "").rstrip("/")
            if not url:
                return Response("Training service is not configured", status_code=503)
            import httpx
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=10), follow_redirects=False) as client:
                    headers = {k: v for k, v in request.headers.items() if k.lower() not in ("host", "content-length", "connection", "transfer-encoding")}
                    upstream = await client.request(request.method, url + path,
                        params=request.query_params, content=await request.body(), headers=headers)
                outgoing = {k: v for k, v in upstream.headers.items() if k.lower() not in ("content-length", "connection", "transfer-encoding", "content-encoding")}
                return Response(upstream.content, status_code=upstream.status_code, headers=outgoing)
            except httpx.HTTPError:
                return Response("Training service is unavailable", status_code=503)
        if current == "training" and not is_training and path not in ("/health", "/v1/stats", "/query_result"):
            return Response("Endpoint is unavailable on the training role", status_code=409)
        response = await call_next(request)
        if (
            current == "generation"
            and path == "/v1/audio"
            and request.method == "GET"
            and response.status_code == 404
            and request.headers.get("x-rawchunks-peer-hop") != "1"
        ):
            target = request.query_params.get("path", "")
            name = Path(target).name
            store = getattr(request.app.state, "job_store", None)
            if name and store is not None:
                try:
                    raw = await asyncio.to_thread(fetch_cached_audio_bytes, store, target)
                    if raw:
                        temp_dir = getattr(request.app.state, "temp_audio_dir", None)
                        if temp_dir and len(raw) <= 1024 * 1024:
                            local_path = Path(temp_dir) / name
                            local_path.parent.mkdir(parents=True, exist_ok=True)
                            local_path.write_bytes(raw)
                        return Response(raw, status_code=200, media_type="audio/wav")
                except Exception:
                    pass
        return response


def _job_root(state, task_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id):
        raise HTTPException(400, "Invalid task identifier")
    return Path(state.training_artifact_root) / task_id


def _write_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, sort_keys=True, ensure_ascii=False, allow_nan=False, indent=2) + "\n")
    os.replace(temporary, path)


def _progress(store, task_id, *, stage, step=0, total_steps=0, loss=None, progress=.02):
    store._update(task_id, {"stage": stage, "step": step, "total_steps": total_steps,
        "loss": loss, "progress": progress})


def _cancelled(store, task_id):
    return bool(store.client.hget(store.key("cancellations"), task_id))


def _check_cancel(store, task_id):
    if _cancelled(store, task_id):
        raise RuntimeError("Training cancelled")


def decode_audio(source: Path, destination: Path) -> float:
    """Decode installed formats without clipping, gain normalization, or trim."""
    result = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=channels,sample_rate,duration:format=duration", "-of", "json", str(source)],
        check=True, capture_output=True, text=True)
    data = json.loads(result.stdout)
    streams = data.get("streams", [])
    if len(streams) != 1 or int(streams[0].get("channels", 0)) not in (1, 2):
        raise ValueError("A mono or stereo audio stream is required")
    duration = float(streams[0].get("duration") or data.get("format", {}).get("duration") or 0)
    if not math.isfinite(duration) or not 0 < duration <= 240:
        raise ValueError("Audio duration must be positive and at most 240 seconds")
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(source), "-map", "0:a:0",
        "-vn", "-c:a", "pcm_f32le", str(destination)], check=True, capture_output=True)
    import soundfile as sf
    info = sf.info(str(destination))
    actual = info.frames / info.samplerate
    if not math.isfinite(actual) or actual <= 0 or abs(actual-duration) > max(.25, duration*.01):
        raise ValueError("Decoded audio duration differs from the source")
    return actual


async def download_source(url: str, destination: Path):
    import httpx
    req_url = url
    req_headers: dict[str, str] = {}
    try:
        from acestep.core.generation.handler.io_audio import r2_authenticated_request
        req_url, req_headers = r2_authenticated_request(url)
    except Exception:
        req_url = url
        req_headers = {}
    async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=10), follow_redirects=True) as client:
        async with client.stream("GET", req_url, headers=req_headers) as response:
            response.raise_for_status()
            with destination.open("wb") as handle:
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > 256 * 1024 * 1024:
                        raise ValueError("Source audio exceeds 256 MiB")
                    handle.write(chunk)
    if not destination.stat().st_size:
        raise ValueError("Source audio is empty")


def _merge_metadata(explicit: dict, generated: dict) -> dict:
    result = dict(explicit)
    aliases = {"genres": "genre", "vocal_language": "language"}
    for key, value in generated.items():
        key = aliases.get(key, key)
        if result.get(key) in (None, "") and value not in (None, ""):
            result[key] = value
    # Raw, bracketed user lyrics are the training text, without LM formatting.
    if explicit.get("raw_lyrics"):
        result["lyrics"] = explicit["raw_lyrics"]
    elif explicit.get("lyrics"):
        result["lyrics"] = explicit["lyrics"]
    if "is_instrumental" in explicit:
        result["is_instrumental"] = explicit["is_instrumental"]
    if explicit.get("is_instrumental") is False and not (explicit.get("raw_lyrics") or explicit.get("lyrics")) and str(result.get("lyrics", "")).strip().casefold() == "[instrumental]":
        raise RuntimeError("Vocal sample labeling returned only [Instrumental]; no vocal transcription was produced")
    return result


def label_samples(state, samples: list[dict], model: str, store, task_id):
    """Load only the chosen encoder and existing LM; fill missing metadata."""
    _check_cancel(store, task_id)
    needs = [s for s in samples if any(s.get(k) in (None, "") for k in ("caption", "bpm", "keyscale", "timesignature")) or
             (not s.get("is_instrumental", False) and not (s.get("raw_lyrics") or s.get("lyrics")))]
    if not needs:
        return [_merge_metadata(s, {}) for s in samples]
    from acestep.handler import AceStepHandler
    from acestep.llm_inference import LLMHandler
    handler, llm = AceStepHandler(), LLMHandler()
    try:
        _, ok = handler.initialize_service(project_root=str(Path(__file__).resolve().parents[2]), config_path=model,
            device="cuda", use_flash_attention=True, compile_model=False, offload_to_cpu=False, offload_dit_to_cpu=True)
        if not ok:
            raise RuntimeError("Exact XL model failed to load for sample labeling")
        # Decoder is unused by audio-code understanding and stays off the GPU.
        handler.model.decoder = None
        handler.text_encoder = None
        handler.model.to("cuda")
        handler.offload_dit_to_cpu = False
        # Bypass the generation loader's amplitude clamp for training samples.
        from acestep.training.dataset_builder_modules.preprocess_audio import load_audio_stereo
        handler.process_src_audio = lambda file: load_audio_stereo(file, 48000, 240)[0]
        lm_name = os.getenv("ACESTEP_LM_MODEL_PATH", "acestep-5Hz-lm-4B")
        status, ok = llm.initialize(checkpoint_dir=state._checkpoint_dir, lm_model_path=lm_name,
            backend=os.getenv("ACESTEP_LM_BACKEND", "pt"), device="cuda", offload_to_cpu=False, dtype=None)
        if not ok:
            raise RuntimeError(f"Existing LM failed to initialize: {status}")
        merged = []
        for i, sample in enumerate(samples):
            _check_cancel(store, task_id)
            generated = {}
            if sample in needs:
                codes = handler.convert_src_audio_to_codes(sample["audio_path"])
                if not codes or codes.startswith("❌"):
                    raise RuntimeError("Sample audio-code encoding failed")
                generated, status = llm.understand_audio_from_codes(audio_codes=codes, temperature=.7, use_constrained_decoding=True)
                if not generated:
                    raise RuntimeError(f"Sample labeling failed: {status}")
            current = _merge_metadata(sample, generated)
            if not current.get("is_instrumental", False) and not current.get("lyrics"):
                raise RuntimeError("Vocal sample has no lyrics after labeling")
            current["labeled"] = True
            merged.append(current)
            _progress(store, task_id, stage="labeling", step=i+1, total_steps=len(samples), progress=.05+.1*(i+1)/len(samples))
        return merged
    finally:
        if getattr(llm, "llm_initialized", False):
            llm.unload()
        for name in ("model", "vae", "text_encoder"):
            component = getattr(handler, name, None)
            if component is not None and hasattr(component, "to"):
                component.to("cpu")
            setattr(handler, name, None)
        import gc, torch
        del handler, llm
        gc.collect()
        torch.cuda.empty_cache()


def validate_lora(output: Path, rank: int, alpha: int) -> float:
    """Validate every paired factor and the effective B@A update on CPU."""
    import torch
    from safetensors.torch import load_file
    config = json.loads((output / "adapter_config.json").read_text())
    if config.get("peft_type") != "LORA" or config.get("r") != rank or config.get("lora_alpha") != alpha:
        raise ValueError("Saved adapter configuration does not match the training job")
    if config.get("bias", "none") != "none" or config.get("use_dora", False) or config.get("rank_pattern") or config.get("alpha_pattern"):
        raise ValueError("Unsupported adapter configuration")
    weights = load_file(str(output / "adapter_model.safetensors"), device="cpu")
    if not weights:
        raise ValueError("Saved adapter is empty")
    pairs = {}
    for key, tensor in weights.items():
        match = re.fullmatch(r"(.+)\.lora_([AB])(?:\.default)?\.weight", key)
        if not match or tensor.ndim != 2 or not tensor.is_floating_point() or not bool(torch.isfinite(tensor).all()):
            raise ValueError(f"Invalid adapter tensor: {key}")
        pairs.setdefault(match[1], {})[match[2]] = tensor
    norm_squared = 0.0
    for name, pair in pairs.items():
        if set(pair) != {"A", "B"} or pair["A"].shape[0] != rank or pair["B"].shape[1] != rank:
            raise ValueError(f"Invalid LoRA factor pair: {name}")
        a, b = pair["A"].double(), pair["B"].double()
        # Chunked exact product avoids materializing an entire XL weight matrix.
        for chunk in b.split(64):
            update = chunk @ a
            if not bool(torch.isfinite(update).all()):
                raise ValueError("Nonfinite effective LoRA update")
            norm_squared += float(update.square().sum()) * (alpha / rank) ** 2
    norm = math.sqrt(norm_squared)
    if not math.isfinite(norm) or norm <= 0:
        raise ValueError("Saved LoRA has zero effective B@A update")
    return norm


def consume_updates(trainer, cancellation: dict, store, task_id):
    completed, step, loss, total_steps = False, 0, None, 0
    for update in trainer.train(training_state=cancellation):
        if _cancelled(store, task_id):
            cancellation["should_stop"] = True
        kind = getattr(update, "kind", None)
        if hasattr(update, "step"):
            current_step, current_loss, message = int(update.step), float(update.loss), str(update.msg)
        else:
            current_step, current_loss, message = int(update[0]), float(update[1]), str(update[2])
        if kind == "fail":
            raise RuntimeError(message)
        if not math.isfinite(current_loss):
            raise RuntimeError("Training produced nonfinite loss")
        if cancellation.get("should_stop"):
            raise RuntimeError("Training cancelled")
        if kind in ("step", "epoch", "complete"):
            if current_step < step:
                raise RuntimeError("Optimizer step regressed")
            step, loss = current_step, current_loss
            total_steps = max(total_steps, int(getattr(update, "steps_per_epoch", 0) or 0) * trainer.training_config.max_epochs)
            _progress(store, task_id, stage="training", step=step, total_steps=max(total_steps,step), loss=loss,
                progress=min(.9, .2+.7*step/max(total_steps,step,1)))
        if kind == "complete":
            completed = True
    if not completed or step <= 0 or loss is None:
        raise RuntimeError("Training did not complete positive optimizer steps")
    return step, loss


def _make_artifact(state, task_id, request, output, metrics, *, adapter_type="lora"):
    filename = "adapter_model.safetensors" if adapter_type == "lora" else "lokr_weights.safetensors"
    names = ("adapter_config.json", filename)
    files = [{"filename": name, "digest": hashlib.sha256((output/name).read_bytes()).hexdigest(),
              "content_type": ADAPTER_FILES[name]} for name in names]
    manifest = {"schema_version": 1, "task_id": task_id, "model": request["model"],
        "checkpoint_fingerprint": request["checkpoint_fingerprint"], "adapter_type": adapter_type,
        "training_config": request["training_config"], "files": files, "metrics": metrics}
    _write_json(output/"manifest.json", manifest)
    digest = hashlib.sha256((output/"manifest.json").read_bytes()).hexdigest()
    return {"files": files + [{"filename": "manifest.json", "digest": digest, "content_type": "application/json"}],
        "manifest": "manifest.json", "digest": digest, "checkpoint_fingerprint": request["checkpoint_fingerprint"], "metrics": metrics}


def _train_blocking(state, store, task_id, request, tensor_dir: str):
    from acestep.training_v2.configs import TrainingConfigV2, LoRAConfigV2, LoKRConfigV2
    from acestep.training_v2.trainer_fixed import FixedLoRATrainer
    from acestep.training_v2.model_loader import load_decoder_for_training
    cfg = request["training_config"]
    output_root = _job_root(state, task_id)
    attempt = Path(tempfile.mkdtemp(prefix="attempt-", dir=output_root))
    model = None
    trainer = None
    try:
        _check_cancel(store, task_id)
        variant = "xl_turbo" if request["model"].endswith("turbo") else "xl_sft"
        model = load_decoder_for_training(state._checkpoint_dir, variant, "cuda", "bf16")
        config = TrainingConfigV2(dataset_dir=tensor_dir, model_variant=variant, checkpoint_dir=state._checkpoint_dir,
            device="cuda", precision="bf16", output_dir=str(attempt), learning_rate=cfg["learning_rate"],
            batch_size=cfg["train_batch_size"], gradient_accumulation_steps=cfg["gradient_accumulation"],
            max_epochs=cfg["train_epochs"], save_every_n_epochs=cfg["save_every_n_epochs"], seed=cfg["training_seed"],
            gradient_checkpointing=True, num_workers=0, persistent_workers=False, pin_memory=False,
            log_every=1, log_heavy_every=50, warmup_steps=0, sample_every_n_epochs=0,
            timestep_mu=cfg["timestep_mu"], timestep_sigma=cfg["timestep_sigma"], data_proportion=cfg["data_proportion"],
            adapter_type=request.get("adapter_type", "lora"))
        adapter = (LoKRConfigV2(**request["lokr_config"]) if config.adapter_type == "lokr" else
                   LoRAConfigV2(r=cfg["lora_rank"], alpha=cfg["lora_alpha"], dropout=cfg["lora_dropout"]))
        trainer = FixedLoRATrainer(model, adapter, config)
        steps, loss = consume_updates(trainer, {"should_stop": False}, store, task_id)
        _check_cancel(store, task_id)
        final = attempt / "final"
        if config.adapter_type == "lora":
            norm = validate_lora(final, cfg["lora_rank"], cfg["lora_alpha"])
        else:
            norm = validate_lokr(trainer, final)
            _write_json(final/"adapter_config.json", {"adapter_type": "lokr", "lokr_config": request["lokr_config"]})
        metrics = {"optimizer_steps": steps, "final_loss": loss, "effective_update_norm": norm}
        artifact = _make_artifact(state, task_id, request, final, metrics, adapter_type=config.adapter_type)
        # Only this validated attempt can become the task's served artifact.
        served = output_root / "artifact"
        if served.exists():
            shutil.rmtree(served)
        os.replace(final, served)
        return {"artifact": artifact, "metrics": metrics}
    finally:
        if trainer is not None:
            trainer.module = None
            trainer.model = None
        if model is not None:
            model.to("cpu")
        import gc, torch
        del trainer, model
        gc.collect()
        torch.cuda.empty_cache()
        shutil.rmtree(attempt, ignore_errors=True)


def validate_lokr(trainer, output):
    """Require saved finite weights and a nonzero effective LyCORIS diff."""
    import torch
    from safetensors.torch import load_file
    weights = load_file(str(output/"lokr_weights.safetensors"), device="cpu")
    if not weights or any(not bool(torch.isfinite(t).all()) for t in weights.values()):
        raise ValueError("Invalid saved LoKR weights")
    network = getattr(trainer.module, "lycoris_net", None)
    modules = getattr(network, "loras", [])
    norm_squared = 0.0
    for module in modules:
        diff = module.get_diff_weight()
        diff = diff[0] if isinstance(diff, tuple) else diff
        if not torch.is_tensor(diff) or not bool(torch.isfinite(diff).all()):
            raise ValueError("Invalid effective LoKR update")
        norm_squared += float(diff.double().square().sum())
    norm = math.sqrt(norm_squared)
    if not math.isfinite(norm) or norm <= 0:
        raise ValueError("Saved LoKR has zero effective update")
    return norm


async def execute_training_job(state, store, task_id, request):
    """Execute durable train/label/preprocess input within the shared worker."""
    if getattr(state, "role", role()) != "training":
        raise RuntimeError("Training jobs require the training role")
    store.mark_running(task_id)
    _progress(store, task_id, stage="running", progress=.01)
    root = _job_root(state, task_id)
    root.mkdir(parents=True, exist_ok=True)
    _check_cancel(store, task_id)
    operation = request.get("operation", "train")
    samples = request.get("samples")
    if request.get("source_audio_url"):
        _progress(store, task_id, stage="downloading")
        source = root / "source.audio"
        await download_source(request["source_audio_url"], source)
        _check_cancel(store, task_id)
        decoded = root / "source.wav"
        duration = await asyncio.to_thread(decode_audio, source, decoded)
        explicit = dict(request.get("sample_metadata", {}))
        explicit.setdefault("is_instrumental", False)
        explicit.update(audio_path=str(decoded), filename=decoded.name, duration=duration)
        samples = [explicit]
    if samples is not None:
        if not samples:
            raise RuntimeError("Dataset is empty")
        normalized = []
        for index, sample in enumerate(samples):
            source_path = Path(sample["audio_path"])
            if not source_path.is_file():
                raise RuntimeError("Dataset source audio is missing")
            destination = root / f"sample-{index}.wav"
            duration = await asyncio.to_thread(decode_audio, source_path, destination)
            normalized.append({**sample, "audio_path": str(destination), "filename": destination.name, "duration": duration})
        samples = normalized
        _progress(store, task_id, stage="labeling", total_steps=len(samples), progress=.05)
        samples = await run_gpu(state, label_samples, state, samples, request["model"], store, task_id)
        _check_cancel(store, task_id)
        dataset = root / "dataset.json"
        metadata = request.get("dataset_metadata", {"name": task_id, "all_instrumental": False})
        _write_json(dataset, {"metadata": metadata, "samples": samples})
        _check_cancel(store, task_id)
        if operation == "label":
            result = {"samples": samples, "labeled_count": len(samples), "dataset_json": str(dataset)}
            builder = getattr(state, "dataset_builder", None)
            if builder is not None and [s.to_dict() for s in builder.samples] == request["samples"]:
                from acestep.training.dataset_builder import AudioSample
                updated_samples = [AudioSample.from_dict(sample) for sample in samples]
                _check_cancel(store, task_id)
                builder.samples = updated_samples
                state.dataset_json_path = str(dataset)
            _check_cancel(store, task_id)
            store.mark_succeeded(task_id, result)
            return
        from acestep.training_v2.preprocess import preprocess_audio_files
        tensor_dir = root / "tensors"
        # A recovered attempt rebuilds from its admitted audio instead of
        # treating partial or completed tensor files as a completed phase.
        if tensor_dir.exists():
            await asyncio.to_thread(shutil.rmtree, tensor_dir)
        _progress(store, task_id, stage="preprocessing", progress=.15)
        def preprocess():
            _check_cancel(store, task_id)
            result = preprocess_audio_files(audio_dir=None, output_dir=str(tensor_dir), checkpoint_dir=state._checkpoint_dir,
                variant="xl_turbo" if request["model"].endswith("turbo") else "xl_sft", max_duration=240,
                dataset_json=str(dataset), device="cuda", precision="bf16",
                cancel_check=lambda: _cancelled(store, task_id),
                progress_callback=lambda current,total,msg: _progress(store, task_id, stage="preprocessing",
                    step=current, total_steps=total, progress=.15+.05*current/max(total,1)))
            _check_cancel(store, task_id)
            if result.get("failed") or result.get("processed") != len(samples):
                raise RuntimeError(f"Dataset preprocessing failed: {result}")
            return result
        processed = await run_gpu(state, preprocess)
        if operation == "preprocess":
            _check_cancel(store, task_id)
            store.mark_succeeded(task_id, {**processed, "tensor_dir": str(tensor_dir)})
            return
    else:
        # Copy durable admitted tensor bytes into the job root before training.
        tensor_dir = root / "tensors"
        snapshot = root / "input-tensors"
        source = Path(request.get("tensor_snapshot_dir") or request["tensor_dir"])
        if not snapshot.exists():
            await asyncio.to_thread(shutil.copytree, source, snapshot)
        if tensor_dir.exists():
            await asyncio.to_thread(shutil.rmtree, tensor_dir)
        await asyncio.to_thread(shutil.copytree, snapshot, tensor_dir)
    _check_cancel(store, task_id)
    if not tensor_dir.is_dir() or not list(tensor_dir.glob("*.pt")):
        raise RuntimeError("No preprocessed tensor files found")
    result = await run_gpu(state, _train_blocking, state, store, task_id, request, str(tensor_dir))
    _check_cancel(store, task_id)
    store.mark_succeeded(task_id, result)


def prepare_training_request(state, body: dict, *, adapter_type="lora"):
    # Legacy tensor-dir API fields are accepted through the same corrected job.
    body = dict(body)
    body.setdefault("model", TRAINING_MODELS[0])
    legacy = {key: body.pop(key) for key in list(body) if key in TrainingConfig.model_fields}
    if legacy:
        body["training_config"] = {**legacy, **body.get("training_config", {})}
    body.pop("lora_output_dir", None)
    body.pop("output_dir", None)
    body.pop("use_fp8", None)
    body.pop("training_shift", None)
    lokr = {key: body.pop(key) for key in list(body) if key.startswith("lokr_")}
    req = StartTrainingRequest(**body)
    info = state.training_checkpoints[req.model]
    if req.checkpoint_fingerprint and req.checkpoint_fingerprint != info["fingerprint"]:
        raise ValueError("Training checkpoint fingerprint changed")
    config = req.training_config.model_dump()
    for key, value in info["timetable"].items():
        if config[key] is not None and config[key] != value:
            raise ValueError("Training timetable must match the exact checkpoint")
        config[key] = value
    payload = req.model_dump()
    payload.update(training_config=config, checkpoint_fingerprint=info["fingerprint"], adapter_type=adapter_type)
    if adapter_type == "lokr":
        from acestep.training_v2.configs import LoKRConfigV2
        names = {"lokr_linear_dim": "linear_dim", "lokr_linear_alpha": "linear_alpha", "lokr_factor": "factor",
            "lokr_decompose_both": "decompose_both", "lokr_use_tucker": "use_tucker", "lokr_use_scalar": "use_scalar",
            "lokr_weight_decompose": "weight_decompose"}
        payload["lokr_config"] = LoKRConfigV2(**{names[k]: v for k,v in lokr.items()}).to_dict()
        payload["lokr_config"].pop("attention_type", None)
    return payload


async def admit_training(state, request: Request, payload: dict, *, kind="training"):
    identifier = request.headers.get("Idempotency-Key") or str(uuid4())
    if payload.get("tensor_dir"):
        payload = dict(payload)
        try:
            source = Path(payload["tensor_dir"]).resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise HTTPException(400, "Tensor input directory is unavailable") from exc
        if not source.is_dir() or not list(source.glob("*.pt")):
            raise HTTPException(400, "No preprocessed tensor files found")
        snapshot_root = _job_root(state, identifier) / "admitted-tensors"
        digest = hashlib.sha256()
        for path in sorted(source.glob("*.pt")):
            if path.is_symlink():
                raise HTTPException(400, "Tensor input cannot use symlinks")
            digest.update(path.name.encode()+b"\0")
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(8*1024*1024), b""):
                    digest.update(chunk)
        payload["tensor_digest"] = digest.hexdigest()
        payload["tensor_snapshot_dir"] = str(snapshot_root / payload["tensor_digest"])
        destination = Path(payload["tensor_snapshot_dir"])
        if not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = Path(tempfile.mkdtemp(prefix="snapshot-", dir=destination.parent))
            try:
                for path in source.glob("*.pt"):
                    await asyncio.to_thread(shutil.copyfile, path, temporary/path.name)
                os.replace(temporary, destination)
            finally:
                shutil.rmtree(temporary, ignore_errors=True)
    try:
        record, position = await asyncio.to_thread(state.job_queue.admit, payload, kind=kind, job_id=identifier)
    except QueueFull as exc:
        raise HTTPException(429, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    state.job_store.client.set(state.job_store.key("latest:"+payload.get("operation", "train")), record.job_id)
    return {"task_id": record.job_id, "queue_position": max(0, position)}


def durable_status(state, task_id):
    record = state.job_store.get(task_id) if task_id else None
    if record is None:
        raise HTTPException(404, "Training task not found")
    return {"task_id": record.job_id, "status": record.status, "stage": record.stage,
        "step": getattr(record, "step", 0), "total_steps": getattr(record, "total_steps", 0),
        "loss": getattr(record, "loss", None), "error": record.error, "result": record.result,
        "current": getattr(record, "step", 0), "total": getattr(record, "total_steps", 0), "progress": record.progress}


def register_training_routes(app, verify_api_key, wrap_response):
    @app.get("/v1/training/options")
    async def options(_: None = Depends(verify_api_key)):
        return wrap_response(training_options(app.state))

    async def start(request: Request, adapter_type="lora"):
        try:
            payload = prepare_training_request(app.state, await request.json(), adapter_type=adapter_type)
        except (ValueError, KeyError) as exc:
            raise HTTPException(400, str(exc)) from exc
        return wrap_response(await admit_training(app.state, request, payload))

    @app.post("/v1/training/start")
    async def start_lora(request: Request, _: None = Depends(verify_api_key)):
        return await start(request)

    @app.post("/v1/training/start_lokr")
    async def start_lokr(request: Request, _: None = Depends(verify_api_key)):
        return await start(request, "lokr")

    @app.post("/v1/training/stop")
    async def stop(request: Request, _: None = Depends(verify_api_key)):
        body = await request.json() if await request.body() else {}
        task_id = body.get("task_id") or app.state.job_store.client.get(app.state.job_store.key("latest:train"))
        current = durable_status(app.state, task_id)
        app.state.job_store.client.hset(app.state.job_store.key("cancellations"), task_id, "1")
        return wrap_response({"task_id": task_id, "message": "Cancellation requested", "status": current["status"]})

    @app.get("/v1/training/status")
    async def status(task_id: Optional[str] = None, _: None = Depends(verify_api_key)):
        task_id = task_id or app.state.job_store.client.get(app.state.job_store.key("latest:train"))
        return wrap_response(durable_status(app.state, task_id))

    @app.post("/v1/training/query_result")
    async def query(request: Request, _: None = Depends(verify_api_key)):
        from acestep.api.http.query_result_service import collect_query_results, parse_task_id_list
        body = await request.json()
        ids = parse_task_id_list(body.get("task_id_list", []))
        return wrap_response(collect_query_results(ids, None, app.state.job_store,
            lambda value: 1 if value == "succeeded" else 2 if value == "failed" else 0, "", 3600, lambda: ""))

    @app.get("/v1/training/artifact/{task_id}/{filename}")
    async def artifact(task_id: str, filename: str, _: None = Depends(verify_api_key)):
        current = durable_status(app.state, task_id)
        artifact = (current.get("result") or {}).get("artifact", {})
        entry = next((f for f in artifact.get("files", []) if f.get("filename") == filename), None)
        if current["status"] != "succeeded" or filename not in ADAPTER_FILES or not entry:
            raise HTTPException(404, "Validated artifact file not found")
        path = _job_root(app.state, task_id)/"artifact"/filename
        if not path.is_file() or path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != entry["digest"]:
            raise HTTPException(409, "Validated artifact was modified")
        return FileResponse(path, media_type=ADAPTER_FILES[filename], filename=filename)

    @app.post("/v1/training/export")
    async def export(request: Request, _: None = Depends(verify_api_key)):
        body = await request.json()
        task_id = body.get("task_id")
        if not task_id:
            raise HTTPException(400, "Export requires an exact successful task_id")
        current = durable_status(app.state, task_id)
        artifact = (current.get("result") or {}).get("artifact")
        if current["status"] != "succeeded" or not artifact:
            raise HTTPException(409, "Training task has no validated artifact")
        return wrap_response({"task_id": task_id, "artifact": artifact})

    @app.post("/v1/training/load_tensor_info")
    async def tensor_info(request: Request, _: None = Depends(verify_api_key)):
        directory = Path((await request.json()).get("tensor_dir", ""))
        if not directory.is_dir() or not list(directory.glob("*.pt")):
            raise HTTPException(400, "No preprocessed tensors found")
        return wrap_response({"tensor_dir": str(directory), "num_samples": len(list(directory.glob("*.pt")))})


def register_dataset_jobs(app, verify_api_key, wrap_response):
    async def submit(request, operation, sync=False):
        body = await request.json()
        builder = app.state.dataset_builder
        if builder is None:
            raise HTTPException(400, "No dataset loaded")
        model = body.get("model", TRAINING_MODELS[0])
        if model not in TRAINING_MODELS:
            raise HTTPException(400, "Dataset jobs require an exact supported XL model")
        if body.get("lm_model_path") and body["lm_model_path"] != os.getenv("ACESTEP_LM_MODEL_PATH", "acestep-5Hz-lm-4B"):
            raise HTTPException(400, "Labeling uses the configured existing LM")
        snapshot = {"operation": operation, "model": model, "samples": [s.to_dict() for s in builder.samples],
            "dataset_metadata": builder.metadata.to_dict()}
        result = await admit_training(app.state, request, snapshot)
        if sync:
            record = await app.state.job_queue.wait(result["task_id"])
            if record.status == "failed":
                raise HTTPException(500, record.error)
            return wrap_response(record.result)
        return wrap_response(result)

    @app.post("/v1/dataset/auto_label")
    async def label(request: Request, _: None = Depends(verify_api_key)):
        return await submit(request, "label", True)

    @app.post("/v1/dataset/auto_label_async")
    async def label_async(request: Request, _: None = Depends(verify_api_key)):
        return await submit(request, "label")

    @app.post("/v1/dataset/preprocess")
    async def preprocess(request: Request, _: None = Depends(verify_api_key)):
        return await submit(request, "preprocess", True)

    @app.post("/v1/dataset/preprocess_async")
    async def preprocess_async(request: Request, _: None = Depends(verify_api_key)):
        return await submit(request, "preprocess")

    @app.get("/v1/dataset/auto_label_status/{task_id}")
    @app.get("/v1/dataset/preprocess_status/{task_id}")
    async def status(task_id: str, _: None = Depends(verify_api_key)):
        return wrap_response(durable_status(app.state, task_id))

    @app.get("/v1/dataset/auto_label_status")
    async def latest_label(_: None = Depends(verify_api_key)):
        task_id = app.state.job_store.client.get(app.state.job_store.key("latest:label"))
        return wrap_response(durable_status(app.state, task_id)) if task_id else wrap_response({"status": "idle", "task_id": None})

    @app.get("/v1/dataset/preprocess_status")
    async def latest_preprocess(_: None = Depends(verify_api_key)):
        task_id = app.state.job_store.client.get(app.state.job_store.key("latest:preprocess"))
        return wrap_response(durable_status(app.state, task_id)) if task_id else wrap_response({"status": "idle", "task_id": None})
