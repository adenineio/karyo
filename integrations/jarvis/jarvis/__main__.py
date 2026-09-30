"""`python -m jarvis serve [--port 5190] [--project DIR]` · `python -m jarvis mcp [--url URL]`."""
from __future__ import annotations

import argparse
import contextlib
import logging
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PAGE_URL = os.environ.get("KARYO_JARVIS_PAGE") or "http://localhost:5180/jarvis.html"  # `karyo jarvis` sets it


def serve(args: argparse.Namespace) -> None:
    import uvicorn

    from jarvis.brain import ClaudeBrain
    from jarvis.server import Hub, build_app
    from jarvis.stt import Whisper

    project = Path(args.project).resolve()
    url = f"http://127.0.0.1:{args.port}"
    stt = None if args.no_whisper else Whisper(device=args.device)
    if stt:
        stt.start()

    def brain(hub: Hub) -> ClaudeBrain | None:
        if args.no_brain:
            return None
        return ClaudeBrain(hub, project=project, server_url=url, model=args.model, claude=args.claude, effort=args.effort)

    hub = Hub(stt=stt, project=project, brain_factory=brain, allow_origins=set(args.allow_origin or []))
    app = build_app(hub)

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        if hub.brain:
            await hub.brain.start()
        print(f"Jarvis on ws://127.0.0.1:{args.port}/ws · project {project}\nOpen {PAGE_URL}" + ("" if os.environ.get("KARYO_JARVIS_PAGE") else " (with `just dev` running)"),
              file=sys.stderr, flush=True)
        yield
        if hub.brain:
            await hub.brain.close()

    app.router.lifespan_context = lifespan
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning", ws_max_size=64 * 1024 * 1024)


def mcp(args: argparse.Namespace) -> None:
    from jarvis.view_mcp import build

    build(args.url).run()


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="jarvis", description="Jarvis mode for Karyo (local only).")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="the page's WebSocket, Whisper and the Claude brain, on 127.0.0.1")
    s.add_argument("--port", type=int, default=5190)
    s.add_argument("--project", default=str(REPO), help="the directory Claude reads to answer questions (default: this repo)")
    s.add_argument("--model", default="opus")
    s.add_argument("--effort", default=None, help="claude --effort (low … max); default: Claude Code's")
    s.add_argument("--claude", default="claude", help="the claude executable")
    s.add_argument("--device", default=None, help="torch device for Whisper (default: mps when available, else cpu)")
    s.add_argument("--allow-origin", action="append", help="another page origin allowed to connect (loopback origins always are)")
    s.add_argument("--no-whisper", action="store_true", help="typed commands only")
    s.add_argument("--no-brain", action="store_true", help="fast-path commands only (no claude)")
    s.add_argument("-v", "--verbose", action="store_true")
    s.set_defaults(fn=serve)
    m = sub.add_parser("mcp", help="the karyo-view MCP server (stdio), for the brain")
    m.add_argument("--url", default="http://127.0.0.1:5190", help="the Jarvis server")
    m.set_defaults(fn=mcp)
    args = p.parse_args(argv)
    # stdout belongs to the protocol under `mcp`: log to stderr only
    logging.basicConfig(level=logging.DEBUG if getattr(args, "verbose", False) else logging.INFO, stream=sys.stderr,
                        format="%(asctime)s %(name)s %(message)s")
    args.fn(args)


if __name__ == "__main__":
    main()
