import os
import shutil
import sys
from pathlib import Path

import pytest
from mcp import Client

from karyo_mcp.app import build
from karyo_mcp.cli import REPO, Karyo

HERE = Path(__file__).parent


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def karyo(tmp_path) -> Karyo:
    """The server's view of the CLI, pointed at the fake CLI and a temp workspace."""
    return Karyo(command=[sys.executable, str(HERE / "fake_karyo.py")], workspace=tmp_path / "ws",
                 components=tmp_path / "ws" / "components")


@pytest.fixture(params=["auto", "legacy"])
async def client(request, karyo, tmp_path, monkeypatch):
    """A client on the 2026-07-28 protocol (auto) and on the 2025-11-25 handshake (legacy, what
    Claude Desktop negotiates); every test using it runs against both."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))  # the adenine scope writes under ~
    async with Client(build(karyo), mode=request.param) as c:
        yield c


def core_ready() -> bool:
    return (REPO / "src/explainer/validate.ts").exists() and (REPO / "src/explainer/build.ts").exists() and shutil.which("bun") is not None


slow = pytest.mark.skipif(not core_ready() or os.environ.get("KARYO_SKIP_SLOW") == "1",
                          reason="needs the explainer core (src/explainer/*) and bun")
