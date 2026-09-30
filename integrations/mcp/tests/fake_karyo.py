"""A stand-in for the `karyo` CLI with the same --json contract, so the server's tests run without bun,
Chrome or the explainer core. Components live in $FAKE_KARYO_COMPONENTS (a JSON file), plus a builtin."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from PIL import Image

BUILTIN = {"card": {"name": "card", "source": "builtin", "dir": "/repo/components/card",
                    "description": "A titled card.", "props": {"type": "object", "properties": {"title": {"type": "string"}}},
                    "example": {"component": "card", "props": {"title": "Hello"}}}}


def out(o, code=0):
    print(json.dumps(o))
    sys.exit(code)


def validate(spec) -> list[dict]:
    issues = []
    if spec.get("karyo") != "explainer/1":
        issues.append({"path": "/karyo", "level": "error", "message": "must be \"explainer/1\"", "hint": "add \"karyo\": \"explainer/1\""})
    for i, s in enumerate(spec.get("steps", [])):
        if not s.get("title"):
            issues.append({"path": f"/steps/{i}/title", "level": "warn", "message": "a step without a title"})
    return issues


def main(argv: list[str]) -> None:
    argv = [a for a in argv if a != "--json"]
    opt = lambda k, d=None: argv[argv.index(k) + 1] if k in argv else d  # noqa: E731
    cmd = argv[0]
    if cmd == "new":
        f = Path(argv[1])
        spec = {"karyo": "explainer/1", "title": opt("--title"), "steps": [{"title": "One"}, {"title": "Two"}]}
        f.parent.mkdir(parents=True, exist_ok=True)
        (f.parent / "components").mkdir(exist_ok=True)
        f.write_text(json.dumps(spec))
        out({"file": str(f), "id": f.name.split(".")[0], "spec": spec, "issues": []})
    if cmd in ("validate", "info", "stills", "build"):
        f = Path(argv[1])
        if not f.exists():
            out({"error": f"no such file: {f}"}, 2)
        try:
            spec = json.loads(f.read_text())
        except json.JSONDecodeError as e:
            issues = [{"path": "", "level": "error", "message": f"not valid JSON: {e}"}]
            out({"file": str(f), "ok": False, "issues": issues}, 1)
        issues = validate(spec)
        ok = not any(i["level"] == "error" for i in issues)
        if cmd == "validate":
            out({"file": str(f), "ok": ok, "issues": issues}, 0 if ok else 1)
        if cmd == "info":
            out({"file": str(f), "title": spec.get("title", ""), "steps": [{"n": i + 1, "title": s.get("title", "")} for i, s in enumerate(spec.get("steps", []))]})
        if not ok:
            out({"file": str(f), "ok": False, "issues": issues, "stills": []}, 1)
        if cmd == "stills":
            sel = opt("--step", "all")
            a, _, b = sel.partition("-")
            steps = range(int(a), int(b or a) + 1)
            d = Path(opt("--out"))
            stills = []
            for n in steps:
                p = d / f"step-{n}.png"
                Image.new("RGB", (1600, 900), (20 * n, 120, 200)).save(p)
                stills.append({"step": n, "file": str(p)})
            out({"file": str(f), "ok": True, "issues": issues, "stills": stills})
        if cmd == "build":
            h = Path(opt("-o"))
            h.write_text("<!doctype html><title>x</title>")
            out({"file": str(f), "ok": True, "html": str(h), "bytes": h.stat().st_size, "issues": issues})
    extra = json.loads(Path(os.environ["FAKE_KARYO_COMPONENTS"]).read_text()) if os.environ.get("FAKE_KARYO_COMPONENTS") else {}
    lib = {**BUILTIN, **extra}
    if cmd == "components":
        out({"components": [{k: c[k] for k in ("name", "source", "description", "dir")} for c in lib.values()]})
    if cmd == "component" and argv[1] == "show":
        if argv[2] not in lib:
            out({"error": f"no component \"{argv[2]}\" (have: {', '.join(lib)})"}, 2)
        out(lib[argv[2]])
    if cmd == "component" and argv[1] == "check":
        d = Path(argv[2])
        meta = json.loads((d / "component.json").read_text())
        issues = [] if meta.get("description") else [{"path": "/description", "level": "error", "message": "missing"}]
        out({"name": d.name, "dir": str(d), "source": "env", "ok": not issues, "issues": issues}, 1 if issues else 0)
    out({"error": f"unknown command {cmd}"}, 2)


if __name__ == "__main__":
    main(sys.argv[1:])
