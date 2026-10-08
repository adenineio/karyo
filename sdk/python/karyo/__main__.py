"""The karyo CLI.

    python -m karyo scan <package-dir> [...] [-o out.karyo.json] [--root DIR] [--auto | --no-auto]
        Read `# karyo:` directives (and @karyo.node / external / edge calls) and the import graph with
        tokenize + ast, without importing or running anything. Writes a model fragment. Malformed
        directives are `directive-invalid` warnings (printed, and in the fragment's checks).
        Automatic mode (--auto; the default when no module has a directive) also makes every class
        and public function a node and adds the static call graph (karyo/auto.py); directives then
        refine the automatic nodes of the defs they sit on. --no-auto: directives only.

    python -m karyo record [--out .karyo] [--root .] [--hooks karyo_hooks.py] [--package app] [--project name]
                           [--monitor | --no-monitor] [--sample 0.01] [--auto | --no-auto] -- <command ...>
        Run a command with recording on (local builds only): every Python process it starts records
        the listed packages and writes its fragment to --out at exit. With sys.monitoring (--monitor;
        the default for automatic-mode projects, Python 3.12+) every call between their functions
        (karyo/_monitor.py); else the directive-marked functions, instrumented at import time
        (karyo/_record.py). --sample records that share of flows.

    python -m karyo check-prod <dir> [...] [--allow karyo_hooks.py,scripts,tests] [--strict]
        Exit 1 unless karyo is inert in the app: app code may use its public API (inert unless
        KARYO_RECORD is set) but not its internals, recording APIs must be guarded, no code or
        deployment config turns recording on, and an app that imports karyo must depend on it.
        --strict: no karyo imports at all and karyo not a runtime dependency (zero footprint).
"""
from __future__ import annotations

import argparse
import ast
import gc
import json
import os
import re
import sys
from concurrent.futures import BrokenExecutor, ProcessPoolExecutor
from datetime import datetime, timezone
from typing import Iterator

from . import __version__, code_excerpt
from . import auto as am
from . import directives as dv
from .declare import declare


def _import_root(d: str) -> str:
    """The sys.path entry a directory's modules are imported from, so scanned module names are the names
    Python (and the recorder) gives them: a package is named from its topmost enclosing package (scanning
    `app/core` still says `app.core.x`), a folder of .py files without __init__.py is a namespace
    package named by its folder, and a folder of packages (a `src/` layout) is itself the root."""
    is_pkg = lambda x: os.path.isfile(os.path.join(x, "__init__.py"))
    if is_pkg(d):
        top = d
        while is_pkg(os.path.dirname(top)) and os.path.dirname(top) != top:
            top = os.path.dirname(top)
        return os.path.dirname(top)
    if any(f.endswith(".py") for f in os.listdir(d)):
        return os.path.dirname(d)
    return d


def _modules(pkg_dirs: list[str]) -> dict[str, str]:
    """module name -> file path, for every .py under the given package directories."""
    mods: dict[str, str] = {}
    for d in pkg_dirs:
        d = os.path.abspath(d)
        base = _import_root(d)
        for root, dirs, files in os.walk(d):
            dirs[:] = [x for x in dirs if not x.startswith((".", "__pycache__"))]
            for f in files:
                if not f.endswith(".py"):
                    continue
                path = os.path.join(root, f)
                rel = os.path.relpath(path, base)[:-3].replace(os.sep, ".")
                name = rel[: -len(".__init__")] if rel.endswith(".__init__") else rel
                mods[name] = path
    return mods


def _lit(n: ast.AST):
    try:
        return ast.literal_eval(n)
    except Exception:
        return None


_karyo_names = am.karyo_names     # how a module refers to karyo
_call_name = am.karyo_call        # the karyo function a call calls, else ""


def _code(rel: str, lines: list[str], n: ast.AST) -> dict:
    """A declaration's source, from its first decorator to its last line."""
    start = n.decorator_list[0].lineno if n.decorator_list else n.lineno
    end = n.end_lineno or n.lineno
    return code_excerpt(rel, lines[start - 1:end], start, end)


# ------------------------------------------------------------------ scan

# Below this much source, starting worker processes costs more than they save (`scan(parallel=True)`).
PARALLEL_MIN_BYTES = 2_000_000
PARALLEL_WORKERS = 2        # they only tokenize (for comments), which two keep well ahead of the rest of the scan


def _comments(texts: list[str], parallel: bool) -> Iterator:
    """Each source's comments (dv.comments_or_error), in order, read by worker processes while this one
    parses and resolves; None for each one left to the scan itself (few sources, or no processes here)."""
    done = 0
    if parallel and len(texts) > 1 and sum(map(len, texts)) >= PARALLEL_MIN_BYTES and (os.cpu_count() or 1) > 1:
        try:
            with ProcessPoolExecutor(max_workers=PARALLEL_WORKERS) as pool:
                for c in pool.map(dv.comments_or_error, texts, chunksize=16):
                    done += 1
                    yield c
        except (OSError, NotImplementedError, BrokenExecutor):
            pass                    # no worker processes to be had: the scan reads the rest itself
    for _ in texts[done:]:
        yield None


def scan(pkg_dirs: list[str], root: str, auto: bool | None = None, parallel: bool = False) -> dict:
    """The static fragment of some package directories. `auto` (automatic mode: every class and public
    function a node, plus the static call graph; karyo/auto.py): None means "when no module declares
    itself", i.e. no `# karyo:` directive and no `@karyo.node` anywhere in them. `parallel`: read the
    files' comments in worker processes when there are enough of them (the CLI does; the fragment is the same)."""
    # the scan makes millions of objects (every module's syntax tree, kept to the end) and next to no cycles:
    # the cyclic garbage collector would only walk them all again and again
    collecting = gc.isenabled()
    gc.disable()
    try:
        return _scan(pkg_dirs, root, auto, parallel)
    finally:
        if collecting:
            gc.enable()


def _scan(pkg_dirs: list[str], root: str, auto: bool | None, parallel: bool) -> dict:
    mods = _modules(pkg_dirs)
    sources: dict[str, str] = {}
    for mod, path in mods.items():
        with open(path, encoding="utf-8") as fh:
            sources[mod] = fh.read()
    if auto is None:
        auto = not am.has_directives(sources.values())
    parsed_mods: dict[str, am.Mod] = {}
    nodes: dict[str, dict] = {}
    where: dict[str, str] = {}          # node id -> file:line of its declaration (duplicates)
    edges: dict[tuple, dict] = {}
    problems: list[dv.Problem] = []
    spans: list[tuple[dv.Directive, str]] = []

    def add_edge(a, b, kind="calls", label=None, source="declared"):
        e = edges.setdefault((a, b, kind), {"from": a, "to": b, "kind": kind, "sources": []})
        if source not in e["sources"]:                # a declared import and an extracted one: both sources
            e["sources"].append(source)
        if label:
            e.setdefault("label", label)

    order = sorted(mods.items())
    for (mod, path), comments in zip(order, _comments([sources[m] for m, _ in order], parallel)):
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        parsed_mods[mod] = am.Mod(mod, path, rel, sources[mod], comments)
        parsed = parsed_mods[mod].parsed
        problems += parsed.problems
        tree, lines = parsed.tree, parsed.lines
        is_pkg = path.endswith("__init__.py")
        # a module is a node of kind module; a declaration that took its name first keeps it (the name
        # clash is reported below, and the merge refuses the model: one id, two things)
        if nodes.get(mod, {}).get("kind", "module") == "module":
            nodes[mod] = {"id": mod, "kind": "module", "label": mod, "group": mod.split(".")[0], "module": mod,
                          "lang": "python", "ref": {"file": rel, "line": 1}, "sources": ["extracted"]}
        if tree is None:
            continue

        # directives (the default way to declare)
        def add_node(n: dict, _rel=rel) -> None:
            nid, cur = n["id"], nodes.get(n["id"])
            if nid in mods:
                problems.append(dv.Problem(_rel, (n.get("ref") or {}).get("line", 1),
                                           f"node id {nid} is also the name of module {nid}; node ids and module names share one namespace: rename the node"))
            if n.get("ref"):                          # a node directive or decorator, on a def or class
                if cur and cur.get("ref") and cur.get("kind") != "module" and "declared" in cur.get("sources", ()):
                    problems.append(dv.Problem(_rel, n["ref"]["line"], f"node {nid} is declared twice (also at {where[nid]})"))
                nodes[nid], where[nid] = n, f"{_rel}:{n['ref']['line']}"
            elif cur is None or cur.get("kind") == "module":   # an external: a richer declaration wins
                nodes[nid] = n
        declare(parsed, mod, rel, add_node, add_edge)
        spans += [(d, rel) for d in parsed.directives if d.verb == "span"]

        pkg = mod if is_pkg else mod.rpartition(".")[0]
        karyo_names = _karyo_names(parsed_mods[mod].found())
        # its imports, defs and calls in ast.walk's order (all this loop looks at); a module that doesn't
        # import karyo makes no karyo calls, and then its imports are all there is to see
        for n in parsed_mods[mod].found(calls=bool(karyo_names[0] or karyo_names[1])):
            # imports between this project's modules
            targets: list[str] = []
            if isinstance(n, ast.Import):
                targets = [a.name for a in n.names]
            elif isinstance(n, ast.ImportFrom):
                if n.level:
                    parts = pkg.split(".")
                    base = ".".join(parts[: len(parts) - (n.level - 1)]) if n.level > 1 else pkg
                    src = f"{base}.{n.module}" if n.module else base
                else:
                    src = n.module or ""
                targets = [f"{src}.{a.name}" if f"{src}.{a.name}" in mods else src for a in n.names]
            for t in targets:
                while t and t not in mods:
                    t = t.rpartition(".")[0]
                if t and t != mod:
                    add_edge(mod, t, "imports", source="extracted")
            # the decorator form (@karyo.node / karyo.external / karyo.edge), still supported
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                for d in n.decorator_list:
                    if isinstance(d, ast.Call) and _call_name(d, karyo_names) == "node" and d.args and isinstance(_lit(d.args[0]), str):
                        kw = {k.arg: _lit(k.value) for k in d.keywords if k.arg}
                        nid = _lit(d.args[0])
                        doc = ast.get_docstring(n)
                        rec = {"id": nid, "kind": kw.get("kind") or "function", "label": kw.get("label") or n.name,
                               "summary": kw.get("summary") or (doc.strip().splitlines()[0] if doc else None),
                               "group": kw.get("group") or mod.split(".")[0], "category": kw.get("category"),
                               "tags": sorted(set(kw.get("tags") or ())) or None, "module": mod, "lang": "python",
                               "ref": {"file": rel, "line": n.lineno, "symbol": n.name},
                               "code": _code(rel, lines, n), "sources": ["declared"]}
                        add_node({k: v for k, v in rec.items() if v is not None})
                        for k in ("calls", "reads", "writes", "publishes"):
                            for t in kw.get(k) or ():
                                add_edge(nid, t, k)
            if isinstance(n, ast.Call) and _call_name(n, karyo_names) == "external" and n.args and isinstance(_lit(n.args[0]), str):
                kw = {k.arg: _lit(k.value) for k in n.keywords if k.arg}
                nid = _lit(n.args[0])
                nodes.setdefault(nid, {k: v for k, v in {
                    "id": nid, "kind": kw.get("kind") or "external", "label": kw.get("label") or nid,
                    "summary": kw.get("summary"), "group": kw.get("group") or nid.split(".")[0],
                    "category": kw.get("category"), "sources": ["declared"]}.items() if v is not None})
            if isinstance(n, ast.Call) and _call_name(n, karyo_names) == "edge" and len(n.args) >= 2:
                a, b = _lit(n.args[0]), _lit(n.args[1])
                kind = _lit(n.args[2]) if len(n.args) > 2 else next((_lit(k.value) for k in n.keywords if k.arg == "kind"), "calls")
                label = _lit(n.args[3]) if len(n.args) > 3 else next((_lit(k.value) for k in n.keywords if k.arg == "label"), None)
                if isinstance(a, str) and isinstance(b, str):
                    if (kind or "calls") not in dv.EDGE_KINDS:
                        problems.append(dv.Problem(rel, n.lineno, f"karyo.edge({a!r}, {b!r}) has kind {kind!r}, not one of {', '.join(dv.EDGE_KINDS)}"))
                    else:
                        add_edge(a, b, kind or "calls", label if isinstance(label, str) else None)

    # automatic mode: a node for every class and public function no directive declares, and the static call graph;
    # a declaration on a def refines that def's automatic node (am.refine) instead of standing beside it
    if auto:
        taken = set(nodes)
        auto_nodes, calls, project = am.extract(parsed_mods, taken)
        for n in auto_nodes:
            nodes[n["id"]] = n
        for m in parsed_mods.values():
            for nid, d in am.declared_defs(m).items():
                if nid in nodes and nodes[nid].get("ref"):
                    am.refine(nodes[nid], d)
        for a, b in calls:
            add_edge(a, b, "calls", source="extracted")

    # a span directive must name a node declared somewhere in what was scanned
    for d, rel in spans:
        if nodes.get(d.attrs["node"], {}).get("kind", "module") == "module":
            problems.append(dv.Problem(rel, d.line, f"karyo:span names node {d.attrs['node']!r}, which no directive declares"))

    frag = {"karyo": 1,
            "producers": [{"name": "karyo-py scan", "lang": "python", "version": __version__,
                           "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}],
            "nodes": [{k: v for k, v in n.items() if v is not None} for n in nodes.values()],
            "edges": list(edges.values()), "flows": []}
    if problems:
        frag["checks"] = [p.check() for p in problems]
    return frag


# ------------------------------------------------------------------ record

def boot_dir() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "_boot")


def record_env(out: str, root: str, packages: list[str], hooks: str | None, project: str | None,
               base: dict | None = None, monitor: bool = False, sample: float = 1.0,
               auto: bool | None = None) -> dict[str, str]:
    """The environment `record` runs its command with."""
    env = dict(os.environ if base is None else base)
    env.update({"KARYO_RECORD": "1" if sample >= 1 else repr(sample), "KARYO_OUT": os.path.abspath(out),
                "KARYO_ROOT": os.path.abspath(root), "KARYO_PACKAGES": ",".join(packages),
                "KARYO_MONITOR": "1" if monitor else "0"})
    if auto is not None:
        env["KARYO_AUTO"] = "1" if auto else "0"
    else:
        env.pop("KARYO_AUTO", None)
    if hooks:
        env["KARYO_HOOKS"] = os.path.abspath(hooks)
    if project:
        env["KARYO_PROJECT"] = project
    pp = env.get("PYTHONPATH")
    env["PYTHONPATH"] = boot_dir() + (os.pathsep + pp if pp else "")
    for k in ("KARYO_TRACE", "KARYO_PARENT"):       # a recording starts its own traces
        env.pop(k, None)
    return env


def _declares_itself(packages: list[str], root: str) -> bool:
    """Does any module of these packages (found under root, or root itself) carry a karyo directive?"""
    dirs = [os.path.join(root, *p.split(".")) for p in packages] or [root]
    texts = []
    for d in dirs:
        for r, sub, files in os.walk(d):
            sub[:] = [x for x in sub if not x.startswith(".") and x not in ("node_modules", "__pycache__", ".venv", "venv", "site-packages")]
            for f in files:
                if f.endswith(".py"):
                    try:
                        with open(os.path.join(r, f), encoding="utf-8") as fh:
                            texts.append(fh.read())
                    except (OSError, UnicodeDecodeError):
                        pass
    return am.has_directives(texts)


def record(a: argparse.Namespace) -> int:
    cmd = list(a.command)
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        print("karyo record: give a command after --, e.g. python -m karyo record --package app -- python -m app", file=sys.stderr)
        return 2
    if a.hooks and not os.path.isfile(a.hooks):
        print(f"karyo record: hooks file {a.hooks} not found", file=sys.stderr)
        return 2
    packages = [p.strip() for x in a.package for p in x.split(",") if p.strip()]
    if not 0 < a.sample <= 1:
        print("karyo record: --sample is a share of flows, 0 < sample <= 1", file=sys.stderr)
        return 2
    monitor = a.monitor
    if monitor is None:                           # the default: sys.monitoring for automatic-mode projects
        monitor = a.auto if a.auto is not None else not _declares_itself(packages, a.root)
    if monitor and sys.version_info < (3, 12):
        print("karyo record: sys.monitoring needs Python 3.12+; using the import-time recorder (directives only)", file=sys.stderr)
        monitor = False
    os.makedirs(a.out, exist_ok=True)
    env = record_env(a.out, a.root, packages, a.hooks, a.project, monitor=monitor, sample=a.sample, auto=a.auto)
    sys.stdout.flush(); sys.stderr.flush()
    if os.name == "posix":
        # replace this process, so whoever started it (an MCP client over stdio, a shell) manages the command itself
        try:
            os.execvpe(cmd[0], cmd, env)
        except FileNotFoundError:
            print(f"karyo record: command not found: {cmd[0]}", file=sys.stderr)
            return 127
    import subprocess
    return subprocess.call(cmd, env=env)


# ------------------------------------------------------------------ check-prod

def _allowed(rel: str, allow: list[str]) -> bool:
    rel = rel.replace(os.sep, "/")
    parts = rel.split("/")
    for a in allow:
        a = a.strip().strip("/")
        if a and (rel == a or rel.startswith(a + "/") or a in parts):
            return True
    return False


def _karyo_imports(tree: ast.AST) -> list[tuple[int, str]]:
    """Every import of karyo in a module (the --strict rule: none at all)."""
    out = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.name == "karyo" or a.name.startswith("karyo."):
                    out.append((n.lineno, f"import {a.name}"))
        elif isinstance(n, ast.ImportFrom) and not n.level and n.module and (n.module == "karyo" or n.module.startswith("karyo.")):
            out.append((n.lineno, f"from {n.module} import …"))
        elif isinstance(n, ast.Call) and n.args and isinstance(_lit(n.args[0]), str):
            f = n.func
            name = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else ""
            mod = _lit(n.args[0])
            if name in ("__import__", "import_module") and (mod == "karyo" or mod.startswith("karyo.")):
                out.append((n.lineno, f"{name}({mod!r})"))
    return out


# The public API app code may use in production: inert unless recording is on (docs/MODEL.md "Inert in production").
INERT_API = {"node", "external", "edge", "watch", "recording", "span", "context", "context_from", "current", "node_of",
             "check", "__version__"}
# Recording APIs: they start recording, write files or keep flows in memory. Dev code (drivers, hooks, tests) only,
# or guarded by `if karyo.recording():` / a KARYO_RECORD test.
RECORDING_API = {"instrument", "flow", "write", "fragment", "reset", "on_import", "wrap"}
_ON = re.compile(r"""KARYO_RECORD\s*[:=]\s*["']?([^\s"',}]*)""")
_OFF = ("", "0", "false", "no", "off")


def _guarded(n: ast.AST, parents: dict) -> bool:
    """Is n inside an `if` (or conditional expression) that tests `recording()` or KARYO_RECORD?"""
    while n in parents:
        p = parents[n]
        if isinstance(p, (ast.If, ast.IfExp, ast.While)) and n is not p.test:
            if any((isinstance(x, ast.Name) and x.id == "recording") or (isinstance(x, ast.Attribute) and x.attr == "recording")
                   or (isinstance(x, ast.Constant) and x.value == "KARYO_RECORD") for x in ast.walk(p.test)):
                return True
        n = p
    return False


def _in_try_import_error(n: ast.AST, parents: dict) -> bool:
    """Is n inside a `try:` whose handlers catch ImportError (an optional import)?"""
    while n in parents:
        p = parents[n]
        if isinstance(p, ast.Try) and any(n is x for x in p.body):
            for h in p.handlers:
                names = [h.type] if not isinstance(h.type, ast.Tuple) else list(h.type.elts)
                if h.type is None or any(isinstance(x, ast.Name) and x.id in ("ImportError", "ModuleNotFoundError", "Exception") for x in names):
                    return True
        n = p
    return False


def _inert_problems(tree: ast.AST) -> tuple[list[tuple[int, str]], bool]:
    """What in a module keeps karyo from being inert, and whether it imports karyo unconditionally."""
    parents = {c: p for p in ast.walk(tree) for c in ast.iter_child_nodes(p)}
    bad: list[tuple[int, str]] = []
    mods: set[str] = set()
    funcs: dict[str, str] = {}
    hard_import = False
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.name == "karyo":
                    mods.add(a.asname or "karyo")
                    hard_import = hard_import or not _in_try_import_error(n, parents)
                elif a.name.startswith("karyo."):
                    bad.append((n.lineno, f"import {a.name}: recorder internals (only the public `karyo` API is inert)"))
        elif isinstance(n, ast.ImportFrom) and not n.level and n.module and (n.module == "karyo" or n.module.startswith("karyo.")):
            if n.module != "karyo":
                bad.append((n.lineno, f"from {n.module} import …: recorder internals (only the public `karyo` API is inert)"))
                continue
            hard_import = hard_import or not _in_try_import_error(n, parents)
            for a in n.names:
                if a.name.startswith("_") or a.name in ("auto", "directives", "declare"):
                    bad.append((n.lineno, f"from karyo import {a.name}: recorder internals"))
                elif a.name in RECORDING_API and not _guarded(n, parents):
                    funcs[a.asname or a.name] = a.name
                elif a.name == "*":
                    bad.append((n.lineno, "from karyo import *: name what you use (the inert API)"))
    for n in ast.walk(tree):
        what = None
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id in mods:
            if n.attr.startswith("_") and n.attr != "__version__" or n.attr in ("auto", "directives", "declare"):
                bad.append((n.lineno, f"{n.value.id}.{n.attr}: recorder internals"))
            elif n.attr in RECORDING_API and isinstance(parents.get(n), ast.Call) and parents[n].func is n:
                what = f"{n.value.id}.{n.attr}(…)"
        elif isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in funcs:
            what = f"{n.func.id}(…)"
        if what and not _guarded(n, parents):
            bad.append((n.lineno, f"{what} records (or keeps flows in memory) unconditionally: guard it with "
                                  f"`if karyo.recording():`, or move it to dev code"))
        # turning recording on from app code
        if isinstance(n, (ast.Assign, ast.Call)):
            key = val = None
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Subscript):
                key, val = _lit(n.targets[0].slice), n.value
            elif isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("setdefault", "putenv", "__setitem__") and len(n.args) >= 2:
                key, val = _lit(n.args[0]), n.args[1]
            if key == "KARYO_RECORD" and str(_lit(val)).strip().lower() not in _OFF:
                bad.append((n.lineno, "sets KARYO_RECORD: app code turns recording on"))
    return bad, hard_import


_CONFIG = re.compile(r"(^|/)(\.env[^/]*|[^/]*\.env|Dockerfile[^/]*|[^/]*compose[^/]*\.ya?ml|Procfile|[^/]*\.service|app\.ya?ml|fly\.toml|[^/]*\.sh)$")


def _config_problems(dirs: list[str], allow: list[str]) -> list[str]:
    """Deployment config (env files, Dockerfiles, compose files, Procfiles, units, scripts) that sets KARYO_RECORD
    to anything but off, in the app's folders and the project folder next to them."""
    out: list[str] = []
    seen: set[str] = set()
    for d in dirs:
        base = d if os.path.isdir(d) else os.path.dirname(d)
        places = [(base, True), (os.path.dirname(base), False)]
        for top, deep in places:
            for root, subs, names in os.walk(top):
                subs[:] = [x for x in subs if deep and not x.startswith(".") and x not in ("node_modules", "__pycache__")
                           and not _allowed(os.path.relpath(os.path.join(root, x), top), allow)] if deep else []
                for f in names:
                    path = os.path.join(root, f)
                    rel = os.path.relpath(path, top).replace(os.sep, "/")
                    if path in seen or not _CONFIG.search("/" + rel) or _allowed(rel, allow):
                        continue
                    seen.add(path)
                    try:
                        text = open(path, encoding="utf-8").read()
                    except (OSError, UnicodeDecodeError):
                        continue
                    for i, line in enumerate(text.splitlines(), 1):
                        if line.lstrip().startswith("#"):
                            continue
                        for m in _ON.finditer(line):
                            if m.group(1).strip().lower() not in _OFF:
                                out.append(f"{os.path.relpath(path)}:{i}: sets KARYO_RECORD={m.group(1)}: recording would be on in production "
                                           f"(remove it; --allow this file if sampling in production is intended)")
    return out


def _runtime_dep(pyproject: str) -> bool:
    """Does this pyproject.toml list karyo in [project] dependencies (not a dev group)?"""
    try:
        import tomllib
        with open(pyproject, "rb") as fh:
            deps = tomllib.load(fh).get("project", {}).get("dependencies", [])
    except Exception:
        try:
            text = open(pyproject, encoding="utf-8").read()
        except OSError:
            return False
        m = re.search(r"^\[project\][^\[]*?^dependencies\s*=\s*\[(.*?)\]", text, re.S | re.M)
        deps = re.findall(r"[\"']([^\"']+)[\"']", m.group(1)) if m else []
    return any(re.match(r"^karyo(\W|$)", d.strip()) for d in deps)


def _py_files(d: str, allow: list[str]) -> list[tuple[str, str]]:
    """(path, path relative to d) of every .py under d (or d itself, a file), minus the allowed ones."""
    if os.path.isfile(d):
        return [(d, os.path.basename(d))]
    out = []
    for root, subdirs, names in os.walk(d):
        subdirs[:] = [x for x in subdirs if not x.startswith((".", "__pycache__")) and x != "node_modules"
                      and not _allowed(os.path.relpath(os.path.join(root, x), d), allow)]
        for f in sorted(names):
            if f.endswith(".py"):
                rel = os.path.relpath(os.path.join(root, f), d)
                if not _allowed(rel, allow):
                    out.append((os.path.join(root, f), rel))
    return out


def check_prod(dirs: list[str], allow: list[str], strict: bool = False) -> int:
    """Inert (default): app code may import karyo's public API (it does nothing unless recording is on), but
    not its internals; recording APIs must be guarded; nothing may turn recording on; and if the app imports
    karyo, a production install must have it. --strict: no karyo imports at all, and karyo not a runtime
    dependency (the zero-footprint rule)."""
    bad: list[str] = []
    files = 0
    importers: list[str] = []
    for d in map(os.path.abspath, dirs):
        for path, _ in _py_files(d, allow):
            files += 1
            shown = os.path.relpath(path)
            try:
                tree = ast.parse(open(path, encoding="utf-8").read(), filename=path)
            except SyntaxError as e:
                bad.append(f"{shown}:{e.lineno}: can't parse ({e.msg})")
                continue
            if strict:
                bad += [f"{shown}:{line}: {what}" for line, what in _karyo_imports(tree)]
                continue
            probs, hard = _inert_problems(tree)
            bad += [f"{shown}:{line}: {what}" for line, what in probs]
            if hard:
                importers.append(shown)
        base = d if os.path.isdir(d) else os.path.dirname(d)
        for pp in (os.path.join(base, "pyproject.toml"), os.path.join(os.path.dirname(base), "pyproject.toml")):
            if os.path.isfile(pp):
                dep = _runtime_dep(pp)
                if strict and dep:
                    bad.append(f"{os.path.relpath(pp)}: karyo is a runtime dependency (move it to [dependency-groups] dev)")
                if not strict and importers and not dep:
                    bad.append(f"{os.path.relpath(pp)}: {importers[0]}{f' (and {len(importers) - 1} more)' if len(importers) > 1 else ''} "
                               f"imports karyo, but it isn't a runtime dependency: a production install would fail to import it "
                               f"(add karyo to [project] dependencies, or import it in a try/except ImportError)")
                break
    if not strict:
        bad += _config_problems([os.path.abspath(x) for x in dirs], allow)
    bad = list(dict.fromkeys(bad))
    if bad:
        what = "the app would need karyo at runtime" if strict else "karyo would not be inert in production"
        print(f"karyo check-prod{' --strict' if strict else ''}: FAIL, {what} ({len(bad)}):", file=sys.stderr)
        for b in bad:
            print(f"  {b}", file=sys.stderr)
        return 1
    if strict:
        print(f"karyo check-prod --strict: ok, {files} module(s), no karyo imports, karyo not a runtime dependency", file=sys.stderr)
    else:
        print(f"karyo check-prod: ok, {files} module(s); karyo is inert: {len(importers)} of them import its public API only, "
              f"no recording API runs unguarded, nothing turns recording on", file=sys.stderr)
    return 0


# ------------------------------------------------------------------ main

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m karyo")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan", help="read directives, annotations and imports statically")
    s.add_argument("packages", nargs="+", help="package directories")
    mode = s.add_mutually_exclusive_group()
    mode.add_argument("--auto", dest="auto", action="store_true", default=None,
                      help="automatic mode: every class and public function a node, plus the static call graph "
                           "(default: on when no module has a karyo directive)")
    mode.add_argument("--no-auto", dest="auto", action="store_false", help="directives and imports only")
    s.add_argument("-o", "--out", help="output file (default: stdout)")
    s.add_argument("--root", default=os.getcwd(), help="paths in refs are relative to this (default: cwd)")
    r = sub.add_parser("record", help="run a command with recording on (local only)")
    r.add_argument("--out", default=".karyo", help="fragment directory (default: .karyo)")
    r.add_argument("--root", default=os.getcwd(), help="paths in refs are relative to this (default: cwd)")
    r.add_argument("--hooks", help="a hooks file with setup(karyo), e.g. karyo_hooks.py (dev only)")
    r.add_argument("--package", action="append", default=[], help="package whose directives to instrument (repeatable, or comma-separated)")
    r.add_argument("--project", help="project name written into the fragments")
    mon = r.add_mutually_exclusive_group()
    mon.add_argument("--monitor", dest="monitor", action="store_true", default=None,
                     help="record every call between the packages' functions with sys.monitoring (Python 3.12+; "
                          "the default for a project with no karyo directives)")
    mon.add_argument("--no-monitor", dest="monitor", action="store_false",
                     help="instrument the directives at import time instead (spans inside karyo.flow() only)")
    r.add_argument("--sample", type=float, default=1.0,
                   help="record this share of flows (e.g. 0.01; a flow is one top-level call from outside the packages)")
    am_ = r.add_mutually_exclusive_group()
    am_.add_argument("--auto", dest="auto", action="store_true", default=None, help="automatic mode's nodes (as scan --auto)")
    am_.add_argument("--no-auto", dest="auto", action="store_false", help="directive nodes only")
    r.add_argument("command", nargs=argparse.REMAINDER, help="-- the command to run")
    c = sub.add_parser("check-prod", help="fail unless karyo is inert in the app's production code")
    c.add_argument("dirs", nargs="+", help="package directories (or files) of the app")
    c.add_argument("--strict", action="store_true", help="no karyo imports at all, and karyo not a runtime dependency")
    c.add_argument("--allow", default="karyo_hooks.py,scripts,tests",
                   help="comma-separated files/directories that may import karyo (default: karyo_hooks.py,scripts,tests)")
    a = ap.parse_args(argv)

    if a.cmd == "record":
        return record(a)
    if a.cmd == "check-prod":
        return check_prod(a.dirs, a.allow.split(","), a.strict)

    # what the scan builds (every module's syntax tree, in reference cycles) is garbage once it is done: the
    # collector would only walk it all again while the fragment is written out
    collecting = gc.isenabled()
    gc.disable()
    frag = scan(a.packages, a.root, a.auto, parallel=True)
    for chk in frag.get("checks", []):
        print(f"karyo: ⚠ {chk['code']} {chk['message']}", file=sys.stderr)
    text = json.dumps(frag, indent=1)
    if a.out:
        os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
        with open(a.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"{a.out}: {len(frag['nodes'])} nodes, {len(frag['edges'])} edges"
              f"{', %d warning(s)' % len(frag['checks']) if frag.get('checks') else ''}", file=sys.stderr)
    else:
        print(text)
    if collecting:
        gc.enable()
    return 0


if __name__ == "__main__":
    status = main()
    gc.freeze()         # exiting: the collector needn't walk what a scan left behind once more
    sys.exit(status)
