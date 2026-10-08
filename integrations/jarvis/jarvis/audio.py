"""Audio from the page: base64 of float32 little-endian mono samples, resampled to Whisper's 16 kHz."""
from __future__ import annotations

import base64
import binascii

import numpy as np

RATE = 16000
MAX_SECONDS = 60


class AudioError(ValueError):
    pass


def decode(pcm_b64: str, sample_rate: int = RATE) -> np.ndarray:
    """float32 samples at 16 kHz, clipped to [-1, 1] and to MAX_SECONDS."""
    try:
        raw = base64.b64decode(pcm_b64, validate=True)
    except (binascii.Error, ValueError, TypeError) as e:
        raise AudioError(f"pcm is not base64: {e}") from None
    if len(raw) % 4:
        raise AudioError(f"pcm is {len(raw)} bytes, not a whole number of float32 samples")
    if not isinstance(sample_rate, (int, float)) or not 4000 <= sample_rate <= 192000:
        raise AudioError(f"sampleRate {sample_rate!r} is out of range")
    a = np.frombuffer(raw, dtype="<f4").astype(np.float32)
    a = np.nan_to_num(a, nan=0.0, posinf=0.0, neginf=0.0)
    if sample_rate != RATE and len(a):
        n = max(1, round(len(a) * RATE / sample_rate))
        a = np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype(np.float32)
    return np.clip(a[: RATE * MAX_SECONDS], -1.0, 1.0)


def encode(samples: np.ndarray) -> str:
    """The page's encoding, for tests and tools."""
    return base64.b64encode(np.asarray(samples, dtype="<f4").tobytes()).decode()


FRAME = RATE * 30 // 1000   # 30 ms
MIN_VOICED = 7              # frames, about 0.2 s


def is_silent(a: np.ndarray) -> bool:
    """No speech worth transcribing: under 0.2 s of frames that are loud (RMS > 0.03) or well above
    the clip's own noise floor (3× its 10th-percentile RMS, and > 0.01). With a prompt, Whisper turns
    silence and steady noise into a vocabulary word, so this gate runs first."""
    n = len(a) // FRAME
    if n < MIN_VOICED:
        return True
    rms = np.sqrt((a[: n * FRAME].reshape(n, FRAME).astype(np.float64) ** 2).mean(axis=1))
    floor = float(np.percentile(rms, 10))
    loud = int((rms > 0.03).sum())
    above = int(((rms > 3 * floor) & (rms > 0.01)).sum())
    return max(loud, above) < MIN_VOICED
