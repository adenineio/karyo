"""The real thing: the server driving the real karyo CLI (bun, the explainer core, headless Chrome).
Skipped when the core is missing. One test runs in process (both protocol modes); one launches
`karyo-mcp` over stdio, as Claude Desktop does."""
import base64
import io
import json
import os
import shutil
from pathlib import Path

import pytest
from mcp import Client, StdioServerParameters
from mcp.types import ImageContent
from PIL import Image

from conftest import slow
from karyo_mcp.app import build
from karyo_mcp.cli import Karyo, resolve_command

pytestmark = [pytest.mark.anyio, pytest.mark.slow, slow]

SPEC = {
    "karyo": "explainer/1",
    "id": "handshake",
    "title": "The TCP handshake",
    "elements": [
        {"id": "client", "type": "card", "props": {"title": "Client", "body": "Wants to talk"}},
        {"id": "server", "type": "card", "props": {"title": "Server", "body": "Listening on :443"}},
        {"id": "count", "type": "tally", "props": {"label": "Packets", "n": 1}},
    ],
    "uses": ["tally"],
    "links": [{"id": "syn", "from": "client", "to": "server", "label": "SYN"}],
    "steps": [
        {"title": "Two machines", "text": "A client and a server, not yet connected.", "show": ["client", "server"], "connect": []},
        {"title": "SYN", "text": "The client asks to open a connection.", "add": ["count"], "emphasize": ["client"]},
    ],
}


TALLY = {
    "name": "tally", "description": "A label and a counted number.", "version": "0.1.0",
    "props": {"type": "object", "required": ["label", "n"], "additionalProperties": False,
              "properties": {"label": {"type": "string"}, "n": {"type": "number"}}},
    "size": {"w": 200}, "example": {"label": "Packets", "n": 3},
}


async def _component(c: Client, ws: Path):
    r = await c.call_tool("create_component", {"name": "tally", "component_json": TALLY, "scope": "workspace",
                                               "template_html": '<div class="pl-card box"><div class="pl-label">{{label}}</div><b data-k-num="n">{{n}}</b></div>',
                                               "style_css": "b { font: 800 32px/1 var(--pl-font-display); color: var(--pl-accent); }"})
    assert not r.is_error, r.content[0].text
    assert r.structured_content["ok"], r.structured_content["issues"]
    assert (ws / "components" / "tally" / "template.html").exists()
    r = await c.call_tool("create_component", {"name": "broken", "component_json": {**TALLY, "name": "broken", "example": {"label": 1}},
                                               "template_html": "{{#if label}}", "scope": "workspace"})
    assert not r.is_error and not r.structured_content["ok"]
    assert {i["path"] for i in r.structured_content["issues"]} >= {"/example/label", ""}
    assert not (ws / "components" / "broken").exists()
    r = await c.call_tool("list_components", {})
    assert {"name": "tally", "source": "env"}.items() <= next(x for x in r.structured_content["components"] if x["name"] == "tally").items()


async def _loop(c: Client, ws: Path):
    await _component(c, ws)
    r = await c.call_tool("new_explainer", {"id": "handshake", "title": "The TCP handshake", "template": "steps"})
    assert not r.is_error, r.content[0].text
    assert r.structured_content["ok"], r.structured_content["issues"]  # the starter is valid as written
    r = await c.call_tool("write_explainer", {"id": "handshake", "spec_json": json.dumps(SPEC)})
    assert not r.is_error, r.content[0].text
    assert r.structured_content["ok"], r.structured_content["issues"]
    r = await c.call_tool("preview_explainer", {"id": "handshake", "step": "all"}, read_timeout_seconds=230)
    assert not r.is_error, r.content[0].text
    images = [b for b in r.content if isinstance(b, ImageContent)]
    assert len(images) == 2
    assert "Issues" not in r.content[0].text, r.content[0].text  # e.g. the page not finding the custom component
    im = Image.open(io.BytesIO(base64.b64decode(images[0].data)))
    assert 320 <= im.width <= 1600
    r = await c.call_tool("build_explainer", {"id": "handshake"}, read_timeout_seconds=230)
    assert not r.is_error, r.content[0].text
    html = Path(r.structured_content["html"])
    assert html == ws / "handshake" / "handshake.html" and html.stat().st_size == r.structured_content["bytes"]
    text = html.read_text()
    assert "The TCP handshake" in text and "<script" in text


@pytest.fixture(params=["auto", "legacy"])
def mode(request):
    return request.param


async def test_in_process(tmp_path, mode):
    k = Karyo(command=resolve_command(), workspace=tmp_path / "ws", components=tmp_path / "ws" / "components")
    async with Client(build(k), mode=mode) as c:
        await _loop(c, tmp_path / "ws")


async def test_stdio_round_trip(tmp_path):
    ws = tmp_path / "ws"
    uv = shutil.which("uv") or "/opt/homebrew/bin/uv"
    params = StdioServerParameters(command=uv, args=["--directory", str(Path(__file__).parents[1]), "run", "karyo-mcp"],
                                   env={"KARYO_WORKSPACE": str(ws), "PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path / "home")})
    async with Client(params) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert {"new_explainer", "write_explainer", "preview_explainer", "build_explainer"} <= names
        await _loop(c, ws)
