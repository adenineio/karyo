# The karyo plugin

Karyo ships as one Claude Code plugin, `karyo`, listed in the `adenine` marketplace. Install it once and it works in
any project.

## Install

```sh
claude plugin marketplace add adenineio/adenine
claude plugin install karyo@adenine
```

Or, inside a Claude Code session: `/plugin marketplace add adenineio/adenine`, then `/plugin install karyo@adenine`,
then `/reload-plugins`.

**Requirements.**

| tool | needed for |
|---|---|
| [bun](https://bun.sh) | everything: the CLI, the view, stills and builds |
| [uv](https://docs.astral.sh/uv/) | the MCP server and Jarvis (their Python envs) |
| python3 (3.12+) | `karyo model scan` (reading Python `# karyo:` directives) |
| Google Chrome (or `CHROME_PATH`) | stills and lint |
| ffmpeg | contact sheets and video export (`scripts/render.ts sheet` / `video`) only |

`karyo setup` checks bun, uv, python3 and Chrome, says how to install what's missing, and installs the JS dependencies
and the MCP server's Python env ahead of time (`--jarvis`: Jarvis's env too), so the first use doesn't wait on an
install.

## What the plugin contains

| part | how you reach it | what it is |
|---|---|---|
| the CLI | the skills run it as `"${CLAUDE_PLUGIN_ROOT}/cli/karyo" …` | `cli/karyo`, a shell wrapper that finds bun and runs `cli/karyo.ts` |
| the project view | `karyo view`, or `/karyo:view` | `project.html` on a local server: the project's model as a structure board (Bench, theater, Splice), its recorded flows as trace boards, its tours and its explainers |
| skills | `/karyo:karyo-explain`, `/karyo:docket`, `/karyo:view`, `/karyo:jarvis` | `skills/*/SKILL.md` |
| adoption | `/karyo:karyo-adopt` ("set up Karyo here", "refresh Karyo"); `karyo init` / `refresh` / `record` | `skills/karyo-adopt/SKILL.md`, `src/cli/init.ts`, `src/cli/adopt.ts`: sets a project up (docs/ADOPT.md) and keeps its model current, with the hooks installed into the project only |
| the MCP server | `plugin:karyo:karyo` in `/mcp`; tools `mcp__plugin_karyo_karyo__*` | `integrations/mcp` (Python, stdio), started by `scripts/plugin/karyo-mcp.sh` |
| Jarvis mode | `karyo jarvis`, or `/karyo:jarvis` | local voice control of plates: `integrations/jarvis` (official Whisper and a `claude -p` brain) and `jarvis.html` |
| models from code | `karyo model scan`, `karyo model build` | the Python SDK's scan (`sdk/python`, standard library only) and `scripts/model.ts` |
| kits | `karyo kit new` / `list` / `check` / `trust` / `untrust` | node kinds and plate types a project adds ([KITS.md](KITS.md)) |

The CLI is not on PATH: a plugin with a top-level `bin/` can't be installed in claude.ai or Cowork, so the skills call
it by its full path. From a checkout, `just karyo …` runs it.

**Skills and when they trigger.**

- `karyo-explain` triggers when you ask Claude to explain, visualize or walk through something visually. It writes an
  explainer spec, validates it, renders stills and looks at them, lints and builds one HTML file.
- `docket` triggers on "put this on the docket", "what's on the docket" and similar ([DOCKET.md](DOCKET.md)).
- `view` triggers when you ask to open or see the project's Karyo view, board or map, and turns `# karyo:` directives
  into a model when there's nothing to draw yet.
- `jarvis` runs only when you invoke `/karyo:jarvis`: it starts a microphone server and spends model turns.

## Commands

The project-level commands (`karyo --help` lists every command):

| command | does |
|---|---|
| `karyo view [dir] [--port N] [--open]` | serves the project's view and prints its URL (`http://localhost:<port>/project.html`), reusing a server already running for that project. `dir` defaults to the enclosing git repo, else the working directory |
| `karyo jarvis [dir] [--spec <spec>] [--no-whisper] [--no-brain]` | starts (or reuses) the project's view and the Jarvis server, and prints the page URL ([JARVIS.md](JARVIS.md)) |
| `karyo stop [dir] [--all]` | stops the view and Jarvis servers started for the project (`--all`: every one) |
| `karyo status` | lists the running servers |
| `karyo model scan [<package-dir>…]` | reads the project's Python `# karyo:` directives into `.karyo/` and builds `karyo.model.json` (no argument: every package holding a directive) |
| `karyo model build` | merges the fragments in `.karyo/` (scans and recorded runs) into `karyo.model.json` |
| `karyo setup [--jarvis]` | checks the tools and installs the dependencies (above) |

Explainers: `karyo new`, `validate`, `info`, `stills`, `lint`, `build`, `open`, `serve`, and `components` /
`component show|new|check` ([EXPLAINERS.md](EXPLAINERS.md)). Kits: `karyo kit …` ([KITS.md](KITS.md)). The docket:
`karyo docket …` ([DOCKET.md](DOCKET.md)). Every command takes `--json`.

`karyo model scan` reads Python. Fragments written by other SDKs (such as `sdk/go`) are merged by `karyo model build`.

Jarvis shows an explainer (`--spec`, else the project's first) or a built-in plate; it doesn't draw the project's
model board.

## Where files go

**In the project**, only the Karyo files you ask for: `karyo.model.json` and `.karyo/` fragments (`karyo model`),
explainers (`karyo new`), kits under `karyo/kits/` (`karyo kit new`), and splices under `karyo/splices/` and
`karyo.layout.json` (saved from the view). Nothing is added to the project's dependencies or production code, and
nothing is installed into its environment.

**The plugin's data dir** holds everything Karyo installs or generates for itself. It is `$KARYO_DATA` if set, else
Claude Code's `${CLAUDE_PLUGIN_DATA}` for the plugin (`~/.claude/plugins/data/karyo-adenine/`), else, for a plugin
loaded from its own folder (a checkout), `$KARYO_HOME/runtime`.

| path | what |
|---|---|
| `deps/<hash>/node_modules` | JS dependencies, only when Claude Code's own install at plugin install time didn't run (bun was missing, or it timed out) |
| `venv/mcp`, `venv/jarvis` | the MCP server's and Jarvis's Python envs (uv, from their locked versions) |
| `whisper/` | the Whisper weights, fetched on Jarvis's first start from OpenAI's official URL and SHA-256 checked |
| `vite-cache/`, `pycache/`, `logs/`, `servers.json` | the view server's cache, Python bytecode, server logs, and what `karyo view` / `jarvis` started |

**Karyo's home**, `$KARYO_HOME` (default `~/.adenine/karyo`), holds what belongs to you rather than to one install:
the dockets (`dockets/`), shared kits (`kits/`) and components (`components/`), the MCP server's explainer workspace
(`explainers/`, or `$KARYO_WORKSPACE`), and the trust store.

**The trust store**, `$KARYO_HOME/trust.json` (default `~/.adenine/karyo/trust.json`, mode 600), lists which versions of
which kits you allowed to run their own JavaScript: the kit's folder and a sha256 over its kit.json and scripts. The
view's "Trust this version" button and `karyo kit trust` write it; `karyo kit untrust` or deleting the file empties it.
A changed file asks again. Built-in kits need no entry. It survives reinstalling the plugin.

## Ports and security

`karyo view` uses the first free port in 5781–5799 (or `--port`); `karyo jarvis` picks its server's port from the same
range. Every server binds to this machine only. The view server makes a random token at each start and puts it in the
pages it serves; its write endpoints (splices, the team layout, trust) refuse requests without it or from another
origin ([KITS.md](KITS.md) "The local server"). When a project has kits that run their own JavaScript, `karyo view`
prints a line naming them and whether each version is trusted.

## Updates

The plugin's version is the `version` in `.claude-plugin/plugin.json`. To update:

```sh
claude plugin marketplace update adenine   # refresh the catalog
claude plugin update karyo@adenine
```

then restart Claude Code or run `/reload-plugins`. The `/plugin` menu does the same, and its Marketplaces tab can turn
on background auto-update for `adenine` (off by default for third-party marketplaces). The plugin's data dir is kept
across updates; it is removed when the plugin is uninstalled, unless you pass `--keep-data`. Karyo's home is never
touched by an update or an uninstall.

## A checkout as the plugin

To work on Karyo itself, load a checkout as the plugin for one session, with nothing installed:

```sh
just plugin-dev              # claude --plugin-dir <checkout>
just plugin-validate         # validate .claude-plugin/plugin.json and the skills
just view [dir]              # the project view, straight from the checkout
```

A plugin loaded from its own folder keeps its data in `$KARYO_HOME/runtime` (default `~/.adenine/karyo/runtime`).
`just --list` shows every recipe.
