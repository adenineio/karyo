"""karyo — describe how Python code fits together, for Karyo.

Three sources of truth, one output file (a Karyo model fragment):
  declared   `# karyo:node …` comment directives (the default: the app never imports karyo), or
             the @node(...) / external(...) / edge(...) calls
  extracted  `python -m karyo scan <pkg>`: directives, decorators and imports read with tokenize +
             ast (nothing runs); `--auto` (the default for a package with no directives) also makes
             every class and public function a node and adds the static call graph (karyo/auto.py)
  observed   `python -m karyo record … -- <command>`: the recorder watches that command's processes
             only: with sys.monitoring (karyo/_monitor.py, Python 3.12+) every call between the
             project's functions, or (older Pythons, directive projects) the functions the
             directives mark; spans are joined across processes by a trace id (KARYO_TRACE / KARYO_PARENT)

Inert in production: importing karyo costs about a millisecond (everything heavy is imported
lazily), `@karyo.node` returns what it decorates unchanged, and nothing is registered, wrapped or
monitored unless KARYO_RECORD turns recording on. `python -m karyo check-prod <pkg>` checks that.
Standard library only. See docs/MODEL.md.
"""
from __future__ import annotations

# Keep this import list tiny: `import karyo` must stay cheap in production (tests/test_karyo.py has the
# budget). inspect, functools, json, datetime and the recorders are imported where they're used.
import _thread
import contextvars
import os
import sys
import time

TYPE_CHECKING = False
if TYPE_CHECKING:  # annotations only (they're strings at runtime): importing typing costs more than all of karyo
    from typing import Any, Callable, Iterable, Optional

__version__ = "0.1.0"
__all__ = ["node", "external", "edge", "watch", "flow", "span", "current", "context", "context_from", "write", "fragment",
           "reset", "recording", "instrument", "on_import", "wrap", "node_of", "check"]

KINDS = {"service", "function", "type", "store", "queue", "external", "actor", "module"}
EDGE_KINDS = {"calls", "reads", "writes", "publishes", "subscribes", "imports"}


def _token(n: int) -> str:
    return os.urandom(n).hex()


# --------------------------------------------------------------------------- registry

class _Span:
    """One recorded call of one node."""
    __slots__ = ("id", "parent", "node", "label", "start", "end", "status", "flow", "attrs")

    def __init__(self, id: str, parent: Optional[str], node: str, label: str, start: int, end: Optional[int] = None,
                 status: str = "ok", flow: Optional[str] = None, attrs: Optional[dict] = None):
        self.id, self.parent, self.node, self.label, self.start = id, parent, node, label, start
        self.end, self.status, self.flow, self.attrs = end, status, flow, attrs if attrs is not None else {}

    def env(self) -> dict[str, str]:
        """Environment for a child process so its spans join this trace under this span."""
        return {"KARYO_TRACE": _trace.get() or "", "KARYO_PARENT": self.id}

    def headers(self) -> dict[str, str]:
        """HTTP headers carrying the same context."""
        return {"karyo-trace": _trace.get() or "", "karyo-parent": self.id}


_lock = _thread.allocate_lock()
_nodes: dict[str, dict] = {}
_edges: dict[tuple, dict] = {}
_flows: dict[str, dict] = {}          # trace id -> flow
_trace: "contextvars.ContextVar[Optional[str]]" = contextvars.ContextVar("karyo_trace", default=None)
_current: "contextvars.ContextVar[Optional[_Span]]" = contextvars.ContextVar("karyo_span", default=None)
_remote_parent: "contextvars.ContextVar[Optional[str]]" = contextvars.ContextVar("karyo_remote_parent", default=None)
_checks: list[dict] = []
_contributors: list = []              # recorders that add to the fragment (karyo/_monitor.py): () -> partial fragment
_recording = False                    # set by instrument() / watch() (the recorders); the decorator form is a no-op without it


def reset() -> None:
    """Forget everything recorded so far (tests)."""
    with _lock:
        _nodes.clear(); _edges.clear(); _flows.clear(); _checks.clear()


def recording() -> bool:
    """True inside `python -m karyo record` (or after instrument() / an enabled watch()): only then do
    decorators wrap anything."""
    return _recording or os.environ.get("KARYO_RECORD", "") not in ("", "0")


def _sample_rate(value: Optional[str]) -> float:
    """KARYO_RECORD as a sampling rate: unset, empty or 0 is off (0.0); a number between 0 and 1 samples
    that share of flows; anything else (1, true, yes) records everything."""
    v = (value or "").strip().lower()
    if v in ("", "0", "false", "no", "off"):
        return 0.0
    try:
        f = float(v)
    except ValueError:
        return 1.0
    return 0.0 if f <= 0 else min(f, 1.0)


def watch(*packages: str, sample: Optional[float] = None, out: Optional[str] = None, root: Optional[str] = None,
          project: Optional[str] = None) -> bool:
    """Record calls between the functions of `packages`, but only when the environment asks for it.

    Inert by default, so it is safe in production code: unless KARYO_RECORD is set (1 records every flow,
    0.01 samples 1% of them) it returns False at once, having imported and registered nothing. When
    enabled it starts the sys.monitoring recorder (karyo/_monitor.py; Python 3.12+; the import-time
    instrumenting recorder on older Pythons) for those packages and writes the fragment at exit to
    `out` (default $KARYO_OUT, else .karyo). `sample` overrides the rate KARYO_RECORD gives. Returns
    True when recording started."""
    rate = _sample_rate(os.environ.get("KARYO_RECORD")) if sample is None else max(0.0, min(float(sample), 1.0))
    if rate <= 0.0:
        return False
    pk = [p for x in packages for p in str(x).split(",") if p.strip()]
    if sys.version_info >= (3, 12) and os.environ.get("KARYO_MONITOR", "") != "0":
        from . import _monitor
        _monitor.install(pk, sample=rate, out=out or os.environ.get("KARYO_OUT") or ".karyo",
                         root=root or os.environ.get("KARYO_ROOT"), project=project)
    else:
        instrument(pk, out=out or os.environ.get("KARYO_OUT") or ".karyo", root=root)
    return True


def check(code: str, message: str, subject: Optional[str] = None, level: str = "warn") -> None:
    """Add a check (a warning or note) to this process's fragment; the merge prints it with the others."""
    c = {"level": level, "code": code, "message": message}
    if subject:
        c["subject"] = subject
    with _lock:
        if c not in _checks:
            _checks.append(c)


def _add_node(n: dict) -> None:
    # a kit's node kind (docs/KITS.md) is any other lowercase word
    if n["kind"] not in KINDS and not (isinstance(n["kind"], str) and n["kind"][:1].isalpha() and n["kind"].replace("-", "").isalnum() and n["kind"].islower()):
        raise ValueError(f"karyo: unknown node kind {n['kind']!r} (one of {sorted(KINDS)})")
    conflict = None
    with _lock:
        cur = _nodes.get(n["id"])
        if cur is None:
            _nodes[n["id"]] = dict(n)
        else:
            for k, v in n.items():
                if k == "sources":
                    cur["sources"] = sorted(set(cur["sources"]) | set(v))
                elif k == "tags" and v:
                    cur["tags"] = sorted(set(cur.get("tags") or ()) | set(v))
                elif k == "category" and v and cur.get("category") and cur["category"] != v:
                    conflict = (cur["category"], v)
                elif k == "code" and v and len(v["text"]) > len((cur.get("code") or {}).get("text", "")):
                    cur["code"] = v                      # the same node declared twice: keep the longer source
                elif v is not None and cur.get(k) is None:
                    cur[k] = v
    if conflict:
        check("category-conflict", f"{n['id']} is declared with category {conflict[0]!r} and {conflict[1]!r}; keeping {conflict[0]!r}.", n["id"])


def _add_edge(a: str, b: str, kind: str = "calls", label: Optional[str] = None, source: str = "declared") -> None:
    if kind not in EDGE_KINDS:
        raise ValueError(f"karyo: unknown edge kind {kind!r}")
    with _lock:
        e = _edges.setdefault((a, b, kind), {"from": a, "to": b, "kind": kind, "sources": []})
        if label and not e.get("label"):
            e["label"] = label
        if source not in e["sources"]:
            e["sources"].append(source)


def _module_name(module: str) -> str:
    """The name the scan gives a module: under `python -m pkg.mod` a function's __module__ is "__main__",
    but its module is pkg.mod (the name `python -m karyo scan` and the import checks use)."""
    if module == "__main__":
        spec = getattr(sys.modules.get("__main__"), "__spec__", None)
        if spec is not None and getattr(spec, "name", None):
            return spec.name
    return module


def _group_of(module: str) -> str:
    return module.split(".")[0] if module else "app"


CODE_MAX_LINES = 80
_LANGS = {".py": "python", ".go": "go", ".ts": "typescript", ".js": "javascript", ".rs": "rust"}


def code_excerpt(file: str, lines: list[str], start: int, end: int) -> dict:
    """A node's source as the model carries it: `lines` are the declaration's lines (decorators or
    doc comment included), `start`..`end` their 1-based numbers in `file`. Capped at 80 lines; a
    longer declaration keeps its first 80 and is marked `truncated`, with `end` the last line kept."""
    out = {"file": file, "start": start, "end": end,
           "lang": _LANGS.get(os.path.splitext(file)[1], "text"), "text": ""}
    if len(lines) > CODE_MAX_LINES:
        lines = lines[:CODE_MAX_LINES]
        out["end"], out["truncated"] = start + CODE_MAX_LINES - 1, True
    out["text"] = "\n".join(l.rstrip("\r\n") for l in lines)
    return out


def _rel(file: str) -> str:
    root = os.environ.get("KARYO_ROOT", os.getcwd())
    try:
        file = os.path.relpath(file, root)
    except ValueError:
        pass
    return file.replace(os.sep, "/")


def _code_of(fn: Callable) -> Optional[dict]:
    """The decorated function's or class's source, decorators included (inspect), or None."""
    import inspect
    try:
        file = inspect.getsourcefile(fn) or ""
        lines, start = inspect.getsourcelines(fn)
    except (OSError, TypeError):
        return None
    if not file or not lines:
        return None
    return code_excerpt(_rel(file), lines, max(start, 1), max(start, 1) + len(lines) - 1)


def _ref_of(fn: Callable) -> Optional[dict]:
    import inspect
    try:
        file = inspect.getsourcefile(fn) or ""
        line = inspect.getsourcelines(fn)[1]
    except (OSError, TypeError):
        return None
    return {"file": _rel(file), "line": line, "symbol": fn.__qualname__}


# --------------------------------------------------------------------------- annotations

def node(id: str, *, kind: str = "function", label: Optional[str] = None, summary: Optional[str] = None,
         group: Optional[str] = None, category: Optional[str] = None, tags: Iterable[str] = (),
         calls: Iterable[str] = (), reads: Iterable[str] = (), writes: Iterable[str] = (),
         publishes: Iterable[str] = (), record: bool = True) -> Callable:
    """Declare a function (or class) as a node: the decorator form of `# karyo:node`.

    Outside a recording (`recording()` is false) it returns what it decorates unchanged: no wrapper,
    no bookkeeping. Inside one it registers the node and wraps a function so its calls in a flow()
    are spans. Prefer the comment directive: it keeps karyo out of the app's imports entirely."""
    def deco(fn: Callable) -> Callable:
        if not recording():
            return fn
        import inspect
        module = _module_name(getattr(fn, "__module__", "") or "")
        _add_node({k: v for k, v in {
            "id": id, "kind": kind, "label": label or fn.__name__, "summary": summary or _first_line(fn.__doc__),
            "group": group or _group_of(module), "category": category, "tags": sorted(set(tags)) or None,
            "module": module, "lang": "python", "ref": _ref_of(fn), "code": _code_of(fn), "sources": ["declared"]}.items()
            if v is not None})
        for kind_, targets in (("calls", calls), ("reads", reads), ("writes", writes), ("publishes", publishes)):
            for t in targets:
                _add_edge(id, t, kind_)
        if inspect.isclass(fn):
            fn.__karyo_node__ = id
            return fn
        if not record:
            return fn
        return wrap(fn, id)
    return deco


def wrap(fn: Callable, node_id: Optional[str], label: Optional[str] = None, **attrs: Any) -> Callable:
    """Return `fn` wrapped so each call is a span of `node_id` (label default: `name()`). Works for plain,
    async, generator and async-generator functions and keeps the signature (functools.wraps). With no
    node id it returns `fn` as is. For recording hooks (karyo_hooks.py); the recorder uses it for
    directives."""
    if not node_id:
        return fn
    import functools
    import inspect
    label = label or f"{getattr(fn, '__name__', node_id)}()"
    if inspect.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def awrapper(*a, **kw):
            with span(node_id, label=label, **attrs):
                return await fn(*a, **kw)
        w: Callable = awrapper
    elif inspect.isasyncgenfunction(fn):
        @functools.wraps(fn)
        async def agwrapper(*a, **kw):
            with span(node_id, label=label, **attrs):
                async for x in fn(*a, **kw):
                    yield x
        w = agwrapper
    elif inspect.isgeneratorfunction(fn):
        @functools.wraps(fn)
        def gwrapper(*a, **kw):
            with span(node_id, label=label, **attrs):
                return (yield from fn(*a, **kw))
        w = gwrapper
    else:
        @functools.wraps(fn)
        def wrapper(*a, **kw):
            with span(node_id, label=label, **attrs):
                return fn(*a, **kw)
        w = wrapper
    w.__karyo_node__ = node_id  # type: ignore[attr-defined]
    return w


def node_of(obj: Any) -> Optional[str]:
    """The node id a directive (or @node) gave `obj`, its class, or a bound method's class; else None."""
    for o in (obj, getattr(obj, "__self__", None), type(getattr(obj, "__self__", None)) if hasattr(obj, "__self__") else None,
              type(obj)):
        nid = getattr(o, "__karyo_node__", None) if o is not None else None
        if isinstance(nid, str):
            return nid
    return None


def instrument(packages: Iterable[str] = (), *, hooks: Optional[str] = None, out: Optional[str] = None,
               root: Optional[str] = None) -> None:
    """Start recording in this process: instrument the directives of `packages` as their modules are
    imported, run the hooks file's `setup(karyo)`, pass trace context to child processes, and (with
    `out`) write the fragment at exit. `python -m karyo record` does this for you; tests call it
    before importing the app."""
    from . import _record
    _record.install(list(packages), hooks=hooks, out=out, root=root)


def on_import(module: str) -> Callable[[Callable[[Any], None]], Callable[[Any], None]]:
    """Decorator for recording hooks: run `fn(module_object)` right after `module` is imported (or now,
    if it already is). Only while recording."""
    from . import _record
    return _record.on_import(module)


def external(id: str, *, kind: str = "external", label: Optional[str] = None, summary: Optional[str] = None,
             group: Optional[str] = None, category: Optional[str] = None, tags: Iterable[str] = ()) -> None:
    """Declare a node implemented elsewhere (another service, another language, a database). Inert (does
    nothing) unless recording: the static scan reads the call from the source either way."""
    if not recording():
        return
    _add_node({k: v for k, v in {"id": id, "kind": kind, "label": label or id, "summary": summary,
                                 "group": group or id.split(".")[0], "category": category,
                                 "tags": sorted(set(tags)) or None, "sources": ["declared"]}.items() if v is not None})


def edge(a: str, b: str, kind: str = "calls", label: Optional[str] = None) -> None:
    """Declare a relationship that isn't attached to a decorated function. Inert unless recording, like
    external()."""
    if not recording():
        return
    _add_edge(a, b, kind, label)


def _first_line(doc: Optional[str]) -> Optional[str]:
    return doc.strip().splitlines()[0] if doc and doc.strip() else None


# --------------------------------------------------------------------------- runtime

def _now() -> int:
    return time.time_ns()


class flow:
    """Start (or continue) a traced flow. Use as a context manager.

    A flow continues an existing trace when one is given: explicitly with `trace=` / `parent=`
    (e.g. read from request headers or MCP `_meta` with `context_from()`), or through the
    KARYO_TRACE / KARYO_PARENT environment of a child process. Otherwise it starts a new trace.
    """

    def __init__(self, id: str, *, title: Optional[str] = None, entry: Optional[str] = None,
                 trace: Optional[str] = None, parent: Optional[str] = None):
        self.id, self.title, self.entry = id, title, entry
        self._trace_in, self._parent_in = trace, parent
        self._tokens: list = []

    def __enter__(self) -> "flow":
        explicit = self._trace_in is not None
        trace = self._trace_in or os.environ.get("KARYO_TRACE") or _token(8)
        self.trace = trace
        with _lock:
            f = _flows.setdefault(trace, {"id": self.id, "title": self.title, "trace": trace, "spans": []})
            if self.entry:
                f["entry"] = self.entry
        self._tokens.append((_trace, _trace.set(trace)))
        remote = self._parent_in if explicit else os.environ.get("KARYO_PARENT")
        self._tokens.append((_remote_parent, _remote_parent.set(remote or None)))
        return self

    def __exit__(self, *exc) -> None:
        for var, tok in reversed(self._tokens):
            var.reset(tok)


class span:
    """Record one call of a node. Automatic for directive-marked functions while recording; use it
    directly (in a recording hook or a driver script) around anything else. Outside a flow it records
    nothing and costs one context-variable read."""

    __slots__ = ("node_id", "label", "attrs", "s", "_tok")

    def __init__(self, node_id: str, *, label: Optional[str] = None, **attrs: Any):
        self.node_id, self.label, self.attrs = node_id, label, attrs
        self.s: Optional[_Span] = None

    def __enter__(self) -> Optional[_Span]:
        trace = _trace.get()
        if trace is None:
            return None
        parent = _current.get()
        s = _Span(id=_token(6), parent=parent.id if parent else _remote_parent.get(), node=self.node_id,
                  label=self.label or self.node_id, start=_now(), attrs=dict(self.attrs))
        self.s = s
        with _lock:
            f = _flows[trace]
            if parent is None and not f["spans"] and _remote_parent.get() is None:
                s.flow = f["id"]
            f["spans"].append(s)
        self._tok = _current.set(s)
        return s

    def __exit__(self, et, ev, tb) -> None:
        if self.s is None:
            return
        self.s.end = _now()
        if et is not None:
            self.s.status = "error"
            self.s.attrs["error"] = f"{et.__name__}: {ev}"
        _current.reset(self._tok)


def context() -> dict[str, str]:
    """Trace context to send with an outgoing request (HTTP headers, MCP `_meta`): the trace, the
    current span (if any) and the flow's name. Empty outside a flow."""
    trace = _trace.get()
    if trace is None:
        return {}
    cur = _current.get()
    out = {"karyo-trace": trace}
    parent = cur.id if cur else _remote_parent.get()
    if parent:
        out["karyo-parent"] = parent
    with _lock:
        f = _flows.get(trace)
    if f:
        out["karyo-flow"] = f["id"]
    return out


def context_from(carrier: Optional[dict]) -> dict[str, Optional[str]]:
    """Read trace context from incoming headers or MCP `_meta`: {trace, parent, flow} (values may be None).
    Pass `trace` and `parent` to flow(...) to continue the caller's trace."""
    c = {str(k).lower(): v for k, v in (carrier or {}).items()}
    return {"trace": c.get("karyo-trace") or None, "parent": c.get("karyo-parent") or None, "flow": c.get("karyo-flow") or None}


def current() -> Optional[_Span]:
    """The span being recorded right now (e.g. to pass `current().env()` to a child process)."""
    return _current.get()


# --------------------------------------------------------------------------- output

def fragment(project: Optional[str] = None) -> dict:
    """The Karyo model fragment recorded by this process."""
    with _lock:
        nodes = [{k: v for k, v in n.items() if v is not None} for n in _nodes.values()]
        edges = [dict(e) for e in _edges.values()]
        flows = []
        for f in _flows.values():
            spans = []
            for s in f["spans"]:
                d = {"id": s.id, "parent": s.parent, "node": s.node, "label": s.label, "start": s.start, "end": s.end or _now(),
                     "status": s.status, "lang": "python"}
                if s.flow:
                    d["flow"] = s.flow
                if s.attrs:
                    d["attrs"] = s.attrs
                spans.append(d)
            flows.append({k: v for k, v in {**f, "spans": spans}.items() if v is not None})
        checks = [dict(c) for c in _checks]
    from datetime import datetime, timezone
    out = {"karyo": 1, "producers": [{"name": "karyo-py", "lang": "python", "version": __version__,
                                        "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}],
           "nodes": nodes, "edges": edges, "flows": flows}
    for part in list(_contributors):
        p = part()
        out["nodes"] += p.get("nodes", [])
        out["edges"] += p.get("edges", [])
        if p.get("coverage"):
            out.setdefault("coverage", []).extend(p["coverage"])
        checks += p.get("checks", [])
    if checks:
        out["checks"] = checks
    if project:
        out["project"] = project
    return out


def write(path: Optional[str] = None, project: Optional[str] = None) -> str:
    """Write this process's fragment. Default: $KARYO_OUT/python-<pid>.karyo.json (KARYO_OUT defaults to .karyo)."""
    import json
    if path is None:
        d = os.environ.get("KARYO_OUT", ".karyo")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, f"python-{os.getpid()}.karyo.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(fragment(project), fh, indent=1)
    return path
