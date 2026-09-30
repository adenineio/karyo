"""The WebSocket protocol against a fake page: hello, text and audio in; status, transcript, action,
activity, caption and error out; /action and /view over loopback HTTP."""
import threading

import pytest
from conftest import FakeBrain, FakeSTT, voiced
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from jarvis import audio
from jarvis.server import Hub, build_app, origin_ok

HELLO = {"type": "hello", "scene": "orders-board", "vocab": ["Pipeline tools", "Session store"],
         "settings": {"wakeWord": "adenine", "wakeEnabled": False}}
SNAP = {"plate": "board", "nodes": [{"id": "pipeline", "label": "Pipeline tools"}], "selection": None}


def make(stt=None, script=None, brain=True):
    brains = []

    def factory(hub):
        b = FakeBrain(hub, script)
        brains.append(b)
        return b
    hub = Hub(stt=stt or FakeSTT(), project=".", brain_factory=factory if brain else None)
    # `with client` (in the tests) runs every request and socket on one event loop, as uvicorn does
    return hub, TestClient(build_app(hub)), brains


def until(ws, kind, limit=20):
    """Messages up to and including the first of type `kind`."""
    got = []
    for _ in range(limit):
        m = ws.receive_json()
        got.append(m)
        if m["type"] == kind:
            return got
    raise AssertionError(f"no {kind} in {got}")


def hello(ws):
    ws.send_json(HELLO)
    assert ws.receive_json() == {"type": "status", "state": "idle", "detail": "connected"}


def test_text_fast_path_acts_without_claude():
    hub, client, brains = make()
    with client.websocket_connect("/ws") as ws:
        hello(ws)
        ws.send_json({"type": "text", "text": "Go back."})
        got = until(ws, "action")
        # the last turn's caption goes (it was about the view before), then the action
        assert got[0] == {"type": "caption", "text": "", "final": True}
        assert got[1] == {"type": "status", "state": "acting", "detail": "back"}
        act = got[-1]
        assert act["name"] == "back" and act["args"] == {} and act["id"]
        ws.send_json({"type": "action_result", "id": act["id"], "ok": True, "state": {"level": 0}})
        assert ws.receive_json() == {"type": "activity", "text": "went back"}
        assert ws.receive_json() == {"type": "status", "state": "idle", "detail": ""}
    assert brains[0].asked == []


def test_fast_path_error_is_reported():
    hub, client, _ = make()
    with client.websocket_connect("/ws") as ws:
        hello(ws)
        ws.send_json({"type": "text", "text": "fan out"})
        act = until(ws, "action")[-1]
        assert act["name"] == "fan" and act["args"] == {"on": True}
        ws.send_json({"type": "action_result", "id": act["id"], "ok": False, "error": "this plate doesn't fan out"})
        assert ws.receive_json() == {"type": "activity", "text": "couldn't fan: this plate doesn't fan out"}


def test_text_goes_to_the_brain_with_the_view():
    async def turn(hub, text):
        await hub.brain_caption("The pipeline", False)
        res = await hub.perform("focus", {"target": "Pipeline tools"})
        assert res["ok"] and res["state"] == {"focused": "pipeline"}
        await hub.brain_caption("The pipeline runs tools.", True)
        await hub.brain_turn_end(True, None)

    hub, client, brains = make(script=turn)
    with client.websocket_connect("/ws") as ws:
        hello(ws)
        ws.send_json({"type": "view", "snapshot": SNAP})
        ws.send_json({"type": "text", "text": "Adenine, what does the pipeline do?"})
        got = until(ws, "action")
        assert {"type": "status", "state": "thinking", "detail": ""} in got
        assert {"type": "caption", "text": "The pipeline", "final": False} in got
        act = got[-1]
        assert act["name"] == "focus" and act["args"] == {"target": "Pipeline tools"}
        ws.send_json({"type": "action_result", "id": act["id"], "ok": True, "state": {"focused": "pipeline"}})
        rest = until(ws, "caption")
        assert {"type": "activity", "text": "focused Pipeline tools"} in rest
        assert rest[-1] == {"type": "caption", "text": "The pipeline runs tools.", "final": True}
        assert ws.receive_json() == {"type": "status", "state": "idle", "detail": ""}
    asked = brains[0].asked[0]
    assert asked.endswith("\nwhat does the pipeline do?")  # wake word stripped
    assert asked.startswith("[page · scene orders-board · view {") and '"Pipeline tools"' in asked


def test_view_is_sent_to_the_brain_only_when_it_changed():
    async def turn(hub, text):
        await hub.brain_turn_end(True, None)
    hub, client, brains = make(script=turn)
    with client.websocket_connect("/ws") as ws:
        hello(ws)
        ws.send_json({"type": "text", "text": "what is this"})
        until(ws, "status"); until(ws, "status")
        ws.send_json({"type": "view", "snapshot": SNAP})
        for _ in range(2):
            ws.send_json({"type": "text", "text": "and this"})
            until(ws, "status"); until(ws, "status")
    a = brains[0].asked
    assert "no view reported yet" in a[0] and '"board"' in a[1] and "view unchanged" in a[2]


def test_audio_ptt_wake_and_silence():
    async def turn(hub, text):
        await hub.brain_turn_end(True, None)
    stt = FakeSTT("Show me the session store.", "Show me the session store.", "Adonine, go back.", "Adenine.")
    hub, client, brains = make(stt=stt, script=turn)
    pcm = audio.encode(voiced())
    with client.websocket_connect("/ws") as ws:
        hello(ws)
        # push-to-talk: no wake word needed
        ws.send_json({"type": "audio", "mode": "ptt", "sampleRate": 16000, "pcm": pcm})
        got = until(ws, "transcript")
        assert got[0] == {"type": "status", "state": "transcribing", "detail": ""}
        assert got[-1] == {"type": "transcript", "text": "Show me the session store.", "wake": False, "accepted": True}
        assert until(ws, "status")[-1]["state"] == "thinking"
        assert until(ws, "status")[-1]["state"] == "idle"
        # wake mode without the wake word: shown, not acted on
        ws.send_json({"type": "audio", "mode": "wake", "sampleRate": 16000, "pcm": pcm})
        got = until(ws, "transcript")
        assert got[-1] == {"type": "transcript", "text": "Show me the session store.", "wake": False, "accepted": False}
        until(ws, "status")
        # wake mode with a misheard wake word → fast path
        ws.send_json({"type": "audio", "mode": "wake", "sampleRate": 16000, "pcm": pcm})
        got = until(ws, "transcript")
        assert got[-1] == {"type": "transcript", "text": "Adonine, go back.", "wake": True, "accepted": True}
        act = until(ws, "action")[-1]
        assert act["name"] == "back"
        ws.send_json({"type": "action_result", "id": act["id"], "ok": True, "state": {}})
        until(ws, "activity")
        until(ws, "status")
        # the wake word alone: heard, nothing to do
        ws.send_json({"type": "audio", "mode": "wake", "sampleRate": 16000, "pcm": pcm})
        got = until(ws, "transcript")
        assert got[-1] == {"type": "transcript", "text": "Adenine.", "wake": True, "accepted": False}
        until(ws, "status")
        # silence never reaches Whisper
        ws.send_json({"type": "audio", "mode": "ptt", "sampleRate": 16000, "pcm": audio.encode(voiced() * 0)})
        assert until(ws, "status")[-1]["detail"] == "no speech"
        # broken audio
        ws.send_json({"type": "audio", "mode": "ptt", "sampleRate": 16000, "pcm": "%%%"})
        assert until(ws, "error")[-1]["message"].startswith("pcm is not base64")
    assert brains[0].asked[0].endswith("\nShow me the session store.") and len(brains[0].asked) == 1
    assert "Pipeline tools. Session store." in stt.prompts[0]


def test_settings_change_the_wake_word():
    stt = FakeSTT("Jarvis, next.", "Adenine, next.")
    hub, client, _ = make(stt=stt)
    pcm = audio.encode(voiced())
    with client.websocket_connect("/ws") as ws:
        hello(ws)
        ws.send_json({"type": "settings", "settings": {"wakeWord": "jarvis", "wakeEnabled": True}})
        ws.send_json({"type": "audio", "mode": "wake", "sampleRate": 16000, "pcm": pcm})
        assert until(ws, "transcript")[-1]["accepted"] is True
        act = until(ws, "action")[-1]
        assert act["name"] == "step" and act["args"] == {"to": "next"}
        ws.send_json({"type": "action_result", "id": act["id"], "ok": True})
        until(ws, "activity")
        ws.send_json({"type": "audio", "mode": "wake", "sampleRate": 16000, "pcm": pcm})
        assert until(ws, "transcript")[-1]["accepted"] is False
    assert hub.settings == {"wakeWord": "jarvis", "wakeEnabled": True}


def test_http_action_and_view_through_the_page():
    hub, client, _ = make()
    with client:
        _http_action_and_view(hub, client)


def _http_action_and_view(hub, client):
    assert client.get("/view").json() == {"connected": False, "scene": None, "snapshot": None}
    r = client.post("/action", json={"name": "focus", "args": {"target": "x"}})
    assert r.json()["ok"] is False and "no Karyo page" in r.json()["error"]
    with client.websocket_connect("/ws") as ws:
        hello(ws)
        ws.send_json({"type": "view", "snapshot": SNAP})
        ws.send_json({"type": "text", "text": "x"})  # too short: ignored, and a sync point for the view
        assert ws.receive_json()["state"] == "idle"
        assert client.get("/view").json() == {"connected": True, "scene": "orders-board", "snapshot": SNAP}
        out = {}
        t = threading.Thread(target=lambda: out.update(r=client.post("/action", json={"name": "highlight", "args": {"tag": "io"}})))
        t.start()
        act = until(ws, "action")[-1]
        assert act["name"] == "highlight" and act["args"] == {"tag": "io"}
        ws.send_json({"type": "action_result", "id": act["id"], "ok": False, "error": "no tag io"})
        t.join(5)
        assert out["r"].json() == {"id": act["id"], "ok": False, "error": "no tag io"}
    assert client.post("/action", json={"name": "rm_rf", "args": {}}).status_code == 400
    assert client.post("/action", content='{"name":"back"}', headers={"content-type": "text/plain"}).status_code == 415
    assert client.post("/action", json={"name": "back"}, headers={"origin": "https://evil.example"}).status_code == 403


def test_action_timeout(monkeypatch):
    monkeypatch.setattr("jarvis.server.ACTION_TIMEOUT", 0.2)
    hub, client, _ = make()
    with client, client.websocket_connect("/ws") as ws:
        hello(ws)
        out = {}
        t = threading.Thread(target=lambda: out.update(r=client.post("/action", json={"name": "clear", "args": {}})))
        t.start()
        until(ws, "action")
        t.join(5)
        assert out["r"].json()["ok"] is False and "didn't answer" in out["r"].json()["error"]


def test_no_brain_and_unknown_messages():
    hub, client, _ = make(brain=False)
    with client.websocket_connect("/ws") as ws:
        hello(ws)
        ws.send_json({"type": "text", "text": "what does this do"})
        assert "no brain" in until(ws, "error")[-1]["message"]
        ws.send_json({"type": "nope"})
        assert until(ws, "error")[-1]["message"] == "unknown message type 'nope'"
        ws.send_text("not json")
        assert until(ws, "error")[-1]["message"].startswith("bad message")


def test_foreign_origins_are_refused():
    hub, client, _ = make()
    with pytest.raises(WebSocketDisconnect), client.websocket_connect("/ws", headers={"origin": "https://evil.example"}) as ws:
        ws.receive_json()
    assert origin_ok("http://localhost:5180", set()) and origin_ok("http://127.0.0.1:5173", set()) and origin_ok(None, set())
    assert not origin_ok("https://localhost.evil.example", set()) and origin_ok("https://x.dev", {"https://x.dev"})


def test_a_new_page_replaces_the_old():
    hub, client, _ = make()
    with client.websocket_connect("/ws") as ws1:
        hello(ws1)
        with client.websocket_connect("/ws") as ws2:
            hello(ws2)
            assert hub.page is not None
            ws2.send_json({"type": "text", "text": "next"})
            assert until(ws2, "action")[-1]["name"] == "step"


def test_activity_lines_use_labels():
    hub, _, _ = make()
    hub.snapshot = {"plate": "board", "nodes": [{"id": "orders.items", "label": "Pipeline tools"}],
                    "groups": [{"id": "pipeline", "label": "Pipeline"}]}
    assert hub.labelled({"node": "orders.items", "nodes": ["pipeline", "x"], "on": True}) == \
        {"node": "Pipeline tools", "nodes": ["Pipeline", "x"], "on": True}
    from jarvis.server import describe, lookup_activity
    assert describe("show_details", hub.labelled({"node": "orders.items"})) == "showed details of Pipeline tools"
    assert describe("show_details", hub.labelled({"node": "orders.items", "section": "schemas"})) == "showed the schemas of Pipeline tools"
    assert describe("show_details", {"node": "Pipeline tools", "section": "tools", "item": "pipeline_run"}) == "showed the tools of Pipeline tools (pipeline_run)"
    assert describe("scroll", {"to": "down"}) == "scrolled down" and describe("scroll", {"to": "top"}) == "scrolled to the top"
    assert describe("scroll", {"to": "pipeline_run"}) == "scrolled to pipeline_run"
    assert describe("highlight", {"tag": "io", "nodes": ["a"]}) == "highlighted tag io and a"
    assert describe("step", {"to": 3}) == "went to step 3" and describe("select", {"index": None}) == "cleared the selection"
    assert describe("pin_inspector", {"on": True}) == "pinned the inspector"
    assert describe("pin_inspector", {"on": True, "side": "left", "lock": True}) == "pinned the inspector on the left and locked it"
    assert describe("pin_inspector", {"on": False}) == "unpinned the inspector"
    assert describe("splice_add", {"label": "Orders cache", "between": ["Checkout", "Pipeline tools"]}) == "proposed Orders cache between Checkout and Pipeline tools"
    assert describe("splice_add", {"label": "Validator", "before": "Pipeline tools"}) == "proposed Validator before Pipeline tools"
    assert describe("splice_connect", {"from": "A", "to": "B"}) == "proposed A → B"
    assert describe("splice_remove", {"node": "Audit log"}) == "proposed removing Audit log"
    assert describe("splice_open", {"name": "caching"}) == "opened a splice 'caching'"
    assert describe("splice_leave", {}) == "left the splice (the real view)"
    assert describe("splice_stack", {}) == "stacked the splices"
    assert describe("splice_stack", {"splices": ["Caching", "Session queue"], "combine": True}) == "stacked and combined Caching, Session queue"
    assert describe("splice_stack_open", {"slice": "queueing"}) == "opened slice queueing of the stack on the board"
    assert describe("splice_stack_return", {}) == "back to the stack of splices"
    assert describe("splice_stack_conflict", {"n": 2}) == "lit item 2 and opened its card"
    assert describe("splice_stack_conflict", {}) == "lit item 1 and opened its card"
    assert describe("splice_stack_conflict", {"n": None}) == "closed the card"
    assert describe("splice_replace", {"node": "Session store", "with": "Session queue"}) == "proposed replacing Session store with Session queue"
    assert describe("splice_stack_swap", {}) == "swapped the combination's order"
    assert describe("splice_stack_same", {"n": 1}) == "treated them as the same thing (this combination only)"
    assert describe("splice_stack_same", {"same": False}) == "treated them as different again"
    assert lookup_activity("Read", {"file_path": str(hub.project.resolve() / "src/x.ts")}, hub.project) == "read src/x.ts"
    assert lookup_activity("mcp__karyo_view__focus", {}, hub.project) is None


def test_a_new_page_starts_a_fresh_conversation():
    """Claude must not carry memories of a view from a page that no longer exists."""
    hub, client, brains = make()
    resets = []

    class Resettable:
        alive = True

        async def reset(self):
            resets.append(1)

        async def ask(self, text):
            pass

    hub.brain = Resettable()
    with client:
        with client.websocket_connect("/ws", headers={"origin": "http://localhost:5180"}) as ws:
            hello(ws)
        with client.websocket_connect("/ws", headers={"origin": "http://localhost:5180"}) as ws:
            hello(ws)
    assert len(resets) == 2


def test_turn_log(caplog):
    """Each turn logs at INFO: the transcript, the turn's start, every action with its args and result (with what the
    page says is visible), the final caption, and the end with timings."""
    import logging

    async def turn(hub, text):
        res = await hub.perform("show_details", {"node": "pipeline", "section": "schemas"})
        assert res["ok"]
        await hub.perform("scroll", {"to": "sideways"})
        await hub.brain_tool("Read", {"file_path": "x.json"})
        await hub.brain_caption("The first two of seven tool schemas are on screen.", True)
        await hub.brain_turn_end(True, None)

    hub, client, _ = make(script=turn)
    caplog.set_level(logging.INFO, logger="jarvis.turn")
    with client.websocket_connect("/ws") as ws:
        hello(ws)
        ws.send_json({"type": "text", "text": "show me the schemas for the pipeline tools"})
        act = until(ws, "action")[-1]
        ws.send_json({"type": "action_result", "id": act["id"], "ok": True,
                      "state": {"open": "pipeline", "section": "tools", "visible": "2 of 7 tools fully visible; scroll for the rest"}})
        act = until(ws, "action")[-1]
        ws.send_json({"type": "action_result", "id": act["id"], "ok": False, "error": "scroll takes down, up, top, bottom"})
        until(ws, "caption")
        assert ws.receive_json() == {"type": "status", "state": "idle", "detail": ""}
    lines = [r.getMessage() for r in caplog.records if r.name == "jarvis.turn"]
    assert lines.pop(0) == 'typed "show me the schemas for the pipeline tools"'
    assert lines[0] == 'turn 1 start "show me the schemas for the pipeline tools"'
    assert lines[1].startswith('turn 1 action show_details {"node": "pipeline", "section": "schemas"} → ok section=tools '
                               'visible="2 of 7 tools fully visible; scroll for the rest" (')
    assert lines[2].startswith('turn 1 action scroll {"to": "sideways"} → error "scroll takes down, up, top, bottom" (')
    assert lines[3] == "turn 1 lookup read x.json"
    assert lines[4].startswith('turn 1 caption "The first two of seven tool schemas are on screen." (at ')
    assert lines[5].startswith("turn 1 end ok: ") and "2 action(s) (1 failed), 1 lookup(s)" in lines[5]


def test_transcript_is_logged(caplog):
    import logging
    hub, client, _ = make(stt=FakeSTT("Adenine, scroll down."), brain=False)
    caplog.set_level(logging.INFO, logger="jarvis.turn")
    with client.websocket_connect("/ws") as ws:
        hello(ws)
        ws.send_json({"type": "audio", "mode": "wake", "sampleRate": 16000, "pcm": audio.encode(voiced())})
        until(ws, "transcript")
    lines = [r.getMessage() for r in caplog.records if r.name == "jarvis.turn"]
    assert lines[0].startswith('transcript "Adenine, scroll down." accepted=True wake=True mode=wake (whisper ')
    assert lines[1].startswith('fast path ') and lines[1].endswith('→ scroll {"to": "down"}')
