"""The Jarvis server: the page's WebSocket, Whisper, the fast path, the brain, and the loopback HTTP the
karyo-view MCP server calls. Bound to 127.0.0.1; see docs/JARVIS.md for the protocol.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
import uuid
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

from jarvis import audio, fastpath
from jarvis.stt import build_prompt
from jarvis.wake import match as wake_match

log = logging.getLogger("jarvis.server")
tlog = logging.getLogger("jarvis.turn")  # one line per step of a turn, at INFO (docs/JARVIS.md "Turn log")


def _q(text: str, limit: int = 300) -> str:
    """Quoted, one line, cut at `limit`."""
    t = " ".join(str(text).split())
    return json.dumps(t if len(t) <= limit else t[:limit] + "…", ensure_ascii=False)


@dataclass
class TurnLog:
    """What the log says about one brain turn: when it started, its actions, lookups and caption."""
    n: int
    text: str
    t0: float = field(default_factory=time.monotonic)
    first_action: float | None = None
    first_caption: float | None = None
    actions: int = 0
    failed: int = 0
    lookups: int = 0
    caption: str = ""

    def at(self) -> float:
        return time.monotonic() - self.t0

SPLICE_ACTIONS = {"splice_open", "splice_add", "splice_group", "splice_connect", "splice_disconnect", "splice_remove", "splice_replace", "splice_rename",
                  "splice_move", "splice_undo", "splice_redo", "splice_save", "splice_discard", "splice_leave", "splice_list",
                  "splice_stack", "splice_stack_open", "splice_stack_return", "splice_stack_leave", "splice_stack_conflict",
                  "splice_stack_swap", "splice_stack_same"}
ACTIONS = {"focus", "open", "close", "drill", "back", "highlight", "clear", "show_details", "scroll", "step", "select",
           "theater", "fan", "bench", "pin_inspector", "zoom", "pan", "groups"} | SPLICE_ACTIONS
ACTION_TIMEOUT = 10.0
DEFAULT_SETTINGS = {"wakeWord": "adenine", "wakeEnabled": False}
MIN_COMMAND_CHARS = 2
SNAPSHOT_IN_PROMPT = 4000  # chars of view JSON sent along with an utterance when it changed

_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}


def origin_ok(origin: str | None, extra: set[str]) -> bool:
    """No Origin (a local tool, the MCP server, tests) or a loopback page. A web page on another host
    must not reach a session that reads the project."""
    if not origin:
        return True
    if origin in extra:
        return True
    u = urlsplit(origin)
    return u.scheme in ("http", "https") and (u.hostname or "") in _LOOPBACK_HOSTS


def describe(name: str, args: dict[str, Any]) -> str:
    """A one-line activity for an action that went through: 'focused Orders store'."""
    a = args or {}
    match name:
        case "focus":
            return f"focused {a.get('target', '?')}"
        case "open":
            return f"opened {a.get('node', '?')}"
        case "close":
            return "closed the card"
        case "drill":
            g = str(a.get("group", "?"))
            if g.strip().lower() in ("out", "up", "back", "up a level"):
                return "went up a level"
            if g.strip().lower() in ("top", "all", "all groups", "overview", "the overview", "the top", "groups", "top level"):
                return "went to all groups"
            return f"went into {g}"
        case "groups":
            return "showed every card" if a.get("on") is False else "showed the groups"
        case "back":
            return "went back"
        case "highlight":
            what = [f"tag {a['tag']}"] if a.get("tag") else []
            if a.get("nodes"):
                what.append(", ".join(map(str, a["nodes"])))
            return "highlighted " + (" and ".join(what) or "nothing")
        case "clear":
            return "cleared the view"
        case "show_details":
            what = f"the {a['section']} of " if a.get("section") else "details of "
            item = f" ({a['item']})" if a.get("item") else ""
            return f"showed {what}{a.get('node', '?')}{item}"
        case "scroll":
            to = a.get("to", "down")
            return f"scrolled {to}" if to in ("down", "up") else f"scrolled to {'the ' if to in ('top', 'bottom') else ''}{to}"
        case "step":
            to = a.get("to")
            return {"next": "next step", "prev": "previous step"}.get(to, f"went to step {to}")
        case "select":
            return "cleared the selection" if a.get("index") is None else f"selected #{a.get('index')}"
        case "pin_inspector":
            if a.get("on") is False:
                return "unpinned the inspector"
            side = f" on the {a['side']}" if a.get("side") in ("left", "right") else ""
            lock = {True: " and locked it", False: " and unlocked it"}.get(a.get("lock"), "")
            return f"pinned the inspector{side}{lock}"
        case "splice_open":
            where = f" in {a['group']}" if a.get("group") else ""
            return f"opened a splice{' ' + repr(a['name']) if a.get('name') else ''}{where}"
        case "splice_group":
            att = (f", an outlet of {a['outlet_of']}" if a.get("outlet_of") else f", calling {a['inlet_of']}" if a.get("inlet_of") else "")
            under = f" under {a['parent']}" if a.get("parent") else ""
            return f"proposed the group {a.get('label', '?')}{under}{att}"
        case "splice_add":
            where = (f" between {a['between'][0]} and {a['between'][1]}" if isinstance(a.get("between"), list) and len(a["between"]) == 2
                     else f" before {a['before']}" if a.get("before") else f" after {a['after']}" if a.get("after")
                     else f" next to {a['attach'].get('to', '?')}" if isinstance(a.get("attach"), dict) else "")
            return f"proposed {a.get('label', '?')}{where}"
        case "splice_connect":
            return f"proposed {a.get('from', '?')} → {a.get('to', '?')}"
        case "splice_disconnect":
            return f"proposed removing {a.get('from', '?')} → {a.get('to', '?')}"
        case "splice_remove":
            return f"proposed removing {a.get('node') or ('the group ' + str(a.get('group', '?')))}"
        case "splice_replace":
            return f"proposed replacing {a.get('node', '?')} with {a.get('with', '?')}"
        case "splice_rename":
            return f"proposed renaming {a.get('node') or ('the group ' + str(a.get('group', '?')))} to {a.get('label', '?')}"
        case "splice_move":
            return f"proposed moving {a.get('node', '?')} into {a.get('group', '?')}"
        case "splice_undo":
            return "undid the last proposal"
        case "splice_redo":
            return "redid the proposal"
        case "splice_save":
            return f"saved the splice{' as ' + repr(a['name']) if a.get('name') else ''}"
        case "splice_discard":
            return "discarded the splice"
        case "splice_leave":
            return "left the splice (the real view)"
        case "splice_list":
            return "listed the saved splices"
        case "splice_stack":
            names = a.get("splices")
            names = ", ".join(map(str, names)) if isinstance(names, list) else str(names) if names else "the splices"
            return f"{'stacked and combined' if a.get('combine') else 'stacked'} {names}"
        case "splice_stack_open":
            return f"opened slice {a.get('slice', '?')} of the stack on the board"
        case "splice_stack_return":
            return "back to the stack of splices"
        case "splice_stack_leave":
            return "left the stack of splices"
        case "splice_stack_conflict":
            n = a.get("n")
            return "closed the card" if n in (0, None, False, "none", "close") and "n" in a else f"lit item {n if n is not None else 1} and opened its card"
        case "splice_stack_swap":
            return "swapped the combination's order"
        case "splice_stack_same":
            return "treated them as different again" if a.get("same") is False else "treated them as the same thing (this combination only)"
        case "theater" | "fan" | "bench":
            label = {"theater": "theater", "fan": "fan out", "bench": "bench"}[name]
            return f"{label} {'on' if a.get('on') else 'off'}"
    return f"{name} {json.dumps(a)}"


def lookup_activity(name: str, args: dict[str, Any], project: Path) -> str | None:
    """An activity line for a lookup tool (Read/Grep/Glob) the brain used; karyo_view actions are
    reported when they reach /action, so they return None here."""
    def rel(p: str) -> str:
        with contextlib.suppress(ValueError):
            return str(Path(p).resolve().relative_to(project.resolve()))
        return p
    if name == "Read":
        return f"read {rel(str(args.get('file_path', '?')))}"
    if name == "Grep":
        where = f" in {rel(str(args['path']))}" if args.get("path") else ""
        return f"searched for “{args.get('pattern', '?')}”{where}"
    if name == "Glob":
        return f"listed {args.get('pattern', '?')}"
    if name == "mcp__karyo_view__view":
        return "looked at the view"
    return None


class Hub:
    """Everything one server holds: the connected page, its latest hello/settings/view, pending
    actions, and the brain."""

    def __init__(self, *, stt: Any, project: Path, brain_factory: Callable[[Hub], Any] | None = None,
                 allow_origins: set[str] | None = None):
        self.stt, self.project = stt, Path(project)
        self.allow_origins = allow_origins or set()
        self.page: WebSocket | None = None
        self.scene: str | None = None
        self.vocab: list[str] = []
        self.settings: dict[str, Any] = dict(DEFAULT_SETTINGS)
        self.snapshot: dict[str, Any] | None = None
        self._snapshot_sent: str | None = None
        self.pending: dict[str, asyncio.Future] = {}
        self.brain = brain_factory(self) if brain_factory else None
        self.turns = 0          # brain turns in flight
        self._turn_logs: deque[TurnLog] = deque()   # the turns in flight, oldest first (the brain answers in order)
        self._turn_n = 0
        # quick commands (the fast path) since the brain's last turn: it never saw them, so it is told what they did
        self._quick: list[str] = []
        self._stt_took: float | None = None  # the last transcription's duration, for the transcript's log line
        self._send_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task] = set()

    # ------------------------------------------------------------ to the page

    async def send(self, msg: dict[str, Any]) -> None:
        ws = self.page
        if ws is None:
            return
        try:
            async with self._send_lock:
                await ws.send_json(msg)
        except Exception as e:  # the page went away mid-send
            log.debug("send failed: %s", e)

    async def status(self, state: str, detail: str = "") -> None:
        await self.send({"type": "status", "state": state, "detail": detail})

    async def idle_or_thinking(self) -> None:
        await (self.status("thinking") if self.turns else self.status("idle"))

    def spawn(self, coro) -> None:
        t = asyncio.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    # ------------------------------------------------------------ actions

    async def perform(self, name: str, args: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
        """Send an action to the page and wait (ACTION_TIMEOUT, 10 s) for its action_result."""
        timeout = ACTION_TIMEOUT if timeout is None else timeout
        if name not in ACTIONS:
            return {"ok": False, "error": f"unknown action {name!r}"}
        if self.page is None:
            return {"ok": False, "error": "no Karyo page is connected to Jarvis"}
        aid = uuid.uuid4().hex[:12]
        t_act = time.monotonic()
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[aid] = fut
        await self.status("acting", name)
        await self.send({"type": "action", "id": aid, "name": name, "args": args})
        try:
            res = await asyncio.wait_for(fut, timeout)
        except TimeoutError:
            res = {"ok": False, "error": f"the page didn't answer {name} within {timeout:g} s"}
        finally:
            self.pending.pop(aid, None)
        res = {"id": aid, **res}
        self._log_action(name, args, res, time.monotonic() - t_act)
        if res.get("ok"):
            st = res.get("state") if isinstance(res.get("state"), dict) else {}
            # a splice action's own words say where it went (saved to …, opened the saved splice …)
            note = st.get("spliceNote") if name in ("splice_open", "splice_save", "splice_discard", "splice_leave", "splice_stack_open", "splice_stack_leave", "splice_stack_swap") else None
            await self.send({"type": "activity", "text": note or describe(name, self.labelled(args))})
        else:
            await self.send({"type": "activity", "text": f"couldn't {name}: {res.get('error', 'failed')}"})
        await self.idle_or_thinking()
        return res

    def _log_action(self, name: str, args: dict[str, Any], res: dict[str, Any], took: float) -> None:
        turn = self._turn_logs[0] if self._turn_logs else None
        head = f"turn {turn.n} " if turn else ""
        when = f", at {turn.at():.1f} s" if turn else ""
        if turn:
            turn.actions += 1
            if turn.first_action is None:
                turn.first_action = turn.at()
        if res.get("ok"):
            st = res.get("state") if isinstance(res.get("state"), dict) else {}
            seen = f" visible={_q(st['visible'], 200)}" if st.get("visible") else ""
            sec = f" section={st['section']}" if st.get("section") else ""
            if isinstance(st.get("splice"), dict):
                sp = st["splice"]
                sec += f" splice={_q(sp.get('title', ''), 60)} ops={sp.get('ops')}{' dirty' if sp.get('dirty') else ''}"
            if st.get("spliceNote"):
                sec += f" note={_q(st['spliceNote'], 200)}"
            tlog.info("%saction %s %s → ok%s%s (%.2f s%s)", head, name, json.dumps(args, ensure_ascii=False), sec, seen, took, when)
        else:
            if turn:
                turn.failed += 1
            tlog.info("%saction %s %s → error %s (%.2f s%s)", head, name, json.dumps(args, ensure_ascii=False), _q(res.get("error", "failed"), 400), took, when)

    def labelled(self, args: dict[str, Any]) -> dict[str, Any]:
        """Args with ids swapped for their labels, where the view knows them (for activity lines)."""
        labels: dict[str, str] = {}

        def walk(x: Any) -> None:
            if isinstance(x, dict):
                if isinstance(x.get("id"), str) and isinstance(x.get("label"), str):
                    labels.setdefault(x["id"], x["label"])
                for v in x.values():
                    walk(v)
            elif isinstance(x, list):
                for v in x:
                    walk(v)
        walk(self.snapshot)
        swap = lambda v: labels.get(v, v) if isinstance(v, str) else v
        return {k: ([swap(i) for i in v] if isinstance(v, list) else swap(v)) for k, v in args.items()}

    # ------------------------------------------------------------ from the page

    async def connect(self, ws: WebSocket) -> None:
        old, self.page = self.page, ws
        if old is not None:
            with contextlib.suppress(Exception):
                await old.close(code=4000, reason="another Jarvis page connected")
        self._fail_pending("the page reconnected")

    def disconnect(self, ws: WebSocket) -> None:
        if self.page is ws:
            self.page = None
            self._fail_pending("the page disconnected")

    def _fail_pending(self, why: str) -> None:
        for fut in self.pending.values():
            if not fut.done():
                fut.set_result({"ok": False, "error": why})

    async def handle(self, msg: dict[str, Any]) -> None:
        t = msg.get("type")
        if t == "hello":
            self.scene = msg.get("scene")
            self.vocab = [str(v) for v in msg.get("vocab") or [] if str(v).strip()]
            self.settings = {**DEFAULT_SETTINGS, **(msg.get("settings") or {})}
            self._snapshot_sent = None
            # a new page is a new conversation: what Claude remembered about the old view no longer exists
            if self.brain is not None and getattr(self.brain, "alive", False) and hasattr(self.brain, "reset"):
                await self.brain.reset()
            await self.status("idle", "connected")
        elif t == "settings":
            self.settings.update(msg.get("settings") or {})
        elif t == "view":
            self.snapshot = msg.get("snapshot")
        elif t == "action_result":
            fut = self.pending.get(str(msg.get("id")))
            if fut and not fut.done():
                res = {"ok": bool(msg.get("ok"))}
                if res["ok"]:
                    res["state"] = msg.get("state")
                else:
                    res["error"] = str(msg.get("error") or "the page refused the action")
                fut.set_result(res)
        elif t == "audio":
            self.spawn(self.on_audio(msg))
        elif t == "text":
            text = str(msg.get("text") or "").strip()
            tlog.info("typed %s", _q(text))
            self.spawn(self.on_command(wake_match(text, self.wake_word).rest if text else ""))
        else:
            await self.send({"type": "error", "message": f"unknown message type {t!r}"})

    @property
    def wake_word(self) -> str:
        return str(self.settings.get("wakeWord") or DEFAULT_SETTINGS["wakeWord"])

    async def on_audio(self, msg: dict[str, Any]) -> None:
        mode = msg.get("mode", "ptt")
        try:
            samples = audio.decode(str(msg.get("pcm") or ""), int(msg.get("sampleRate") or audio.RATE))
        except (audio.AudioError, ValueError) as e:
            await self.send({"type": "error", "message": str(e)})
            return
        if audio.is_silent(samples):
            await self.status("thinking" if self.turns else "idle", "no speech")
            return
        if self.stt is None:
            await self.send({"type": "error", "message": "speech recognition is off on this server"})
            return
        await self.status("transcribing")
        t_stt = time.monotonic()
        try:
            text = await self.stt.transcribe(samples, build_prompt(self.vocab, self.wake_word))
        except Exception as e:
            log.exception("transcription failed")
            await self.send({"type": "error", "message": f"transcription failed: {e}"})
            await self.idle_or_thinking()
            return
        self._stt_took = time.monotonic() - t_stt
        await self.on_transcript(text, mode)

    async def on_transcript(self, text: str, mode: str) -> None:
        text = text.strip()
        if len(text.strip(" .,!?")) < MIN_COMMAND_CHARS:
            await self.idle_or_thinking()
            return
        m = wake_match(text, self.wake_word)
        accepted = (m.wake or mode != "wake") and len(m.rest) >= MIN_COMMAND_CHARS
        took, self._stt_took = self._stt_took, None
        tlog.info("transcript %s accepted=%s wake=%s mode=%s%s", _q(text), accepted, m.wake, mode,
                  f" (whisper {took:.2f} s)" if took is not None else "")
        await self.send({"type": "transcript", "text": text, "wake": m.wake, "accepted": accepted})
        if not accepted:
            await self.idle_or_thinking()
            return
        await self.on_command(m.rest)

    async def on_command(self, text: str) -> None:
        if len(text.strip(" .,!?")) < MIN_COMMAND_CHARS:
            await self.idle_or_thinking()
            return
        hit = fastpath.lookup(text)
        if hit:
            name, args, _ = hit
            tlog.info("fast path %s → %s %s", _q(text), name, json.dumps(args))
            # the last turn's caption is about what was on screen then; the activity line says what this did
            await self.send({"type": "caption", "text": "", "final": True})
            res = await self.perform(name, args)
            st = res.get("state") if isinstance(res, dict) and isinstance(res.get("state"), dict) else {}
            did = (st.get("spliceNote") if res.get("ok") else None) or (describe(name, args) if res.get("ok") else f"failed: {res.get('error', '')}")
            self._quick = [*self._quick, f"{_q(text)} → {did}"][-6:]
            return
        if self.brain is None:
            await self.send({"type": "error", "message": "no brain: only the fast-path commands work"})
            await self.idle_or_thinking()
            return
        self.turns += 1
        self._turn_n += 1
        turn = TurnLog(self._turn_n, text)
        self._turn_logs.append(turn)
        tlog.info("turn %d start %s", turn.n, _q(text))
        await self.status("thinking")
        try:
            await self.brain.ask(self.page_line() + text)
        except Exception as e:
            self.turns = max(0, self.turns - 1)
            with contextlib.suppress(ValueError):
                self._turn_logs.remove(turn)
            tlog.info("turn %d failed to start: %s", turn.n, e)
            await self.send({"type": "error", "message": f"couldn't reach Claude: {e}"})
            await self.idle_or_thinking()

    def page_line(self) -> str:
        """Context for the brain: quick commands run since its last turn, then the view when it changed since the last
        message, else a note."""
        quick = ""
        if self._quick:
            quick = f"[quick commands since your last turn, already done (not by you): {'; '.join(self._quick)}]\n"
            self._quick = []
        return quick + self._view_line()

    def _view_line(self) -> str:
        snap = json.dumps(self.snapshot, separators=(",", ":"), ensure_ascii=False) if self.snapshot is not None else None
        head = f"[page · scene {self.scene or '?'}"
        if snap is None:
            return head + " · no view reported yet; call view]\n"
        if snap == self._snapshot_sent:
            return head + " · view unchanged]\n"
        self._snapshot_sent = snap
        if len(snap) > SNAPSHOT_IN_PROMPT:
            return head + " · the view changed (large); call view]\n"
        return head + f" · view {snap}]\n"

    # ------------------------------------------------------------ brain events

    async def brain_caption(self, text: str, final: bool) -> None:
        turn = self._turn_logs[0] if self._turn_logs else None
        if turn and turn.first_caption is None:
            turn.first_caption = turn.at()
        if final:
            if turn:
                turn.caption = text
            tlog.info("%scaption %s%s", f"turn {turn.n} " if turn else "", _q(text, 1000), f" (at {turn.at():.1f} s)" if turn else "")
        await self.send({"type": "caption", "text": text, "final": final})

    async def brain_tool(self, name: str, args: dict[str, Any]) -> None:
        line = lookup_activity(name, args, self.project)
        turn = self._turn_logs[0] if self._turn_logs else None
        if line and not name.startswith("mcp__karyo_view__"):
            if turn:
                turn.lookups += 1
            tlog.info("%slookup %s", f"turn {turn.n} " if turn else "", line)
        if line:
            await self.send({"type": "activity", "text": line})
        if line:  # karyo_view actions report "acting" themselves, when they reach /action
            await self.status("thinking", line)

    async def brain_turn_end(self, ok: bool, error: str | None) -> None:
        self.turns = max(0, self.turns - 1)
        turn = self._turn_logs.popleft() if self._turn_logs else None
        if turn:
            fa = f"{turn.first_action:.1f} s" if turn.first_action is not None else "none"
            fc = f"{turn.first_caption:.1f} s" if turn.first_caption is not None else "none"
            tlog.info("turn %d end %s: %.1f s total, first action at %s, first caption at %s, %d action(s) (%d failed), %d lookup(s)%s",
                      turn.n, "ok" if ok else f"error {_q(error or 'failed')}", turn.at(), fa, fc, turn.actions, turn.failed, turn.lookups,
                      "" if turn.caption else ", no caption")
        if not ok:
            await self.send({"type": "error", "message": error or "Claude's turn failed"})
        await self.idle_or_thinking()

    async def brain_down(self, message: str) -> None:
        self.turns = 0
        for t in self._turn_logs:
            tlog.info("turn %d lost: %s", t.n, message)
        self._turn_logs.clear()
        await self.send({"type": "error", "message": f"{message}; restarting"})
        await self.status("idle")


def build_app(hub: Hub) -> Starlette:
    async def ws_endpoint(ws: WebSocket) -> None:
        if not origin_ok(ws.headers.get("origin"), hub.allow_origins):
            await ws.close(code=1008, reason="origin not allowed")
            return
        await ws.accept()
        await hub.connect(ws)
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                    if not isinstance(msg, dict):
                        raise ValueError("not an object")
                except ValueError as e:
                    await hub.send({"type": "error", "message": f"bad message: {e}"})
                    continue
                await hub.handle(msg)
        except WebSocketDisconnect:
            pass
        finally:
            hub.disconnect(ws)

    def guard(req: Request) -> JSONResponse | None:
        host = req.client.host if req.client else ""
        if host not in ("127.0.0.1", "::1", "localhost", "testclient"):
            return JSONResponse({"ok": False, "error": "loopback only"}, status_code=403)
        if not origin_ok(req.headers.get("origin"), hub.allow_origins):
            return JSONResponse({"ok": False, "error": "origin not allowed"}, status_code=403)
        return None

    async def action(req: Request) -> JSONResponse:
        if (bad := guard(req)) is not None:
            return bad
        if not re.match(r"application/json\b", req.headers.get("content-type", "")):
            return JSONResponse({"ok": False, "error": "send application/json"}, status_code=415)
        try:
            body = await req.json()
            name, args = str(body["name"]), body.get("args") or {}
            if not isinstance(args, dict):
                raise ValueError("args must be an object")
        except (ValueError, KeyError, TypeError) as e:
            return JSONResponse({"ok": False, "error": f"bad request: {e}"}, status_code=400)
        if name not in ACTIONS:
            return JSONResponse({"ok": False, "error": f"unknown action {name!r}"}, status_code=400)
        return JSONResponse(await hub.perform(name, args))

    async def view(req: Request) -> JSONResponse:
        if (bad := guard(req)) is not None:
            return bad
        return JSONResponse({"connected": hub.page is not None, "scene": hub.scene, "snapshot": hub.snapshot})

    async def health(req: Request) -> JSONResponse:
        return JSONResponse({"ok": True, "page": hub.page is not None,
                             "whisper": getattr(hub.stt, "device", None), "brain": bool(hub.brain and hub.brain.alive)})

    return Starlette(routes=[WebSocketRoute("/ws", ws_endpoint), Route("/action", action, methods=["POST"]),
                             Route("/view", view, methods=["GET"]), Route("/health", health, methods=["GET"])])
