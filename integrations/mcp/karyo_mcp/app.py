"""The MCP server: Karyo explainers for Claude Desktop and Cowork.

Explainers live in a workspace (`$KARYO_WORKSPACE`, default ~/.adenine/karyo/explainers), one folder
per explainer: `<id>/<id>.explainer.json`, its own `components/`, and the built `<id>.html`. Every
tool shells out to the `karyo` CLI, which holds the logic; this module shapes the answers for a model.
"""
from __future__ import annotations

import io
import json
import re
import shutil
import tempfile
from pathlib import Path
from typing import Annotated, Any, Literal

from mcp.server.mcpserver import Image, MCPServer
from mcp.server.mcpserver.exceptions import ResourceError
from mcp.types import TextContent, ToolAnnotations
from PIL import Image as PILImage
from pydantic import BaseModel, Field

from karyo_mcp import __version__
from karyo_mcp.cli import REPO, CliError, Karyo

INSTRUCTIONS = """\
Karyo turns a JSON spec into a visual, step-by-step explainer: real HTML components, one idea per step,
shipped as a single self-contained HTML file. The loop: new_explainer → read karyo://docs/explainers and
list_components → write_explainer (fix every error it reports) → preview_explainer and LOOK at the images,
fixing what reads badly → build_explainer. When no component fits, create_component makes one."""

ID = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$", description="The explainer's id: lowercase letters, digits and dashes.")]
MAX_IMAGES = 6

RO = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)


class Issue(BaseModel):
    path: str = Field(description="JSON pointer into the spec ('' is the whole document).")
    level: Literal["error", "warn"]
    message: str
    hint: str | None = None


class ComponentInfo(BaseModel):
    name: str
    source: str = Field(description="Where it comes from: project (the explainer's components/), env ($KARYO_COMPONENTS, the workspace), adenine (~/.adenine/karyo/components) or builtin.")
    description: str = ""
    dir: str = ""


class ComponentList(BaseModel):
    components: list[ComponentInfo]


class ComponentDetail(ComponentInfo):
    props: dict[str, Any] = Field(default_factory=dict, description="JSON Schema of the component's props.")
    example: Any = Field(default=None, description="An example use, ready to paste into a step.")


class ComponentCheck(BaseModel):
    name: str
    dir: str
    ok: bool
    issues: list[Issue]


class ExplainerFile(BaseModel):
    id: str
    path: str
    ok: bool = Field(description="True when the spec has no errors (warnings are allowed).")
    issues: list[Issue]
    spec: dict[str, Any] | None = Field(default=None, description="The spec as written (new_explainer only).")


class ExplainerSummary(BaseModel):
    id: str
    title: str
    path: str
    steps: int
    html: str | None = Field(default=None, description="The built HTML file, when there is one.")


class ExplainerList(BaseModel):
    workspace: str
    explainers: list[ExplainerSummary]


class Built(BaseModel):
    id: str
    html: str = Field(description="Absolute path of the single self-contained HTML file.")
    bytes: int
    size: str
    issues: list[Issue]


def _issues(raw: Any) -> list[Issue]:
    return [Issue.model_validate({"path": i.get("path", ""), "level": i.get("level", "error"), "message": i.get("message", ""),
                                  "hint": i.get("hint")}) for i in raw or []]


def _lines(raw: Any) -> str:
    return "\n".join(f"{i.get('level', 'error')} {i.get('path') or '/'}: {i.get('message', '')}" + (f" (hint: {i['hint']})" if i.get("hint") else "")
                     for i in raw or [])


def _human(n: int) -> str:
    return f"{n / 1024:.1f} KB" if n < 1024 * 1024 else f"{n / 1024 / 1024:.2f} MB"


def _shrink(png: Path, max_width: int, fmt: str) -> Image:
    """A preview small enough for a tool result: at most `max_width` px wide; PNG, or JPEG when that
    is asked for or the PNG would be heavy (photographic backgrounds, grain)."""
    im = PILImage.open(png)
    im.load()
    if im.width > max_width:
        im = im.resize((max_width, round(im.height * max_width / im.width)), PILImage.Resampling.LANCZOS)
    buf = io.BytesIO()
    if fmt == "png":
        im.save(buf, "PNG", optimize=True)
        if buf.tell() <= 350_000:
            return Image(data=buf.getvalue(), format="png")
        buf = io.BytesIO()
    im.convert("RGB").save(buf, "JPEG", quality=82, optimize=True)
    return Image(data=buf.getvalue(), format="jpeg")


def _steps(step: int | str, total: int) -> list[int]:
    if isinstance(step, int) or (isinstance(step, str) and step.isdigit()):
        n = int(step)
        if not 1 <= n <= total:
            raise CliError(f"step {n} doesn't exist: the explainer has {total} step(s)")
        return [n]
    if step == "all":
        return list(range(1, total + 1))
    m = re.fullmatch(r"(\d+)-(\d+)", str(step))
    if not m:
        raise CliError(f"step takes a number, a range like '7-12', or 'all' (got {step!r})")
    a, b = int(m[1]), int(m[2])
    if not (1 <= a <= b <= total):
        raise CliError(f"steps {a}-{b} don't exist: the explainer has {total} step(s)")
    return list(range(a, b + 1))


def build(karyo: Karyo | None = None) -> MCPServer:
    k = karyo or Karyo.from_env()
    server = MCPServer("karyo", title="Karyo explainers", version=__version__, instructions=INSTRUCTIONS)

    def spec_of(explainer_id: str) -> Path:
        p = k.spec_path(explainer_id)
        if not p.exists():
            have = ", ".join(sorted(d.name for d in k.workspace.iterdir() if (d / f"{d.name}.explainer.json").exists())) \
                if k.workspace.exists() else ""
            raise CliError(f"no explainer '{explainer_id}' in {k.workspace}" + (f" (have: {have})" if have else "; new_explainer makes one"))
        return p

    # ------------------------------------------------------------ components

    @server.tool(title="List components", annotations=RO)
    async def list_components(explainer_id: Annotated[str | None, Field(description="Include this explainer's own components.")] = None) -> ComponentList:
        """Every component an explainer can use: name, where it comes from, and what it's for. Call
        get_component for a component's props and an example before using it in a spec."""
        args = ["components"] + (["--spec", str(spec_of(explainer_id))] if explainer_id else [])
        data = await k.run(*args)
        return ComponentList(components=[ComponentInfo.model_validate(c) for c in data["components"]])

    @server.tool(title="Get a component", annotations=RO)
    async def get_component(name: str, explainer_id: Annotated[str | None, Field(description="Look in this explainer's own components too.")] = None) -> ComponentDetail:
        """A component's description, props (JSON Schema) and an example use."""
        args = ["component", "show", name] + (["--spec", str(spec_of(explainer_id))] if explainer_id else [])
        return ComponentDetail.model_validate(await k.run(*args))

    @server.tool(title="Create a component",
                 annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True, open_world_hint=False))
    async def create_component(
        name: Annotated[str, Field(pattern=r"^[a-z][a-z0-9-]{0,63}$", description="Lowercase kebab-case, e.g. 'queue-lane'.")],
        component_json: Annotated[dict[str, Any] | str, Field(description="component.json: description, props (JSON Schema) and example. See karyo://docs/explainers.")],
        template_html: Annotated[str, Field(description="template.html in the component template language.")],
        style_css: Annotated[str, Field(description="style.css: theme tokens only (var(--pl-…)), no transitions or animations.")] = "",
        scope: Annotated[Literal["adenine", "workspace"], Field(description="adenine: ~/.adenine/karyo/components, for every explainer on this machine. workspace: this server's workspace.")] = "workspace",
        replace: Annotated[bool, Field(description="Overwrite a component of the same name in that scope.")] = False,
    ) -> ComponentCheck:
        """Make a reusable custom component when no existing one fits. It is checked (metadata, props
        schema, the example rendered through the validator) before it replaces anything; a component
        that fails the check is not installed and the issues come back."""
        meta = json.loads(component_json) if isinstance(component_json, str) else component_json
        if not isinstance(meta, dict):
            raise CliError("component_json must be a JSON object")
        root = (Path.home() / ".adenine/karyo/components") if scope == "adenine" else k.components
        dest = root / name
        if dest.exists() and not replace:
            raise CliError(f"a component '{name}' already exists in {root}; pass replace=true to overwrite it")
        root.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=root)) / name
        try:
            staging.mkdir()
            (staging / "component.json").write_text(json.dumps(meta, indent=2) + "\n")
            (staging / "template.html").write_text(template_html)
            (staging / "style.css").write_text(style_css)
            data = await k.run("component", "check", str(staging), ok_codes=(0, 1))
            result = ComponentCheck(name=name, dir=str(dest), ok=bool(data["ok"]), issues=_issues(data.get("issues")))
            if result.ok:
                if dest.exists():
                    shutil.rmtree(dest)
                shutil.move(str(staging), dest)
            else:
                result.dir = ""
            return result
        finally:
            shutil.rmtree(staging.parent, ignore_errors=True)

    # ------------------------------------------------------------ explainers

    @server.tool(title="List explainers", annotations=RO)
    async def list_explainers() -> ExplainerList:
        """The explainers in the workspace, with their titles, step counts and built HTML."""
        out: list[ExplainerSummary] = []
        if k.workspace.exists():
            for d in sorted(p for p in k.workspace.iterdir() if (p / f"{p.name}.explainer.json").exists()):
                try:
                    info = await k.run("info", str(d / f"{d.name}.explainer.json"))
                except CliError:
                    info = {"title": "(unreadable JSON)", "steps": []}
                html = d / f"{d.name}.html"
                out.append(ExplainerSummary(id=d.name, title=info.get("title", ""), path=str(d / f"{d.name}.explainer.json"),
                                            steps=len(info.get("steps", [])), html=str(html) if html.exists() else None))
        return ExplainerList(workspace=str(k.workspace), explainers=out)

    @server.tool(title="Start an explainer", annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False))
    async def new_explainer(
        id: ID,
        title: str,
        template: Annotated[Literal["blank", "steps", "graph"], Field(description="blank: one empty step. steps: a short sequence of cards. graph: nodes and edges that build up.")] = "steps",
    ) -> ExplainerFile:
        """Create a starter explainer in the workspace and return its spec, to edit and send back
        with write_explainer. Refuses an id that already exists."""
        p = k.spec_path(id)
        if p.exists():
            raise CliError(f"explainer '{id}' already exists ({p}); use write_explainer to change it")
        k.workspace.mkdir(parents=True, exist_ok=True)
        data = await k.run("new", str(p), "--title", title, "--template", template)
        issues = _issues(data.get("issues"))
        return ExplainerFile(id=id, path=data["file"], ok=not any(i.level == "error" for i in issues), issues=issues, spec=data.get("spec"))

    @server.tool(title="Write an explainer",
                 annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True, open_world_hint=False))
    async def write_explainer(
        id: ID,
        spec_json: Annotated[dict[str, Any] | str, Field(description="The whole spec (\"karyo\": \"explainer/1\"); see karyo://docs/explainers.")],
    ) -> ExplainerFile:
        """Save an explainer's spec (replacing the previous one) and validate it. It is saved even with
        errors so you can fix them in place; each issue has a JSON pointer, a message and often a hint."""
        try:
            spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json
        except json.JSONDecodeError as e:
            raise CliError(f"spec_json isn't valid JSON: {e}") from e
        if not isinstance(spec, dict):
            raise CliError("spec_json must be a JSON object")
        p = k.spec_path(id)
        p.parent.mkdir(parents=True, exist_ok=True)
        (p.parent / "components").mkdir(exist_ok=True)
        p.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n")
        data = await k.run("validate", str(p), ok_codes=(0, 1))
        return ExplainerFile(id=id, path=str(p), ok=bool(data["ok"]), issues=_issues(data.get("issues")))

    @server.tool(title="Validate an explainer", annotations=RO)
    async def validate_explainer(id: ID) -> ExplainerFile:
        """Check an explainer's spec against the schema and its components."""
        p = spec_of(id)
        data = await k.run("validate", str(p), ok_codes=(0, 1))
        return ExplainerFile(id=id, path=str(p), ok=bool(data["ok"]), issues=_issues(data.get("issues")))

    @server.tool(title="Preview an explainer", annotations=RO)
    async def preview_explainer(
        id: ID,
        step: Annotated[int | str, Field(description=f"A step number (1-based), a range like '7-12', or 'all' (at most {MAX_IMAGES} images per call).")] = "all",
        theme: Annotated[Literal["adenine", "adenine-periwinkle", "adenine-jade", "adenine-alt", "adenine-lavender", "adenine-glacier", "adenine-seafoam", "adenine-graphite", "neutral"] | None, Field(description="A theme; default adenine. neutral follows `mode`.")] = None,
        mode: Literal["light", "dark"] | None = None,
        max_width: Annotated[int, Field(ge=320, le=1600)] = 1280,
        format: Annotated[Literal["auto", "png", "jpeg"], Field(description="auto: JPEG (Claude Desktop caps a tool result near 150k characters, and one PNG step can reach ~135k); png when you need exact pixels for a single step.")] = "auto",
    ) -> list[Image | TextContent]:
        """Render steps at rest and return them as images, so you can look at your work: is each step
        one clear idea, is anything clipped, crowded or overlapping, does the text fit? Fix the spec
        and preview again."""
        p = spec_of(id)
        checked = await k.run("validate", str(p), ok_codes=(0, 1))
        if not checked["ok"]:
            raise CliError("the spec has errors, fix them first:\n" + _lines(checked.get("issues")))
        info = await k.run("info", str(p))
        total = len(info.get("steps", []))
        if total == 0:
            raise CliError("the explainer has no steps yet")
        want = _steps(step, total)
        note = ""
        if len(want) > MAX_IMAGES:
            note = f" Showing steps {want[0]}-{want[MAX_IMAGES - 1]} of {total}; call again with step='{want[MAX_IMAGES]}-{want[-1]}' for the rest."
            want = want[:MAX_IMAGES]
        with tempfile.TemporaryDirectory(prefix="karyo-preview-") as tmp:
            sel = str(want[0]) if len(want) == 1 else f"{want[0]}-{want[-1]}"
            args = ["stills", str(p), "--step", sel, "--out", tmp, "--dpr", "1"]
            if theme:
                args += ["--theme", theme]
            if mode:
                args += ["--mode", mode]
            data = await k.run(*args, ok_codes=(0, 1))
            if not data.get("ok", True):
                raise CliError("the spec has errors, fix them first:\n" + _lines(data.get("issues")))
            fmt = format if format != "auto" else "jpeg"
            images = [_shrink(Path(s["file"]), max_width, fmt) for s in data["stills"]]
        titles = {s["n"]: s.get("title", "") for s in info.get("steps", [])}
        caption = f"{info.get('title', id)}: " + "; ".join(f"step {n}" + (f" ({titles.get(n)})" if titles.get(n) else "") for n in want)
        warns = _lines(data.get("issues"))
        text = caption + "." + note + ("\nIssues:\n" + warns if warns else "")
        return [TextContent(type="text", text=text), *images]

    @server.tool(title="Build an explainer", annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True, open_world_hint=False))
    async def build_explainer(id: ID) -> Built:
        """Build the explainer into one self-contained HTML file (no server, no network needed) and
        return its path. Rebuilding replaces the previous HTML."""
        p = spec_of(id)
        data = await k.run("build", str(p), "-o", str(p.parent / f"{id}.html"), ok_codes=(0, 1))
        if "html" not in data:
            raise CliError("the spec has errors, fix them first:\n" + _lines(data.get("issues")))
        return Built(id=id, html=data["html"], bytes=data["bytes"], size=_human(data["bytes"]), issues=_issues(data.get("issues")))

    # ------------------------------------------------------------ resources and prompts

    @server.resource("karyo://docs/explainers", name="explainer-docs", title="Explainer spec guide", mime_type="text/markdown",
                     description="How to write a Karyo explainer spec: format, steps, components, rules.")
    def docs() -> str:
        f = REPO / "docs/EXPLAINERS.md"
        if not f.exists():
            raise ResourceError(f"{f} is missing from this Karyo checkout; spec/karyo-explainer.schema.json has the format")
        return f.read_text()

    @server.resource("karyo://components", name="components", title="Component library", mime_type="application/json",
                     description="Every component available to explainers, with source and description.")
    async def components() -> str:
        return json.dumps(await k.run("components"), indent=2)

    @server.prompt(name="explain-visually", title="Explain something visually")
    def explain_visually(topic: Annotated[str, Field(description="What to explain.")],
                         audience: Annotated[str, Field(description="Who it's for (default: a curious newcomer).")] = "") -> str:
        """Author a step-by-step visual explainer of a topic with Karyo, looking at every step before shipping."""
        who = audience or "a curious newcomer"
        return f"""Make a visual explainer of: {topic}
Audience: {who}.

Work with the Karyo tools:
1. Read the resource karyo://docs/explainers, then list_components (get_component for any you plan to use).
2. Plan 3-8 steps. One idea per step, at most about 7 things on screen, captions of one or two short sentences.
   The last step is the full picture; motion happens only between steps.
3. new_explainer (a short kebab-case id), then write_explainer with the full spec. Fix every error it reports.
4. preview_explainer with step='all' and LOOK at each image: clipped or overlapping text, crowding, a step that
   says two things, labels too small. Fix and preview again until each step reads at a glance. Check one dark
   preview (mode='dark').
5. If no component shows an idea well, create_component (theme tokens only, no CSS transitions).
6. build_explainer and give me the HTML path and size, plus a one-line summary of each step."""

    return server
