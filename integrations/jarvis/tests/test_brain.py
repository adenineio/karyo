"""The brain: its sandboxed command line, stream-json parsing, and restarting a dead process (against
a fake claude that speaks stream-json)."""
import asyncio
import json
import sys
from pathlib import Path

import pytest

from jarvis.brain import ClaudeBrain, mcp_config

pytestmark = pytest.mark.anyio
FAKE = [sys.executable, str(Path(__file__).parent / "fake_claude.py")]


class Recorder:
    def __init__(self):
        self.events: list[tuple] = []
        self.turn_ended = asyncio.Event()
        self.down = asyncio.Event()

    async def brain_caption(self, text, final):
        self.events.append(("caption", text, final))

    async def brain_tool(self, name, args):
        self.events.append(("tool", name, args))

    async def brain_turn_end(self, ok, error):
        self.events.append(("end", ok, error))
        self.turn_ended.set()

    async def brain_down(self, message):
        self.events.append(("down", message))
        self.down.set()


def test_command_is_sandboxed(tmp_path):
    b = ClaudeBrain(Recorder(), project=tmp_path, server_url="http://127.0.0.1:5190")
    cmd = b.command()
    flag = lambda f: cmd[cmd.index(f) + 1]
    assert cmd[:2] == ["claude", "-p"]
    assert flag("--input-format") == flag("--output-format") == "stream-json"
    assert "--include-partial-messages" in cmd and "--strict-mcp-config" in cmd
    assert flag("--model") == "opus"
    assert flag("--tools") == "Read,Grep,Glob"
    assert flag("--allowedTools") == "mcp__karyo_view__*,Read,Grep,Glob"
    assert flag("--permission-mode") == "dontAsk"
    assert "karyo_view tools" in flag("--append-system-prompt")
    cfg = json.loads(flag("--mcp-config"))
    srv = cfg["mcpServers"]["karyo_view"]
    assert srv["args"] == ["-m", "jarvis", "mcp", "--url", "http://127.0.0.1:5190"]
    assert Path(srv["env"]["PYTHONPATH"], "jarvis", "view_mcp.py").exists()
    assert mcp_config("http://x")["mcpServers"]["karyo_view"]["command"] == sys.executable


async def test_stream_events_become_captions_and_tools(tmp_path):
    r = Recorder()
    b = ClaudeBrain(r, project=tmp_path, server_url="http://x")
    b.in_flight = 1
    for ev in [
        {"type": "system", "subtype": "init"},
        {"type": "stream_event", "event": {"type": "message_start", "message": {}}},
        {"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}},
        {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "hmm"}}},
        {"type": "stream_event", "event": {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}},
        {"type": "stream_event", "event": {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "It "}}},
        {"type": "stream_event", "event": {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "reads."}}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "It reads."}]}, "parent_tool_use_id": None},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "/a"}}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "inner"}]}, "parent_tool_use_id": "toolu_1"},
        {"type": "result", "is_error": False, "result": "It reads."},
    ]:
        await b.handle(ev)
    assert r.events == [("caption", "It", False), ("caption", "It reads.", False), ("caption", "It reads.", True),
                        ("tool", "Read", {"file_path": "/a"}), ("end", True, None)]
    assert b.in_flight == 0
    await b.handle({"type": "result", "is_error": True, "result": "overloaded"})
    assert r.events[-1] == ("end", False, "overloaded")


async def test_process_turns_and_restart(tmp_path, monkeypatch):
    argv = tmp_path / "argv.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_ARGV", str(argv))
    r = Recorder()
    b = ClaudeBrain(r, project=tmp_path, server_url="http://127.0.0.1:5190", claude=FAKE)
    b._backoff = 0.05
    try:
        await b.start()
        await b.ask("please focus the pipeline")
        await asyncio.wait_for(r.turn_ended.wait(), 10)
        assert ("tool", "mcp__karyo_view__focus", {"target": "Pipeline tools"}) in r.events
        assert ("caption", "You said: please focus the pipeline", True) in r.events
        assert ("caption", "You", False) in r.events and r.events[-1] == ("end", True, None)

        r.turn_ended.clear()
        await b.ask("die now")
        await asyncio.wait_for(r.down.wait(), 10)
        assert r.events[-2][0] == "end" and r.events[-2][1] is False and "exited (3)" in r.events[-2][2]
        assert r.events[-1][0] == "down"
        for _ in range(100):  # restarted with backoff
            if b.alive:
                break
            await asyncio.sleep(0.05)
        assert b.alive
        r.turn_ended.clear()
        await b.ask("still there?")
        await asyncio.wait_for(r.turn_ended.wait(), 10)
        assert ("caption", "You said: still there?", True) in r.events
    finally:
        await b.close()
    runs = [json.loads(l) for l in argv.read_text().splitlines()]
    assert len(runs) == 2 and all(run["cwd"] == str(tmp_path.resolve()) or run["cwd"] == str(tmp_path) for run in runs)
    assert "--strict-mcp-config" in runs[0]["argv"]
