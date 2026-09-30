"""The server against the fake CLI: catalog, each tool, errors reaching the model, images coming back."""
import base64
import io
import json

import pytest
from mcp.types import ImageContent, TextContent
from PIL import Image

pytestmark = pytest.mark.anyio


async def call(c, tool, **args):
    r = await c.call_tool(tool, args)
    assert not r.is_error, r.content[0].text
    return r.structured_content


async def test_catalog_is_annotated(client):
    tools = {t.name: t for t in (await client.list_tools()).tools}
    assert set(tools) == {"list_components", "get_component", "create_component", "new_explainer", "write_explainer",
                          "validate_explainer", "preview_explainer", "build_explainer", "list_explainers"}
    for ro in ("list_components", "get_component", "validate_explainer", "preview_explainer", "list_explainers"):
        assert tools[ro].annotations.read_only_hint is True, ro
    for w in ("create_component", "new_explainer", "write_explainer", "build_explainer"):
        assert tools[w].annotations.read_only_hint is False, w
    assert tools["write_explainer"].annotations.destructive_hint is True
    assert tools["new_explainer"].annotations.destructive_hint is False
    assert tools["validate_explainer"].output_schema["properties"]["issues"]["type"] == "array"
    assert tools["preview_explainer"].output_schema is None  # images, not data


async def test_resources_and_prompt(client):
    uris = {str(r.uri) for r in (await client.list_resources()).resources}
    assert {"karyo://docs/explainers", "karyo://components"} <= uris
    comps = json.loads((await client.read_resource("karyo://components")).contents[0].text)
    assert comps["components"][0]["name"] == "card"
    p = await client.get_prompt("explain-visually", {"topic": "TCP handshakes", "audience": "new engineers"})
    text = p.messages[0].content.text
    assert "TCP handshakes" in text and "new engineers" in text and "preview_explainer" in text


async def test_explainer_loop(client, karyo):
    made = await call(client, "new_explainer", id="tcp", title="TCP handshake", template="steps")
    assert made["ok"] and made["path"].endswith("tcp/tcp.explainer.json") and made["spec"]["title"] == "TCP handshake"
    assert (karyo.workspace / "tcp" / "components").is_dir()

    r = await client.call_tool("new_explainer", {"id": "tcp", "title": "again"})
    assert r.is_error and "already exists" in r.content[0].text

    spec = {"karyo": "explainer/1", "title": "TCP", "steps": [{"title": "SYN"}, {"title": "SYN-ACK"}, {}]}
    w = await call(client, "write_explainer", id="tcp", spec_json=json.dumps(spec))  # a JSON string, as Desktop sends
    assert w["ok"] and [i["path"] for i in w["issues"]] == ["/steps/2/title"]
    w = await call(client, "write_explainer", id="tcp", spec_json={"title": "no version"})
    assert not w["ok"] and w["issues"][0]["hint"]
    v = await call(client, "validate_explainer", id="tcp")
    assert not v["ok"]

    r = await client.call_tool("preview_explainer", {"id": "tcp"})
    assert r.is_error and "fix them first" in r.content[0].text
    r = await client.call_tool("build_explainer", {"id": "tcp"})
    assert r.is_error and "/karyo" in r.content[0].text

    await call(client, "write_explainer", id="tcp", spec_json=spec)
    listed = await call(client, "list_explainers")
    assert [(e["id"], e["steps"], e["html"]) for e in listed["explainers"]] == [("tcp", 3, None)]
    built = await call(client, "build_explainer", id="tcp")
    assert built["html"].endswith("tcp/tcp.html") and built["bytes"] > 0 and built["size"].endswith("KB")
    assert (await call(client, "list_explainers"))["explainers"][0]["html"] == built["html"]


async def test_preview_returns_small_images(client):
    await call(client, "new_explainer", id="many", title="Many")
    await call(client, "write_explainer", id="many", spec_json={"karyo": "explainer/1", "title": "Many",
                                                                  "steps": [{"title": f"s{i}"} for i in range(8)]})
    r = await client.call_tool("preview_explainer", {"id": "many", "step": "all"})
    assert not r.is_error
    text, *imgs = r.content
    assert isinstance(text, TextContent) and "step='7-8'" in text.text
    assert len(imgs) == 6 and all(isinstance(i, ImageContent) and i.mime_type == "image/jpeg" for i in imgs)  # auto: many → JPEG
    im = Image.open(io.BytesIO(base64.b64decode(imgs[0].data)))
    assert im.width == 1280  # 1600 px stills are scaled down
    r = await client.call_tool("preview_explainer", {"id": "many", "step": 2})
    assert len(r.content) == 2 and r.content[1].mime_type == "image/jpeg"  # auto: JPEG (Desktop size cap)
    r = await client.call_tool("preview_explainer", {"id": "many", "step": "3-4", "format": "png", "max_width": 800})
    assert len(r.content) == 3 and Image.open(io.BytesIO(base64.b64decode(r.content[2].data))).width == 800
    assert "step 3 (s2); step 4 (s3)" in r.content[0].text
    r = await client.call_tool("preview_explainer", {"id": "many", "step": 9})
    assert r.is_error and "has 8 step(s)" in r.content[0].text


async def test_unknown_things_are_model_errors(client):
    r = await client.call_tool("validate_explainer", {"id": "nope"})
    assert r.is_error and "new_explainer makes one" in r.content[0].text
    r = await client.call_tool("get_component", {"name": "nope"})
    assert r.is_error and 'no component "nope"' in r.content[0].text
    r = await client.call_tool("new_explainer", {"id": "Bad Id", "title": "x"})
    assert r.is_error
    r = await client.call_tool("write_explainer", {"id": "x", "spec_json": "{not json"})
    assert r.is_error and "isn't valid JSON" in r.content[0].text


async def test_components(client, karyo, tmp_path):
    lst = await call(client, "list_components")
    assert lst["components"][0] == {"name": "card", "source": "builtin", "description": "A titled card.", "dir": "/repo/components/card"}
    card = await call(client, "get_component", name="card")
    assert card["props"]["properties"]["title"]["type"] == "string" and card["example"]["component"] == "card"

    meta = {"description": "A lane of queued items.", "props": {"type": "object"}, "example": {}}
    made = await call(client, "create_component", name="queue-lane", component_json=json.dumps(meta),
                      template_html="<div class='lane'></div>", style_css=".lane{color:var(--pl-fg)}")
    assert made["ok"] and made["dir"] == str(karyo.components / "queue-lane")
    assert (karyo.components / "queue-lane" / "template.html").read_text() == "<div class='lane'></div>"
    assert not [p for p in karyo.components.iterdir() if p.name.startswith(".staging")]

    r = await client.call_tool("create_component", {"name": "queue-lane", "component_json": meta, "template_html": "x"})
    assert r.is_error and "replace=true" in r.content[0].text

    bad = await call(client, "create_component", name="broken", component_json={"props": {}}, template_html="x", scope="adenine")
    assert not bad["ok"] and bad["issues"][0]["path"] == "/description"
    assert not (tmp_path / "home/.adenine/karyo/components/broken").exists()  # a failing component isn't installed
    good = await call(client, "create_component", name="lane", component_json=meta, template_html="x", scope="adenine")
    assert good["dir"] == str(tmp_path / "home/.adenine/karyo/components/lane")
