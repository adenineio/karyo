"""The recorder: instruments directive-marked code at import time, in recording processes only.

`python -m karyo record … -- <command>` runs the command with KARYO_RECORD=1 and a bootstrap
`sitecustomize` on PYTHONPATH (karyo/_boot), which calls `install_from_env()` in every Python
process of that command, children included. `install()` then

  - puts an import hook in front of `sys.meta_path` for the listed packages. When one of their
    modules is imported, its source is read with the directives (tokenize + ast), the declared nodes
    and edges are registered, and every def a `# karyo:node` / `# karyo:span` directive marks gets
    one decorator added to its AST before compiling: so it is wrapped at definition time, and lists
    or registries built at import time (`STAGES = [normalize, chunk, …]`) hold the recorded version.
    Class nodes are only marked (`__karyo_node__`); a method is wrapped when it has a directive of
    its own. Instrumented bytecode is never cached, so a later normal run can't pick it up;
  - runs the hooks file's `setup(karyo)` (karyo_hooks.py: boundary code such as continuing a trace
    from a request's `_meta`, or spans around dynamic dispatch). Its `karyo.on_import(name)`
    callbacks run right after that module is imported;
  - gives every child process started inside a flow the trace context (KARYO_TRACE / KARYO_PARENT),
    so a Go or Python child joins the trace with no code in the app;
  - writes the fragment at exit (atexit) to KARYO_OUT, when anything was declared or recorded.

None of this exists in a normal run: without KARYO_RECORD the bootstrap does nothing and the app
never imports karyo.
"""
from __future__ import annotations

import ast
import atexit
import importlib.abc
import importlib.machinery
import importlib.util
import os
import subprocess
import sys
import threading
from typing import Any, Callable, Optional

import karyo

from . import directives
from .declare import declare, span_targets

_lock = threading.RLock()
_packages: list[str] = []
_callbacks: dict[str, list[Callable[[Any], None]]] = {}
_installed = False
_finder: Optional["_Finder"] = None


def _wanted(name: str) -> bool:
    return any(name == p or name.startswith(p + ".") for p in _packages)


def on_import(module: str) -> Callable[[Callable[[Any], None]], Callable[[Any], None]]:
    def deco(fn: Callable[[Any], None]) -> Callable[[Any], None]:
        with _lock:
            _callbacks.setdefault(module, []).append(fn)
            mod = sys.modules.get(module)
        if mod is not None and getattr(mod, "__spec__", None) is not None and not _initializing(mod):
            fn(mod)
        return fn
    return deco


def _initializing(mod: Any) -> bool:
    return bool(getattr(getattr(mod, "__spec__", None), "_initializing", False))


def _run_callbacks(name: str, module: Any) -> None:
    with _lock:
        fns = list(_callbacks.get(name, ()))
    for fn in fns:
        fn(module)


# ------------------------------------------------------------------ runtime side of the added decorators

def _mark(verb: str, node_id: str, label: Optional[str]) -> Callable[[Any], Any]:
    """The decorator the recorder adds under a directive: mark a class, wrap a function."""
    def deco(obj: Any) -> Any:
        if isinstance(obj, type):
            obj.__karyo_node__ = node_id
            return obj
        return karyo.wrap(obj, node_id, label)
    return deco


def _decorator(verb: str, node_id: str, label: Optional[str], at: ast.AST) -> ast.expr:
    """`__import__('karyo._record', fromlist=['_mark'])._mark(verb, id, label)`, located at `at`."""
    expr = ast.parse(f"__import__('karyo._record', fromlist=['_mark'])._mark({verb!r}, {node_id!r}, {label!r})",
                     mode="eval").body
    for n in ast.walk(expr):
        ast.copy_location(n, at)
        if hasattr(n, "end_lineno"):
            n.end_lineno, n.end_col_offset = at.lineno, getattr(at, "col_offset", 0)
    return expr


def instrument_source(source: str, path: str, module: str) -> tuple[Any, directives.Parsed]:
    """Compile a module with its directives instrumented. Returns (code object, parsed directives)."""
    rel = karyo._rel(path)
    parsed = directives.read(source, rel)
    for p in parsed.problems:
        karyo.check("directive-invalid", f"{p.file}:{p.line}: {p.message}", f"{p.file}:{p.line}")
        print(f"karyo: warning: {p}", file=sys.stderr)
    if parsed.tree is None:
        return compile(source, path, "exec", dont_inherit=True), parsed
    declare(parsed, module, rel, karyo._add_node, karyo._add_edge)
    for d, label in span_targets(parsed):
        node_id = d.attrs["id"] if d.verb == "node" else d.attrs["node"]
        assert d.target is not None
        # innermost (applied first), so staticmethod / property / registering decorators get the wrapped function
        d.target.decorator_list.append(_decorator(d.verb, node_id, label, d.target))
    return compile(parsed.tree, path, "exec", dont_inherit=True), parsed


class _Loader(importlib.machinery.SourceFileLoader):
    """A source loader that instruments directives and never reads or writes cached bytecode."""

    def __init__(self, fullname: str, path: str, transform: bool):
        super().__init__(fullname, path)
        self._transform = transform

    def get_code(self, fullname: str) -> Any:
        if not self._transform:
            return super().get_code(fullname)
        source = self.get_data(self.path).decode("utf-8")
        code, _ = instrument_source(source, self.path, fullname)
        return code

    def exec_module(self, module: Any) -> None:
        super().exec_module(module)
        _run_callbacks(module.__name__, module)


class _CallbackLoader(importlib.abc.Loader):
    """Any other loader, with the hooks' on_import callbacks run after it."""

    def __init__(self, inner: Any):
        self._inner = inner

    def create_module(self, spec: Any) -> Any:
        return self._inner.create_module(spec)

    def exec_module(self, module: Any) -> None:
        self._inner.exec_module(module)
        _run_callbacks(module.__name__, module)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


class _Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, name: str, path: Any, target: Any = None) -> Any:
        transform = _wanted(name)
        if not transform and name not in _callbacks:
            return None
        spec = None
        for f in sys.meta_path:
            if f is self or not hasattr(f, "find_spec"):
                continue
            spec = f.find_spec(name, path, target)
            if spec is not None:
                break
        if spec is None or spec.loader is None:
            return spec
        if isinstance(spec.loader, importlib.machinery.SourceFileLoader) and spec.origin:
            spec.loader = _Loader(name, spec.origin, transform)
        elif name in _callbacks:
            spec.loader = _CallbackLoader(spec.loader)
        return spec


# ------------------------------------------------------------------ child processes

_popen_init = subprocess.Popen.__init__


def _popen(self: Any, args: Any, *a: Any, **kw: Any) -> None:
    ctx = _child_env()
    if ctx and len(a) < 10:                         # env is Popen's 11th parameter; given by keyword in practice
        kw["env"] = {**(kw.get("env") if kw.get("env") is not None else os.environ), **ctx}
    _popen_init(self, args, *a, **kw)


def _child_env() -> dict[str, str]:
    trace = karyo._trace.get()
    if trace is None:
        return {}
    cur = karyo._current.get()
    parent = cur.id if cur else karyo._remote_parent.get()
    return {"KARYO_TRACE": trace, **({"KARYO_PARENT": parent} if parent else {})}


# ------------------------------------------------------------------ install

def _load_hooks(path: str) -> None:
    spec = importlib.util.spec_from_file_location("karyo_hooks", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"karyo: can't load hooks file {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["karyo_hooks"] = mod
    spec.loader.exec_module(mod)
    setup = getattr(mod, "setup", None)
    if not callable(setup):
        raise ImportError(f"karyo: hooks file {path} has no setup(karyo) function")
    setup(karyo)


def _write_at_exit() -> None:
    frag = karyo.fragment()
    if frag["nodes"] or frag["flows"]:
        path = karyo.write(project=os.environ.get("KARYO_PROJECT") or None)
        print(f"karyo: wrote {path}", file=sys.stderr)


def install(packages: list[str], *, hooks: Optional[str] = None, out: Optional[str] = None,
            root: Optional[str] = None) -> None:
    """Start recording in this process (see the module docstring). Idempotent; packages accumulate."""
    global _installed, _finder
    with _lock:
        if root:
            os.environ["KARYO_ROOT"] = os.path.abspath(root)
        if out:
            os.environ["KARYO_OUT"] = os.path.abspath(out)
        for p in packages:
            if p and p not in _packages:
                _packages.append(p)
                early = sorted(m for m in sys.modules if m == p or m.startswith(p + "."))
                if early:
                    print(f"karyo: warning: {', '.join(early)} imported before recording started; "
                          f"their directives are not instrumented", file=sys.stderr)
        karyo._recording = True
        if not _installed:
            _installed = True
            _finder = _Finder()
            sys.meta_path.insert(0, _finder)
            subprocess.Popen.__init__ = _popen  # type: ignore[method-assign]
            if out:
                atexit.register(_write_at_exit)
    if hooks:
        _load_hooks(os.path.abspath(hooks))


def install_from_env() -> None:
    """Called by the bootstrap sitecustomize when KARYO_RECORD is set. KARYO_MONITOR=1 (what `record` sets
    for automatic-mode projects and with --monitor) records with sys.monitoring (karyo/_monitor.py) on
    Python 3.12+; otherwise, or on older Pythons, the listed packages' directives are instrumented at
    import time. Either way the hooks file runs and child processes get the trace context."""
    pk = [p.strip() for p in os.environ.get("KARYO_PACKAGES", "").split(",") if p.strip()]
    out = os.environ.get("KARYO_OUT") or ".karyo"
    root = os.environ.get("KARYO_ROOT") or None
    hooks = os.environ.get("KARYO_HOOKS") or None
    if os.environ.get("KARYO_MONITOR") == "1" and sys.version_info >= (3, 12):
        from . import _monitor
        _monitor.install(pk, sample=karyo._sample_rate(os.environ.get("KARYO_RECORD")), out=out, root=root,
                         project=os.environ.get("KARYO_PROJECT") or None)
        install([], hooks=hooks, root=root)          # hooks, on_import callbacks and child processes; no rewriting
        return
    install(pk, hooks=hooks, out=out, root=root)
