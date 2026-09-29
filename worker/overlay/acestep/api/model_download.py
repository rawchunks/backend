"""Download and validate the requested checkpoint from its registered source."""

from __future__ import annotations

import json
import os
from pathlib import Path

from acestep.model_downloader import (
    MAIN_MODEL_COMPONENTS,
    MAIN_MODEL_REPO,
    SUBMODEL_REGISTRY,
)


def _validate_weights(path: Path) -> bool:
    for filename in (
        "model.safetensors", "pytorch_model.bin",
        "diffusion_pytorch_model.safetensors", "diffusion_pytorch_model.bin",
    ):
        weight = path / filename
        if weight.is_file() and weight.stat().st_size > 0:
            return True
        index = path / (filename + ".index.json")
        if not index.is_file():
            continue
        data = json.loads(index.read_text())
        shards = set(data.get("weight_map", {}).values())
        if not shards:
            raise RuntimeError(f"Empty checkpoint index: {index}")
        for shard in shards:
            if not isinstance(shard, str) or Path(shard).name != shard:
                raise RuntimeError(f"Invalid checkpoint shard: {shard!r}")
            file = path / shard
            if not file.is_file() or file.stat().st_size == 0:
                raise RuntimeError(f"Missing checkpoint shard: {file}")
        return True
    return False


def ensure_model_downloaded(model_name: str, checkpoint_dir: str) -> str:
    registry = {name: MAIN_MODEL_REPO for name in MAIN_MODEL_COMPONENTS}
    registry.update(SUBMODEL_REGISTRY)
    if model_name not in registry:
        raise ValueError(f"Unknown checkpoint: {model_name!r}")
    path = Path(checkpoint_dir) / model_name
    if _validate_weights(path):
        return str(path)
    if path.exists() and any(path.iterdir()):
        raise RuntimeError(f"Checkpoint has no weights: {path}")

    source = os.environ.get("ACESTEP_DOWNLOAD_SOURCE", "huggingface").strip().lower()
    repo = registry[model_name]
    unified = repo == MAIN_MODEL_REPO
    destination = Path(checkpoint_dir) if unified else path
    destination.mkdir(parents=True, exist_ok=True)
    patterns = [f"{model_name}/*"] if unified else None
    if source == "huggingface":
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id=repo, local_dir=str(destination), allow_patterns=patterns)
    elif source == "modelscope":
        from modelscope import snapshot_download
        snapshot_download(model_id=repo, local_dir=str(destination), allow_patterns=patterns)
    else:
        raise ValueError(f"Unknown checkpoint download source: {source!r}")
    if not _validate_weights(path):
        raise RuntimeError(f"Downloaded checkpoint has no weights: {path}")
    return str(path)
