import sys
import wave
from pathlib import Path

import numpy as np
import pytest

JARVIS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(JARVIS))

CLIPS = JARVIS / ".models" / "clips"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def load_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, path
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return pcm.astype(np.float32) / 32768.0


def voiced(seconds: float = 1.0) -> np.ndarray:
    """A loud tone: passes the silence gate (the fake STT decides the words)."""
    t = np.arange(int(16000 * seconds)) / 16000
    return (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


class FakeSTT:
    """Whisper's stand-in: returns the next canned transcript and records the prompts."""
    device = "fake"

    def __init__(self, *texts: str):
        self.texts = list(texts)
        self.prompts: list[str] = []

    async def transcribe(self, audio, prompt=""):
        self.prompts.append(prompt)
        return self.texts.pop(0) if self.texts else ""


class FakeBrain:
    """The brain's stand-in. `script(hub, text)` plays a turn: captions, actions through hub.perform
    (as the MCP server's POST /action would), then the turn's end."""
    alive = True

    def __init__(self, hub, script=None):
        self.hub, self.script = hub, script
        self.asked: list[str] = []

    async def ask(self, text):
        self.asked.append(text)
        if self.script:
            self.hub.spawn(self.script(self.hub, text))

    async def start(self):
        pass

    async def close(self):
        pass
