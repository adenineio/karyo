"""Automatic mode (karyo/auto.py): nodes for every class and public function, and the static call graph.

The fixture project has the tricky cases: import aliases, module aliases, `self.method()` through an
inherited class, `super()`, attribute types from `__init__` and from class annotations, parameter
annotations (Optional), private helpers (transparent: their calls are their callers'), a lambda, a
shadowing parameter, a reassigned variable, and dynamic calls (`getattr`) that must never become edges.
Run: `just sdk-test`.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SDK = Path(__file__).resolve().parent.parent

STORE = '''\
"""Storage."""


class Base:
    def save(self):
        return True

    def load(self):
        return self._raw()

    def _raw(self):                 # private: its calls are its caller's (load)
        return helper()


class Index:
    def find(self, k):
        return k


class Store(Base):
    """A key-value store."""

    def __init__(self, path: str):
        self.path = path
        self.index = Index()

    def get(self, k):
        self.load()                 # inherited: Base.load
        return self.index.find(k)   # attribute type from __init__: Index.find

    def put(self, k, v):
        super().save()              # super(): Base.save
        return self._check(v)

    def _check(self, v):            # private: inlined into put
        return validate(v)

    @property
    def size(self):                 # a property is an attribute, not a call
        return len(self.path)


def helper():
    return 1


def validate(v):
    return v is not None


def factory() -> Store:
    return Store("f")
'''

API = '''\
"""The API."""
from typing import Optional

import proj.store as st
from proj.store import Store as S, helper as h
from . import store

alias = st.validate


def handler(name):
    s = S("p")                        # an aliased class: instantiation of Store
    s.get(name)                       # a local's type: Store.get
    h()                               # an aliased function
    st.validate(1)                    # a module alias
    store.helper()                    # from . import store
    alias(2)                          # a module-level alias of validate
    getattr(s, "put")(name, 1)        # dynamic: never an edge to Store.put
    fn = getattr(s, name)
    fn()                              # dynamic: nothing
    return use(s)


def use(x: Optional[S]):
    return x.put("a", 1)              # a parameter's annotation: Store.put


def shadowed(helper):
    return helper()                   # the parameter, not proj.store.helper


def reassigned():
    x = S("a")
    x = 5
    return x.get(1)                   # x isn't certainly a Store: no edge to Store.get


def made():
    return factory_store().get(1)     # a return annotation: Store.get


def factory_store() -> "S":
    return st.factory()


class Service:
    store: S                          # a class-level annotation

    def run(self):
        self.store.get("k")           # Store.get through the annotated attribute
        cb = lambda: later()          # a lambda's calls are its enclosing function's
        return cb

    def _private(self):
        return 0


def later():
    return 0

'''

INIT = '''\
def store():                          # proj.store is also a module: this node is proj:store
    return 0
'''


def _write(root: Path, files: dict[str, str]) -> None:
    for rel, text in files.items():
        f = root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)


def _scan(cwd: Path, *args: str) -> dict:
    r = subprocess.run([sys.executable, "-m", "karyo", "scan", *args, "--root", "."], cwd=cwd, capture_output=True, text=True,
                       env={**os.environ, "PYTHONPATH": str(SDK)})
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@pytest.fixture
def proj(tmp_path: Path) -> Path:
    _write(tmp_path, {"proj/__init__.py": INIT, "proj/store.py": STORE, "proj/api.py": API})
    return tmp_path


def _calls(frag: dict) -> set[tuple[str, str]]:
    return {(e["from"], e["to"]) for e in frag["edges"] if e["kind"] == "calls"}


def test_auto_is_the_default_without_directives(proj: Path):
    frag = _scan(proj, "proj")
    nodes = {n["id"]: n for n in frag["nodes"]}
    assert nodes["proj.store.Store"]["kind"] == "type" and nodes["proj.store.Store"]["summary"] == "A key-value store."
    get = nodes["proj.store.Store.get"]
    assert get["kind"] == "function" and get["parent"] == "proj.store.Store" and get["fold"] is True
    assert get["group"] == "proj" and get["module"] == "proj.store" and get["sources"] == ["extracted"]
    assert get["ref"] == {"file": "proj/store.py", "line": get["code"]["start"], "symbol": "Store.get"}
    assert get["code"]["text"].startswith("    def get(self, k):")
    # private helpers, dunders and properties are no nodes
    assert not any(i.endswith(("._raw", "._check", "._private", ".__init__", ".size")) for i in nodes)
    # a function named like a module gets `module:qualname` (ids and module names share one namespace)
    assert "proj:store" in nodes and nodes["proj.store"]["kind"] == "module"
    assert all(e["sources"] == ["extracted"] for e in frag["edges"])


def test_static_call_graph(proj: Path):
    calls = _calls(_scan(proj, "proj"))
    S = "proj.store"
    expected = {
        (f"{S}.Base.load", f"{S}.helper"),               # through the private _raw
        (f"{S}.Store", f"{S}.Index"),                    # __init__ is the class: Store constructs an Index
        (f"{S}.Store.get", f"{S}.Base.load"),            # inherited self.method()
        (f"{S}.Store.get", f"{S}.Index.find"),           # attribute type from __init__
        (f"{S}.Store.put", f"{S}.Base.save"),            # super()
        (f"{S}.Store.put", f"{S}.validate"),             # through the private _check
        (f"{S}.factory", f"{S}.Store"),
        ("proj.api.handler", f"{S}.Store"),              # aliased class
        ("proj.api.handler", f"{S}.Store.get"),          # local variable's type
        ("proj.api.handler", f"{S}.helper"),             # alias, and from . import store
        ("proj.api.handler", f"{S}.validate"),           # module alias, module-level alias
        ("proj.api.handler", "proj.api.use"),
        ("proj.api.use", f"{S}.Store.put"),              # Optional[S] annotation
        ("proj.api.reassigned", f"{S}.Store"),
        ("proj.api.made", "proj.api.factory_store"),
        ("proj.api.made", f"{S}.Store.get"),             # return annotation (a string)
        ("proj.api.factory_store", f"{S}.factory"),
        ("proj.api.Service.run", f"{S}.Store.get"),      # class-level annotation
        ("proj.api.Service.run", "proj.api.later"),      # lambda
    }
    assert expected <= calls, sorted(expected - calls)
    never = {
        ("proj.api.handler", f"{S}.Store.put"),          # getattr(s, "put")(…)
        ("proj.api.shadowed", f"{S}.helper"),            # a parameter shadows the global
        ("proj.api.reassigned", f"{S}.Store.get"),       # x = S(); x = 5
    }
    assert not (never & calls), sorted(never & calls)
    assert calls == expected, sorted(calls - expected)   # nothing else: no guessed edges


def test_unknown_base_classes_stop_method_lookup(tmp_path: Path):
    # a method a base the scan can't see could override is not resolved; known-harmless bases (ABC) are passed
    _write(tmp_path, {"q/__init__.py": "", "q/m.py": '''
import abc
from somewhere import Mixin

class Known(abc.ABC):
    def go(self): return 1

class Mine(Known):
    def run(self): return self.go()

class Mixed(Mixin, Known):
    def run(self): return self.go()      # Mixin could define go(): no edge
'''})
    calls = _calls(_scan(tmp_path, "q"))
    assert ("q.m.Mine.run", "q.m.Known.go") in calls
    assert not any(a == "q.m.Mixed.run" for a, _ in calls)


def test_a_directive_overrides_the_automatic_node(tmp_path: Path):
    _write(tmp_path, {"p/__init__.py": "", "p/m.py": '''
# karyo:node id=p.entry label=Entry kind=service category=api calls=p.m.b
def a():
    return b()

def b():
    return c()

# karyo:span node=p.entry label=c
def c():
    return 0
'''})
    frag = _scan(tmp_path, "p", "--auto")
    nodes = {n["id"]: n for n in frag["nodes"]}
    assert "p.m.a" not in nodes and nodes["p.entry"]["label"] == "Entry" and nodes["p.entry"]["sources"] == ["declared"]
    assert "p.m.c" not in nodes                           # a span of p.entry: part of it
    edges = {(e["from"], e["to"]): e["sources"] for e in frag["edges"] if e["kind"] == "calls"}
    assert sorted(edges[("p.entry", "p.m.b")]) == ["declared", "extracted"]
    assert edges[("p.m.b", "p.entry")] == ["extracted"]


def test_directives_turn_automatic_mode_off_unless_asked(tmp_path: Path):
    _write(tmp_path, {"p/__init__.py": "# karyo:node id=p.one\ndef one():\n    return two()\n\ndef two():\n    return 0\n"})
    plain = _scan(tmp_path, "p")
    assert {n["id"] for n in plain["nodes"]} == {"p", "p.one"} and not _calls(plain)
    auto = _scan(tmp_path, "p", "--auto")
    assert {n["id"] for n in auto["nodes"]} == {"p", "p.one", "p.two"} and _calls(auto) == {("p.one", "p.two")}
    off = _scan(tmp_path, "p", "--no-auto")
    assert off == {**off, "nodes": plain["nodes"]}


REFINED = {"p/__init__.py": "", "p/mail.py": '''
# karyo:external id=ext.smtp label="SMTP relay" category=outside


# karyo:node label="Mail sender" category=adapter tags=network calls=ext.smtp
class Mailer:
    """Sends mail."""

    def send(self, to):
        return self._wire(to)

    def _wire(self, to):
        return to


class Notifier:
    def __init__(self):
        self.mail = Mailer()

    # karyo:node id=p.notify label="Notify" category=service
    def notify(self, who):
        return self.mail.send(who)

    def other(self):
        return self.notify("x")
''', "p/deco.py": '''
import karyo


@karyo.node("p.worker", category="job")
def work():
    return helper()


def helper():
    return 1
'''}


def test_directives_refine_automatic_nodes_without_duplicates(tmp_path: Path):
    """Automatic mode with directives: every automatic node stays, and a directive on a def refines that def's
    node (its label, category, tags, extra relationships) instead of adding one. Without id= it keeps the
    automatic id; with one it renames it. What it doesn't say (kind, group, the class a method folds into)
    stays automatic."""
    _write(tmp_path, REFINED)
    frag = _scan(tmp_path, "p", "--auto")
    nodes = {n["id"]: n for n in frag["nodes"]}
    m = nodes["p.mail.Mailer"]                                   # no id=: the automatic id
    assert m["label"] == "Mail sender" and m["category"] == "adapter" and m["tags"] == ["network"]
    assert m["kind"] == "type" and m["group"] == "p" and m["summary"] == "Sends mail." and sorted(m["sources"]) == ["declared"]
    assert nodes["p.mail.Mailer.send"]["parent"] == "p.mail.Mailer"   # its methods still fold into it
    n = nodes["p.notify"]                                          # id= renames the method's node
    assert "p.mail.Notifier.notify" not in nodes and n["label"] == "Notify" and n["category"] == "service"
    assert n["parent"] == "p.mail.Notifier" and n["fold"] is True and n["kind"] == "function"
    assert nodes["p.worker"]["category"] == "job" and "p.deco.work" not in nodes   # the decorator form too
    assert nodes["p.worker"]["label"] == "work" and nodes["p.worker"]["group"] == "p"
    assert {"p.mail.Notifier", "p.mail.Notifier.other", "p.deco.helper", "ext.smtp"} <= set(nodes)
    calls = {(e["from"], e["to"]): e["sources"] for e in frag["edges"] if e["kind"] == "calls"}
    assert calls[("p.mail.Mailer", "ext.smtp")] == ["declared"]
    assert calls[("p.notify", "p.mail.Mailer.send")] == ["extracted"]
    assert calls[("p.mail.Notifier.other", "p.notify")] == ["extracted"]
    assert calls[("p.worker", "p.deco.helper")] == ["extracted"]
    assert "checks" not in frag
    # directives only: no automatic nodes; the id-less directive still names its def (module.qualname)
    plain = _scan(tmp_path, "p", "--no-auto")
    ids = {x["id"] for x in plain["nodes"] if x["kind"] != "module"}
    assert ids == {"p.mail.Mailer", "p.notify", "p.worker", "ext.smtp"}


def test_ids_that_differ_only_in_case_are_kept_apart(tmp_path: Path):
    # `Chunk` the class and `chunk` the function would be one name to a reader (the model refuses that):
    # the one defined later is written module:qualname, and calls still land on the right one
    _write(tmp_path, {"p/__init__.py": "", "p/m.py": "class Chunk:\n    def __init__(self):\n        pass\n\n\ndef chunk():\n    return Chunk()\n"})
    frag = _scan(tmp_path, "p")
    ids = {n["id"] for n in frag["nodes"] if n["kind"] != "module"}
    assert ids == {"p.m.Chunk", "p.m:chunk"}
    assert _calls(frag) == {("p.m:chunk", "p.m.Chunk")}


REBIND = '''\
class Font:
    def model_copy(self, **kw):
        return self

    def render(self):
        return 1


class Style:
    def __init__(self):
        self.font = Font()

    def rebound(self):
        font = self.font                   # resolves: Font
        font = font.model_copy()           # a name rebound from itself
        return font.render()

    def cycle(self):
        a = Font()
        b = a
        a = b.model_copy()                 # two names that lean on each other
        b = a
        return b.render()

    def augmented(self):
        f = Font()
        f = f.model_copy().model_copy()
        return f.render()
'''


def test_a_name_rebound_from_itself_does_not_recurse(tmp_path: Path):
    """`x = y; x = x.method()` makes x's value depend on x (and two names can lean on each other): the scan
    reads such a name as unknown instead of recursing, and so draws no call it can't prove."""
    _write(tmp_path, {"rb/__init__.py": "", "rb/style.py": REBIND})
    frag = _scan(tmp_path, "rb")
    ids = {n["id"] for n in frag["nodes"]}
    assert {"rb.style.Font", "rb.style.Style"} <= ids
    calls = _calls(frag)
    assert ("rb.style.Style", "rb.style.Font") in calls          # __init__ builds a Font: still resolved


def test_reading_comments_in_worker_processes_changes_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A big project's comments (where directives live) are read in worker processes while the scan parses
    (the CLI's `scan(parallel=True)`, from PARALLEL_MIN_BYTES of source): the fragment is the same, problems
    included, and so it is when no worker process can be started."""
    from karyo import __main__ as cli
    _write(tmp_path, {"proj/__init__.py": INIT, "proj/store.py": STORE, "proj/api.py": API,
                      "proj/broken.py": "def f(:\n", "proj/marked.py": "x = 1  # karyo:node id=a.b\n"})

    def fragment(parallel: bool) -> str:
        frag = cli.scan([str(tmp_path / "proj")], str(tmp_path), None, parallel=parallel)
        frag["producers"][0].pop("at")
        return json.dumps(frag, indent=1)

    serial = fragment(False)
    assert "not valid Python" in serial and "must be a comment on its own line" in serial
    pools = []
    real_pool = cli.ProcessPoolExecutor
    monkeypatch.setattr(cli, "PARALLEL_MIN_BYTES", 0)
    monkeypatch.setattr(cli, "ProcessPoolExecutor", lambda **kw: pools.append(kw) or real_pool(**kw))
    assert fragment(True) == serial
    assert pools, "the comments were not read in worker processes"

    def no_processes(**kw):
        raise OSError("no processes here")
    monkeypatch.setattr(cli, "ProcessPoolExecutor", no_processes)
    assert fragment(True) == serial
