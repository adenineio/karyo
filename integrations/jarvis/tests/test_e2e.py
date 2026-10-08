"""End to end, opt-in (JARVIS_E2E=1; costs one turn of the brain's model): a recorded utterance (.models/clips/c1.wav)
through the real server, official Whisper and a real `claude -p` brain, whose karyo-view MCP server
drives a fake page that accepts every action and records it.

    JARVIS_E2E=1 uv run pytest -s -m e2e
"""
import asyncio
import json
import os
import shutil
import socket
import time

import pytest
from conftest import CLIPS, JARVIS, load_wav

from jarvis import audio

REPO = JARVIS.parents[1]

pytestmark = [
    pytest.mark.e2e,
    pytest.mark.anyio,
    pytest.mark.skipif(os.environ.get("JARVIS_E2E") != "1", reason="set JARVIS_E2E=1 (real Whisper + real claude -p)"),
    pytest.mark.skipif(not (CLIPS / "c1.wav").exists() or not (JARVIS / ".models/large-v3-turbo.pt").exists(),
                       reason="needs .models/large-v3-turbo.pt and .models/clips/c1.wav"),
    pytest.mark.skipif(shutil.which("claude") is None, reason="needs the claude CLI"),
]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def board_snapshot() -> dict:
    """What a structure board would report: its readable nodes, groups and tags (a small invented order system
    with a pipeline group, which the recorded clip asks about)."""
    nodes = [
        {"id": "api.checkout", "label": "Checkout", "group": "api", "kind": "service", "tags": ["entry"]},
        {"id": "pipeline.validate", "label": "Validate order", "group": "pipeline", "kind": "function", "tags": []},
        {"id": "pipeline.price", "label": "Price order", "group": "pipeline", "kind": "function", "tags": []},
        {"id": "pipeline.runner", "label": "Pipeline runner", "group": "pipeline", "kind": "service", "tags": []},
        {"id": "orders.store", "label": "Orders store", "group": "storage", "kind": "store", "tags": ["state"]},
        {"id": "billing.charge", "label": "Charge card", "group": "billing", "kind": "function", "tags": ["external"]},
    ]
    groups = sorted({n["group"] for n in nodes})
    tags = sorted({t for n in nodes for t in n["tags"]})
    return {"plate": "board", "title": "orders", "nodes": nodes, "groups": [{"id": g, "label": g} for g in groups],
            "tags": [{"id": t, "label": t} for t in tags], "selection": None, "open": None}


async def test_clip_through_whisper_and_claude():
    import uvicorn
    from websockets.asyncio.client import connect

    from jarvis.brain import ClaudeBrain
    from jarvis.server import Hub, build_app
    from jarvis.stt import Whisper

    port = free_port()
    url = f"http://127.0.0.1:{port}"
    stt = Whisper()
    await asyncio.to_thread(stt.load)
    hub = Hub(stt=stt, project=REPO,
              brain_factory=lambda h: ClaudeBrain(h, project=REPO, server_url=url, model=os.environ.get("JARVIS_E2E_MODEL", "opus")))
    server = uvicorn.Server(uvicorn.Config(build_app(hub), host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    serving = asyncio.create_task(server.serve())
    snap = board_snapshot()
    log: list[dict] = []
    actions: list[dict] = []
    try:
        while not server.started:
            await asyncio.sleep(0.05)
        await hub.brain.start()
        async with connect(f"ws://127.0.0.1:{port}/ws", origin="http://localhost:5180", max_size=None) as ws:
            await ws.send(json.dumps({"type": "hello", "scene": "orders-board", "vocab": [n["label"] for n in snap["nodes"]],
                                      "settings": {"wakeWord": "adenine", "wakeEnabled": True}}))
            await ws.send(json.dumps({"type": "view", "snapshot": snap}))
            t0 = time.perf_counter()
            await ws.send(json.dumps({"type": "audio", "mode": "wake", "sampleRate": 16000,
                                      "pcm": audio.encode(load_wav(CLIPS / "c1.wav"))}))
            final_caption = False
            deadline = time.perf_counter() + 240
            while time.perf_counter() < deadline:
                msg = json.loads(await asyncio.wait_for(ws.recv(), deadline - time.perf_counter()))
                msg["t"] = round(time.perf_counter() - t0, 2)
                log.append(msg)
                if msg["type"] == "action":
                    actions.append({"name": msg["name"], "args": msg["args"]})
                    state = {"focused": msg["args"].get("target")} if msg["name"] == "focus" else {"done": msg["name"]}
                    await ws.send(json.dumps({"type": "action_result", "id": msg["id"], "ok": True, "state": state}))
                elif msg["type"] == "caption" and msg["final"]:
                    final_caption = True
                elif msg["type"] == "status" and msg["state"] == "idle" and final_caption and not hub.turns:
                    break
    finally:
        await hub.brain.close()
        server.should_exit = True
        await serving

    print("\n--- e2e log ---")
    for m in log:
        if m["type"] != "caption" or m["final"]:
            print(json.dumps(m, ensure_ascii=False))
    print("--- actions ---\n" + json.dumps(actions, indent=1))

    transcript = next(m for m in log if m["type"] == "transcript")
    assert transcript["wake"] and transcript["accepted"], transcript
    assert "pipeline" in transcript["text"].lower()
    assert actions, "Claude took no action"
    assert final_caption
    assert not [m for m in log if m["type"] == "error"], [m for m in log if m["type"] == "error"]
