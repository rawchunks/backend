"""Install reviewed overlays only on the exact pinned ACE-Step source.

This build step validates every source/target before the first write. It is
idempotent on the applied overlay and fails on any unknown upstream edit.
"""

from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path


def install(root: Path, overlay: Path, manifest: Path):
    expected = json.loads(manifest.read_text())
    updates = []
    for relative, source_hash in expected["files"].items():
        source = overlay / relative
        target = root / relative
        if not source.is_file():
            raise RuntimeError(f"Missing overlay: {relative}")
        data = source.read_bytes()
        current = target.read_bytes() if target.exists() else None
        if current == data:
            continue
        if source_hash is None:
            if current is not None:
                raise RuntimeError(f"Unexpected existing module: {relative}")
        elif current is None or hashlib.sha256(current).hexdigest() != source_hash:
            raise RuntimeError(f"Pinned upstream source mismatch: {relative}")
        compile(data, str(target), "exec")
        updates.append((target, data))
    # Full preflight means a drifting anchor never produces a partial patch.
    for target, data in updates:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".rawchunks-tmp")
        temporary.write_bytes(data)
        os.replace(temporary, target)
    return len(updates)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("/app/ACE-Step-1.5"))
    parser.add_argument("--overlay", type=Path, default=Path("/tmp/rawchunks-overlay"))
    parser.add_argument(
        "--manifest", type=Path, default=Path("/tmp/rawchunks-source.json")
    )
    args = parser.parse_args()
    print(
        f"Installed {install(args.root,args.overlay,args.manifest)} ACE-Step worker overlays"
    )
