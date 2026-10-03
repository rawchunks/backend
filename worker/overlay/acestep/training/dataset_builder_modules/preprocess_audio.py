"""Decode complete source audio; never silently shorten or normalize it."""
import math
import subprocess
import tempfile
from pathlib import Path
import soundfile as sf
import torch
import torchaudio


def load_audio_stereo(audio_path: str, target_sample_rate: int, max_duration: float):
    with tempfile.TemporaryDirectory(prefix="acestep-decode-") as directory:
        decoded = Path(directory) / "decoded.wav"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", audio_path,
            "-map", "0:a:0", "-vn", "-c:a", "pcm_f32le", str(decoded)],
            check=True, capture_output=True)
        values, sr = sf.read(str(decoded), dtype="float32", always_2d=True)
    if values.shape[1] not in (1, 2) or values.shape[0] <= 0:
        raise ValueError("Training source must be nonempty mono or stereo audio")
    duration = values.shape[0] / sr
    if not math.isfinite(duration) or duration > max_duration:
        raise ValueError("Training source exceeds max_duration; refusing to truncate")
    audio = torch.from_numpy(values.T.copy())
    if not bool(torch.isfinite(audio).all()):
        raise ValueError("Training source contains nonfinite audio")
    if sr != target_sample_rate:
        audio = torchaudio.transforms.Resample(sr, target_sample_rate)(audio)
    if audio.shape[0] == 1:
        audio = audio.repeat(2, 1)
    return audio, target_sample_rate
