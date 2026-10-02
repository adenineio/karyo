"""karyo-view: the MCP server (stdio) the brain drives the page through.

Each tool is one page action, POSTed to the Jarvis server's loopback /action, which forwards it to the
page and returns the page's action_result; `view` reads the latest snapshot the page reported. A page
error (an unknown id, an action the current plate doesn't support) comes back as a tool error.
"""
from __future__ import annotations

from typing import Annotated, Any, Literal

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field

INSTRUCTIONS = """\
Drives the Karyo plate on the user's screen. Call `view` to see what is on screen (the plate's kind, its \
nodes, groups, tags and steps with ids and labels, and the selection); then act with the other tools. \
Targets take an id or a label from `view`. An action the current plate doesn't support fails with a \
message saying so."""

DEFAULT_URL = "http://127.0.0.1:5190"

ACT = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True, open_world_hint=False)
RO = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)

Ref = Annotated[str, Field(min_length=1, description="An id or a label, as `view` lists them.")]
Node = Annotated[str, Field(min_length=1, description="A node: its id or label, as `view` lists them (proposed nodes count).")]


class ActionResult(BaseModel):
    ok: bool = Field(description="Always true here: a refused action is a tool error.")
    state: dict[str, Any] | None = Field(default=None, description=(
        "What the page reports after the action: the selection and, with a card open, its details as measured on "
        "screen: `section`, `sections`, `visible` (e.g. \"2 of 7 tools fully visible, pipeline_run partly; scroll for "
        "the rest\"), `items` {shown, partly, hidden} and `more` {above, below}. Describe only what this says is visible."))


class View(BaseModel):
    connected: bool = Field(description="Whether a Karyo page is connected.")
    scene: str | None = Field(default=None, description="The id of the scene the page shows.")
    snapshot: dict[str, Any] | None = Field(default=None, description="What is on screen: the plate's kind, nodes, groups, tags, steps (ids and labels) and the current selection.")


def build(url: str = DEFAULT_URL, transport: httpx.AsyncBaseTransport | None = None) -> MCPServer:
    server = MCPServer("karyo_view", title="Karyo view", version="0.1.0", instructions=INSTRUCTIONS)
    base = url.rstrip("/")

    def client() -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=base, timeout=15.0, transport=transport)

    async def act(action: str, /, **args: Any) -> ActionResult:
        payload = {k: v for k, v in args.items() if v is not None or action in ("select", "splice_stack_conflict")}
        try:
            async with client() as c:
                r = await c.post("/action", json={"name": action, "args": payload})
        except httpx.HTTPError as e:
            raise ToolError(f"the Jarvis server at {base} isn't reachable: {e}") from None
        try:
            body = r.json()
        except ValueError:
            raise ToolError(f"the Jarvis server answered {r.status_code} without JSON") from None
        if r.status_code >= 400 or not body.get("ok"):
            raise ToolError(str(body.get("error") or f"{action} failed ({r.status_code})"))
        state = body.get("state")
        return ActionResult(ok=True, state=state if isinstance(state, dict) else ({"value": state} if state is not None else None))

    @server.tool(title="See the view", annotations=RO)
    async def view() -> View:
        """What the page shows right now: the plate's kind, its nodes, groups, tags and steps with their
        ids and labels, and the current selection. Call it first when unsure what is on screen."""
        try:
            async with client() as c:
                r = await c.get("/view")
            return View.model_validate(r.json())
        except (httpx.HTTPError, ValueError) as e:
            raise ToolError(f"the Jarvis server at {base} isn't reachable: {e}") from None

    @server.tool(title="Focus", annotations=ACT)
    async def focus(target: Annotated[str, Field(min_length=1, description="A node or group: its id or label.")]) -> ActionResult:
        """Bring a node or a group into focus: centre it and light it, dimming the rest."""
        return await act("focus", target=target)

    @server.tool(title="Open a node", annotations=ACT)
    async def open(node: Annotated[str, Field(min_length=1, description="A node: its id or label.")]) -> ActionResult:
        """Open a node's card (its panel with what the plate knows about it)."""
        return await act("open", node=node)

    @server.tool(title="Close", annotations=ACT)
    async def close() -> ActionResult:
        """Close the open card or panel."""
        return await act("close")

    @server.tool(title="Drill into a group", annotations=ACT)
    async def drill(group: Annotated[str, Field(min_length=1, description="A group: its id or label; 'out' goes up a level, 'top' to the overview of all groups.")]) -> ActionResult:
        """Go inside a group. On a structure board in its groups view (state.level.view 'groups'), this slides into the
        group's own scene: its cards, its subgroups as group cards, and its neighbours as stubs at the edges; 'out' goes
        up a level, 'top' back to the overview of all groups. In the cards view, the group's cards fill the board. On a
        sequence diagram, expand a folded lane into its members' lanes (group: its name, e.g. "stages"); 'out' folds it back."""
        return await act("drill", group=group)

    @server.tool(title="Back", annotations=ACT)
    async def back() -> ActionResult:
        """Go back one level: close what is open first, then up a level (out of an entered or drilled group); on a
        sequence diagram, fold expanded lanes back."""
        return await act("back")

    @server.tool(title="Groups or every card", annotations=ACT)
    async def groups(on: Annotated[bool | None, Field(description="True: the groups view (one card per group, starting at the overview); false: every card on one board. Omit to toggle.")] = None) -> ActionResult:
        """Switch a structure board between its groups view (one card per group; enter one with drill) and every card.
        state.level says which view it is in, the group entered and its path."""
        return await act("groups", on=on)

    @server.tool(title="Highlight", annotations=ACT)
    async def highlight(
        tag: Annotated[str | None, Field(description="A tag (or category) to light: its id or name, as the legend shows it.")] = None,
        nodes: Annotated[list[str] | None, Field(description="Nodes to light: ids or labels.")] = None,
    ) -> ActionResult:
        """Light a tag's nodes, or a list of nodes, and dim the rest. Give a tag, nodes, or both."""
        if not tag and not nodes:
            raise ToolError("highlight needs a tag or some nodes")
        return await act("highlight", tag=tag, nodes=nodes)

    @server.tool(title="Clear", annotations=ACT)
    async def clear() -> ActionResult:
        """Clear focus, highlights and pins: back to the whole plate."""
        return await act("clear")

    @server.tool(title="Show details", annotations=ACT)
    async def show_details(
        node: Annotated[str, Field(min_length=1, description="A node: its id or label (or the exact name of an item one of its sections lists).")],
        section: Annotated[str | None, Field(description=(
            "A section of the card to show large, as a section view: its id or title, or a word for it "
            "(e.g. 'schemas', 'inputs', 'tools', 'calls', 'checks', 'code', 'summary'). Omit for the small card panel."))] = None,
        item: Annotated[str | None, Field(description="An item inside the section to scroll to (e.g. one tool by name).")] = None,
    ) -> ActionResult:
        """Open a node's card with its details. A card's details are named sections (its summary, its calls, its checks,
        and whatever the plate attaches, e.g. a list of tools with their schemas). Give `section` when the user asks for a
        specific part: that section opens large, the others behind tabs. The result's state says what is actually
        visible (`visible`, `items`); an unknown section fails with the card's sections and which cards have one."""
        return await act("show_details", node=node, section=section, item=item)

    @server.tool(title="Scroll the details", annotations=ACT)
    async def scroll(to: Annotated[str, Field(min_length=1, description="'down' or 'up' (a page), 'top', 'bottom', or an item's name to bring it to the top.")]) -> ActionResult:
        """Scroll the open card's details. The result's state says what is visible afterwards."""
        return await act("scroll", to=to)

    @server.tool(title="Step", annotations=ACT)
    async def step(to: Annotated[int | Literal["next", "prev"], Field(description="A step number as `view` lists it, or 'next' / 'prev'.")]) -> ActionResult:
        """Move through a plate's steps (a tour's stops, an explainer's steps, a stack's slices)."""
        return await act("step", to=to)

    @server.tool(title="Select", annotations=ACT)
    async def select(index: Annotated[int | None, Field(description="An entry's index as `view` lists it; null clears the selection.")]) -> ActionResult:
        """Select one entry in the plate's list (e.g. a recorded run on a trace plate), as `view` lists them; null clears the selection."""
        return await act("select", index=index)

    @server.tool(title="Theater", annotations=ACT)
    async def theater(on: Annotated[bool, Field(description="true fills the window; false returns the plate to the page.")]) -> ActionResult:
        """Lift the plate out of the page to fill the window, or put it back."""
        return await act("theater", on=on)

    @server.tool(title="Fan out", annotations=ACT)
    async def fan(on: Annotated[bool, Field(description="true fans out; false collapses.")]) -> ActionResult:
        """Fan a stacked plate out into its overview, or collapse it (where the plate stacks)."""
        return await act("fan", on=on)

    @server.tool(title="Bench", annotations=ACT)
    async def bench(on: Annotated[bool, Field(description="true opens Bench (rearranging); false closes it.")]) -> ActionResult:
        """Turn Bench mode (where the viewer can rearrange the plate) on or off."""
        return await act("bench", on=on)

    @server.tool(title="Pin the inspector", annotations=ACT)
    async def pin_inspector(
        on: Annotated[bool, Field(description="true pins the inspector beside the window; false puts it back into the plate.")] = True,
        lock: Annotated[bool | None, Field(description=(
            "true locks it on what it shows now (it stops following the card that opens); false follows again. "
            "Omit to leave it as it is."))] = None,
        side: Annotated[Literal["left", "right"] | None, Field(description="Which side of the window it docks to. Omit to keep it.")] = None,
    ) -> ActionResult:
        """Pin the inspector (the large details view of a card, e.g. its tools with full schemas) to the side of the
        window, outside the plate; the plate re-fits into the rest. Pinned, it follows whatever card opens (show_details,
        open) unless locked. The result's state.inspector says what it shows, measured on screen (`visible`, `items`)."""
        return await act("pin_inspector", on=on, lock=lock, side=side)

    @server.tool(title="Zoom", annotations=ACT)
    async def zoom(
        to: Annotated[Literal["in", "out", "fit"] | int | None, Field(description=(
            "'in' or 'out' by a step, 'fit' back to the whole plate, or a percentage (100 = fit, up to 400). "
            "Omit with `target` to pick a zoom that frames it."))] = None,
        target: Annotated[str | None, Field(min_length=1, description="A node (or a structure board's group) to centre: its id or label, as `view` lists them.")] = None,
    ) -> ActionResult:
        """Zoom the view of the plate in or out, back to fit, or onto one node (centred). It changes only how close the
        viewer is, never what the plate shows; state.zoom is the zoom in percent (100 = the whole plate). 'out' at fit goes
        back to the overview, as clear does."""
        return await act("zoom", to=to, target=target)

    @server.tool(title="Pan", annotations=ACT)
    async def pan(
        direction: Annotated[Literal["left", "right", "up", "down"], Field(description="Which way to look: the view moves that way.")],
        amount: Annotated[float | None, Field(gt=0, le=1, description="How far, as a fraction of the view (default 0.4).")] = None,
    ) -> ActionResult:
        """Move a zoomed-in view left, right, up or down. At fit the whole plate is on screen, so there is nothing to pan
        (zoom in first)."""
        return await act("pan", direction=direction, amount=amount)

    # ---------------------------------------------------------------- splices: proposals only

    @server.tool(title="Open a splice", annotations=ACT)
    async def splice_open(
        name: Annotated[str | None, Field(description="The splice's name. A saved splice with this name opens over the current picture; otherwise a new splice gets this name.")] = None,
        new: Annotated[bool | None, Field(description="true: always start a new splice from the current view (e.g. 'splice this', 'open this view in a new splice called …'), even if a saved one has the name.")] = None,
        group: Annotated[str | None, Field(description="Go into this group first and open the splice there ('splice the X group'); 'top' for the overview. Omit for the view on screen.")] = None,
    ) -> ActionResult:
        """Open a splice: a sandbox over exactly the current view where changes are only proposed. The real picture is
        never changed. The plate shows a tinted frame and a 'Splice' banner that says where you are. The splice
        remembers this view (the group you are in): reopening it later slides back there. Use it for 'splice this' (new:
        true, no name: the name is asked for on save), 'open this view in a new splice (called X)' (new: true) or 'open
        the X splice'. The state's `splice` reports it (title, ops, last change, dirty, where, home, proposed groups)."""
        return await act("splice_open", name=name, new=new, group=group)

    @server.tool(title="Propose a node", annotations=ACT)
    async def splice_add(
        label: Annotated[str, Field(min_length=1, description="The new node's name, e.g. 'Orders cache'.")],
        kind: Annotated[Literal["service", "function", "store", "queue", "external", "actor"] | None, Field(description="What it is; default service.")] = None,
        category: Annotated[str | None, Field(description="Its category (colours its card), e.g. one the legend already has.")] = None,
        between: Annotated[list[str] | None, Field(min_length=2, max_length=2, description="Two connected nodes [a, b]: the new node goes between them (a → new → b replaces a → b).")] = None,
        before: Annotated[str | None, Field(description="A node: the new node goes in front of it (what called it now calls the new node, which calls it).")] = None,
        after: Annotated[str | None, Field(description="A node: the new node goes behind it (it calls the new node, which calls what it called).")] = None,
        attach: Annotated[dict[str, Any] | None, Field(description="{to: node, dir: 'out' (new → to) or 'in' (to → new), kind}: one relationship to an existing node.")] = None,
        summary: Annotated[str | None, Field(description="One sentence on what it would do.")] = None,
        group: Annotated[str | None, Field(description="The group it goes in (a proposed one counts: 'put a Mailer card in it'). Omit inside a group: it joins the group you are in.")] = None,
    ) -> ActionResult:
        """Propose a new node in the open splice. Give at most one place: between two connected nodes, before or after a
        node, or attached to one; none places it on its own. Fails with the reason (and a did-you-mean) when it can't apply."""
        return await act("splice_add", label=label, kind=kind, category=category, between=between, before=before, after=after, attach=attach, summary=summary, group=group)

    @server.tool(title="Propose a group", annotations=ACT)
    async def splice_group(
        label: Annotated[str, Field(min_length=1, description="The new group's name, e.g. 'Notifications'.")],
        parent: Annotated[str | None, Field(description="The group it goes inside ('add a group … under X'); 'top' for the top level. Omit: the group you are in now (the top level on the overview).")] = None,
        outlet_of: Annotated[str | None, Field(description="A node that calls into the new group ('attach it to X as an outlet'): X → the group.")] = None,
        inlet_of: Annotated[str | None, Field(description="A node the new group calls ('… as an inlet of X'): the group → X.")] = None,
        kind: Annotated[Literal["calls", "reads", "writes", "publishes", "subscribes"] | None, Field(description="The relationship's kind; default calls.")] = None,
        first: Annotated[str | None, Field(description="Its first card's name, if the user names one.")] = None,
        show: Annotated[bool | None, Field(description="false: stay where you are. By default the view slides into the new group's scene.")] = None,
    ) -> ActionResult:
        """Propose a new group in the open splice (proposals only). Without a card it shows a 'No cards yet' empty state
        that holds its relationship; the first card proposed into it (splice_add with group, or any splice_add while
        inside it) takes that relationship over. By default the view then slides into the new group, and the state's
        spliceNote says exactly what is on screen there; describe that, as a proposal."""
        return await act("splice_group", label=label, parent=parent, outlet_of=outlet_of, inlet_of=inlet_of, kind=kind, first=first, show=show)

    @server.tool(title="Propose a relationship", annotations=ACT)
    async def splice_connect(
        from_node: Annotated[str, Field(min_length=1, description="The node the relationship starts at: its id or label.")],
        to_node: Annotated[str, Field(min_length=1, description="The node it goes to: its id or label.")],
        kind: Annotated[Literal["calls", "reads", "writes", "publishes", "subscribes"] | None, Field(description="Default calls.")] = None,
        label: Annotated[str | None, Field(description="A short label for it.")] = None,
    ) -> ActionResult:
        """Propose a relationship from one node to another in the open splice."""
        return await act("splice_connect", **{"from": from_node}, to=to_node, kind=kind, label=label)

    @server.tool(title="Propose removing a relationship", annotations=ACT)
    async def splice_disconnect(
        from_node: Annotated[str, Field(min_length=1, description="Where it starts: a node's id or label.")],
        to_node: Annotated[str, Field(min_length=1, description="Where it goes: a node's id or label.")],
    ) -> ActionResult:
        """Propose removing the relationship from → to in the open splice (it stays drawn as a faint ghost)."""
        return await act("splice_disconnect", **{"from": from_node}, to=to_node)

    @server.tool(title="Propose removing a node", annotations=ACT)
    async def splice_remove(
        node: Annotated[str | None, Field(description="A node: its id or label (proposed nodes count).")] = None,
        group: Annotated[str | None, Field(description="Instead: a group the splice proposes; it goes with every card in it.")] = None,
    ) -> ActionResult:
        """Propose removing a node in the open splice: it stays drawn as a faint ghost with its relationships. Removing a
        node the splice itself proposed takes the proposal back; removing a proposed group takes it back with its cards."""
        if not node and not group:
            raise ToolError("splice_remove needs a node or a group")
        return await act("splice_remove", node=node, group=group)

    @server.tool(title="Propose a replacement", annotations=ACT)
    async def splice_replace(
        node: Node,
        with_node: Annotated[str, Field(min_length=1, description="The replacement: a new node's name, or (existing: true) a node on the plate.")],
        existing: Annotated[bool | None, Field(description="true: `with` names a node already on the plate.")] = None,
        kind: Annotated[str | None, Field(description="The new node's kind (default: the replaced node's).")] = None,
        summary: Annotated[str | None, Field(description="One line on what the new node is.")] = None,
    ) -> ActionResult:
        """Propose swapping a node for another in the open splice ("replace the orders store with an event log"): the new
        node takes over every relationship of the old one, in and out; the old one stays drawn as a ghost with its old wires
        marked rerouted. When splices are combined, other splices' changes to the old node follow the replacement."""
        return await act("splice_replace", node=node, **{"with": with_node}, existing=existing, kind=kind, summary=summary)

    @server.tool(title="Propose a new name", annotations=ACT)
    async def splice_rename(
        label: Annotated[str, Field(min_length=1, description="The new name.")],
        node: Annotated[str | None, Field(description="A node: its id or label (proposed nodes count).")] = None,
        group: Annotated[str | None, Field(description="Instead: a group (a proposed one, or one of the model's).")] = None,
    ) -> ActionResult:
        """Propose renaming a node (the old name shows struck through) or a group in the open splice."""
        if not node and not group:
            raise ToolError("splice_rename needs a node or a group")
        return await act("splice_rename", node=node, group=group, label=label)

    @server.tool(title="Propose moving a node", annotations=ACT)
    async def splice_move(node: Node, group: Annotated[str, Field(min_length=1, description="The group to move it into.")]) -> ActionResult:
        """Propose moving a node into another group in the open splice."""
        return await act("splice_move", node=node, group=group)

    @server.tool(title="Undo a proposal", annotations=ACT)
    async def splice_undo() -> ActionResult:
        """Take the splice's last change back."""
        return await act("splice_undo")

    @server.tool(title="Redo a proposal", annotations=ACT)
    async def splice_redo() -> ActionResult:
        """Put back the change the last undo took back."""
        return await act("splice_redo")

    @server.tool(title="Save the splice", annotations=ACT)
    async def splice_save(name: Annotated[str | None, Field(description="Its name; needed when it has none yet.")] = None) -> ActionResult:
        """Save the open splice (its proposed changes and view) so it can be opened again later over the current picture.
        The state's `spliceNote` says where it was saved."""
        return await act("splice_save", name=name)

    @server.tool(title="Leave the splice", annotations=ACT)
    async def splice_leave(force: Annotated[bool | None, Field(description="true: leave even with unsaved changes (they are lost).")] = None) -> ActionResult:
        """Leave the splice: back to the real picture. Fails when there are unsaved changes, unless force."""
        return await act("splice_leave", force=force)

    @server.tool(title="Discard the splice", annotations=ACT)
    async def splice_discard() -> ActionResult:
        """Throw the open splice away: its unsaved changes and, if it was saved, its saved copy. Only when the user asks to discard it."""
        return await act("splice_discard")

    @server.tool(title="List saved splices", annotations=RO)
    async def splice_list() -> ActionResult:
        """The saved splices: name, how many changes, how many the real picture already has (landed), and how many no
        longer apply. In the state's `splices`."""
        return await act("splice_list")

    # ---------------------------------------------------------------- a stack of splices: compare many, edit one at a time

    @server.tool(title="Stack the splices", annotations=ACT)
    async def splice_stack(
        splices: Annotated[list[str] | None, Field(description=(
            "Splices to compare, by name, in order (e.g. ['caching', 'queueing']). Omit for every saved splice. "
            "The real view always comes first."))] = None,
        combine: Annotated[bool | list[str] | None, Field(description=(
            "true: add one more slice that combines the stacked splices in order (read-only); or the names to combine. "
            "Its warning says where they conflict."))] = None,
    ) -> ActionResult:
        """Stack splices in a Stack view over the board to compare them: the real view first, then one slice per splice
        (drawn with its proposals), and with `combine` one more slice layering them. An open splice's unsaved changes are
        included as they are, marked unsaved. The state's `spliceStack` lists the slices (index, title, kind, unsaved,
        changes in words, warning) and the combination's conflicts. step / fan / focus / highlight then move the stack."""
        return await act("splice_stack", splices=splices, combine=combine)

    @server.tool(title="Open a slice of the stack", annotations=ACT)
    async def splice_stack_open(
        slice: Annotated[int | str, Field(description="The slice: its number as the stack shows it, a splice's name, 'real' or 'combined'.")],
    ) -> ActionResult:
        """Bring one slice of the stack back to the board: that splice opens there, ready to edit (with any unsaved changes
        it had); 'real' shows the board without a splice. The combined slice is read-only: it fails, naming its splices."""
        return await act("splice_stack_open", slice=slice)

    @server.tool(title="Back to the stack", annotations=ACT)
    async def splice_stack_return() -> ActionResult:
        """From the board, after opening a slice: back to the stack of splices (rebuilt with what was changed, marked unsaved)."""
        return await act("splice_stack_return")

    @server.tool(title="Explain a conflict", annotations=ACT)
    async def splice_stack_conflict(
        n: Annotated[int | str | None, Field(description=(
            "Which item of the combined slice: its number as the header lists it (1, 2 …), or words naming what it is "
            "about ('the orders store one'); null closes the card. Omit for the first."))] = 1,
    ) -> ActionResult:
        """Light one item of the combined slice (a conflict, a consequence, the order, a same-name question, or a note:
        agreed, follows) and open its card: what each splice does, and what the combination shows (the stack goes to the
        combined slice if it isn't there). The words are in the state's spliceStack.explained (numbered, each with its
        kind); spliceStack.lit says which item is lit now."""
        return await act("splice_stack_conflict", n=n)

    @server.tool(title="Swap the order", annotations=ACT)
    async def splice_stack_swap() -> ActionResult:
        """Combine the same splices in the other order ("swap the order"). The state's spliceStack.order says the order
        now, whether the order matters, and what the other order gives; spliceNote says what changed."""
        return await act("splice_stack_swap")

    @server.tool(title="Treat two proposals as the same", annotations=ACT)
    async def splice_stack_same(
        n: Annotated[int | str | None, Field(description="The same-name item (its number or words, e.g. 'the orders cache'); omit for the first.")] = None,
        same: Annotated[bool | None, Field(description="false: treat them as different things again.")] = None,
    ) -> ActionResult:
        """Two splices propose different nodes with one name (a 'same name' item): "they're the same cache" treats them as
        one node in the combination only (never written to either splice file); same: false undoes it."""
        return await act("splice_stack_same", n=n, same=same)

    @server.tool(title="Leave the stack", annotations=ACT)
    async def splice_stack_leave() -> ActionResult:
        """Close the stack of splices; the board stays as it is (the splice last opened stays open). Nothing is thrown away."""
        return await act("splice_stack_leave")

    return server
