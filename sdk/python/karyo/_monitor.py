"""The sys.monitoring recorder (PEP 669, Python 3.12+): every call between the project's functions.

Nothing is wrapped, rewritten or imported early: a monitoring tool gets a PY_START event when a
function starts and a PY_RETURN / PY_UNWIND when it ends. Which code is a node follows the static
scan's rule (karyo/auto.py: the file's directives, else automatic mode's classes and public
functions), so what is recorded lands on the scan's nodes:

  - the first time a code object starts, it is classified once. Code outside the watched packages (a
    library, the standard library) and code that is no node (a private helper, a lambda) gets
    `sys.monitoring.DISABLE`: that code object never calls back again, so it costs nothing after its
    first call. A node's code gets PY_RETURN turned on for it alone (`set_local_events`);
  - a node call's caller is the nearest node frame below it on the stack (transparent code in between
    is skipped: a private helper's calls count as its caller's), else the node running in the same task
    (a context variable, for asyncio tasks), else none: a root call;
  - a root call from outside the watched code (a test function, a request handler's framework, a
    script's top level) starts an automatic flow, named after that caller (`test_checkout`); the other
    root calls made by the same caller frame join it. Inside an explicit `karyo.flow(…)` they join it
    instead. The flow is the sampling unit: with KARYO_RECORD=0.01 one flow (a request, a test) in a
    hundred is recorded, whole, and the others cost one callback per node call;
  - calls are kept as spans (the flow replay's material) up to KARYO_MAX_SPANS per process (default
    20000) and KARYO_MAX_FLOW_SPANS per flow (5000); past that they are only counted on their
    relationship (an observed edge with a count), so coverage stays complete;
  - at exit the fragment is written, with a `coverage` entry saying which packages were watched in
    full (and the sampling rate): what lets the model mark code that never ran as "not exercised".

Off by default and free when off: nothing here is imported, and no monitoring tool is registered,
unless recording is on (`python -m karyo record`, or `karyo.watch(…)` with KARYO_RECORD set).
"""
from __future__ import annotations

import atexit
import os
import random
import sys
import threading
import time
from contextvars import ContextVar
from typing import Any, Optional

import karyo

from . import auto as am
from .declare import declare

M = sys.monitoring
EV = M.events
DISABLE = M.DISABLE
CO_OPTIMIZED, CO_GENERATOR, CO_COROUTINE, CO_ASYNC_GENERATOR = 0x1, 0x20, 0x80, 0x200
_SKIP_DIRS = ("site-packages", "dist-packages", ".venv", "venv", "node_modules", ".tox", ".git", "__pycache__")
_SDK_DIR = os.path.dirname(os.path.abspath(__file__))


class _Call:
    """One running call of a node (kept as a span, or only counted)."""
    __slots__ = ("node", "span", "trace", "sampled", "tokens", "flow", "ttok")

    def __init__(self, node: Optional[str], span: Any, trace: Optional[str], sampled: bool, flow: Any = None):
        self.node, self.span, self.trace, self.sampled, self.flow = node, span, trace, sampled, flow
        self.tokens: Any = None
        self.ttok: Any = None                     # an automatic flow's root: the trace it set


class _Flow:
    __slots__ = ("trace", "sampled", "spans", "name", "title")

    def __init__(self, trace: Optional[str], sampled: bool, name: str = "run", title: Optional[str] = None):
        self.trace, self.sampled, self.spans, self.name, self.title = trace, sampled, 0, name, title


_task: ContextVar[Optional[_Call]] = ContextVar("karyo_monitor_call", default=None)
# trace and span ids only need to be unique, not secret: a seeded PRNG instead of a syscall per span
_rng = random.Random(int.from_bytes(os.urandom(16), "big"))


def _id(n: int) -> str:
    return f"{_rng.getrandbits(8 * n):0{2 * n}x}"
_monitor: Optional["Monitor"] = None


class Monitor:
    def __init__(self, packages: list[str], sample: float, root: str, auto: Optional[bool], project: Optional[str]):
        self.packages = packages
        self.sample = sample
        self.root = os.path.abspath(root)
        self.auto = auto
        self.project = project
        self.tool: Optional[int] = None
        self.codes: dict = {}                     # code object -> node id | ("init", class node, receiver) | DISABLE
        self.active: dict = {}                    # frame -> _Call
        self.mods: dict[str, am.Mod] = {}         # module name -> parsed module (indexed once)
        self.maps: dict[str, dict] = {}
        self.defs: dict[str, am.Def] = {}         # node id -> the def it was first seen as
        self.counts: dict[tuple[str, str], int] = {}   # observed calls not kept as spans
        self.ran: set[str] = set()
        self.kept = 0
        self.calls = 0
        self.starts = 0                           # PY_START callbacks: after DISABLE, only node calls come back
        self.libcode: dict = {}                   # code object -> is it library code (for naming flows)
        self.use_disable = True                   # False only to measure what DISABLE saves (benchmarks)
        self.max_spans = int(os.environ.get("KARYO_MAX_SPANS", "20000"))
        self.max_flow = int(os.environ.get("KARYO_MAX_FLOW_SPANS", "5000"))
        self.tls = threading.local()
        self.lock = threading.Lock()
        self.scope_seen: set[str] = set()
        self.max_depth = 64
        import sysconfig
        paths = sysconfig.get_paths()
        self.lib_dirs = tuple(sorted({os.path.realpath(paths[k]) + os.sep for k in ("stdlib", "platstdlib") if paths.get(k)} |
                                     {paths[k] + os.sep for k in ("stdlib", "platstdlib") if paths.get(k)}))

    # ---------------------------------------------------------------- what is watched

    def _decide_auto(self) -> bool:
        env = os.environ.get("KARYO_AUTO", "")
        if env in ("0", "1"):
            return env == "1"
        texts = []
        for d in self._package_dirs():
            for r, dirs, files in os.walk(d):
                dirs[:] = [x for x in dirs if not x.startswith(".") and x not in _SKIP_DIRS]
                for f in files:
                    if f.endswith(".py"):
                        try:
                            with open(os.path.join(r, f), encoding="utf-8") as fh:
                                texts.append(fh.read())
                        except (OSError, UnicodeDecodeError):
                            pass
        return not am.has_directives(texts)

    def _package_dirs(self) -> list[str]:
        if not self.packages:
            return [self.root]
        import importlib.util
        out = []
        for p in self.packages:
            try:
                spec = importlib.util.find_spec(p)
            except (ImportError, ValueError):
                spec = None
            if spec is None:
                continue
            if spec.submodule_search_locations:
                out += list(spec.submodule_search_locations)
            elif spec.origin:
                out.append(spec.origin)
        return out

    def _module_of(self, frame: Any, code: Any) -> str:
        g = frame.f_globals
        name = g.get("__name__") or ""
        if name == "__main__":
            spec = g.get("__spec__")
            if spec is not None and getattr(spec, "name", None):
                return spec.name
            rel = os.path.relpath(os.path.abspath(code.co_filename), self.root)
            return rel[:-3].replace(os.sep, ".") if rel.endswith(".py") and not rel.startswith("..") else name
        return name

    def _watched(self, module: str, filename: str) -> bool:
        if self.packages:
            return any(module == p or module.startswith(p + ".") for p in self.packages)
        f = os.path.abspath(filename)
        if not f.startswith(self.root + os.sep) or f.startswith(_SDK_DIR):
            return False
        parts = os.path.relpath(f, self.root).split(os.sep)
        return not any(p in _SKIP_DIRS or p.startswith(".") for p in parts[:-1])

    def _index(self, module: str, filename: str) -> Optional[dict]:
        cmap = self.maps.get(module)
        if cmap is not None:
            return cmap
        if self.auto is None:
            self.auto = self._decide_auto()
        try:
            with open(filename, encoding="utf-8") as fh:
                source = fh.read()
        except (OSError, UnicodeDecodeError):
            self.maps[module] = {}
            return None
        rel = karyo._rel(filename)
        mod = am.Mod(module, os.path.abspath(filename), rel, source)
        cmap = am.code_map(mod, self.auto)
        self.mods[module], self.maps[module] = mod, cmap
        for d in mod.defs:
            if d.id and d.id not in self.defs and (d.own or d.init):
                self.defs[d.id] = d.cls if d.init and d.cls is not None else d
        if mod.tree is not None:                  # the directives' nodes and edges, as the import-time recorder registers them
            declare(mod.parsed, module, rel, karyo._add_node, karyo._add_edge)
        self.scope_seen.add(module.split(".")[0])
        return cmap

    def _classify(self, code: Any, frame: Any) -> Any:
        if not code.co_flags & CO_OPTIMIZED:      # a module or class body
            return DISABLE
        module = self._module_of(frame, code)
        if not module or not self._watched(module, code.co_filename):
            return DISABLE
        # code generated at run time (a dataclass's __init__ and __eq__: co_filename "<string>") runs with its module's
        # globals but isn't in its file: never a node, and never what the module is indexed from
        file = frame.f_globals.get("__file__") or code.co_filename
        if code.co_filename.startswith("<") or os.path.abspath(code.co_filename) != os.path.abspath(file):
            return DISABLE
        with self.lock:
            cmap = self._index(module, file)
        hits = (cmap or {}).get(code.co_qualname) or []
        hit = next((h for h in hits if h[0] == code.co_firstlineno), hits[0] if len(hits) == 1 else None)
        if hit is None or hit[1] is None:
            return DISABLE
        if hit[2]:                                # a class's __init__ / __new__ / __post_init__: the class node
            return ("init", hit[1], code.co_varnames[0] if code.co_argcount else None)
        return hit[1]

    def _init_node(self, spec: tuple, frame: Any) -> str:
        """The node of the object being constructed: its own class's, when that class is a node (an
        inherited __init__ constructs the subclass), else the class defining the __init__."""
        _, node, recv = spec
        if recv is None:
            return node
        obj = frame.f_locals.get(recv)
        cls = obj if isinstance(obj, type) else type(obj)
        mod = getattr(cls, "__module__", None)
        qn = getattr(cls, "__qualname__", None)
        if mod and qn:
            m = self.mods.get(mod)
            ds = m.by_qualname.get(qn) if m is not None else None
            if ds and ds[0].id and ds[0].own:
                return ds[0].id
        return node

    # ---------------------------------------------------------------- events

    def on_start(self, code: Any, offset: int) -> Any:
        self.starts += 1
        node = self.codes.get(code)
        frame = sys._getframe(1)
        if node is None:
            node = self._classify(code, frame)
            self.codes[code] = node
            if node is DISABLE:
                return DISABLE if self.use_disable else None
            M.set_local_events(self.tool, code, EV.PY_RETURN)
        elif node is DISABLE:
            return DISABLE if self.use_disable else None
        if type(node) is tuple:
            node = self._init_node(node, frame)
        # the caller: the nearest node frame below (transparent code skipped), else this task's running node
        active = self.active
        parent = None
        f = frame.f_back
        n = 0
        while f is not None and n < self.max_depth:
            parent = active.get(f)
            if parent is not None:
                break
            f = f.f_back
            n += 1
        if parent is None:
            parent = _task.get()
        if parent is not None and not parent.sampled:
            return None                           # inside a flow the sampling left out
        self.calls += 1
        gen = code.co_flags & (CO_GENERATOR | CO_ASYNC_GENERATOR)
        if parent is None:
            call = self._root(node, frame, code)
        else:
            self.ran.add(node)
            call = _Call(node, None, parent.trace, True, parent.flow)
            fl = parent.flow
            if parent.span is not None and self.kept < self.max_spans and (fl is None or fl.spans < self.max_flow):
                call.span = self._span(node, code, parent.span.id, parent.trace)
                if fl is not None:
                    fl.spans += 1
            elif parent.node is not None and parent.node != node:
                k = (parent.node, node)
                self.counts[k] = self.counts.get(k, 0) + 1
        active[frame] = call
        if not gen:                               # a generator's context isn't its own: its callees use the frame walk
            call.tokens = (_task.set(call), karyo._current.set(call.span) if call.span is not None else None)
        return None

    def _root(self, node: str, frame: Any, code: Any) -> _Call:
        trace = karyo._trace.get()
        if trace is not None:                     # inside an explicit karyo.flow(): join it
            cur = karyo._current.get()
            self.ran.add(node)
            call = _Call(node, None, trace, True)
            if self.kept < self.max_spans:
                call.span = self._span(node, code, cur.id if cur is not None else karyo._remote_parent.get(), trace)
            elif cur is not None and cur.node != node:
                self.counts[(cur.node, node)] = self.counts.get((cur.node, node), 0) + 1
            return call
        caller = self._outside_caller(frame.f_back)
        st = self.tls
        fl: Optional[_Flow] = getattr(st, "flow", None)
        if fl is None or getattr(st, "caller", None) is not caller or caller is None:
            fl = self._new_flow(caller, node)
            st.caller, st.flow = caller, fl
        call = _Call(node, None, fl.trace, fl.sampled, fl)
        if not fl.sampled:
            return call
        self.ran.add(node)
        if self.kept < self.max_spans and fl.spans < self.max_flow:
            call.span = self._span(node, code, os.environ.get("KARYO_PARENT") or None, fl.trace, fl)
            fl.spans += 1
        call.ttok = karyo._trace.set(fl.trace)
        return call

    def _outside_caller(self, f: Any) -> Any:
        """The code that made a root call: the nearest frame that is neither the standard library nor an
        installed package (asyncio.run's event loop, a framework's dispatch), e.g. the test function."""
        first = f
        lib = self.libcode
        while f is not None:
            c = f.f_code
            is_lib = lib.get(c)
            if is_lib is None:
                fn = c.co_filename
                is_lib = lib[c] = fn.startswith("<") or fn.startswith(self.lib_dirs) or "site-packages" in fn
            if not is_lib:
                return f
            f = f.f_back
        return first

    def _new_flow(self, caller: Any, node: str) -> _Flow:
        sampled = self.sample >= 1.0 or random.random() < self.sample
        if not sampled:
            return _Flow(None, False)
        name, title = self._flow_name(caller, node)
        # the flow is registered with its first kept span (past the span cap a flow only counts): a child process's
        # flows all join the parent's trace (KARYO_TRACE)
        return _Flow(os.environ.get("KARYO_TRACE") or _id(8), True, name, title)

    def _flow_name(self, caller: Any, node: str) -> tuple[str, str]:
        """An automatic flow is named after the code outside the watched packages that made the root call (a test,
        a request handler, a script); its title adds the code that called that, e.g. `call ← test_rate_limit`. Called
        from library code only, it is named after its root node."""
        if caller is None:
            return "run", node
        names: list[str] = []
        f = caller
        while f is not None and len(names) < 3:
            fn = f.f_code.co_filename
            if not fn.startswith("<") and not fn.startswith(self.lib_dirs) and "site-packages" not in fn:
                n = f.f_code.co_name
                if n == "<module>":
                    mod = f.f_globals.get("__name__") or "run"
                    names.append(os.path.splitext(os.path.basename(fn))[0] if mod == "__main__" else mod)
                    break
                names.append(n)
            f = f.f_back
        if not names:                             # called from library code only (a server's framework): the node names it
            short = node.rpartition(".")[2] or node
            return "".join(ch if ch.isalnum() or ch in "_.:-" else "_" for ch in short).strip("_") or "run", node
        clean = "".join(ch if ch.isalnum() or ch in "_.:-" else "_" for ch in names[0]).strip("_") or "run"
        return clean, " ← ".join(names)

    def _span(self, node: str, code: Any, parent: Optional[str], trace: str, fl: Optional[_Flow] = None) -> Any:
        name = code.co_name
        if name in am.INIT_METHODS:
            d = self.defs.get(node)
            name = d.name if d is not None else code.co_qualname.rpartition(".")[0].rpartition(".")[2] or name
        s = karyo._Span(id=_id(6), parent=parent, node=node, label=f"{name}()", start=time.time_ns())
        with karyo._lock:
            f = karyo._flows.get(trace)
            if f is None:
                f = karyo._flows[trace] = {"id": fl.name if fl else "run", "title": fl.title if fl else None, "trace": trace, "spans": []}
            if parent is None and not f["spans"]:
                s.flow = f["id"]
            f["spans"].append(s)
        self.kept += 1
        return s

    def on_return(self, code: Any, offset: int, retval: Any) -> Any:
        call = self.active.pop(sys._getframe(1), None)
        if call is not None:
            self._end(call, None)
        return None

    def on_unwind(self, code: Any, offset: int, exc: BaseException) -> Any:
        call = self.active.pop(sys._getframe(1), None)
        if call is not None:
            self._end(call, exc)
        return None

    def _end(self, call: _Call, exc: Optional[BaseException]) -> None:
        s = call.span
        if s is not None:
            s.end = time.time_ns()
            if exc is not None:
                s.status = "error"
                s.attrs["error"] = f"{type(exc).__name__}: {exc}"
        t1, t2 = call.tokens or (None, None)
        for var, tok in ((_task, t1), (karyo._current, t2), (karyo._trace, call.ttok)):
            if tok is None:
                continue
            try:
                var.reset(tok)
            except ValueError:                    # ended in another context (a generator finished elsewhere)
                var.set(tok.old_value if tok.old_value is not tok.MISSING else None)

    # ---------------------------------------------------------------- output

    def part(self) -> dict:
        """What this recorder adds to the process's fragment: the nodes that ran, the calls not kept as spans,
        and what was watched."""
        nodes = []
        for nid in sorted(self.ran):
            d = self.defs.get(nid)
            if d is None:
                nodes.append({"id": nid, "kind": "function", "sources": ["observed"]})
                continue
            if d.declared:                        # its declaration came from the directive (declare() above)
                nodes.append({"id": nid, "kind": _declared_kind(d) or "function", "module": d.mod.name, "lang": "python",
                              "sources": ["observed"]})
                continue
            rec = am.node_record(d)
            rec.pop("code", None)
            rec.pop("summary", None)
            rec["sources"] = ["observed"]
            nodes.append(rec)
        edges = [{"from": a, "to": b, "kind": "calls", "sources": ["observed"], "count": c}
                 for (a, b), c in sorted(self.counts.items())]
        scope = sorted(self.packages) if self.packages else sorted(self.scope_seen)
        out: dict = {"nodes": nodes, "edges": edges,
                     "coverage": [{"scope": scope, "by": "karyo-py monitor", **({"sample": self.sample} if self.sample < 1 else {})}]}
        dropped = sum(self.counts.values())
        if dropped:
            out["checks"] = [{"level": "info", "code": "monitor-capped", "subject": "monitor",
                              "message": f"the monitor kept {self.kept} of {self.kept + dropped} recorded calls as spans; "
                                         f"the other {dropped} are counted on their relationships (KARYO_MAX_SPANS, KARYO_MAX_FLOW_SPANS)"}]
        return out


def _declared_kind(d: am.Def) -> Optional[str]:
    for x in d.mod.parsed.directives:
        if x.target is d.ast and x.verb == "node":
            return x.attrs.get("kind") or "function"
    return None


# ------------------------------------------------------------------ install

def install(packages: list[str], *, sample: float = 1.0, out: Optional[str] = None, root: Optional[str] = None,
            project: Optional[str] = None, auto: Optional[bool] = None) -> Monitor:
    """Register the monitoring tool (idempotent; packages accumulate). Writes the fragment at exit when `out`
    is given."""
    global _monitor
    if root:
        os.environ["KARYO_ROOT"] = os.path.abspath(root)
    if out:
        os.environ["KARYO_OUT"] = os.path.abspath(out)
    if _monitor is not None:
        for p in packages:
            if p and p not in _monitor.packages:
                _monitor.packages.append(p)
        return _monitor
    mon = Monitor([p for p in packages if p], sample, root or os.environ.get("KARYO_ROOT") or os.getcwd(), auto, project)
    for tid in (4, 3, 5, 1, 0):
        try:
            M.use_tool_id(tid, "karyo")
        except ValueError:
            continue
        mon.tool = tid
        break
    else:
        raise RuntimeError("karyo: no free sys.monitoring tool id")
    M.register_callback(mon.tool, EV.PY_START, mon.on_start)
    M.register_callback(mon.tool, EV.PY_RETURN, mon.on_return)
    M.register_callback(mon.tool, EV.PY_UNWIND, mon.on_unwind)
    M.set_events(mon.tool, EV.PY_START | EV.PY_UNWIND)
    _monitor = mon
    karyo._recording = True
    karyo._contributors.append(mon.part)
    if out:
        atexit.register(_write_at_exit, project)
    return mon


def uninstall() -> None:
    """Stop recording (tests): unregister the tool; what was recorded stays in karyo's registry."""
    global _monitor
    mon = _monitor
    if mon is None or mon.tool is None:
        return
    M.set_events(mon.tool, 0)
    for ev in (EV.PY_START, EV.PY_RETURN, EV.PY_UNWIND):
        M.register_callback(mon.tool, ev, None)
    M.free_tool_id(mon.tool)
    _monitor = None


def current() -> Optional[Monitor]:
    return _monitor


def _write_at_exit(project: Optional[str]) -> None:
    mon = _monitor
    if mon is not None and mon.tool is not None:
        try:
            M.set_events(mon.tool, 0)             # nothing more to record while writing
        except ValueError:
            pass
    frag = karyo.fragment()
    if frag["nodes"] or frag["flows"]:
        path = karyo.write(project=project or os.environ.get("KARYO_PROJECT") or None)
        print(f"karyo: wrote {path}", file=sys.stderr)
