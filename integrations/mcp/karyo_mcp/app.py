"""The MCP server: Karyo explainers for Claude Desktop and Cowork.

Explainers live in a workspace (`$KARYO_WORKSPACE`, default ~/.adenine/karyo/explainers), one folder
per explainer: `<id>/<id>.explainer.json`, its own `components/`, and the built `<id>.html`. Every
tool shells out to the `karyo` CLI, which holds the logic; this module shapes the answers for a model.
"""
from __future__ import annotations

import base64
import io
import json
import re
import shutil
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Annotated, Any, Literal

import anyio

from mcp.server.mcpserver import Image, MCPServer
from mcp.server.mcpserver.exceptions import ResourceError
from mcp.types import TextContent, ToolAnnotations
from PIL import Image as PILImage
from pydantic import BaseModel, Field

from karyo_mcp import __version__
from karyo_mcp.cli import REPO, CliError, Karyo

INSTRUCTIONS = """\
Karyo turns a JSON spec into a visual, step-by-step explainer of any topic (a concept, a process, a plan, a
system): real HTML components, one idea per step, shipped as a single self-contained HTML file. The loop:
new_explainer → read karyo://docs/explainers and list_components → write_explainer (fix every error it reports)
→ preview_explainer and LOOK at the images, fixing what reads badly → lint_explainer → build_explainer with
save_to = a folder the user can open (their working folder), then give them that file. add_image puts a picture
in an explainer; create_component makes a component when none fits; get_explainer reads a spec back to revise it.
If a tool says a tool or browser is missing, call check_setup (a one-time download) and tell the user in plain
words what it said. The user may not be a developer: talk about the explainer, not about JSON or commands."""

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
    target: Literal["file", "artifact"] = "file"
    saved: str | None = Field(default=None, description="Where a copy was saved (save_to), when one was asked for.")
    title: str | None = None
    review: str | None = Field(default=None, description="artifact target: the page with Karyo's runtime swapped for a marker (about 15 KB). Read it before publishing the page anywhere.")
    runtime_verified: bool | None = Field(default=None, description="artifact target: true when the page carries exactly this install's runtime, byte for byte (so the review copy is the whole story).")
    sha256: str | None = None


class ExplainerSpec(BaseModel):
    id: str
    path: str
    spec: dict[str, Any]
    html: str | None = Field(default=None, description="The built HTML file, when there is one.")
    images: list[str] = Field(default_factory=list, description="Image files beside the spec, as `src` values (images/<name>).")


class Lint(BaseModel):
    id: str
    ok: bool = Field(description="True when no step has layout problems.")
    problems: list[str] = Field(description="One line per problem: the element, the step and time, and what is wrong (off the stage, clipped text).")
    issues: list[Issue]


class AddedImage(BaseModel):
    id: str
    src: str = Field(description="The value to put in an image or figure element's `src` prop (relative to the spec).")
    path: str
    bytes: int
    width: int
    height: int


class Demo(BaseModel):
    demo: str
    title: str
    index: str = Field(description="The demo's first page (its map): open this one.")
    dir: str = Field(description="The folder holding every page of the demo (they link to each other).")
    pages: int
    saved: str | None = Field(default=None, description="Where the demo's folder was copied (save_to), when asked.")


class Setup(BaseModel):
    ready: bool = Field(description="True when explainers can be written, previewed and built.")
    summary: str = Field(description="What works and what doesn't, in plain words for the user.")
    workspace: str
    output_dir: str | None = Field(default=None, description="Where build_explainer saves a copy by default ($KARYO_OUTPUT_DIR), when set.")
    problems: list[str]
    details: dict[str, Any] = Field(default_factory=dict)


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


MAX_IMAGE_BYTES = 12 * 1024 * 1024


def _read_source(source: str) -> tuple[bytes, str | None]:
    """The bytes of a picture from a path, an https URL or a data: URI, and a name guessed from it."""
    if source.startswith("data:"):
        head, _, body = source.partition(",")
        if ";base64" not in head:
            raise CliError("a data: URI must be base64 (data:image/png;base64,...)")
        try:
            return base64.b64decode(body, validate=False), None
        except ValueError as e:
            raise CliError(f"the data: URI isn't valid base64: {e}") from e
    if source.startswith(("https://", "http://")):
        req = urllib.request.Request(source, headers={"User-Agent": "karyo-mcp"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read(MAX_IMAGE_BYTES + 1)
        except OSError as e:
            raise CliError(f"couldn't download {source}: {e}") from e
        if len(raw) > MAX_IMAGE_BYTES:
            raise CliError(f"{source} is over {MAX_IMAGE_BYTES // (1024 * 1024)} MB; use a smaller image")
        return raw, Path(urllib.parse.urlparse(source).path).name or None
    f = Path(source).expanduser()
    if not f.is_absolute():
        raise CliError(f"give an absolute path, an https:// URL or a data: URI (got {source!r})")
    if not f.is_file():
        raise CliError(f"no such file: {f} (this server may see the user's files under a different path than you do; a data: URI always works)")
    if f.stat().st_size > MAX_IMAGE_BYTES:
        raise CliError(f"{f} is over {MAX_IMAGE_BYTES // (1024 * 1024)} MB; use a smaller image")
    return f.read_bytes(), f.name


def _image_kind(raw: bytes) -> tuple[str, int, int]:
    """The file extension and pixel size of an image; an error for anything that isn't one."""
    head = raw[:512].lstrip()
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in raw[:4096]):
        m = re.search(rb'viewBox="\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)', raw[:4096])
        return "svg", (round(float(m[1])) if m else 0), (round(float(m[2])) if m else 0)
    try:
        im = PILImage.open(io.BytesIO(raw))
        fmt = (im.format or "").lower()
    except Exception as e:  # noqa: BLE001 - PIL raises many kinds
        raise CliError("that isn't an image Karyo can use (PNG, JPEG, GIF, WebP or SVG)") from e
    ext = {"png": "png", "jpeg": "jpg", "gif": "gif", "webp": "webp"}.get(fmt)
    if not ext:
        raise CliError(f"{fmt or 'that format'} isn't supported in a page: use PNG, JPEG, GIF, WebP or SVG")
    return ext, im.width, im.height


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
        theme: Annotated[Literal["adenine", "fresh"] | None, Field(description="A theme; default adenine. fresh is the second look.")] = None,
        mode: Annotated[Literal["light", "dark"] | None, Field(description="Without a theme: plain neutral colours in light or dark, to check a page outside the themes.")] = None,
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

    def out_dir(save_to: str | None) -> Path | None:
        d = save_to or k.output_dir
        if not d:
            return None
        p = Path(d).expanduser()
        if not p.is_absolute():
            raise CliError(f"save_to must be an absolute folder path (got {d!r})")
        if not p.is_dir():
            # never create it: a path from another filesystem (a sandbox's mount, say) would land somewhere odd
            raise CliError(f"there's no folder {p} where this server runs; it may see the user's files under a different path "
                           "than you do. Leave save_to out to keep the page in the workspace, or pass a folder that exists here.")
        return p

    @server.tool(title="Build an explainer", annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True, open_world_hint=False))
    async def build_explainer(
        id: ID,
        target: Annotated[Literal["file", "artifact"], Field(description="file: the page to open in any browser or send to people. artifact: the same page made for a Claude artifact frame (opens in adenine), plus a short review copy to read before publishing it.")] = "file",
        save_to: Annotated[str | None, Field(description="An absolute folder path to save a copy of the page in, e.g. the user's own folder so they can open it. Default: $KARYO_OUTPUT_DIR when set, else no copy (the page stays in the workspace).")] = None,
    ) -> Built:
        """Build the explainer into one self-contained HTML file (no server, no network needed) and
        return its path. Rebuilding replaces the previous HTML. Give the user the saved copy's path."""
        p = spec_of(id).resolve()
        dest = out_dir(save_to)
        if target == "artifact":
            data = await k.run("artifact", "build", str(p), "--project", str(k.workspace.resolve()), ok_codes=(0, 1))
            if "html" not in data:
                raise CliError("the spec has errors, fix them first:\n" + _lines(data.get("issues")))
            if not data.get("ok", True) and data.get("bytes", 0) > data.get("maxBytes", 1 << 62):
                raise CliError(f"the page is {_human(data['bytes'])}, over the {_human(data['maxBytes'])} an artifact may hold: use smaller images")
            built = Built(id=id, html=data["html"], bytes=data["bytes"], size=_human(data["bytes"]), issues=_issues(data.get("issues")),
                          target="artifact", title=data.get("title"), review=data.get("review"), runtime_verified=data.get("runtimeVerified"),
                          sha256=data.get("hash"))
            name = f"{id}.artifact.html"
        else:
            data = await k.run("build", str(p), "-o", str(p.parent / f"{id}.html"), ok_codes=(0, 1))
            if "html" not in data:
                raise CliError("the spec has errors, fix them first:\n" + _lines(data.get("issues")))
            built = Built(id=id, html=data["html"], bytes=data["bytes"], size=_human(data["bytes"]), issues=_issues(data.get("issues")),
                          title=data.get("title"))
            name = f"{id}.html"
        if dest:
            shutil.copyfile(built.html, dest / name)
            built.saved = str(dest / name)
        return built

    @server.tool(title="Read an explainer", annotations=RO)
    async def get_explainer(id: ID) -> ExplainerSpec:
        """An explainer's spec as saved, to revise it (in this conversation or a later one) and send it
        back whole with write_explainer."""
        p = spec_of(id)
        try:
            spec = json.loads(p.read_text())
        except json.JSONDecodeError as e:
            raise CliError(f"{p} isn't valid JSON ({e}); write_explainer replaces it") from e
        html = p.parent / f"{id}.html"
        imgs = sorted(f"images/{f.name}" for f in (p.parent / "images").iterdir() if f.is_file()) if (p.parent / "images").is_dir() else []
        return ExplainerSpec(id=id, path=str(p), spec=spec, html=str(html) if html.exists() else None, images=imgs)

    @server.tool(title="Check an explainer's layout", annotations=RO)
    async def lint_explainer(id: ID) -> Lint:
        """Check every step's layout in a real browser, mid-transition and at rest: elements off the
        stage, clipped text. Run it before the final build; fix every problem it lists."""
        p = spec_of(id)
        data = await k.run("lint", str(p), ok_codes=(0, 1))
        if not data.get("lint") and not data.get("ok", True) and any(i.get("level") == "error" for i in data.get("issues") or []):
            raise CliError("the spec has errors, fix them first:\n" + _lines(data.get("issues")))
        return Lint(id=id, ok=bool(data.get("ok")), problems=[str(x) for x in data.get("lint") or []], issues=_issues(data.get("issues")))

    @server.tool(title="Add an image", annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True, open_world_hint=True))
    async def add_image(
        id: ID,
        source: Annotated[str, Field(description="Where the picture is: an absolute file path this server can read, an https:// URL, or a data: URI (base64).")],
        name: Annotated[str | None, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$", description="File name to keep it under (default: from the source). The extension is set from the image's real format.")] = None,
    ) -> AddedImage:
        """Copy a picture (PNG, JPEG, GIF, WebP or SVG) into the explainer's own images/ folder and return
        the `src` to use in an `image` or `figure` element. The built page carries it inline, so it works
        offline and in an artifact. Keep images small: an artifact holds at most 16 MB."""
        p = spec_of(id)
        raw, guess = await anyio.to_thread.run_sync(_read_source, source)
        ext, w, h = _image_kind(raw)
        stem = Path(name or guess or "image").stem or "image"
        stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-.") or "image"
        dest = p.parent / "images" / f"{stem}.{ext}"
        dest.parent.mkdir(exist_ok=True)
        dest.write_bytes(raw)
        return AddedImage(id=id, src=f"images/{dest.name}", path=str(dest), bytes=len(raw), width=w, height=h)

    @server.tool(title="Build the demo", annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True, open_world_hint=False))
    async def build_demo(
        name: Annotated[str, Field(description="The demo: 'claude-code' (\"Claude Code, explained\": 21 short explainers and a map of them).")] = "claude-code",
        save_to: Annotated[str | None, Field(description="An existing absolute folder to copy the demo into (as a karyo-demo-<name> folder), e.g. the user's folder. Default: $KARYO_OUTPUT_DIR when set.")] = None,
    ) -> Demo:
        """Build a demo that ships with Karyo: a series of finished explainers to show what Karyo makes.
        Give the user the index page (the series' map; every card links to an explainer)."""
        dest = out_dir(save_to)
        args = ["demo", name, "--no-open"] + (["--out", str(dest / f"karyo-demo-{name}")] if dest else [])
        data = await k.run(*args, timeout=k.setup_timeout)
        if "index" not in data:
            raise CliError(f"no demo '{name}'" + (f" (have: {', '.join(d['name'] for d in data.get('demos', []))})" if data.get("demos") else ""))
        return Demo(demo=name, title=data.get("title", name), index=data["index"], dir=data["dir"], pages=len(data.get("pages") or []),
                    saved=data["dir"] if dest else None)

    @server.tool(title="The docket", annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False))
    async def docket(
        action: Annotated[Literal["add", "list", "show", "close", "reopen", "edit", "milestones"], Field(description="add an item; list open items (all=true: closed too); show / close / reopen / edit one by id; milestones: the 'before' values with open counts.")],
        summary: Annotated[str | None, Field(description="add / edit: one line, in the user's own words, lightly cleaned (no added conclusions).")] = None,
        kind: Annotated[Literal["decision", "review", "later", "closed"] | None, Field(description="add / edit: decision (a choice only the user can make), review (something to look at), later (come back to it). list: filter, or 'closed'.")] = None,
        why: Annotated[str | None, Field(description="add / edit: why it needs the user, only when someone said so.")] = None,
        before: Annotated[str | None, Field(description="add / edit / list: a milestone, date or event, in the user's words.")] = None,
        ref: Annotated[str | None, Field(description="add / edit: a place it concerns, e.g. a file and line.")] = None,
        item: Annotated[str | None, Field(description="show / close / reopen / edit: the id, e.g. D-14.")] = None,
        resolution: Annotated[str | None, Field(description="close: what was decided or done, in the user's terms.")] = None,
        all: Annotated[bool, Field(description="list: include closed items.")] = False,
        folder: Annotated[str | None, Field(description="The project or folder whose docket this is (an existing absolute path where this server runs). Default: the workspace's.")] = None,
    ) -> dict[str, Any]:
        """The docket: one sheet per project or folder of what needs the user later (decisions to make,
        things to review, things to come back to before a milestone). Add only when the user asks."""
        args: list[str] = ["docket", action]
        need = lambda v, what: v if v else (_ for _ in ()).throw(CliError(f"{action} needs {what}"))  # noqa: E731
        if action == "add":
            args.append(need(summary, "a summary"))
        if action in ("show", "close", "reopen", "edit"):
            args.append(need(item, "an item id (D-n)"))
        if action == "close":
            args.append(need(resolution, "a resolution (what was decided or done)"))
        if action in ("add", "edit"):
            for flag, v in (("--summary", summary if action == "edit" else None), ("--kind", kind), ("--why", why), ("--before", before), ("--ref", ref)):
                if v is not None:
                    args += [flag, v]
        if action == "list":
            args += (["--all"] if all else []) + (["--kind", kind] if kind else []) + (["--before", before] if before else [])
        where = Path(folder).expanduser() if folder else k.workspace
        if folder and not where.is_dir():
            raise CliError(f"there's no folder {where} where this server runs; leave folder out to use the workspace's docket")
        where.mkdir(parents=True, exist_ok=True)
        return await k.run(*args, "--repo", str(where))

    @server.tool(title="Check Karyo's setup", annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True, open_world_hint=True))
    async def check_setup() -> Setup:
        """Check that this computer can write, preview and build explainers, and set up what is missing
        (Karyo's own copy of its tools and, without Google Chrome, a headless browser for previews): a
        one-time download of a few minutes. Call it when a tool reports a missing tool or browser, or
        before the first preview on a fresh install. Tell the user what it says, in plain words."""
        try:
            data = await k.run("setup", ok_codes=(0, 1), timeout=k.setup_timeout)
        except CliError as e:
            return Setup(ready=False, summary=f"Karyo couldn't start: {e}", workspace=str(k.workspace), output_dir=k.output_dir, problems=[str(e)])
        problems = [str(x) for x in data.get("problems") or [] if "uv is missing" not in str(x)]  # this server already runs, so uv is there
        chrome = data.get("chrome")
        ready = bool(data.get("jsDeps")) and bool(chrome)
        if ready:
            summary = "Karyo is ready: explainers can be written, previewed as images and built into HTML pages."
        elif data.get("jsDeps"):
            summary = "Explainers can be written and built into HTML pages, but previews can't be shown: no browser could be found or set up."
        else:
            summary = "Karyo isn't ready yet: its first-time setup didn't finish (details below)."
        return Setup(ready=ready, summary=summary, workspace=str(k.workspace), output_dir=k.output_dir, problems=problems,
                     details={key: data.get(key) for key in ("version", "data", "dataFrom", "bun", "chrome", "jsDeps") if key in data})

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
   says two things, labels too small. Fix and preview again until each step reads at a glance. Check one
   preview in the second theme (theme='fresh').
5. If no component shows an idea well, create_component (theme tokens only, no CSS transitions).
6. lint_explainer and fix what it lists.
7. build_explainer (save_to: my working folder, when you have one) and give me the saved HTML file, plus a
   one-line summary of each step."""

    return server
