"""Validated, immutable inference artifacts shared by jobs and explicit LoRA loads."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from threading import RLock
from urllib.parse import urljoin, urlparse
from urllib.request import urlopen, Request

_LOCK = RLock()
_FINGERPRINTS = {}
_ARTIFACT_HOST = "pub-1b122472089542a8826ac7f695328c46.r2.dev"


def _hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checkpoint_fingerprint(model_dir) -> str:
    directory = Path(model_dir).resolve(strict=True)
    files = sorted(path for path in directory.rglob("*") if path.is_file() and (path.suffix in {".safetensors", ".bin"} or path.name == "config.json" or path.name.endswith(".index.json")))
    if not files or not any(path.suffix in {".safetensors", ".bin"} for path in files):
        raise ValueError(f"Checkpoint has no validated weights: {directory}")
    signature = tuple((str(path.relative_to(directory)), path.stat().st_size, path.stat().st_mtime_ns) for path in files)
    with _LOCK:
        key = (str(directory), signature)
        if key not in _FINGERPRINTS:
            digest = hashlib.sha256()
            for path in files:
                digest.update(str(path.relative_to(directory)).encode() + b"\0")
                digest.update(bytes.fromhex(_hash(path)))
            _FINGERPRINTS[key] = digest.hexdigest()
        return _FINGERPRINTS[key]


def _download(url, target, maximum):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != _ARTIFACT_HOST or parsed.username or parsed.password:
        raise ValueError("Adapter artifacts must use the configured LoRA object store")
    with urlopen(Request(url, headers={"User-Agent": "Rawchunks/1"}), timeout=60) as response:
        if urlparse(response.url).hostname != _ARTIFACT_HOST:
            raise ValueError("Adapter artifact redirected outside its object store")
        size = 0
        with Path(target).open("wb") as output:
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                size += len(chunk)
                if size > maximum:
                    raise ValueError("Adapter artifact exceeds the supported size")
                output.write(chunk)


def materialize_adapter(state, url, digest, model):
    if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise ValueError("A SHA256 adapter manifest digest is required")
    if model not in {"acestep-v15-xl-turbo", "acestep-v15-xl-sft", "acestep-v15-xl-base"}:
        raise ValueError("An exact XL checkpoint is required for adapter loading")
    fingerprints = getattr(state, "checkpoint_fingerprints", None)
    if fingerprints is None:
        fingerprints = {}
        state.checkpoint_fingerprints = fingerprints
    if model not in fingerprints:
        fingerprints[model] = checkpoint_fingerprint(Path(state._checkpoint_dir) / model)
    root = Path(os.getenv("ACESTEP_ADAPTER_CACHE", str(Path(state._checkpoint_dir) / "runtime" / "adapters")))
    root.mkdir(parents=True, exist_ok=True)
    destination = root / digest
    with _LOCK:
        temporary = Path(tempfile.mkdtemp(prefix="adapter-", dir=root))
        try:
            if destination.is_dir():
                shutil.copyfile(destination / "manifest.json", temporary / "manifest.json")
            else:
                _download(url, temporary / "manifest.json", 1024 * 1024)
            if _hash(temporary / "manifest.json") != digest:
                raise ValueError("Adapter manifest checksum mismatch")
            manifest = json.loads((temporary / "manifest.json").read_text())
            if manifest.get("schema_version") != 1 or manifest.get("model") != model or manifest.get("checkpoint_fingerprint") != fingerprints[model]:
                raise ValueError("Adapter checkpoint is incompatible with the requested resident model")
            metrics = manifest.get("metrics", {})
            import math
            if not isinstance(metrics.get("optimizer_steps"), int) or metrics["optimizer_steps"] < 1 or any(not isinstance(metrics.get(key), (int, float)) or not math.isfinite(metrics[key]) for key in ("final_loss", "effective_update_norm")) or metrics["effective_update_norm"] <= 0:
                raise ValueError("Adapter has no validated effective training update")
            files = manifest.get("files")
            if not isinstance(files, list) or not files:
                raise ValueError("Adapter manifest contains no files")
            names = set()
            for item in files:
                name, checksum = item.get("filename"), item.get("digest")
                if not isinstance(name, str) or Path(name).name != name or name in {".", "..", "manifest.json"} or "\\" in name or name in names or not isinstance(checksum, str) or len(checksum) != 64:
                    raise ValueError("Invalid adapter artifact entry")
                names.add(name)
                if destination.is_dir():
                    path = destination / name
                else:
                    path = temporary / name
                    _download(urljoin(url, name), path, 300_000_000)
                if _hash(path) != checksum:
                    raise ValueError(f"Adapter file checksum mismatch: {name}")
            if "adapter_config.json" not in names or not any(name.endswith(".safetensors") for name in names):
                raise ValueError("Adapter configuration and inference weights are required")
            config_path = (destination if destination.is_dir() else temporary) / "adapter_config.json"
            if not isinstance(json.loads(config_path.read_text()), dict):
                raise ValueError("Invalid adapter configuration")
            if not destination.is_dir():
                os.replace(temporary, destination)
            return str(destination)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)


async def prepare_job_adapter(app_state, req, handler=None):
    url = getattr(req, "lora_manifest_url", None)
    if not url:
        return
    if getattr(req, "lora_path", None):
        raise ValueError("Choose an adapter manifest or a local adapter, not both")
    req.lora_path = await asyncio.to_thread(materialize_adapter, app_state, url, getattr(req, "lora_manifest_digest", None), req.model)
