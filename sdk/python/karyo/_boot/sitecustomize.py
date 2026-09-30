"""Karyo's recording bootstrap. `python -m karyo record` prepends this directory to PYTHONPATH, so
every Python process of the recorded command imports it at startup (site.py imports
`sitecustomize`). It first runs any other sitecustomize further down sys.path (so a virtualenv's or
distro's own keeps working), then, only when KARYO_RECORD is set, starts the recorder
(karyo._record.install_from_env). Outside a recording this directory is not on the path at all.
"""
import importlib.machinery
import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))


def _chain() -> None:
    """Run the next sitecustomize on sys.path, if there is one."""
    for entry in sys.path:
        if os.path.abspath(entry or os.curdir) == _HERE:
            continue
        spec = importlib.machinery.PathFinder.find_spec("sitecustomize", [entry or os.curdir])
        if spec is None or spec.loader is None or os.path.dirname(os.path.abspath(spec.origin or "")) == _HERE:
            continue
        mod = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(mod)
        except Exception as e:  # a broken sitecustomize must not stop the recording, as site.py wouldn't
            print(f"karyo: error in {spec.origin}: {type(e).__name__}: {e}", file=sys.stderr)
        return


def _start() -> None:
    if os.environ.get("KARYO_RECORD", "") in ("", "0"):
        return
    try:
        import karyo._record as rec
    except ImportError:
        # karyo isn't installed in this interpreter: use the copy this bootstrap belongs to
        sys.path.append(os.path.dirname(os.path.dirname(_HERE)))
        import karyo._record as rec
    try:
        rec.install_from_env()
    except Exception:
        # a broken hooks file would record a wrong picture: stop here, loudly (site.py only catches Exception)
        import traceback
        traceback.print_exc()
        raise SystemExit("karyo: recording setup failed (see above)")


_chain()
_start()
