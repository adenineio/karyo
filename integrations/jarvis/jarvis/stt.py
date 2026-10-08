"""Speech to text with OpenAI's official Whisper: the `openai-whisper` package, model "turbo".

`whisper.load_model("turbo", download_root=<models dir>)` fetches large-v3-turbo.pt from OpenAI's CDN only
when it is missing, and checks its SHA-256 against the hash in the official URL either way. No other
source of weights is used. The models dir is integrations/jarvis/.models in a checkout, or $KARYO_WHISPER_MODELS
(the Claude Code plugin sets it to its data dir, so the weights are never part of the plugin itself).
The model loads once (on MPS when available, else CPU) and serves every utterance; transcriptions run
one at a time off the event loop.
"""
from __future__ import annotations

import asyncio
import logging
import os
import threading
from pathlib import Path

import numpy as np

log = logging.getLogger("jarvis.stt")

MODELS = Path(os.environ.get("KARYO_WHISPER_MODELS") or Path(__file__).resolve().parent.parent / ".models")
BASE_PROMPT = ["Adenine", "Karyo", "Jarvis mode"]
MAX_PROMPT_CHARS = 600  # Whisper keeps ~224 prompt tokens


def build_prompt(vocab: list[str], wake_word: str = "adenine") -> str:
    words = [wake_word.strip().title()] + BASE_PROMPT if wake_word.strip() else list(BASE_PROMPT)
    seen: set[str] = set()
    out = ""
    for w in words + [str(v).strip() for v in vocab]:
        if not w or w.lower() in seen:
            continue
        piece = f"{w}. "
        if len(out) + len(piece) > MAX_PROMPT_CHARS:
            break
        seen.add(w.lower())
        out += piece
    return out.strip()


class Whisper:
    """The loaded model. `load()` in a background thread at startup; `transcribe()` waits for it."""

    def __init__(self, model: str = "turbo", download_root: Path = MODELS, device: str | None = None):
        self.name, self.root, self.want_device = model, download_root, device
        self.device = "?"
        self._model = None
        self._ready = threading.Event()
        self._error: BaseException | None = None
        self._lock = threading.Lock()

    def load(self) -> None:
        try:
            import torch
            import whisper

            log.info("loading whisper %s (official: %s) from %s", self.name, whisper._MODELS.get(self.name), self.root)
            # Load on CPU, then move: the official loader builds a sparse tensor MPS can't hold.
            m = whisper.load_model(self.name, device="cpu", download_root=str(self.root))
            dev = self.want_device or ("mps" if torch.backends.mps.is_available() else "cpu")
            if dev != "cpu":
                try:
                    m = m.to(dev)
                    m.transcribe(np.zeros(16000, dtype=np.float32), language="en", fp16=False)  # warm-up
                except Exception as e:  # MPS support in the official package isn't guaranteed
                    log.warning("whisper on %s failed (%s); using CPU", dev, e)
                    m, dev = m.to("cpu"), "cpu"
            self._model, self.device = m, dev
            log.info("whisper ready on %s", dev)
        except BaseException as e:
            self._error = e
            log.exception("whisper failed to load")
        finally:
            self._ready.set()

    def start(self) -> threading.Thread:
        t = threading.Thread(target=self.load, name="whisper-load", daemon=True)
        t.start()
        return t

    def _run(self, audio: np.ndarray, prompt: str) -> dict:
        self._ready.wait()
        if self._model is None:
            raise RuntimeError(f"whisper isn't available: {self._error}")
        with self._lock:
            r = self._model.transcribe(audio, language="en", fp16=False, condition_on_previous_text=False,
                                       initial_prompt=prompt or None, temperature=0.0)
        return r

    async def transcribe(self, audio: np.ndarray, prompt: str = "") -> str:
        r = await asyncio.to_thread(self._run, audio, prompt)
        segs = r.get("segments") or []
        if segs and all(s.get("no_speech_prob", 0) > 0.6 and s.get("avg_logprob", 0) < -1.0 for s in segs):
            return ""
        text = (r.get("text") or "").strip()
        # On near-silence Whisper can echo its prompt back (several of its phrases in a row); that's
        # not speech. One phrase alone ("Orders store.") is a real command, so it stays.
        if prompt and text.count(". ") >= 2 and text.rstrip(".") in prompt:
            return ""
        return text
