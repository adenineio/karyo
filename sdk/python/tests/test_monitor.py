"""The sys.monitoring recorder (karyo/_monitor.py): calls between the project's functions, sampled per
flow, library code disabled after its first call, and the fallback on Pythons without sys.monitoring.

Every recording runs in a fresh subprocess (a monitoring tool is process-wide). Run: `just sdk-test`.
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
pytestmark = pytest.mark.skipif(sys.version_info < (3, 12), reason="sys.monitoring needs Python 3.12+")

APP = '''\
import json


class Store:
    def __init__(self):
        self.d = {}

    def get(self, k):
        return self._norm(self.d.get(k))

    def _norm(self, v):              # transparent: fmt's caller is get
        return fmt(v)

    def put(self, k, v):
        self.d[k] = v


class Sub(Store):                    # an inherited __init__ constructs a Sub
    pass


def fmt(v):
    return json.dumps(v)             # library code: disabled after its first call


def gen(n):
    for i in range(n):
        yield fmt(i)


async def aget(s, k):
    return s.get(k)


def boom():
    raise ValueError("no")


def handle(k):
    s = Store()
    s.put(k, 1)
    list(gen(2))
    try:
        boom()
    except ValueError:
        pass
    return s.get(k)


def never():
    return fmt(0)
'''

MAIN = '''\
import asyncio, app

def test_one():
    app.handle("a")
    app.handle("b")

def test_two():
    s = app.Sub()
    asyncio.run(app.aget(s, "x"))

test_one()
test_two()
'''


@pytest.fixture
def proj(tmp_path: Path) -> Path:
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "__init__.py").write_text(APP)
    (tmp_path / "main.py").write_text(MAIN)
    return tmp_path


def _env(**kw: str) -> dict:
    e = {**os.environ, "PYTHONPATH": str(SDK), **kw}
    for k in ("KARYO_RECORD", "KARYO_TRACE", "KARYO_PARENT", "KARYO_PACKAGES", "KARYO_HOOKS", "KARYO_MONITOR", "KARYO_AUTO"):
        if k not in kw:
            e.pop(k, None)
    return e


def _record(proj: Path, *flags: str, script: str = "main.py", env: dict | None = None) -> dict:
    out = proj / ".karyo"
    r = subprocess.run([sys.executable, "-m", "karyo", "record", "--out", str(out), "--root", str(proj), "--package", "app",
                        *flags, "--", sys.executable, script], cwd=proj, env=env or _env(), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    frags = list(out.glob("python-*.karyo.json"))
    assert len(frags) == 1, r.stderr
    return json.loads(frags[0].read_text())


def _tree(flow: dict) -> list[tuple[str, str | None]]:
    by = {s["id"]: s for s in flow["spans"]}
    return [(s["node"], by[s["parent"]]["node"] if s["parent"] in by else None) for s in flow["spans"]]


def test_monitor_records_calls_between_project_functions(proj: Path):
    frag = _record(proj, "--monitor")
    flows = {f["id"]: f for f in frag["flows"]}
    assert set(flows) == {"test_one", "test_two"}          # a flow per outside caller (the test function)
    one = _tree(flows["test_one"])
    assert one[:9] == [("app.handle", None), ("app.Store", "app.handle"), ("app.Store.put", "app.handle"),
                       ("app.gen", "app.handle"), ("app.fmt", "app.gen"), ("app.fmt", "app.gen"),
                       ("app.boom", "app.handle"), ("app.Store.get", "app.handle"), ("app.fmt", "app.Store.get")]
    assert len(one) == 18                                   # both handle() calls: two root spans, one flow
    boom = next(s for s in flows["test_one"]["spans"] if s["node"] == "app.boom")
    assert boom["status"] == "error" and "ValueError" in boom["attrs"]["error"]
    # an inherited __init__ constructs the subclass; an asyncio task joins the caller's flow
    assert _tree(flows["test_two"]) == [("app.Sub", None), ("app.aget", None), ("app.Store.get", "app.aget"), ("app.fmt", "app.Store.get")]
    assert frag["coverage"] == [{"scope": ["app"], "by": "karyo-py monitor"}]
    ran = {n["id"] for n in frag["nodes"] if "observed" in n["sources"]}
    assert "app.never" not in ran and {"app.handle", "app.fmt", "app.Sub"} <= ran
    spans = [s for f in frag["flows"] for s in f["spans"]]
    assert all(s["end"] >= s["start"] for s in spans)


def test_monitor_is_the_default_for_an_automatic_project(proj: Path):
    frag = _record(proj)                                     # no directives: sys.monitoring, automatic nodes
    assert frag["coverage"] and {f["id"] for f in frag["flows"]} == {"test_one", "test_two"}


def test_library_code_is_disabled_after_its_first_call(proj: Path):
    (proj / "probe.py").write_text(textwrap.dedent('''
        import json, sys, karyo
        karyo.watch("app")
        import app
        from karyo import _monitor
        mon = _monitor.current()
        app.handle("k")                                  # the first call classifies what it reaches
        before, starts = len(mon.codes), mon.starts
        for _ in range(100):
            app.handle("k")
        new, callbacks = len(mon.codes) - before, mon.starts - starts
        codes = {getattr(c, "co_qualname", c.co_name): v for c, v in mon.codes.items()}
        disabled = sorted(q for q, v in codes.items() if v is sys.monitoring.DISABLE)
        print(json.dumps({"disabled": disabled, "nodes": sorted(q for q, v in codes.items() if v is not sys.monitoring.DISABLE),
                          "json_dumps": codes.get("dumps") is sys.monitoring.DISABLE, "new": new,
                          "callbacks": callbacks}))
    '''))
    r = subprocess.run([sys.executable, "probe.py"], cwd=proj, env=_env(KARYO_RECORD="1", KARYO_OUT=str(proj / ".karyo")),
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.splitlines()[-1])
    assert out["json_dumps"], out                            # the standard library: DISABLE
    assert "Store._norm" in out["disabled"]                  # a private helper: DISABLE (its calls are its caller's)
    assert set(out["nodes"]) >= {"handle", "Store.get", "Store.put", "fmt", "gen", "Store.__init__"}
    # classified once: later calls classify nothing new, and only node calls call back (9 per handle(): handle,
    # Store, put, gen, fmt x2, boom, get, fmt); json.dumps, _norm and the rest were disabled
    assert out["new"] == 0 and out["callbacks"] == 900, out


def test_sampling_records_whole_flows(proj: Path):
    (proj / "many.py").write_text(textwrap.dedent('''
        import app
        def request(i):
            app.handle(str(i))
        for i in range(400):
            request(i)
    '''))
    frag = _record(proj, "--monitor", "--sample", "0.1", script="many.py")
    flows = [f for f in frag["flows"] if f["spans"]]
    assert frag["coverage"][0]["sample"] == 0.1
    # a flow is one outside caller frame (each request() call): about 40 of 400 are kept, each whole
    assert 10 <= len(flows) <= 90, len(flows)
    assert all(len(f["spans"]) == 9 and f["spans"][0]["node"] == "app.handle" for f in flows)


def test_span_cap_counts_the_rest_on_relationships(proj: Path):
    frag = _record(proj, "--monitor", env=_env(KARYO_MAX_SPANS="5"))
    kept = sum(len(f["spans"]) for f in frag["flows"])
    assert kept == 5
    counted = {(e["from"], e["to"]): e["count"] for e in frag["edges"] if e.get("count")}
    assert counted[("app.handle", "app.Store.put")] >= 1 and all(e["sources"] == ["observed"] for e in frag["edges"] if e.get("count"))
    assert any(c["code"] == "monitor-capped" for c in frag["checks"])


def test_off_by_default_nothing_is_registered(proj: Path):
    r = subprocess.run([sys.executable, "-c", textwrap.dedent('''
        import sys, karyo
        assert karyo.watch("app") is False
        assert all(sys.monitoring.get_tool(i) is None for i in range(6))
        assert "karyo._monitor" not in sys.modules and "karyo.auto" not in sys.modules
        print("ok")
    ''')], cwd=proj, env=_env(), capture_output=True, text=True)
    assert r.stdout.strip() == "ok", r.stderr


def test_watch_in_app_code_records_when_the_env_says_so(proj: Path):
    (proj / "serve.py").write_text("import karyo\nkaryo.watch('app')\nimport app\ndef request():\n    app.handle('x')\nrequest()\n")
    r = subprocess.run([sys.executable, "serve.py"], cwd=proj, env=_env(KARYO_RECORD="1", KARYO_OUT=str(proj / ".karyo")),
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    frag = json.loads(next((proj / ".karyo").glob("*.json")).read_text())
    assert [f["id"] for f in frag["flows"]] == ["request"]
    r2 = subprocess.run([sys.executable, "serve.py"], cwd=proj, env=_env(), capture_output=True, text=True)
    assert r2.returncode == 0 and "karyo" not in r2.stderr and len(list((proj / ".karyo").glob("*.json"))) == 1


def test_directive_projects_keep_the_import_time_recorder_unless_asked(tmp_path: Path):
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "__init__.py").write_text("# karyo:node id=app.a\ndef a():\n    return b()\n\ndef b():\n    return 1\n")
    (tmp_path / "main.py").write_text("import karyo, app\nwith karyo.flow('f'):\n    app.a()\napp.a()\n")
    old = _record(tmp_path)                                  # directives: instrumented at import, spans inside flows only
    assert "coverage" not in old and [s["node"] for f in old["flows"] for s in f["spans"]] == ["app.a"]
    for f in (tmp_path / ".karyo").glob("*.json"):
        f.unlink()
    new = _record(tmp_path, "--monitor")                     # --monitor: the directive nodes, every call
    assert new["coverage"] and sorted(f["id"] for f in new["flows"]) == ["f", "main"]
    assert {s["node"] for f in new["flows"] for s in f["spans"]} == {"app.a"}   # b is no node without automatic mode


def test_older_pythons_fall_back_to_the_import_time_recorder(proj: Path):
    # what an older Python does (no sys.monitoring): watch() instruments at import time instead
    (proj / "app" / "__init__.py").write_text("# karyo:node id=app.a\ndef a():\n    return 1\n")
    r = subprocess.run([sys.executable, "-c", textwrap.dedent('''
        import sys, karyo
        karyo.watch("app")                                   # KARYO_MONITOR=0 stands in for Python < 3.12
        import app
        assert hasattr(app.a, "__wrapped__") and all(sys.monitoring.get_tool(i) is None for i in range(6))
        print("ok")
    ''')], cwd=proj, env=_env(KARYO_RECORD="1", KARYO_MONITOR="0", KARYO_OUT=str(proj / ".karyo")), capture_output=True, text=True)
    assert r.stdout.strip() == "ok", r.stderr


def test_generated_code_does_not_hide_its_module(tmp_path: Path):
    # a dataclass is built by generated code (`__create_fn__`, co_filename "<string>") that runs with the module's globals
    # at import time: the first code seen from the module, it must not stand in for the module's file (everything else would go unrecorded)
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "__init__.py").write_text("from __future__ import annotations\nfrom dataclasses import dataclass, field\n\n\n@dataclass\nclass Row:\n    x: int\n    tags: list = field(default_factory=list)\n\n\n"
                                                   "def make():\n    return total(Row(1))\n\n\ndef total(r):\n    return r.x\n")
    (tmp_path / "main.py").write_text("import app\nr = app.Row(2)\napp.make()\n")
    frag = _record(tmp_path, "--monitor")
    assert sorted({s["node"] for f in frag["flows"] for s in f["spans"]}) == ["app.Row", "app.make", "app.total"]


def test_generated_constructors_are_constructions(tmp_path: Path):
    """A dataclass's __init__ is generated code (co_filename "<string>"): calling the class still constructs it, a call
    of the class node, as a written __init__ is; a subclass that inherits it is the class built; a class with no
    __init__ of its own is seen where node code constructs it (the CALL event); a class that is no node (private) is
    not recorded. So the static construction wires count as seen when the run makes them."""
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "__init__.py").write_text(textwrap.dedent('''
        from dataclasses import dataclass


        @dataclass
        class Row:
            x: int


        @dataclass
        class Box:
            rows: list

            def __post_init__(self):
                self.n = len(self.rows)


        class Plain(Row):
            pass


        @dataclass
        class _Hidden:
            y: int


        class Bare:                    # no __init__ of its own: object's
            pass


        class Refused(Exception):      # an exception's __init__ (C)
            pass


        def make():
            _Hidden(1)
            Plain(3)
            for _ in range(2):
                Bare()
            try:
                raise Refused("no")
            except Refused:
                pass
            return total(Box([Row(1)]))


        def total(b):
            return b.n
    '''))
    (tmp_path / "main.py").write_text("import app\napp.make()\n")
    frag = _record(tmp_path, "--monitor")
    (flow,) = frag["flows"]
    tree = _tree(flow)
    assert ("app.Plain", "app.make") in tree and ("app.Row", "app.make") in tree and ("app.Box", "app.make") in tree
    assert not any("Hidden" in n for n, _ in tree)
    assert tree.count(("app.Bare", "app.make")) == 2 and ("app.Refused", "app.make") in tree   # seen where node code constructs them
    assert [s["label"] for s in flow["spans"] if s["node"] == "app.Row"] == ["Row()"]
    ran = {n["id"] for n in frag["nodes"] if "observed" in n["sources"]}
    assert {"app.Row", "app.Box", "app.Plain", "app.make", "app.total"} <= ran


def test_directives_refine_automatic_nodes_while_recording(tmp_path: Path):
    """Automatic mode with directives (record --auto, what `karyo record` passes for a project in automatic mode): every
    automatic node is recorded, and a declared node's record says what the scan says (the refined automatic node)."""
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "__init__.py").write_text(textwrap.dedent('''
        # karyo:node label="The store" category=store
        class Store:
            def get(self, k):
                return norm(k)


        def norm(k):
            return k


        def handle(k):
            return Store().get(k)
    '''))
    (tmp_path / "main.py").write_text("import app\napp.handle(1)\n")
    frag = _record(tmp_path, "--monitor", "--auto")
    assert {s["node"] for f in frag["flows"] for s in f["spans"]} == {"app.handle", "app.Store", "app.Store.get", "app.norm"}
    store = next(n for n in frag["nodes"] if n["id"] == "app.Store" and "declared" in n["sources"])
    assert store["label"] == "The store" and store["kind"] == "type" and store["group"] == "app" and store["category"] == "store"
    r = subprocess.run([sys.executable, "-m", "karyo", "scan", "app", "--root", ".", "--auto"], cwd=tmp_path, capture_output=True, text=True,
                       env=_env())
    scanned = next(n for n in json.loads(r.stdout)["nodes"] if n["id"] == "app.Store")
    assert {k: scanned[k] for k in ("label", "kind", "group", "category")} == {k: store[k] for k in ("label", "kind", "group", "category")}
