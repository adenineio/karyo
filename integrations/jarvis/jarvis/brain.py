"""The brain: one long-lived `claude -p` session in stream-json mode.

Each accepted utterance is one user message on stdin. Stdout events become page messages: text deltas
stream as partial captions, a finished text block is a final caption, tool uses are reported (the
server turns karyo_view actions into activity lines itself, when they reach /action), and the turn's
`result` ends it. The session is sandboxed by its flags: the only built-in tools are Read, Grep and
Glob, the only MCP server is karyo-view, and permission mode dontAsk refuses anything not pre-allowed.
If the process dies it is restarted (with backoff), and the next message goes to the new session.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Protocol

from jarvis.prompt import SYSTEM

log = logging.getLogger("jarvis.brain")

JARVIS_DIR = Path(__file__).resolve().parent.parent
ALLOWED = "mcp__karyo_view__*,Read,Grep,Glob"
BUILTIN_TOOLS = "Read,Grep,Glob"


class Events(Protocol):
    async def brain_caption(self, text: str, final: bool) -> None: ...
    async def brain_tool(self, name: str, args: dict[str, Any]) -> None: ...
    async def brain_turn_end(self, ok: bool, error: str | None) -> None: ...
    async def brain_down(self, message: str) -> None: ...


def mcp_config(server_url: str, python: str = sys.executable) -> dict[str, Any]:
    """The --mcp-config for the karyo-view server: this Python, `-m jarvis mcp --url <server>`."""
    return {"mcpServers": {"karyo_view": {
        "type": "stdio",
        "command": python,
        "args": ["-m", "jarvis", "mcp", "--url", server_url],
        "env": {"PYTHONPATH": str(JARVIS_DIR)},
    }}}


class ClaudeBrain:
    def __init__(self, events: Events, *, project: Path, server_url: str, model: str = "opus",
                 claude: str | list[str] = "claude", effort: str | None = None, extra_args: list[str] | None = None):
        self.events, self.project, self.server_url = events, Path(project), server_url
        self.model, self.claude, self.effort, self.extra = model, claude, effort, list(extra_args or [])
        self.proc: asyncio.subprocess.Process | None = None
        self.in_flight = 0
        self._reader: asyncio.Task | None = None
        self._stderr: asyncio.Task | None = None
        self._err_tail: list[str] = []
        self._partial: dict[int, str] = {}
        self._closing = False
        self._backoff = 1.0
        self._restart: asyncio.Task | None = None
        self._start_lock = asyncio.Lock()

    def command(self) -> list[str]:
        exe = [self.claude] if isinstance(self.claude, str) else list(self.claude)
        cmd = [*exe, "-p",
               "--input-format", "stream-json", "--output-format", "stream-json",
               "--include-partial-messages", "--verbose",
               "--model", self.model,
               "--mcp-config", json.dumps(mcp_config(self.server_url)), "--strict-mcp-config",
               "--tools", BUILTIN_TOOLS,
               "--allowedTools", ALLOWED,
               "--permission-mode", "dontAsk",
               "--setting-sources", "",       # no user/project hooks or plugins in the loop
               "--no-session-persistence",
               "--append-system-prompt", SYSTEM]
        if self.effort:
            cmd += ["--effort", self.effort]
        return cmd + self.extra

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    async def start(self) -> None:
        async with self._start_lock:
            if self.alive:
                return
            self._closing = False
            self._partial.clear()
            self._err_tail.clear()
            self.in_flight = 0
            env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}
            log.info("starting claude (%s) in %s", self.model, self.project)
            self.proc = await asyncio.create_subprocess_exec(
                *self.command(), cwd=str(self.project), env=env, limit=32 * 1024 * 1024,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            self._reader = asyncio.create_task(self._read(self.proc))
            self._stderr = asyncio.create_task(self._read_err(self.proc))

    async def ask(self, text: str) -> None:
        if not self.alive:
            await self.start()
        assert self.proc and self.proc.stdin
        line = {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]},
                "parent_tool_use_id": None}
        self.in_flight += 1
        try:
            self.proc.stdin.write((json.dumps(line) + "\n").encode())
            await self.proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError) as e:
            self.in_flight -= 1
            raise RuntimeError(f"claude isn't running: {e}") from None

    async def reset(self) -> None:
        """Start a fresh conversation (a new page connected: the old view and history are gone)."""
        if self.alive:
            await self.close()
        self.proc = None
        await self.start()

    async def close(self) -> None:
        self._closing = True
        if self._restart:
            self._restart.cancel()
        p = self.proc
        if p and p.returncode is None:
            try:
                if p.stdin:
                    p.stdin.close()
                await asyncio.wait_for(p.wait(), 3)
            except (TimeoutError, Exception):
                p.kill()
                await p.wait()
        for t in (self._reader, self._stderr):
            if t:
                t.cancel()

    # ------------------------------------------------------------ stdout

    async def _read_err(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stderr
        async for raw in proc.stderr:
            line = raw.decode(errors="replace").rstrip()
            if line:
                log.debug("claude stderr: %s", line)
                self._err_tail = (self._err_tail + [line])[-20:]

    async def _read(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout
        try:
            async for raw in proc.stdout:
                try:
                    ev = json.loads(raw)
                except ValueError:
                    continue
                try:
                    await self.handle(ev)
                except Exception:
                    log.exception("handling a claude event")
        finally:
            code = await proc.wait()
            if proc is self.proc and not self._closing:
                tail = " | ".join(self._err_tail[-3:])
                msg = f"claude exited ({code})" + (f": {tail}" if tail else "")
                log.warning(msg)
                if self.in_flight:
                    self.in_flight = 0
                    await self.events.brain_turn_end(False, msg)
                await self.events.brain_down(msg)
                self._restart = asyncio.create_task(self._restart_later())

    async def _restart_later(self) -> None:
        await asyncio.sleep(self._backoff)
        self._backoff = min(self._backoff * 2, 30.0)
        if not self._closing and not self.alive:
            try:
                await self.start()
            except Exception as e:
                log.error("restarting claude failed: %s", e)

    async def handle(self, ev: dict[str, Any]) -> None:
        """One stream-json event (public so tests can feed recorded events)."""
        t = ev.get("type")
        if ev.get("parent_tool_use_id"):
            return  # a subagent's inner stream; the brain has no Task tool, but be safe
        if t == "stream_event":
            e = ev.get("event") or {}
            et, idx = e.get("type"), e.get("index", 0)
            if et == "content_block_start":
                blk = e.get("content_block") or {}
                if blk.get("type") == "text":
                    self._partial[idx] = blk.get("text", "")
            elif et == "content_block_delta":
                d = e.get("delta") or {}
                if d.get("type") == "text_delta" and idx in self._partial:
                    self._partial[idx] += d.get("text", "")
                    if self._partial[idx].strip():
                        await self.events.brain_caption(self._partial[idx].strip(), False)
            elif et == "message_start":
                self._partial.clear()
        elif t == "assistant":
            for blk in (ev.get("message") or {}).get("content") or []:
                if blk.get("type") == "text" and blk.get("text", "").strip():
                    await self.events.brain_caption(blk["text"].strip(), True)
                elif blk.get("type") == "tool_use":
                    await self.events.brain_tool(blk.get("name", ""), blk.get("input") or {})
        elif t == "result":
            self.in_flight = max(0, self.in_flight - 1)
            err = None
            if ev.get("is_error"):
                err = str(ev.get("result") or ev.get("subtype") or "error")
            else:
                self._backoff = 1.0
            await self.events.brain_turn_end(err is None, err)
