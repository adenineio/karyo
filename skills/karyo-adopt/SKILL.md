---
name: karyo-adopt
description: Set a project up for Karyo and keep it current, Python or Swift. Use it whenever the user says "set up Karyo here", "adopt Karyo", "add Karyo to this project", "use Karyo on this repo" (an iOS / macOS / SwiftUI app or Swift package too), "refresh Karyo", "update the Karyo curation", "the Karyo board is out of date", or asks why the Karyo model shows stale or unresolved things after a refactor. It runs `karyo init`, the first scan (automatic for Python; for Swift, Claude first writes `// karyo:` marker comments on the parts that matter), proposes a curation (what matters, groups, categories, names, what to hide), records Python tests once, opens the view and offers a refresh hook. Prefer it over hand-writing model files.
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

Karyo draws a project from its code in one of two ways, and `karyo init` says which applies:

- **Python: automatic mode, with directives on top.** No annotations needed: every class and public function is a
  node, plus the static call graph, so the whole codebase is traced. `# karyo:` directives *add* meaning on top of it,
  they never switch it off: a `# karyo:node` on a def refines that def's card (label, category, tags, `calls=` to an
  external) and keeps its id when it gives none. Don't edit application code, and don't add directives or decorators
  unless the user asks; the curation says most of what a directive could. `karyo/config.json` records the mode
  (`"auto"`, or `"directives"` for directives only: `karyo init --mode directives`).
- **Swift** (a `Package.swift`, `.xcodeproj` or `.xcworkspace`): **markers**. There is no automatic mode for Swift
  yet, so you read the app and write `// karyo:` comments above the parts that matter, saying what each is and what it
  calls (step 2). They are comments only: nothing to import, nothing changes how the app builds or runs. They are kept
  by hand (by you, when the code changes); `karyo refresh` re-reads them. A compiler-index automatic mode may come later.

Either way, what makes the board worth reading is the **curation**, `karyo/curation.json`: which pieces matter, how
they group, what they're called. It sits beside the code and never touches it.

## Setting up

1. **Init.** Run `karyo init $ARGUMENTS --dry-run` and tell the user in a few lines what it found (Python packages
   and tests, or the Swift manifest, its targets and how many markers there are; task runner, CI) and what it will
   write. Then `karyo init $ARGUMENTS --yes`. It is idempotent and writes only into the project: the launcher
   `karyo/karyo.sh`, the settings `karyo/config.json` (Python: the mode, `auto` unless the user wants directives only;
   if the code already has directives, say they will now refine automatic mode's cards rather than replace them),
   `.gitignore` entries for generated files, `karyo-scan` / `karyo-record` (Python only) /
   `karyo-view` recipes when a justfile or Makefile already exists. It adds no dependency unless a Python app imports
   `karyo` itself (the code form); automatic mode and markers need none, because the plugin scans with its own code.
   Leave the hook and CI for later (steps 6 and 7) so the user decides them with the board in front of them.
2. **First scan.** Python: `karyo refresh --json --outline`. Swift: write the markers first (below), then the same
   command. The outline lists every card by group, with calls in and out and what each type folds (`⊂`). For a big
   project (hundreds of lines), work group by group.

   **Markers (Swift).** Read the app (entry point, screens, view models, the services under them), then show the user
   the list of parts you'd mark, 10 to 30 for a small app, and write them when they agree. One marker sits directly
   above a declaration (`class`, `struct`, `enum`, `actor`, `protocol`, `extension`, `func`, `var`, `let`; attribute
   lines such as `@MainActor` may sit between, a blank line may not):

   ```swift
   /// Where the app gets notes: the local cache first, the server when it must.
   // karyo:node id=notes.repository kind=service label="Note repository" category=service
   //   calls=notes.api,notes.cache
   struct NoteRepository { … }

   // karyo:external id=ext.keychain label="Keychain" category=outside
   ```

   - **What to mark:** the `@main` App and the composition root that builds things; screens (tabs, pushed or presented
     screens), not every SwiftUI subview or row; view models; services; stores and persistence; network and API
     clients. Value types and small helpers stay unmarked unless they matter to how it works.
   - **ids** `area.thing`, lowercase (`app.main`, `ui.editor`, `vm.editor`, `notes.store`, `notes.api`); the first part is
     the default group. `kind=` what it is (`service`, `store`, `type`, `function`); `category=` a handful of words
     used consistently (entry, screen, viewmodel, service, store, outside), because they are the board's colours.
     `label=` plain words; the `///` doc comment above becomes the summary.
   - **`calls=` from the code:** for each marked part, the marked parts its code calls: follow its stored properties
     and initializer parameters to what its methods call (a screen calls its view model, a view model its repository,
     a repository its client and cache, a client the outside service). List only real calls, only ids that are
     marked; `reads=` / `writes=` where they read better. A list key may repeat on a continuation line (`//   calls=…`).
   - **Outside the app:** one `// karyo:external` per outside service it talks to (the HTTP API, Keychain, CloudKit,
     notifications, files), anywhere in the sources (next to the code that uses it reads best).

   Then `karyo refresh --json --outline` and fix every `directive-invalid` (a typo: it is ignored until fixed) and
   `directive-unknown-target` (a `calls=` id nothing declares; the message has a did-you-mean).
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
   - **Directives (only if the user wants them in the code):** where a fact belongs next to the code rather than in the
     curation, propose a few: a label and category on a central service, a `# karyo:external` for an outside service
     the code talks to (an email relay, a payment API) with `calls=` from the class that talks to it. Leave out `id=`
     so the card keeps its id, and the curation and tours that name it keep working.
   Ask whether to go ahead or change something. When they agree (or asked you to just do it), write
   `karyo/curation.json` (`{"karyo": "curation/1", "note": "…why…", "top": [], "fold": [], "hide": [], "groups": {},
   "nodes": {}}`; schema `${CLAUDE_PLUGIN_ROOT}/spec/karyo-curation.schema.json`), run `karyo refresh`, and fix every
   `curation-unresolved` entry it reports (the message has a did-you-mean).
4. **Record the tests once** (Python only; offer it, it runs their test suite): `karyo record` uses the detected test command, or
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
   Swift: markers don't follow the code by themselves. After a change, update the markers it touched (a renamed or
   moved type keeps its marker above it; a new screen, view model or service gets one; `calls=` follows the code), and
   `directive-unknown-target` names a `calls=` that no longer matches.
3. Show the proposed curation changes as a short diff, write them when agreed, and `karyo refresh` again until
   nothing is unresolved.

## If something is off

- `karyo init --remove` takes out everything init wrote plus the generated files and keeps `karyo/curation.json`
  and splices; `--purge` removes those too. Offer it if the user wants Karyo gone.
- A project with neither a Python package nor a Swift project: Karyo still works from explainers (the karyo-explain
  skill) and from directives in other languages (Go has `//karyo:` directives only); say so rather than forcing a scan.
- bun missing, or the first run installing dependencies: pass on the command it prints.
