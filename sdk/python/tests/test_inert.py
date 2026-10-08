"""Inert in production: `import karyo` is cheap, the decorator returns what it decorates, nothing is
registered while recording is off, check-prod enforces it, and a project folder named `karyo/` doesn't
shadow the package. Run: `just sdk-test`.
"""
from __future__ import annotations

import importlib.metadata
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

SDK = Path(__file__).resolve().parent.parent
IMPORT_BUDGET_MS = 15.0     # the import takes well under 1 ms warm; the budget leaves room for a busy CI machine


def _py(code: str, cwd: Path, env: dict | None = None, pythonpath: bool = True) -> subprocess.CompletedProcess:
    e = {**os.environ, **(env or {})}
    if pythonpath:
        e["PYTHONPATH"] = str(SDK)
    else:
        e.pop("PYTHONPATH", None)
    for k in ("KARYO_RECORD", "KARYO_TRACE", "KARYO_PARENT", "KARYO_MONITOR"):
        if not env or k not in env:
            e.pop(k, None)
    return subprocess.run([sys.executable, "-c", textwrap.dedent(code)], cwd=cwd, env=e, capture_output=True, text=True)


# ------------------------------------------------------------------ benchmark: the cost of karyo when it's off

def test_import_is_cheap(tmp_path: Path):
    r = _py('''
        import time
        t = time.perf_counter()
        import karyo
        ms = (time.perf_counter() - t) * 1000
        import sys
        heavy = sorted(m for m in ("inspect", "json", "secrets", "threading", "dataclasses", "datetime", "typing", "ast",
                                    "karyo._monitor", "karyo._record", "karyo.auto", "karyo.directives") if m in sys.modules)
        print(ms, " ".join(heavy))
    ''', tmp_path)
    assert r.returncode == 0, r.stderr
    # the best of a few runs (the first may compile bytecode)
    runs = [float(r.stdout.split()[0])] + [float(_py("import time; t = time.perf_counter(); import karyo; "
                                                   "print((time.perf_counter() - t) * 1000)", tmp_path).stdout) for _ in range(4)]
    assert min(runs) < IMPORT_BUDGET_MS, runs
    # nothing heavy is imported by karyo itself (the interpreter may have some of these already)
    base = _py("import sys; print(' '.join(sorted(m for m in ('inspect', 'json', 'secrets', 'threading', 'dataclasses', "
               "'datetime', 'typing', 'ast') if m in sys.modules)))", tmp_path).stdout.split()
    extra = set(r.stdout.split()[1:]) - set(base)
    assert not extra, extra


def test_off_means_no_wrappers_and_no_monitoring(tmp_path: Path):
    r = _py('''
        import sys, karyo
        def f(): return 1
        class C: pass
        assert karyo.node("x.f", calls=["x.g"])(f) is f          # the decorator returns the function itself
        assert karyo.node("x.c", kind="type")(C) is C and not hasattr(C, "__karyo_node__")
        karyo.external("db"); karyo.edge("x.f", "db")           # inert: nothing registered
        assert karyo.fragment()["nodes"] == [] and karyo.fragment()["edges"] == []
        assert karyo.watch("app") is False and not karyo.recording()
        assert all(sys.monitoring.get_tool(i) is None for i in range(6))
        assert not [m for m in sys.modules if m.startswith("karyo.")]
        with karyo.span("x.f") as s:
            assert s is None                                     # outside a flow a span records nothing
        print("ok")
    ''', tmp_path)
    assert r.stdout.strip() == "ok", r.stderr


def test_per_call_cost_when_off_is_zero(tmp_path: Path):
    # the decorated function *is* the function: its call costs exactly what an undecorated call costs
    r = _py('''
        import karyo, timeit
        def f(x): return x + 1
        g = karyo.node("x.f")(f)
        print(g is f)
    ''', tmp_path)
    assert r.stdout.strip() == "True", r.stderr


# ------------------------------------------------------------------ a project folder named karyo/ (splices) must not shadow the package

@pytest.mark.skipif(not any(d.metadata["Name"] == "karyo" for d in importlib.metadata.distributions()),
                    reason="karyo isn't installed in this interpreter (run through `just sdk-test`)")
def test_a_karyo_folder_in_the_project_does_not_shadow_the_package(tmp_path: Path):
    (tmp_path / "karyo" / "splices").mkdir(parents=True)      # what a project with saved splices has
    (tmp_path / "karyo" / "splices" / "a.splice.json").write_text("{}")
    r = _py("import karyo; print(karyo.__file__, karyo.__version__)", tmp_path, pythonpath=False)
    assert r.returncode == 0 and r.stdout.split()[0].endswith(os.path.join("karyo", "__init__.py")), r.stdout + r.stderr
    cli = subprocess.run([sys.executable, "-m", "karyo", "check-prod", "--help"], cwd=tmp_path, capture_output=True, text=True,
                         env={k: v for k, v in os.environ.items() if k != "PYTHONPATH"})
    assert cli.returncode == 0, cli.stderr


# ------------------------------------------------------------------ check-prod: inert by default, --strict for zero footprint

def _check(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-m", "karyo", "check-prod", "app", *args], cwd=root, capture_output=True, text=True,
                          env={**os.environ, "PYTHONPATH": str(SDK)})


def _app(root: Path, files: dict[str, str], dep: bool = True) -> None:
    (root / "app").mkdir(exist_ok=True)
    for rel, text in files.items():
        (root / "app" / rel).write_text(textwrap.dedent(text))
    (root / "pyproject.toml").write_text('[project]\nname = "app"\ndependencies = [%s]\n' % ('"karyo>=0.1"' if dep else ""))


def test_check_prod_allows_the_inert_api(tmp_path: Path):
    _app(tmp_path, {"__init__.py": '''
        import karyo

        karyo.watch("app")                     # inert unless KARYO_RECORD is set

        @karyo.node("app.run", calls=["app.db"])
        def run():
            with karyo.span("app.run"):
                return karyo.context()

        if karyo.recording():
            karyo.write()                      # guarded: fine
    '''})
    r = _check(tmp_path)
    assert r.returncode == 0, r.stderr
    strict = _check(tmp_path, "--strict")
    assert strict.returncode == 1 and "app/__init__.py:2: import karyo" in strict.stderr and "runtime dependency" in strict.stderr


@pytest.mark.parametrize("code, needle", [
    ("from karyo import _monitor\n", "recorder internals"),
    ("import karyo._record\n", "recorder internals"),
    ("import karyo\nkaryo._record.install([])\n", "recorder internals"),
    ("import karyo\nkaryo.instrument(['app'])\n", "karyo.instrument(…) records"),
    ("import karyo\nwith karyo.flow('x'):\n    pass\n", "karyo.flow(…) records"),
    ("from karyo import write as w\nw()\n", "w(…) records"),
    ("import os\nos.environ['KARYO_RECORD'] = '1'\n", "turns recording on"),
    ("import os\nos.environ.setdefault('KARYO_RECORD', '0.01')\n", "turns recording on"),
])
def test_check_prod_fails_what_is_not_inert(tmp_path: Path, code: str, needle: str):
    _app(tmp_path, {"__init__.py": code})
    r = _check(tmp_path)
    assert r.returncode == 1 and needle in r.stderr, r.stderr


def test_check_prod_needs_karyo_installed_when_the_app_imports_it(tmp_path: Path):
    _app(tmp_path, {"__init__.py": "import karyo\n"}, dep=False)
    r = _check(tmp_path)
    assert r.returncode == 1 and "isn't a runtime dependency" in r.stderr
    _app(tmp_path, {"__init__.py": "try:\n    import karyo\nexcept ImportError:\n    karyo = None\n"}, dep=False)
    assert _check(tmp_path).returncode == 0                    # an optional import is fine


def test_check_prod_fails_config_that_turns_recording_on(tmp_path: Path):
    _app(tmp_path, {"__init__.py": ""})
    (tmp_path / "Dockerfile").write_text("FROM python:3.13\nENV KARYO_RECORD=1\n")
    r = _check(tmp_path)
    assert r.returncode == 1 and "Dockerfile:2: sets KARYO_RECORD=1" in r.stderr
    (tmp_path / "Dockerfile").write_text("FROM python:3.13\nENV KARYO_RECORD=0\n")
    (tmp_path / "app" / ".env").write_text("# KARYO_RECORD=1 (commented out)\nOTHER=1\n")
    assert _check(tmp_path).returncode == 0
