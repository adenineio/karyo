# Karyo MCP server

Lets Claude Desktop and Claude Cowork author Karyo explainers: write a spec, look at each step as an image, fix it, and ship one self-contained HTML file. Built on the official MCP Python SDK (v2.2, `mcp.server.mcpserver.MCPServer`, stdio).

The server is thin. Every tool runs the `karyo` CLI (`cli/karyo.ts`) with `--json`, so the CLI, the Claude Code skill and this server all behave the same way. The spec format is documented in [`docs/EXPLAINERS.md`](../../docs/EXPLAINERS.md), which the server also exposes as a resource.

## Tools

| tool | annotations | what it does |
|---|---|---|
| `list_components(explainer_id?)` | read-only | every component an explainer can use, with its source (`project`, `env`, `adenine`, `builtin`) and description |
| `get_component(name, explainer_id?)` | read-only | a component's props (JSON Schema) and an example |
| `create_component(name, component_json, template_html, style_css, scope, replace?)` | destructive with `replace` | writes `component.json`, `template.html` and `style.css` to a staging folder, checks them (`karyo component check`), and installs them only if the check passes. `scope`: `workspace` (`$KARYO_COMPONENTS`, default `<workspace>/components`) or `adenine` (`~/.adenine/karyo/components`) |
| `new_explainer(id, title, template)` | | a starter spec from a template (`blank`, `steps`, `graph`); refuses an existing id |
| `write_explainer(id, spec_json)` | destructive, idempotent | saves the whole spec, then validates it. It saves even with errors, so the model can fix them in place; issues come back as JSON pointers with messages and hints |
| `validate_explainer(id)` | read-only | the same check without writing |
| `preview_explainer(id, step, theme?, mode?, max_width?, format?)` | read-only | validates, renders steps at rest (headless Chrome) and returns them as **images** plus one text block with the step titles and any issues (including anything the page itself reported). `step` is a number, a range such as `"7-12"`, or `"all"`, with at most 6 images per call. `theme` is `adenine` (the default) or `fresh`; `mode` (`light` or `dark`, without a theme) shows plain neutral colours |
| `get_explainer(id)` | read-only | the spec as saved (to revise it, in this conversation or a later one), its built HTML and its pictures |
| `lint_explainer(id)` | read-only | every step's layout checked in a browser (off the stage, clipped text), one line per problem |
| `add_image(id, source, name?)` | destructive, open world | copies a picture (an absolute path the server can read, an `https://` URL, or a base64 `data:` URI; PNG, JPEG, GIF, WebP or SVG, at most 12 MB) into the explainer's `images/` and returns the `src` to use |
| `build_explainer(id, target?, save_to?)` | idempotent | builds `<id>.html` next to the spec and returns its path and size. `target="artifact"` builds the page for a Claude artifact (`karyo artifact build`, with the workspace as the project) and returns its review copy, sha256 and whether the runtime was verified. `save_to` (an existing absolute folder; default `$KARYO_OUTPUT_DIR`) also saves a copy there, `<id>.html` or `<id>.artifact.html`; a folder that doesn't exist where the server runs is refused, never created |
| `list_explainers()` | read-only | the workspace's explainers, with titles, step counts and built HTML |
| `build_demo(name?, save_to?)` | idempotent | builds a demo that ships with Karyo (`claude-code`: 21 explainers and a map) and returns its index page; `save_to` copies it into `<folder>/karyo-demo-<name>` |
| `docket(action, …)` | | the docket ([docs/DOCKET.md](../../docs/DOCKET.md)): `add`, `list`, `show`, `close`, `reopen`, `edit`, `milestones`, for the workspace or a `folder` |
| `check_setup()` | open world | checks that explainers can be previewed and built, and sets up what's missing (the JS dependencies; without Chrome, a headless browser): a one-time download. Its `summary` is written for the user |

Mistakes the model can fix (an unknown id, invalid JSON, a step that doesn't exist, a spec with errors) come back as tool errors (`ToolError`) with a message it can act on.

**Resources:** `karyo://docs/explainers` (the spec guide, Markdown) and `karyo://components` (the component list, JSON).
**Prompt:** `explain-visually(topic, audience?)` walks the model through the authoring loop: plan, write, validate, preview and look, fix, build.

## Where things live

| | default | override |
|---|---|---|
| explainers | `~/.adenine/karyo/explainers/<id>/<id>.explainer.json`, each with its own `components/` and the built `<id>.html` | `KARYO_WORKSPACE` |
| workspace components | `<workspace>/components` | `KARYO_COMPONENTS` |
| machine-wide components | `~/.adenine/karyo/components` | |
| the CLI | `cli/karyo.ts` in the checkout this folder is in | `KARYO_BIN` (a `karyo` executable, or a path to `karyo.ts`) |
| where `build_explainer` / `build_demo` save a copy | nowhere | `KARYO_OUTPUT_DIR` (or the `save_to` argument) |

Components resolve from the explainer's own `components/`, then `$KARYO_COMPONENTS`, then `~/.adenine/karyo/components`, then the built-ins.

## Claude Code

The `karyo` plugin (docs/PACKAGING.md) starts this server itself (`plugin:karyo:karyo` in `/mcp`, tools `mcp__plugin_karyo_karyo__*`) through `scripts/plugin/karyo-mcp.sh`, with its Python env in the plugin's data dir. Nothing to configure. On a machine without uv the launcher fetches a pinned uv into the data dir first, and uv fetches a Python 3.12 if there is none; the CLI it drives fetches bun the same way (`scripts/plugin/tools.sh`).

## Claude Desktop and Cowork, from the plugin

Installed from the marketplace in the desktop app (Customize › Plugins), the plugin's server starts on the user's computer: in Claude Desktop's chat, and in a Cowork task that runs on the computer. A Cowork task in the cloud has no local MCP servers; there the skills drive the CLI in Cowork's shell instead ([docs/COWORK.md](../../docs/COWORK.md)). The first `check_setup` (or first preview) sets up the JS dependencies and, without Chrome, a headless browser: about a minute.

## Claude Desktop, by hand (a checkout)

Without the plugin, add the server to `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "karyo": {
      "command": "/opt/homebrew/bin/uv",
      "args": ["--directory", "/abs/path/to/karyo/integrations/mcp", "run", "karyo-mcp"],
      "env": { "KARYO_WORKSPACE": "/path/to/explainers" }
    }
  }
}
```

Use the absolute path to `uv` (`which uv`). Desktop doesn't start servers with your shell's `PATH`, so the server adds `/opt/homebrew/bin`, `/usr/local/bin` and `~/.bun/bin` when it looks for `bun`. `env` is optional. Previews use Google Chrome (or `CHROME_PATH`), else a headless browser fetched once (`check_setup`).

What Desktop supports, and how this server fits it:

- **Tools, resources, prompts and image results** are supported, and they're all this server uses. Previews come back as MCP image content (`ImageContent`), so the model sees its own work.
- **No elicitation or sampling**, so nothing here depends on them. Choices are tool arguments.
- **Result size.** Desktop truncates tool results past roughly 150k characters, so previews stay small. They render at 1× pixel density, are scaled to at most 1280 px wide by default (`max_width` goes up to 1600), and a call returns at most 6 images. `format="auto"` (the default) sends JPEG; `format="png"` gives exact pixels, for a single step. Measured at 1280 px, a step is about 85–135k base64 characters as PNG and 40–50k as JPEG. A PNG over about 350 KB falls back to JPEG.
- **Timeouts.** A tool call has about 240 s. Rendering takes a few seconds per step, and the server stops the CLI after 200 s. For a long explainer, preview a range of steps at a time.

## Running and testing

From the repo root (see the `justfile`):

```sh
just mcp-test          # pytest: every tool, in both protocol modes
just mcp-serve         # stdio, as Desktop runs it
```

Most tests use the in-process `Client` against a stand-in CLI (`tests/fake_karyo.py`, same `--json` contract), in both the 2026-07-28 mode (`auto`) and the 2025-11-25 handshake Claude Desktop negotiates (`legacy`). `tests/test_e2e.py` runs the real CLI in process and over stdio (`karyo-mcp` launched through `StdioServerParameters`): new, write, preview (an image comes back), build. It needs bun and Chrome, and it's skipped when the explainer core is missing. `KARYO_SKIP_SLOW=1` skips it too.
