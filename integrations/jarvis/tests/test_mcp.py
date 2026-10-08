"""karyo-view against a fake /action endpoint, through an in-process MCP client in both protocol modes."""
import json

import httpx
import pytest
from mcp import Client

from jarvis.view_mcp import build

pytestmark = pytest.mark.anyio

SPLICE_TOOLS = {"splice_open", "splice_add", "splice_group", "splice_connect", "splice_disconnect", "splice_remove", "splice_replace", "splice_rename", "splice_move",
                "splice_undo", "splice_redo", "splice_save", "splice_discard", "splice_leave", "splice_list",
                "splice_stack", "splice_stack_open", "splice_stack_return", "splice_stack_leave", "splice_stack_conflict",
                "splice_stack_swap", "splice_stack_same"}
ACTION_TOOLS = {"focus", "open", "close", "drill", "back", "highlight", "clear", "show_details", "scroll", "step", "select",
                "theater", "fan", "bench", "pin_inspector", "zoom", "pan", "groups"} | SPLICE_TOOLS


class FakeServer:
    """The Jarvis server's loopback HTTP: records actions; refuses what the 'plate' doesn't support."""

    def __init__(self):
        self.actions: list[tuple[str, dict]] = []
        self.snapshot = {"plate": "board", "nodes": [{"id": "pipeline", "label": "Pipeline tools"}]}

    def __call__(self, req: httpx.Request) -> httpx.Response:
        if req.method == "GET" and req.url.path == "/view":
            return httpx.Response(200, json={"connected": True, "scene": "orders-board", "snapshot": self.snapshot})
        if req.method == "POST" and req.url.path == "/action":
            assert req.headers["content-type"] == "application/json"
            body = json.loads(req.content)
            self.actions.append((body["name"], body["args"]))
            if body["name"] == "fan":
                return httpx.Response(200, json={"id": "a1", "ok": False, "error": "this plate doesn't fan out"})
            if body["name"] == "focus" and body["args"]["target"] == "nowhere":
                return httpx.Response(200, json={"id": "a2", "ok": False, "error": "no node or group 'nowhere'"})
            return httpx.Response(200, json={"id": "a3", "ok": True, "state": {"did": body["name"]}})
        return httpx.Response(404, json={"ok": False, "error": "no route"})


@pytest.fixture
def fake():
    return FakeServer()


@pytest.fixture(params=["auto", "legacy"])
async def client(request, fake):
    async with Client(build("http://127.0.0.1:5190", transport=httpx.MockTransport(fake)), mode=request.param) as c:
        yield c


async def call(c, tool, **args):
    r = await c.call_tool(tool, args)
    assert not r.is_error, r.content[0].text
    return r.structured_content


async def test_catalog(client):
    tools = {t.name: t for t in (await client.list_tools()).tools}
    assert set(tools) == ACTION_TOOLS | {"view"}
    assert tools["view"].annotations.read_only_hint is True
    assert tools["splice_list"].annotations.read_only_hint is True
    for name in ACTION_TOOLS - {"splice_list"}:
        assert tools[name].annotations.read_only_hint is False, name
        assert tools[name].output_schema["properties"]["ok"]["type"] == "boolean", name
    step_to = json.dumps(tools["step"].input_schema["properties"]["to"])
    assert '"next"' in step_to and '"integer"' in step_to
    # shape-neutral: no MCP/server/request vocabulary in what the brain reads
    words = " ".join((t.description or "") + json.dumps(t.input_schema) for t in tools.values()).lower()
    for banned in ("mcp", "server", "python"):
        assert banned not in words, banned


async def test_view(client, fake):
    v = await call(client, "view")
    assert v == {"connected": True, "scene": "orders-board", "snapshot": fake.snapshot}


async def test_every_action_reaches_the_page(client, fake):
    await call(client, "focus", target="Pipeline tools")
    await call(client, "open", node="pipeline")
    await call(client, "close")
    await call(client, "drill", group="services")
    await call(client, "back")
    await call(client, "highlight", tag="warnings")
    await call(client, "highlight", nodes=["a", "b"])
    await call(client, "clear")
    await call(client, "show_details", node="pipeline")
    await call(client, "show_details", node="pipeline", section="schemas", item="pipeline_start")
    await call(client, "scroll", to="down")
    await call(client, "step", to=3)
    await call(client, "step", to="next")
    await call(client, "select", index=2)
    await call(client, "select", index=None)
    await call(client, "theater", on=True)
    r = await call(client, "bench", on=False)
    assert r == {"ok": True, "state": {"did": "bench"}}
    await call(client, "pin_inspector", on=True, side="left")
    await call(client, "pin_inspector", lock=True)
    await call(client, "zoom", to="in")
    await call(client, "zoom", to=250)
    await call(client, "zoom", target="Pipeline tools")
    await call(client, "pan", direction="left")
    assert fake.actions == [
        ("focus", {"target": "Pipeline tools"}), ("open", {"node": "pipeline"}), ("close", {}),
        ("drill", {"group": "services"}), ("back", {}), ("highlight", {"tag": "warnings"}),
        ("highlight", {"nodes": ["a", "b"]}), ("clear", {}), ("show_details", {"node": "pipeline"}),
        ("show_details", {"node": "pipeline", "section": "schemas", "item": "pipeline_start"}), ("scroll", {"to": "down"}),
        ("step", {"to": 3}), ("step", {"to": "next"}), ("select", {"index": 2}), ("select", {"index": None}),
        ("theater", {"on": True}), ("bench", {"on": False}),
        ("pin_inspector", {"on": True, "side": "left"}), ("pin_inspector", {"on": True, "lock": True}),
        ("zoom", {"to": "in"}), ("zoom", {"to": 250}), ("zoom", {"target": "Pipeline tools"}), ("pan", {"direction": "left"}),
    ]


async def test_splice_stack_actions_reach_the_page(client, fake):
    await call(client, "splice_stack")
    await call(client, "splice_stack", splices=["caching", "queueing"])
    await call(client, "splice_stack", splices=["caching", "queueing"], combine=True)
    await call(client, "splice_stack_open", slice="queueing")
    await call(client, "splice_stack_open", slice=3)
    await call(client, "splice_stack_return")
    await call(client, "splice_stack_conflict", n=2)
    await call(client, "splice_stack_swap")
    await call(client, "splice_stack_same", n="the orders cache")
    await call(client, "splice_stack_same", same=False)
    await call(client, "splice_stack_leave")
    assert fake.actions == [
        ("splice_stack", {}), ("splice_stack", {"splices": ["caching", "queueing"]}),
        ("splice_stack", {"splices": ["caching", "queueing"], "combine": True}),
        ("splice_stack_open", {"slice": "queueing"}), ("splice_stack_open", {"slice": 3}),
        ("splice_stack_return", {}), ("splice_stack_conflict", {"n": 2}), ("splice_stack_swap", {}),
        ("splice_stack_same", {"n": "the orders cache"}), ("splice_stack_same", {"same": False}), ("splice_stack_leave", {}),
    ]


async def test_splice_actions_reach_the_page(client, fake):
    await call(client, "splice_open", name="caching", new=True)
    await call(client, "splice_add", label="Orders cache", kind="store", between=["Checkout", "Pipeline tools"])
    await call(client, "splice_add", label="Validator", before="Pipeline tools")
    await call(client, "splice_add", label="Logger", attach={"to": "Checkout", "dir": "in"})
    await call(client, "splice_connect", from_node="Report renderer", to_node="Orders cache", kind="reads")
    await call(client, "splice_disconnect", from_node="Report renderer", to_node="Session store")
    await call(client, "splice_remove", node="Audit log")
    await call(client, "splice_replace", node="Session store", with_node="Session queue")
    await call(client, "splice_replace", node="Session store", with_node="Audit log", existing=True)
    await call(client, "splice_rename", node="Rate limiter", label="Throttle")
    await call(client, "splice_move", node="Audit log", group="pipeline")
    await call(client, "splice_undo")
    await call(client, "splice_redo")
    await call(client, "splice_save", name="caching")
    await call(client, "splice_list")
    await call(client, "splice_leave")
    await call(client, "splice_leave", force=True)
    await call(client, "splice_discard")
    assert fake.actions == [
        ("splice_open", {"name": "caching", "new": True}),
        ("splice_add", {"label": "Orders cache", "kind": "store", "between": ["Checkout", "Pipeline tools"]}),
        ("splice_add", {"label": "Validator", "before": "Pipeline tools"}),
        ("splice_add", {"label": "Logger", "attach": {"to": "Checkout", "dir": "in"}}),
        ("splice_connect", {"from": "Report renderer", "to": "Orders cache", "kind": "reads"}),
        ("splice_disconnect", {"from": "Report renderer", "to": "Session store"}),
        ("splice_remove", {"node": "Audit log"}),
        ("splice_replace", {"node": "Session store", "with": "Session queue"}),
        ("splice_replace", {"node": "Session store", "with": "Audit log", "existing": True}),
        ("splice_rename", {"node": "Rate limiter", "label": "Throttle"}),
        ("splice_move", {"node": "Audit log", "group": "pipeline"}), ("splice_undo", {}), ("splice_redo", {}),
        ("splice_save", {"name": "caching"}), ("splice_list", {}), ("splice_leave", {}), ("splice_leave", {"force": True}),
        ("splice_discard", {}),
    ]


async def test_group_splice_actions_reach_the_page(client, fake):
    await call(client, "splice_open", new=True, group="Orders")
    await call(client, "splice_group", label="Notifications", outlet_of="Orders API")
    await call(client, "splice_group", label="Email", parent="Notifications", first="SMTP relay", show=False)
    await call(client, "splice_add", label="Mailer", group="Notifications")
    await call(client, "splice_rename", group="Notifications", label="Alerts")
    await call(client, "splice_remove", group="Alerts")
    assert fake.actions == [
        ("splice_open", {"new": True, "group": "Orders"}),
        ("splice_group", {"label": "Notifications", "outlet_of": "Orders API"}),
        ("splice_group", {"label": "Email", "parent": "Notifications", "first": "SMTP relay", "show": False}),
        ("splice_add", {"label": "Mailer", "group": "Notifications"}),
        ("splice_rename", {"group": "Notifications", "label": "Alerts"}),
        ("splice_remove", {"group": "Alerts"}),
    ]


async def test_page_errors_are_tool_errors(client, fake):
    r = await client.call_tool("fan", {"on": True})
    assert r.is_error and "doesn't fan out" in r.content[0].text
    r = await client.call_tool("focus", {"target": "nowhere"})
    assert r.is_error and "no node or group 'nowhere'" in r.content[0].text
    r = await client.call_tool("highlight", {})
    assert r.is_error and "needs a tag or some nodes" in r.content[0].text
    r = await client.call_tool("step", {"to": "sideways"})
    assert r.is_error
    assert [a[0] for a in fake.actions] == ["fan", "focus"]


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_server_down(mode):
    def refuse(req):
        raise httpx.ConnectError("connection refused", request=req)
    async with Client(build("http://127.0.0.1:1", transport=httpx.MockTransport(refuse)), mode=mode) as c:
        r = await c.call_tool("back", {})
        assert r.is_error and "isn't reachable" in r.content[0].text
        r = await c.call_tool("view", {})
        assert r.is_error and "isn't reachable" in r.content[0].text
