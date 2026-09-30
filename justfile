# Karyo: every usage command lives here. `just` (or `just --list`) prints the menu.
#
# Scene recipes pass extra flags through to scripts/render.ts, e.g.
#   just stills request-flow 1,3,5 --mode dark
#   just lint layers-stack --theme adenine-periwinkle

# Extra local recipes, when dev/justfile exists
import? 'dev/justfile'

# Show this menu
default:
    @just --list --unsorted

# ---------------------------------------------------------------- setup

# Install JS deps (bun); the MCP server's and Jarvis's Python envs are made by their own recipes (uv)
[group('setup')]
install:
    bun install

# ---------------------------------------------------------------- engine & site

# Dev server with every scene and the ⚙ theme menu (http://localhost:5180)
[group('site')]
dev:
    bunx vite

# Build the static site into dist/
[group('site')]
build:
    bunx vite build

# Type-check src/ with tsc
[group('site')]
typecheck:
    bunx tsc --noEmit -p tsconfig.json

# ---------------------------------------------------------------- scenes (render.ts; needs Chrome, ffmpeg for sheet/video)

# PNG stills of a scene at comma-separated times, e.g. `just stills request-flow 1,3,5`
[group('scenes')]
stills scene t *flags:
    bun scripts/render.ts stills --scene {{scene}} --t {{t}} {{flags}}

# Contact sheet of a scene
[group('scenes')]
sheet scene *flags:
    bun scripts/render.ts sheet --scene {{scene}} {{flags}}

# Layout lint: one scene, or every scene when none is given
[group('scenes')]
lint scene="" *flags:
    bun scripts/render.ts lint {{ if scene == "" { "" } else { "--scene " + scene } }} {{flags}}

# Export a scene to video (.mp4, .gif or .webm by extension of `out`)
[group('scenes')]
video scene out *flags:
    bun scripts/render.ts video --scene {{scene}} --out {{out}} {{flags}}

# ---------------------------------------------------------------- explainers (docs/EXPLAINERS.md)

# Unit tests of the explainer core (template language, validator, component libraries, bundling, layouts)
[group('explainers')]
explainer-test:
    bun test tests/explainer.test.ts

# Stills of an explainer spec: every step at rest, plus any render.ts flags, e.g. `just explainer-stills my.explainer.json --theme adenine-jade`
[group('explainers')]
explainer-stills spec *flags:
    #!/usr/bin/env bash
    set -euo pipefail
    n=$(bun -e "import {resolveSteps} from './src/explainer/resolve'; console.log(resolveSteps(JSON.parse(await Bun.file('{{spec}}').text())).steps.length)")
    for i in $(seq 1 "$n"); do bun scripts/render.ts stills --spec {{spec}} --state "step-$i" --t 0.7 {{flags}}; done

# Layout lint of an explainer spec (every step, mid-transition and at rest)
[group('explainers')]
explainer-lint spec *flags:
    bun scripts/render.ts lint --spec {{spec}} {{flags}}

# Open an explainer spec on the dev server (explain.html?spec=…)
[group('explainers')]
explainer-dev spec:
    bunx vite --open "/explain.html?spec={{spec}}"

# Build one self-contained HTML file from an explainer spec (runtime cached in dist/runtime/)
[group('explainers')]
explainer-html spec out:
    bun -e "import {buildHtml} from './src/explainer/build'; const r = await buildHtml('{{spec}}', '{{out}}'); for (const i of r.issues) console.error(i.level, i.path || '/', i.message); console.log(r.file, (r.bytes / 1e6).toFixed(2) + ' MB')"

# Interaction smoke test of a shipped explainer (a spec, built to a temp file first, or a built .html) from file://: steps, keys, stations, play, theater, motion 0, no errors
[group('explainers')]
explainer-smoke spec:
    bun scripts/smoke-explainer.ts {{spec}}

# ---------------------------------------------------------------- model

# Unit tests: model merge, automatic mode (curation, coverage and not-exercised marks, the fold view), tours, the explainer core, kits and code in kits, the docket, Jarvis's matching
[group('model')]
test:
    bun test ./tests/

# Tests of the SDKs: Python (directives, scan, automatic mode and the static call graph, both recorders incl. sys.monitoring, inertness and its benchmark, check-prod; a throwaway uv env with pytest) and the Go scan's parser
[group('model')]
sdk-test:
    uv run --no-project --python 3.14 --with pytest --with-editable sdk/python pytest sdk/python/tests -q -p no:cacheprovider
    cd sdk/go && go test ./...

# A model file's git history as Stack view slices (one per commit that touched it), e.g. `just stack-history karyo.model.json out/history.json --last 5`
[group('model')]
stack-history model out *flags:
    bun scripts/stack-from-git.ts {{model}} -o {{out}} {{flags}}

# Reconcile a model file and print its errors, warnings and notes (exits 1 on an error: an identity conflict or a broken invariant)
[group('model')]
check model:
    bun scripts/model.ts check {{model}}

# ---------------------------------------------------------------- explainers & Claude integrations

# The karyo CLI (explainers: new, validate, stills, lint, build, …), e.g. `just karyo validate my.explainer.json`
[group('explainers')]
[no-cd]
[positional-arguments]
karyo *args:
    bun --no-env-file --config=/dev/null "{{justfile_directory()}}/cli/karyo.ts" "$@"

# Kits (docs/KITS.md): node kinds and plate types, e.g. `just kit new queues --kind queue`, `just kit list`, `just kit check queues`, `just kit trust <name>` / `just kit untrust <name>` (a kit that runs JavaScript)
[group('explainers')]
[no-cd]
[positional-arguments]
kit *args:
    bun --no-env-file --config=/dev/null "{{justfile_directory()}}/cli/karyo.ts" kit "$@"

# Tests of kits: resolution order and collisions, the schema and `kit check`, kind rendering and card sizes in the layout, binding kits to a model; code in kits (hash and re-prompt, the trust store in a sandboxed home, safe script reads, the server's guard and trust endpoint, and in Chrome that an untrusted script never runs; files go under $KARYO_TEST_SANDBOX, else the temp folder)
[group('explainers')]
kit-test:
    bun test tests/kits.test.ts tests/kit-scripts.test.ts

# Test the Karyo MCP server (both protocol modes; the end-to-end tests run through the real CLI when bun is installed)
[group('explainers')]
mcp-test *flags:
    cd integrations/mcp && uv sync -q && uv run pytest -q {{flags}}

# Serve the Karyo MCP server over stdio (what Claude Desktop / Cowork launches)
[group('explainers')]
mcp-serve:
    cd integrations/mcp && uv run karyo-mcp


# ---------------------------------------------------------------- the Claude Code plugin (docs/PACKAGING.md)

# A project's Karyo view (models, flows, tours, explainers) on a free port in 5781–5799, e.g. `just view ../my-app` (default: the directory you're in)
[group('plugin')]
[no-cd]
view dir="" *flags:
    bun --no-env-file --config=/dev/null "{{justfile_directory()}}/cli/karyo.ts" view {{dir}} {{flags}}

# Tests of adopting Karyo (docs/ADOPT.md): `karyo init` detection, plan, dry run, idempotency, the justfile / Makefile / settings / git-hook writers, refresh, record, the hook's debounce, and `--remove` leaving the project as it was (a sample project copied under $KARYO_TEST_SANDBOX, else the temp folder)
[group('plugin')]
adopt-test:
    bun test tests/adopt.test.ts

# Validate the plugin manifest and its skills
[group('plugin')]
plugin-validate:
    claude plugin validate .claude-plugin/plugin.json
    claude plugin validate skills

# Claude Code with this checkout loaded as the karyo plugin for one session (--plugin-dir: nothing is installed), e.g. `just plugin-dev -p "list your skills"`
[group('plugin')]
plugin-dev *args:
    claude --plugin-dir "{{justfile_directory()}}" {{args}}

# ---------------------------------------------------------------- docket (docs/DOCKET.md)

# The project's docket: decisions, reviews and come-back-tos (one per repo, shared by every worktree), e.g. `just docket add "Pick a sync format" --before beta`
[group('docket')]
[no-cd]
[positional-arguments]
docket *args:
    bun --no-env-file --config=/dev/null "{{justfile_directory()}}/cli/karyo.ts" docket "$@"

# Tests of the docket: parse/format round trips, worktrees sharing one file, 20 parallel adds, session capture, home-repo commits
[group('docket')]
docket-test:
    bun test tests/docket.test.ts

# ---------------------------------------------------------------- jarvis mode (docs/JARVIS.md; local only)

# Jarvis mode: voice control of plates (official Whisper + a claude -p brain) on 127.0.0.1:5190; then open the page (`just dev` running), e.g. `just jarvis --project ../my-app`
[group('jarvis')]
jarvis *flags:
    @echo "Jarvis mode → open http://localhost:5180/jarvis.html (needs \`just dev\` running)"
    uv sync -q --project integrations/jarvis
    PYTHONPATH=integrations/jarvis uv run -q --project integrations/jarvis python -m jarvis serve {{flags}}

# Tests of Jarvis mode (wake word, audio, protocol, brain, karyo-view MCP); `just jarvis-test --e2e` runs only the real Whisper + claude -p test (one Opus turn)
[group('jarvis')]
jarvis-test *flags:
    #!/usr/bin/env bash
    set -euo pipefail
    cd integrations/jarvis && uv sync -q
    if [[ " {{flags}} " == *" --e2e "* ]]; then JARVIS_E2E=1 uv run pytest -q -s -m e2e; else uv run pytest -q {{flags}}; fi
