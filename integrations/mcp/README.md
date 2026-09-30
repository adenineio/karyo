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
| `preview_explainer(id, step, theme?, mode?, max_width?, format?)` | read-only | validates, renders steps at rest (headless Chrome) and returns them as **images** plus one text block with the step titles and any issues (including anything the page itself reported). `step` is a number, a range such as `"7-12"`, or `"all"`, with at most 6 images per call. `theme` is `adenine` (the default), `adenine-periwinkle`, `adenine-jade`, `adenine-alt`, `adenine-lavender`, `adenine-glacier`, `adenine-seafoam`, `adenine-graphite` or `neutral`; `mode` is `light` or `dark` |
| `build_explainer(id)` | idempotent | builds `<id>.html` next to the spec and returns its path and size |
| `list_explainers()` | read-only | the workspace's explainers, with titles, step counts and built HTML |

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

Components resolve from the explainer's own `components/`, then `$KARYO_COMPONENTS`, then `~/.adenine/karyo/components`, then the built-ins.

## Claude Code

The `karyo` plugin (docs/PACKAGING.md) starts this server itself (`plugin:karyo:karyo` in `/mcp`, tools `mcp__plugin_karyo_karyo__*`) through `scripts/plugin/karyo-mcp.sh`, with its Python env in the plugin's data dir. Nothing to configure.

## Claude Desktop

Add the server to `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart Claude Desktop:

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

Use the absolute path to `uv` (`which uv`). Desktop doesn't start servers with your shell's `PATH`, so the server adds `/opt/homebrew/bin`, `/usr/local/bin` and `~/.bun/bin` when it looks for `bun`. `env` is optional. Previews need Google Chrome (or `CHROME_PATH`).

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
