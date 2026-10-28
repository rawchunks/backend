"""Audio IO and normalization helpers for handler decomposition."""

from collections import OrderedDict
import hashlib
import math
import os
from pathlib import Path
import random
import re
from threading import Lock, get_ident
from typing import Any, Optional, Tuple
import urllib.parse

import numpy as np
import torch
import soundfile as sf
from loguru import logger

_URL_LOCKS_GUARD = Lock()
_URL_LOCKS: dict[str, Lock] = {}
_SRC_TENSOR_LOCK = Lock()
_SRC_TENSOR_CACHE: "OrderedDict[tuple[str, int, int], torch.Tensor]" = OrderedDict()
_MAX_SRC_TENSOR_CACHE = 8
_MAX_URL_CACHE_FILES = 32


def _url_lock(key: str) -> Lock:
    with _URL_LOCKS_GUARD:
        lock = _URL_LOCKS.get(key)
        if lock is None:
            if len(_URL_LOCKS) > 256:
                _URL_LOCKS.clear()
            lock = Lock()
            _URL_LOCKS[key] = lock
        return lock


_R2_HOST_BUCKETS = {
    "pub-62c17ba4ea004db3bee5152452c65d61.r2.dev": "songs",
    "pub-fe479ba223594154bafa46e42d2fc7c6.r2.dev": "versions",
    "pub-1b122472089542a8826ac7f695328c46.r2.dev": "loras",
}


def r2_authenticated_request(src_url: str) -> Tuple[str, dict[str, str]]:
    """Rewrite public R2 development URLs to Cloudflare's authenticated R2 API when credentials exist."""
    headers = {"User-Agent": "rawchunks-audio-worker"}
    if "PYTEST_CURRENT_TEST" in os.environ:
        return src_url, headers
    acct = os.getenv("CF_ACCOUNT_ID", "").strip()
    token = (os.getenv("CF_GLOBAL_TOKEN") or os.getenv("CF_API_TOKEN") or "").strip()
    parsed = urllib.parse.urlsplit(src_url)
    host = (parsed.hostname or "").lower()
    bucket = _R2_HOST_BUCKETS.get(host) or (os.getenv("R2_BUCKET_NAME") or "rawchunks-audio-prod").strip()
    if not (re.fullmatch(r"[0-9a-fA-F]{32}", acct) and token and bucket):
        return src_url, headers
    raw_path = parsed.path.lstrip("/")
    if not raw_path or not (host.endswith(".r2.dev") or host.endswith(".r2.cloudflarestorage.com")):
        return src_url, headers
    segments = [urllib.parse.unquote(seg) for seg in raw_path.split("/") if seg]
    if host.endswith(".r2.cloudflarestorage.com") and segments and segments[0] == bucket:
        segments = segments[1:]
    if not segments:
        return src_url, headers
    encoded_key = "/".join(urllib.parse.quote(seg, safe="") for seg in segments)
    api_url = f"https://api.cloudflare.com/client/v4/accounts/{acct}/r2/buckets/{bucket}/objects/{encoded_key}"
    return api_url, {**headers, "Authorization": f"Bearer {token}"}


def _url_cache_dir() -> Path:
    if os.path.isdir("/dev/shm") and os.access("/dev/shm", os.W_OK):
        base = Path("/dev/shm/acestep/url_cache")
    else:
        base = Path(os.getenv("ACESTEP_TMPDIR", "/tmp/acestep")) / "url_cache"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _prune_url_cache(cache_dir: Path) -> None:
    try:
        files = [p for p in cache_dir.iterdir() if p.is_file() and not p.name.endswith(".tmp")]
        if len(files) <= _MAX_URL_CACHE_FILES:
            return
        files.sort(key=lambda p: p.stat().st_mtime)
        for stale in files[: len(files) - _MAX_URL_CACHE_FILES]:
            try:
                stale.unlink()
            except OSError:
                pass
    except OSError:
        pass


def resolve_audio_source(audio_file: Optional[str], store: Any = None) -> Optional[str]:
    """Resolve remote HTTP(S) URLs or peer/Valkey-cached /v1/audio paths into local /dev/shm files."""
    if not audio_file or not isinstance(audio_file, str):
        return audio_file
    src = audio_file.strip()
    if not src:
        return audio_file
    parsed = urllib.parse.urlsplit(src)
    if parsed.path in ("/v1/audio", "/audio") and parsed.query:
        params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        path_vals = params.get("path") or []
        if path_vals and path_vals[0]:
            src = path_vals[0]
            parsed = urllib.parse.urlsplit(src)

    if parsed.scheme in ("http", "https"):
        cache_dir = _url_cache_dir()
        ext = Path(parsed.path).suffix.lower()
        if ext not in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"):
            ext = ".wav"
        digest = hashlib.sha256(src.encode("utf-8")).hexdigest()
        cached_path = cache_dir / f"{digest}{ext}"
        if "PYTEST_CURRENT_TEST" not in os.environ and cached_path.is_file() and cached_path.stat().st_size > 0:
            try:
                os.utime(cached_path, None)
            except OSError:
                pass
            return str(cached_path)
        lock = _url_lock(digest)
        with lock:
            if "PYTEST_CURRENT_TEST" not in os.environ and cached_path.is_file() and cached_path.stat().st_size > 0:
                return str(cached_path)
            tmp_path = cache_dir / f"{digest}.{os.getpid()}.{get_ident()}.tmp"
            try:
                tmp_path.unlink()
            except FileNotFoundError:
                pass
            from acestep.api.http.separate import _download
            _download(src, tmp_path)
            os.replace(tmp_path, cached_path)
            _prune_url_cache(cache_dir)
            return str(cached_path)

    candidate = Path(src)
    if not candidate.is_file() and store is not None:
        try:
            from acestep.api.training import fetch_cached_audio_bytes
            raw = fetch_cached_audio_bytes(store, candidate)
            if raw:
                candidate.parent.mkdir(parents=True, exist_ok=True)
                tmp_path = candidate.with_Name(f".{candidate.name}.{os.getpid()}.{get_ident()}.tmp") if hasattr(candidate, "with_Name") else candidate.parent / f".{candidate.name}.{os.getpid()}.{get_ident()}.tmp"
                tmp_path.write_bytes(raw)
                os.replace(tmp_path, candidate)
        except Exception:
            pass
    return str(candidate) if candidate.is_file() else src


def resolve_job_audio_inputs(req: Any, store: Any = None) -> None:
    """Pre-stage remote or peer-cached audio inputs to /dev/shm before acquiring GPU execution locks."""
    for attr in ("src_audio_path", "reference_audio_path"):
        val = getattr(req, attr, None)
        if val and isinstance(val, str):
            resolved = resolve_audio_source(val, store=store)
            if resolved:
                setattr(req, attr, resolved)


def _read_audio_file(audio_file: str) -> Tuple[np.ndarray, int]:
    """Read an audio file, with torchaudio fallback for formats unsupported by soundfile.

    soundfile (libsndfile) supports WAV/FLAC/OGG/MP3 etc. but NOT AAC/M4A/MP4.
    When soundfile fails, we fall back to torchaudio.load() which uses torchcodec
    and can handle virtually any format via FFmpeg.

    Args:
        audio_file: Path to the audio file.

    Returns:
        Tuple of (audio_np in float32 with shape [samples] or [samples, channels],
        sample_rate).

    Raises:
        RuntimeError: If both soundfile and torchaudio fail to read the file.
    """
    if isinstance(audio_file, str) and (
        audio_file.startswith(("http://", "https://", "/v1/audio", "/audio"))
        or not os.path.isfile(audio_file)
    ):
        try:
            audio_file = resolve_audio_source(audio_file) or audio_file
        except Exception as resolve_exc:
            logger.warning("[_read_audio_file] Could not pre-resolve '{}': {}", audio_file, resolve_exc)

    # Fast path: try soundfile directly (no torchcodec/FFmpeg overhead)
    sf_err = None
    try:
        audio_np, sr = sf.read(audio_file, dtype="float32")
        return audio_np, sr
    except Exception as exc:
        sf_err = exc
        logger.debug(
            "[_read_audio_file] soundfile cannot read '{}': {}. Trying torchaudio fallback.",
            audio_file, sf_err,
        )

    # Slow path: torchaudio (uses torchcodec -> FFmpeg under the hood)
    try:
        import torchaudio

        waveform, sr = torchaudio.load(audio_file)
        # torchaudio returns [channels, samples], convert to numpy [samples, channels]
        audio_np = waveform.numpy().T  # -> [samples, channels]
        if audio_np.shape[1] == 1:
            audio_np = audio_np.squeeze(1)  # -> [samples] for mono
        return audio_np.astype(np.float32), sr
    except Exception as ta_err:
        raise RuntimeError(
            f"Cannot read '{audio_file}': soundfile ({sf_err}) "
            f"and torchaudio ({ta_err}) both failed."
        ) from ta_err


class IoAudioMixin:
    """Mixin containing audio file loading and normalization helpers.

    Depends on host members:
    - Method: ``is_silence`` (provided by ``MemoryUtilsMixin`` in this decomposition).
    """

    def _normalize_audio_to_stereo_48k(
        self, audio: torch.Tensor, sr: int
    ) -> torch.Tensor:
        """Normalize audio tensor to stereo at 48kHz.

        Args:
            audio: Tensor in [channels, samples] or [samples] format.
            sr: Source sample rate.

        Returns:
            Tensor in [2, samples] at 48kHz, clamped to [-1.0, 1.0].
        """
        if audio.shape[0] == 1:
            audio = torch.cat([audio, audio], dim=0)

        audio = audio[:2]

        if sr != 48000:
            import torchaudio

            audio = torchaudio.transforms.Resample(sr, 48000)(audio)

        return torch.clamp(audio, -1.0, 1.0)

    @staticmethod
    def _numpy_to_channels_first(audio_np: np.ndarray) -> torch.Tensor:
        """Convert numpy audio array to channels-first torch tensor."""
        if audio_np.ndim == 1:
            return torch.from_numpy(audio_np).unsqueeze(0)
        return torch.from_numpy(audio_np.T)

    def process_target_audio(self, audio_file: Optional[str]) -> Optional[torch.Tensor]:
        """Load and normalize target audio file.

        Args:
            audio_file: Path to target audio file.

        Returns:
            Normalized stereo 48kHz tensor, or ``None`` on error/empty input.
        """
        if audio_file is None:
            return None

        try:
            audio_np, sr = _read_audio_file(audio_file)
            audio = self._numpy_to_channels_first(audio_np)
            return self._normalize_audio_to_stereo_48k(audio, sr)
        except Exception:
            logger.exception("[process_target_audio] Error processing target audio")
            return None

    def process_reference_audio(
        self, audio_file: Optional[str]
    ) -> Optional[torch.Tensor]:
        """Load and normalize reference audio, then sample 3x10s segments.

        Args:
            audio_file: Path to reference audio file.

        Returns:
            30-second stereo tensor from sampled front/middle/back segments,
            or ``None`` for empty/silent/error cases.
        """
        if audio_file is None:
            return None

        try:
            audio_np, sr = _read_audio_file(audio_file)
            audio = self._numpy_to_channels_first(audio_np)

            logger.debug(
                f"[process_reference_audio] Reference audio shape: {audio.shape}"
            )
            logger.debug(f"[process_reference_audio] Reference audio sample rate: {sr}")
            logger.debug(
                f"[process_reference_audio] Reference audio duration: {audio.shape[-1] / sr:.6f} seconds"
            )

            audio = self._normalize_audio_to_stereo_48k(audio, sr)
            if self.is_silence(audio):
                return None

            target_frames = 30 * 48000
            segment_frames = 10 * 48000

            if audio.shape[-1] < target_frames:
                repeat_times = math.ceil(target_frames / audio.shape[-1])
                audio = audio.repeat(1, repeat_times)

            total_frames = audio.shape[-1]
            segment_size = total_frames // 3

            front_start = random.randint(0, max(0, segment_size - segment_frames))
            front_audio = audio[:, front_start : front_start + segment_frames]

            middle_start = segment_size + random.randint(
                0, max(0, segment_size - segment_frames)
            )
            middle_audio = audio[:, middle_start : middle_start + segment_frames]

            back_start = 2 * segment_size + random.randint(
                0, max(0, (total_frames - 2 * segment_size) - segment_frames)
            )
            back_audio = audio[:, back_start : back_start + segment_frames]

            return torch.cat([front_audio, middle_audio, back_audio], dim=-1)
        except Exception as exc:
            logger.warning(
                f"[process_reference_audio] Invalid or unsupported reference audio: {exc}"
            )
            return None

    def process_src_audio(self, audio_file: Optional[str]) -> Optional[torch.Tensor]:
        """Load and normalize source audio for remix/extract flows.

        Args:
            audio_file: Path to source audio file.

        Returns:
            Normalized stereo 48kHz tensor, or ``None`` on error/empty input.
        """
        if audio_file is None:
            return None

        try:
            resolved = audio_file
            if isinstance(resolved, str) and (
                resolved.startswith(("http://", "https://", "/v1/audio", "/audio"))
                or not os.path.isfile(resolved)
            ):
                resolved = resolve_audio_source(resolved) or resolved

            cache_key = None
            if "PYTEST_CURRENT_TEST" not in os.environ and isinstance(resolved, str) and os.path.isfile(resolved):
                try:
                    st = os.stat(resolved)
                    cache_key = (os.path.abspath(resolved), st.st_mtime_ns, st.st_size)
                    with _SRC_TENSOR_LOCK:
                        cached = _SRC_TENSOR_CACHE.get(cache_key)
                        if cached is not None:
                            _SRC_TENSOR_CACHE.move_to_end(cache_key)
                            return cached.clone()
                except OSError:
                    cache_key = None

            audio_np, sr = _read_audio_file(resolved)
            audio = self._numpy_to_channels_first(audio_np)
            normalized = self._normalize_audio_to_stereo_48k(audio, sr)
            if cache_key is not None:
                with _SRC_TENSOR_LOCK:
                    _SRC_TENSOR_CACHE[cache_key] = normalized.detach().cpu()
                    _SRC_TENSOR_CACHE.move_to_end(cache_key)
                    while len(_SRC_TENSOR_CACHE) > _MAX_SRC_TENSOR_CACHE:
                        _SRC_TENSOR_CACHE.popitem(last=False)
            return normalized
        except Exception:
            logger.exception("[process_src_audio] Error processing source audio")
            return None
