"""Time OpenAI Whisper (official package + official weights) on this machine.

    uv run python bench.py [clips…]

The model comes from whisper.load_model("turbo"), which fetches OpenAI's own
large-v3-turbo.pt and checks its SHA-256 (the hash in the URL) before use. Audio is fed as
16 kHz float32 samples, so ffmpeg is not needed.
"""
import sys
import time
import wave
from pathlib import Path

import numpy as np
import torch
import whisper

HERE = Path(__file__).parent
MODELS = HERE / ".models"


def load_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, path
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return pcm.astype(np.float32) / 32768.0


def main() -> None:
    clips = [Path(p) for p in sys.argv[1:]] or sorted((MODELS / "clips").glob("*.wav"))
    audio = [(c.name, load_wav(c)) for c in clips]
    print(f"official URL for turbo: {whisper._MODELS['turbo']}")
    t = time.perf_counter()
    model = whisper.load_model("turbo", device="cpu", download_root=str(MODELS))
    print(f"load (download + sha256 check on first run): {time.perf_counter() - t:.1f}s")
    devices = ["cpu"] + (["mps"] if torch.backends.mps.is_available() else [])
    for dev in devices:
        try:
            m = model.to(dev)
            m.transcribe(audio[0][1], language="en", fp16=False)  # warm-up
            for name, a in audio:
                t = time.perf_counter()
                r = m.transcribe(a, language="en", fp16=False, condition_on_previous_text=False)
                dt = time.perf_counter() - t
                print(f"{dev:4} {name}  {len(a) / 16000:4.1f}s audio → {dt:5.2f}s  {r['text'].strip()!r}")
        except Exception as e:  # MPS support in the official package is not guaranteed
            print(f"{dev}: failed — {type(e).__name__}: {str(e).splitlines()[0][:160]}")


if __name__ == "__main__":
    main()
