# Changelog

The `karyo` Claude Code plugin (`.claude-plugin/plugin.json`). Newest first.

## 0.2.1

- **Automatic scan:** a local name assigned from itself (`font = font.model_copy()`, or two names that read each other) is treated as unknown instead of looping, so the scan no longer stops with a recursion error on such code.

## 0.2.0

The `karyo` plugin in the `adenine` marketplace: `claude plugin marketplace add adenineio/adenine`, then `claude plugin install karyo@adenine`. Install details: [docs/PACKAGING.md](docs/PACKAGING.md).

- **Engine:** explainer animations built from real HTML elements with a three.js effects layer; every frame is a function of time, so plates can be scrubbed, stepped, screenshotted, linted and exported to video (`scripts/render.ts`).
- **Built-in scenes:** `request-flow`, `code-walkthrough`, `ci-pipeline`, `network-stack` and `layers-stack` (a Stack view), in the gallery (`just dev`).
- **Themes:** adenine (the default) and its colour schemes, plus neutral (light, dark or following the OS). A link or a stored choice that names a theme not on the list opens the default. Built explainer files load no web fonts and need no network.
- **Models from code:** the `karyo.model.json` format (`"karyo": 1`, JSON Schema in `spec/`), Python and Go SDKs that declare, scan and record, and a merge that reconciles declared, extracted and observed structure into warnings. `karyo model scan` reads Python `# karyo:` directives into `.karyo/` and builds the model; `karyo model build` merges fragments; `just stack-history` turns a model file's git history into Stack view slices, following renames and moves.
- **Views of a model:** structure map and flow replay, the structure board (Bench, theater, Splice: sandboxed what-ifs saved as `karyo/splices/*.splice.json`, stacked and combined), trace boards, tours, sequence plates and the Stack view. A board's `lead` option names the tag and wire its example states lead with.
- **Project view:** `karyo view` (or `/karyo:view`) serves `project.html` for any project on a free port in 5781–5799: its models, recorded flows, tours and explainers. Splices and the team layout save into the project; outside a project view, a team layout saves only as a `karyo.layout.json` beside a `karyo.model.json`.
- **Explainers:** JSON specs of components, links and steps, validated, previewed as stills and built into one self-contained HTML file; built-in and custom components (`components/`, `karyo component …`).
- **Kits:** node kinds and plate types from `karyo/kits/<name>/` folders; a kit that runs its own JavaScript does so only in a sealed frame, after the viewer trusts that version.
- **Skills:** `karyo-explain`, `karyo-adopt`, `docket`, `view` and `jarvis`.
- **MCP server:** `karyo` (`plugin:karyo:karyo`) to create, validate, preview and build explainers from Claude Desktop, Cowork or Claude Code.
- **CLI:** `cli/karyo` (`view`, `jarvis`, `stop`, `status`, `model`, `setup`, the explainer, component, kit and docket commands), called by the skills by full path.
- **Docket:** one Markdown sheet per repository of decisions, reviews and things to come back to, shared by every worktree.
- **Jarvis:** voice control of a plate (`karyo jarvis` or `/karyo:jarvis`): local Whisper speech recognition (the official weights, SHA-256 checked, fetched on first use) and a `claude -p` brain. Its page opens `layers-stack` when no scene is given.
- Everything Karyo installs for itself (JS dependencies, Python environments, Whisper weights, caches, logs) lives in the plugin's data dir, never in the project.
- **Adopt Karyo in one sentence:** the `karyo-adopt` skill ("set up Karyo here", "refresh Karyo") runs `karyo init`, the first automatic scan, a proposed curation (`karyo/curation.json`), one recording of the tests, the view, and offers a refresh hook. docs/ADOPT.md.
- **`karyo init`:** detects the project (packages, tests, package manager, CI, justfile or Makefile), shows a plan and asks; writes the launcher `karyo/karyo.sh`, `.gitignore` entries for generated files, `karyo-*` recipes, a dev dependency only for the SDK's code form, and on request a CI workflow and a refresh hook (Claude Code Stop or PostToolUse, or git post-commit), into the project only. Idempotent; `--remove` takes it all out.
- **`karyo refresh`** (re-scan in automatic mode and rebuild; reports unresolved curation entries and drift; `--check` for CI, `--hook` quiet and debounced) and **`karyo record`** (the tests once under sys.monitoring).
