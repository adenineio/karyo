"""Decoding the page's audio, the silence gate, and Whisper's prompt."""
import base64

import numpy as np
import pytest
from conftest import CLIPS, load_wav

from jarvis import audio
from jarvis.stt import MAX_PROMPT_CHARS, build_prompt


def test_round_trip_is_float32_little_endian():
    a = np.array([0.0, 0.5, -0.25, 1.0], dtype=np.float32)
    b64 = audio.encode(a)
    assert base64.b64decode(b64) == a.astype("<f4").tobytes()
    assert np.array_equal(audio.decode(b64, 16000), a)


def test_clips_and_nans():
    a = np.array([2.0, -3.0, np.nan, np.inf], dtype=np.float32)
    assert audio.decode(audio.encode(a)).tolist() == [1.0, -1.0, 0.0, 0.0]


def test_resamples_to_16k():
    a = np.sin(np.linspace(0, 100, 48000)).astype(np.float32)  # 1 s at 48 kHz
    out = audio.decode(audio.encode(a), 48000)
    assert out.dtype == np.float32 and len(out) == 16000
    assert abs(float(out[8000]) - float(a[24000])) < 0.01


def test_caps_length():
    a = np.zeros(16000 * (audio.MAX_SECONDS + 5), dtype=np.float32)
    assert len(audio.decode(audio.encode(a))) == 16000 * audio.MAX_SECONDS


@pytest.mark.parametrize("pcm, rate, msg", [
    ("not base64!!", 16000, "base64"),
    (base64.b64encode(b"abc").decode(), 16000, "float32"),
    (audio.encode(np.zeros(4, np.float32)), 100, "sampleRate"),
])
def test_bad_audio(pcm, rate, msg):
    with pytest.raises(audio.AudioError, match=msg):
        audio.decode(pcm, rate)


def test_silence_gate():
    rng = np.random.default_rng(0)
    assert audio.is_silent(np.zeros(32000, np.float32))
    assert audio.is_silent((rng.standard_normal(48000) * 0.02).astype(np.float32))  # steady noise
    assert audio.is_silent(np.full(1000, 0.5, np.float32))  # too short
    quiet = (rng.standard_normal(48000) * 0.002).astype(np.float32)
    quiet[16000:24000] += 0.05 * np.sin(np.arange(8000) / 5)  # soft speech over a low floor
    assert not audio.is_silent(quiet)


@pytest.mark.skipif(not (CLIPS / "c1.wav").exists(), reason="clips not present")
def test_real_clips_pass_the_gate():
    for c in sorted(CLIPS.glob("*.wav")):
        assert not audio.is_silent(load_wav(c)), c.name


def test_prompt():
    p = build_prompt(["Pipeline tools", "Session store", "pipeline tools", ""])
    assert p == "Adenine. Karyo. Jarvis mode. Pipeline tools. Session store."
    assert build_prompt([], "jarvis").startswith("Jarvis. Adenine. Karyo.")
    long = build_prompt([f"Node number {i}" for i in range(500)])
    assert len(long) <= MAX_PROMPT_CHARS and long.startswith("Adenine. Karyo.")
