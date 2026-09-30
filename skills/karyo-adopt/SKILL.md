---
name: karyo-adopt
description: Set a project up for Karyo and keep it current. Use it whenever the user says "set up Karyo here", "adopt Karyo", "add Karyo to this project", "use Karyo on this repo", "refresh Karyo", "update the Karyo curation", "the Karyo board is out of date", or asks why the Karyo model shows stale or unresolved things after a refactor. It runs `karyo init`, the first automatic scan, proposes a curation (what matters, groups, categories, names, what to hide), records the tests once, opens the view and offers a refresh hook. Prefer it over hand-writing directives or model files.
argument-hint: "[project dir]"
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" init *)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" refresh *)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" refresh)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" record *)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" view *)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" view)
---

# Adopt Karyo in a project

`karyo` below is the plugin's CLI, run by its full path: `"${CLAUDE_PLUGIN_ROOT}/cli/karyo"` (it isn't on PATH). The
whole story, file by file, is in `${CLAUDE_PLUGIN_ROOT}/docs/ADOPT.md`; the model and curation format in
`${CLAUDE_PLUGIN_ROOT}/docs/MODEL.md` ("Automatic mode", "Curation", "Coverage").

Karyo draws a project from its code with no annotations (automatic mode: every class and public function a node, plus
the static call graph). What makes the board worth reading is the **curation**, `karyo/curation.json`: which pieces
matter, how they group, what they're called. It sits beside the code and never touches it, so the code stays yours:
don't edit application code, and don't add `# karyo:` directives or decorators unless the user asks. Curation first.

## Setting up

1. **Init.** Run `karyo init $ARGUMENTS --dry-run` and tell the user in a few lines what it found (packages, tests,
   task runner, CI) and what it will write. Then `karyo init $ARGUMENTS --yes`. It is idempotent and writes only into
   the project: the launcher `karyo/karyo.sh`, `.gitignore` entries for generated files, `karyo-scan` /
   `karyo-record` / `karyo-view` recipes when a justfile or Makefile already exists. It adds no dependency unless the
   app imports `karyo` itself (the code form); automatic mode needs none, because the plugin scans with its own SDK.
   Leave the hook and CI for later (steps 6 and 7) so the user decides them with the board in front of them.
2. **First scan.** `karyo refresh --json --outline`. The outline lists every card by group, with calls in and out
   and what each type folds (`⊂`). For a big project (hundreds of lines), work group by group.
3. **Propose a curation.** Read the outline and the code it points at (entry points, the main types, the modules the
   most calls go through), then show the user a short outline, 10 to 20 lines, before writing anything:
   - **Top level:** the 5 to 15 cards someone new should see first. `top` unfolds a method that deserves its own card
     (a main operation); `fold` tucks a helper into its type.
   - **Groups:** by layer or feature, 2 to 6 of them, nested with `parent` when the project has sub-areas
     (`"app"` in `"notes"` shows as `Notes / App`). Move nodes with `members` selectors (`billing.charge.*`).
   - **Categories:** a handful (entry, service, store, data, helper, external: whatever fits the project), because
     they are the board's colours and legend; more than about six stops meaning anything.
   - **Tags:** cross-cutting facts (`search`, `money`, `slow`) the legend can filter by.
   - **Renames:** plain words for people (`Note store`, not `NoteStore`), a one-line `summary` where the docstring
     doesn't say it.
   - **Hide:** tests, generated code, trivial value types, compatibility shims. Private helpers (`_name`) are already
     transparent, so they don't need hiding.
   Ask whether to go ahead or change something. When they agree (or asked you to just do it), write
   `karyo/curation.json` (`{"karyo": "curation/1", "note": "…why…", "top": [], "fold": [], "hide": [], "groups": {},
   "nodes": {}}`; schema `${CLAUDE_PLUGIN_ROOT}/spec/karyo-curation.schema.json`), run `karyo refresh`, and fix every
   `curation-unresolved` entry it reports (the message has a did-you-mean).
4. **Record the tests once** (offer it; it runs their test suite): `karyo record` uses the detected test command, or
   `karyo record -- <command>`. It runs under Python's sys.monitoring recorder (Python 3.12+) and rebuilds, so the
   board shows the calls that really happen, flows per test, and what the tests never ran ("not exercised"). A
   failing test still records; say so if one failed.
5. **Open the view.** `karyo view` (add `--open` only if asked) and give the URL in one line: the structure board,
   a trace board per recorded flow.
6. **Offer the refresh hook**, so the model stays current without anyone thinking about it. Explain the choices in a
   sentence each, recommend the first, and install with `karyo init --yes --hook <choice>`:
   - `stop`: a Claude Code Stop hook in the project's `.claude/settings.json`; after each turn it re-scans in the
     background if the code changed. One scan per turn, never slows a turn. Recommended.
   - `edit`: a PostToolUse hook on Edit/Write/MultiEdit; fresher mid-turn, more scans (debounced).
   - `git`: a post-commit hook in this clone (not shared); catches changes made outside Claude too.
   - `none`: they run `karyo refresh` (or `just karyo-scan`) themselves.
   Combinations work (`--hook stop,git`). Hooks go into the project only, never user-level settings.
7. **Offer CI** only if the project has GitHub Actions: `karyo init --yes --ci` adds `.github/workflows/karyo.yml`,
   which checks Karyo stays inert in production (`check-prod`) and fails when the curation no longer matches the code.

Finish with what was written (the init summary lists it), what's committed (`karyo/`, `.gitignore` changes, the
recipes, `.claude/settings.json`) and what isn't (`.karyo/` fragments, `karyo.model.json`, rebuilt from the code).

## Refreshing

After a refactor, a rename, or when the user says the board is stale:

1. `karyo refresh --json --outline`. It reports:
   - `unresolved`: curation entries that match nothing now (a rename, usually). Propose the fix from the did-you-mean
     and the outline: rename the selector, or drop the entry when the code is gone.
   - `drift.seenNotInCode`: calls a recorded run made that static analysis doesn't find: dynamic calls (registries,
     callbacks), or a recording older than the code. After a big refactor, offer `karyo record` again.
   - `drift.notExercised`: code the recorded tests never ran. Mention it as a fact about test coverage, not a fault.
2. New modules or types land in automatic mode with default groups; propose where they belong in the curation.
3. Show the proposed curation changes as a short diff, write them when agreed, and `karyo refresh` again until
   nothing is unresolved.

## If something is off

- `karyo init --remove` takes out everything init wrote plus the generated files and keeps `karyo/curation.json`
  and splices; `--purge` removes those too. Offer it if the user wants Karyo gone.
- A project with no Python package: Karyo still works from explainers (the karyo-explain skill) and from `# karyo:`
  directives in other languages (Go has directives only); say so rather than forcing a scan.
- bun missing, or the first run installing dependencies: pass on the command it prints.
