"""Tests of the Python SDK: directives, the recorder, the decorator form, check-prod.

Recording is process-wide (an import hook, a flag), so everything that records runs in a fresh
subprocess. Run: `just sdk-test`.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

SDK = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SDK))

from karyo import directives  # noqa: E402

APP = '''\
"""A tiny app that declares itself in comments and never imports karyo."""
import os
import subprocess
import sys

# karyo:external id=outside.db kind=store label="A database" category=store


# karyo:node id=app.stage.a label="Stage A" category=stage tags=first
#   tags=early calls=outside.db
def a(x):
    return x + 1


# karyo:node id=app.stage.b category=stage
def b(x):
    return x * 2


STAGES = [a, b]          # built at import time: must hold the recorded versions


# karyo:node id=app.store kind=store label=Store category=store
class Store:
    def __init__(self):
        self.d = {}

    # karyo:span node=app.store label=put
    def put(self, k, v):
        self.d[k] = v

    def peek(self, k):          # no directive: never wrapped
        return self.d.get(k)


# karyo:node id=app.run kind=service calls=app.stage.a,app.stage.b,app.store
async def run(x):
    for s in STAGES:
        x = s(x)
    Store().put("x", x)
    return x


def child_env():
    out = subprocess.run([sys.executable, "-c", "import os; print(os.environ.get('KARYO_TRACE', ''), os.environ.get('KARYO_PARENT', ''))"],
                         capture_output=True, text=True, check=True)
    return out.stdout.split()
'''


@pytest.fixture
def app(tmp_path: Path) -> Path:
    pkg = tmp_path / "app"
    pkg.mkdir()
    (pkg / "__init__.py").write_text(APP)
    return tmp_path


def run_py(code: str, cwd: Path, env: dict | None = None) -> subprocess.CompletedProcess:
    e = {**os.environ, "PYTHONPATH": f"{cwd}{os.pathsep}{SDK}", **(env or {})}
    for k in ("KARYO_RECORD", "KARYO_TRACE", "KARYO_PARENT", "KARYO_PACKAGES", "KARYO_HOOKS"):
        if env is None or k not in env:
            e.pop(k, None)
    return subprocess.run([sys.executable, "-c", textwrap.dedent(code)], cwd=cwd, env=e, capture_output=True, text=True)


# ------------------------------------------------------------------ directives

def test_directives_parse_attach_and_continue():
    p = directives.read(APP, "app/__init__.py")
    assert not p.problems
    by = {(d.verb, d.attrs.get("id") or d.attrs.get("node")): d for d in p.directives}
    a = by[("node", "app.stage.a")]
    assert a.qualname == "a" and a.list("tags") == ["first", "early"] and a.list("calls") == ["outside.db"]
    assert a.start == a.line and a.target is not None and a.target.lineno == a.end + 1
    assert by[("span", "app.store")].qualname == "Store.put"
    assert by[("external", "outside.db")].target is None


@pytest.mark.parametrize("src, needle", [
    ("# karyo:node id=x kind=servce\ndef f(): pass\n", "did you mean 'service'"),
    ("# karyo:node id=x lable=X\ndef f(): pass\n", "no key 'lable'"),
    ("# karyo:nod id=x\ndef f(): pass\n", "unknown directive karyo:nod"),
    ("# karyo:node kind=service\ndef f(): pass\n", "needs id="),
    ("# karyo:node id=x\n\ndef f(): pass\n", "directly above a def"),
    ("# karyo:span node=x\nclass C: pass\n", "not a class"),
    ("x = 1  # karyo:node id=x\n", "on its own line"),
    ("# karyo:node id=x record=maybe\ndef f(): pass\n", "record"),
    ('# karyo:node id=x label="open\ndef f(): pass\n', "unterminated"),
    ("# karyo:edge from=a to=b kind=cals\n", "not a edge kind"),
])
def test_typos_are_problems(src, needle):
    p = directives.read(src, "m.py")
    assert any(needle in pr.message for pr in p.problems), [str(x) for x in p.problems]


def test_directive_text_in_a_string_is_not_a_directive():
    p = directives.read('DOC = """\n# karyo:node id=x kind=nope\n"""\n', "m.py")
    assert not p.problems and not p.directives


def test_scan_reads_directives(app: Path):
    r = subprocess.run([sys.executable, "-m", "karyo", "scan", "app", "--root", "."], cwd=app, capture_output=True, text=True,
                       env={**os.environ, "PYTHONPATH": str(SDK)})
    assert r.returncode == 0, r.stderr
    frag = json.loads(r.stdout)
    nodes = {n["id"]: n for n in frag["nodes"]}
    a = nodes["app.stage.a"]
    assert a["category"] == "stage" and a["tags"] == ["first", "early"] and a["label"] == "Stage A"
    assert a["code"]["text"].startswith("# karyo:node id=app.stage.a") and a["code"]["text"].rstrip().endswith("return x + 1")
    assert a["ref"] == {"file": "app/__init__.py", "line": a["code"]["start"] + 2, "symbol": "a"}
    assert nodes["app.store"]["kind"] == "store" and nodes["outside.db"]["kind"] == "store"
    edges = {(e["from"], e["to"], e["kind"]) for e in frag["edges"]}
    assert ("app.stage.a", "outside.db", "calls") in edges and ("app.run", "app.store", "calls") in edges
    assert "checks" not in frag


def test_scan_warns_on_a_span_of_an_undeclared_node(tmp_path: Path):
    (tmp_path / "m").mkdir()
    (tmp_path / "m" / "__init__.py").write_text("# karyo:span node=nowhere label=x\ndef f(): pass\n")
    r = subprocess.run([sys.executable, "-m", "karyo", "scan", "m"], cwd=tmp_path, capture_output=True, text=True,
                       env={**os.environ, "PYTHONPATH": str(SDK)})
    frag = json.loads(r.stdout)
    assert [c["code"] for c in frag["checks"]] == ["directive-invalid"] and "nowhere" in frag["checks"][0]["message"]
    assert "directive-invalid" in r.stderr


def _scan(cwd: Path, *dirs: str) -> dict:
    r = subprocess.run([sys.executable, "-m", "karyo", "scan", *dirs, "--root", "."], cwd=cwd, capture_output=True, text=True,
                       env={**os.environ, "PYTHONPATH": str(SDK)})
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def _write(root: Path, files: dict[str, str]) -> None:
    for rel, text in files.items():
        f = root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)


@pytest.mark.parametrize("scan_dir", ["src", "src/pkg", "src/pkg/sub"])
def test_scan_names_modules_as_python_imports_them(tmp_path: Path, scan_dir: str):
    # identity: the scan's module ids are the recorder's (the real import names), whatever directory is scanned
    _write(tmp_path, {"src/pkg/__init__.py": "", "src/pkg/sub/__init__.py": "", "src/pkg/sub/m.py": "from . import n\n",
                      "src/pkg/sub/n.py": "# karyo:node id=pkg.n\ndef f(): pass\n"})
    frag = _scan(tmp_path, scan_dir)
    ids = {n["id"] for n in frag["nodes"] if n["kind"] == "module"}
    assert "pkg.sub.m" in ids and "pkg.sub.n" in ids and not any(i.startswith(("src.", "sub.")) for i in ids)
    assert {"from": "pkg.sub.m", "to": "pkg.sub.n", "kind": "imports", "sources": ["extracted"]} in frag["edges"]
    assert next(n for n in frag["nodes"] if n["id"] == "pkg.n")["module"] == "pkg.sub.n"


@pytest.mark.parametrize("first", ["a", "z"])
def test_a_node_named_like_a_module_is_reported_and_kept(tmp_path: Path, first: str):
    # identity: `pkg.z` the module and `pkg.z` the node are one id for two things; the scan says so (the merge refuses it)
    other = "z" if first == "a" else "a"
    _write(tmp_path, {"pkg/__init__.py": "", f"pkg/{first}.py": "# karyo:node id=pkg.z kind=service\ndef f(): pass\n", f"pkg/{other}.py": ""})
    frag = _scan(tmp_path, "pkg")
    z = next(n for n in frag["nodes"] if n["id"] == "pkg.z")
    assert z["kind"] == "service"
    assert any("also the name of module pkg.z" in c["message"] for c in frag.get("checks", []))


def test_scan_reads_only_karyo_edge_calls(tmp_path: Path):
    # identity: another library's `.edge(a, b)` is not a karyo relationship; a karyo one with a bad kind is reported
    _write(tmp_path, {"pkg/__init__.py": "import karyo as k\nfrom karyo import edge as e\nimport graphviz\n"
                      "graphviz.Digraph().edge('x', 'y')\nk.edge('a', 'b', 'reads', label='load')\ne('a', 'c')\nk.edge('a', 'd', 'call')\n"})
    frag = _scan(tmp_path, "pkg")
    rel = {(x["from"], x["to"], x["kind"], x.get("label")) for x in frag["edges"] if x["kind"] != "imports"}
    assert rel == {("a", "b", "reads", "load"), ("a", "c", "calls", None)}
    assert any("'call'" in c["message"] for c in frag["checks"])


def test_scan_edge_sources_add_up(tmp_path: Path):
    _write(tmp_path, {"pkg/__init__.py": "", "pkg/a.py": "from . import b\n# karyo:edge from=pkg.a to=pkg.b kind=imports\n", "pkg/b.py": ""})
    frag = _scan(tmp_path, "pkg")
    imp = [x for x in frag["edges"] if (x["from"], x["to"]) == ("pkg.a", "pkg.b")]
    assert len(imp) == 1 and sorted(imp[0]["sources"]) == ["declared", "extracted"]


# ------------------------------------------------------------------ zero footprint

def test_without_recording_nothing_is_wrapped_and_karyo_is_not_imported(app: Path):
    r = run_py("""
        import sys, app
        assert 'karyo' not in sys.modules
        assert not hasattr(app.a, '__wrapped__') and app.STAGES[0] is app.a
        assert not hasattr(app.Store, '__karyo_node__')
        print('ok')
    """, app)
    assert r.stdout.strip() == "ok", r.stderr


def test_decorator_form_is_a_no_op_unless_recording(app: Path):
    r = run_py("""
        import karyo
        def f(): return 1
        assert karyo.node('x.f')(f) is f
        with karyo.span('x.f') as s:      # no flow: nothing recorded
            assert s is None
        assert karyo.fragment()['nodes'] == [] and karyo.fragment()['flows'] == []
        print('ok')
    """, app)
    assert r.stdout.strip() == "ok", r.stderr


# ------------------------------------------------------------------ recording

def test_instrument_records_directives(app: Path):
    r = run_py("""
        import asyncio, json, karyo
        karyo.instrument(['app'])
        import app
        assert app.STAGES[0] is app.a and hasattr(app.a, '__wrapped__')
        assert app.Store.__karyo_node__ == 'app.store' and not hasattr(app.Store.peek, '__wrapped__')
        with karyo.flow('probe', entry='user'):
            asyncio.run(app.run(1))
            trace = app.child_env()[0]
        f = karyo.fragment()
        spans = f['flows'][0]['spans']
        print(json.dumps({'spans': [(s['node'], s['label']) for s in spans],
                          'parents': [s['parent'] for s in spans], 'ids': [s['id'] for s in spans],
                          'trace': f['flows'][0]['trace'], 'child': [trace],
                          'nodes': sorted(n['id'] for n in f['nodes'])}))
    """, app)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["spans"] == [["app.run", "run()"], ["app.stage.a", "a()"], ["app.stage.b", "b()"], ["app.store", "put"]]
    assert out["parents"][1:] == [out["ids"][0]] * 3
    assert out["child"][0] == out["trace"]           # a child process started in a flow joins the trace
    assert out["nodes"] == ["app.run", "app.stage.a", "app.stage.b", "app.store", "outside.db"]


def test_record_cli_writes_a_fragment_and_runs_hooks(app: Path):
    (app / "hooks.py").write_text(textwrap.dedent("""
        def setup(karyo):
            @karyo.on_import('app')
            def patch(mod):
                mod.Store.peek = karyo.wrap(mod.Store.peek, 'app.store', label='peek')
    """))
    (app / "main.py").write_text(textwrap.dedent("""
        import asyncio, karyo, app
        with karyo.flow('main'):
            asyncio.run(app.run(2))
            app.Store().peek('x')
    """))
    out = app / ".karyo"
    env = {**os.environ, "PYTHONPATH": str(SDK)}
    env.pop("KARYO_RECORD", None)
    r = subprocess.run([sys.executable, "-m", "karyo", "record", "--out", str(out), "--root", str(app), "--package", "app",
                        "--hooks", "hooks.py", "--", sys.executable, "main.py"], cwd=app, env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    frags = list(out.glob("python-*.karyo.json"))
    assert len(frags) == 1, r.stderr
    frag = json.loads(frags[0].read_text())
    labels = [s["label"] for s in frag["flows"][0]["spans"]]
    assert labels == ["run()", "a()", "b()", "put", "peek"]
    assert not list((app / "app").glob("__pycache__/*.pyc")), "instrumented bytecode must never be cached"


# ------------------------------------------------------------------ check-prod

def test_check_prod_strict(app: Path):
    # --strict is the zero-footprint rule: no karyo import at all, karyo not a runtime dependency
    # (the inert default is in test_inert.py)
    env = {**os.environ, "PYTHONPATH": str(SDK)}
    run = lambda *a: subprocess.run([sys.executable, "-m", "karyo", "check-prod", "app", "--strict", *a], cwd=app, env=env,
                                    capture_output=True, text=True)
    ok = run()
    assert ok.returncode == 0, ok.stderr
    (app / "app" / "bad.py").write_text("import os\nfrom karyo import span\n")
    bad = run()
    assert bad.returncode == 1 and "app/bad.py:2" in bad.stderr
    allowed = run("--allow", "bad.py")
    assert allowed.returncode == 0, allowed.stderr
    (app / "pyproject.toml").write_text('[project]\nname = "app"\ndependencies = ["karyo>=0.1"]\n')
    (app / "app" / "bad.py").unlink()
    dep = run()
    assert dep.returncode == 1 and "runtime dependency" in dep.stderr
