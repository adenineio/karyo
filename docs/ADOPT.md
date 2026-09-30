# Adopting Karyo in a project

One sentence in Claude Code, **"set up Karyo here"**, and a project has a Karyo board drawn from its own code, curated
into something a newcomer can read, and kept current from then on without anyone thinking about it. This page is the
whole story: what happens, which files appear in the project and why, what is committed, the refresh hook, and how to
take Karyo out again.

The pieces: the **`karyo-adopt` skill** (`skills/karyo-adopt/SKILL.md`), which drives it; **`karyo init`**, which
sets the project up; **`karyo refresh`**, which re-scans; and **`karyo record`**, which records the tests once.
Code: `src/cli/init.ts` (detection, the plan, the file writers), `src/cli/adopt.ts` (the commands). Tests:
`tests/adopt.test.ts` (`just adopt-test`).

## What happens

The skill runs these in order, and asks before the parts that are a choice:

1. **`karyo init --dry-run`, then `karyo init --yes`.** Detects the project and shows what it will change (below).
2. **The first scan**, `karyo refresh`. Automatic mode: every class and public function becomes a node, methods fold
   into their type, and the static call graph gives the relationships (docs/MODEL.md "Automatic mode"). No
   annotations, nothing imported or run.
3. **A proposed curation.** Claude reads the model's outline (`karyo refresh --outline`) and the code, and proposes
   `karyo/curation.json`: the cards that matter at the top level, groups and their nesting, a handful of categories,
   tags, plain-word names, and what to hide (tests, generated code). It shows this as a short outline first, and
   writes it when you agree. The curation refers to nodes by their ids and never touches the code.
4. **Recording the tests once** (offered): `karyo record` runs the test suite under Python's sys.monitoring recorder,
   so the board shows the calls that really happen, each test as a flow, and what the tests never ran ("not
   exercised").
5. **The view**: `karyo view` prints the URL of the project's board.
6. **The refresh hook** (offered), so the model follows the code from now on.
7. **CI** (offered, only with GitHub Actions).

It never edits application code and never adds `# karyo:` directives or decorators unless you ask. Curation comes
first because it lives beside the code: a directive is worth it only for what a curation can't say.

## `karyo init`

```sh
karyo init [dir] [--dry-run] [--yes] [--hook stop|edit|git|none] [--ci | --no-ci] [--no-recipes]
           [--commit-model | --no-commit-model] [--json]
karyo init [dir] --remove [--purge] [--yes]
```

It detects the git root (the default project dir), the Python packages (top-level folders or `src/*` with an
`__init__.py`; tests, docs, examples and scripts aren't the app), whether they carry directives or import `karyo`,
Go modules, the test runner and its command (pytest or unittest, through uv, poetry, pipenv or the project's
`.venv`), the package manager, CI (GitHub Actions; others are named), a justfile or Makefile, and what an earlier
`karyo init` wrote. Then it prints a plan, one line per file (`create`, `update`, `ok`, `skip` with the reason, `run`),
with the exact text it adds, and asks. `--yes` applies without asking; `--dry-run` never writes; without a terminal
and without `--yes` it only prints the plan. After applying it lists exactly what changed.

It is **idempotent**: a second run with the same choices changes nothing and says so. Leaving out `--hook` or `--ci`
keeps what is installed; `--hook none` and `--no-ci` take them out. Everything init adds to a file it doesn't own sits
between `# >>> karyo >>>` and `# <<< karyo <<<`, so a later run replaces it in place and `--remove` takes out
exactly that.

## Files in the project

| file | written by | committed | why |
|---|---|---|---|
| `karyo/karyo.sh` | init | yes | the launcher the recipes and hooks run. It holds no machine path: it finds Karyo through `$KARYO_CLI`, then the copy that last ran here (`.karyo/cli-path`), then the newest Claude Code plugin install, then `karyo` on PATH. A teammate without Karyo gets a one-line hint, and a hook exits quietly |
| `.gitignore` (a block) | init | yes | ignores `.karyo/` and `karyo.model.json` |
| `justfile` / `Makefile` (a block) | init, only if the file exists | yes | `karyo-scan`, `karyo-record` (with the detected test command), `karyo-view`. Karyo never creates a task runner, and skips a recipe name the file already uses |
| `.claude/settings.json` (hooks) | init, if you pick a Claude Code hook | yes | the refresh hook, for everyone who opens the project in Claude Code |
| `.git/hooks/post-commit` (a block) | init, if you pick the git hook | never (inside `.git`) | the refresh hook for this clone |
| `.github/workflows/karyo.yml` | init, with `--ci` | yes | check-prod and a model build in CI |
| `karyo/curation.json` | the skill (or you) | **yes** | what matters and how it's grouped; the part a person decides |
| `karyo/splices/*.splice.json` | the view (Splice) | **yes** | what-if changes you saved |
| `karyo/kits/` | `karyo kit new` | yes | the project's own node kinds and plate types (docs/KITS.md) |
| `karyo.layout.json` | the view ("save as team layout") | yes | the board's arrangement you chose |
| `karyo.model.json` | `karyo refresh` / `record` | **no** (by default) | generated from the code, the curation and the recordings |
| `.karyo/` | scans, recordings, hooks | no | fragments (`python.*.static.karyo.json`, `python-<pid>.karyo.json` from a recording), `cli-path`, the refresh lock and `refresh.log` |

**Why the model isn't committed.** It is a build output: `karyo refresh` rebuilds it in well under a second from what
is committed, and the refresh hook rewrites it after every change, which as a tracked file would leave every working
tree dirty and every merge a conflict. Recorded flows add timings that differ on every run. Commit it when you
want it (the board without running anything, or its history as a Stack view) with
`karyo init --commit-model`; a project that already tracks `karyo.model.json` keeps it tracked.

## Dependencies

**Automatic mode and `# karyo:` directives need no dependency at all**: the plugin scans and records with its own copy
of the Python SDK (on `PYTHONPATH` for that one command), so the project's install is unchanged and production never
sees Karyo. Only the **code form**, an app that imports `karyo` itself (`@karyo.node`, `karyo.watch()`), needs it,
and then as a **dev dependency**: init runs `uv add --dev` (or `poetry add --group dev`, or adds a line to
`requirements-dev.txt`) with the SDK from the plugin's public repo at the plugin's version,
`karyo @ git+https://github.com/adenineio/karyo@v<version>#subdirectory=sdk/python`. An app that imports `karyo`
unconditionally must also list it at runtime; `check-prod` says when (docs/MODEL.md "Check the production rule").
Go modules are detected; Go has directives only (`//karyo:node`, docs/MODEL.md), no automatic mode yet.

## Refreshing

```sh
karyo refresh [dir] [--if-stale] [--check] [--outline] [--json] [--hook]
```

Scans every Python package (automatic mode where there are no directives), drops fragments of packages that are gone,
and rebuilds `karyo.model.json`, applying `karyo/curation.json`. It reports what needs a person:

- **`curation-unresolved`**: a curation entry that matches nothing now, usually a rename; the message has a
  did-you-mean. The skill proposes the fix. `--check` exits 1 on these (what CI runs).
- **seen, not in the code**: calls a recorded run made that static analysis doesn't find. Dynamic calls (a registry,
  a callback) are expected; after a refactor it usually means the recording is older than the code: record again.
- **not exercised**: code the recorded runs never ran. A fact about the tests, shown dotted on the board.

`--if-stale` does nothing when the model is newer than the code, the curation and the recordings. `--outline` adds a
compact outline of the cards (the skill's input for a curation). `--hook` is what the hooks run: `--if-stale`, silent
(it logs the last 200 lines to `.karyo/refresh.log`), never fails, and **debounced**: while one refresh runs, another
leaves `.karyo/refresh.pending` and exits, and the running one goes once more when it ends, so a burst of edits costs
at most two scans.

## Recording

```sh
karyo record [dir] [--keep] [--sample 0.1] [-- <command …>]
```

Runs the detected test command (or the one after `--`) under `python -m karyo record --monitor`, watching the
project's packages, then rebuilds. A new recording replaces the last (`--keep` adds to it), so the board never mixes
a stale run into a fresh one. It needs Python 3.12+ for sys.monitoring. A failing test still records what ran; the
command's exit code is passed on.

## The refresh hook

Pick one when the skill offers it, or any time: `karyo init --yes --hook <choice>` (a comma list combines them).

| choice | where | when it re-scans | trade-off |
|---|---|---|---|
| **`stop`** (recommended) | `.claude/settings.json`, a `Stop` hook | after each Claude turn, if the code changed | one scan per turn, in the background (`async`): it never slows a turn, and the board is current whenever you look after Claude worked. Shared with the team through the settings file |
| `edit` | `.claude/settings.json`, `PostToolUse` on `Edit\|Write\|MultiEdit` | after every file edit Claude makes | fresher mid-turn, more scans (debounced as above) |
| `git` | `.git/hooks/post-commit` (respects `core.hooksPath`) | after each commit, in the background | catches changes made outside Claude; this clone only; a post-commit hook that isn't a shell script is left alone (init says what to add) |
| `none` | | when you run `karyo refresh` or `just karyo-scan` | nothing automatic |

All of them run `karyo/karyo.sh refresh --hook` and install into the project only, never into user-level settings.
Recommended: `stop`, because edits in a Claude Code session are where the code changes fastest and a turn is the
natural unit; add `git` if people also change the code outside Claude.

## CI

`karyo init --ci` (offered when the project has GitHub Actions) writes `.github/workflows/karyo.yml`: it checks out
the plugin's public repo at the plugin's version, runs `python -m karyo check-prod <packages>` (Karyo is inert in
production code: no recording turned on, no internals imported; `--strict`, zero footprint, is the stronger rule a
project can switch to) and `karyo refresh --check` (fails when the curation no longer matches the code), and uploads
the model as an artifact.

## Removing Karyo

```sh
karyo init --remove            # everything init wrote, and the generated files
karyo init --remove --purge    # also karyo/ (curation, splices, kits) and karyo.layout.json
```

`--remove` takes Karyo's blocks out of `.gitignore`, the justfile or Makefile and the post-commit hook (deleting the
hook file when nothing else is in it), its hooks out of `.claude/settings.json` (deleting the file when it held
nothing else), and deletes the launcher, the CI workflow, `.karyo/` and `karyo.model.json`. What you or Claude wrote,
the curation, splices, kits and layout, stays unless you add `--purge`. It shows the plan and asks first, like init.
A dev dependency added for the code form stays, because the app imports it; `uv remove --dev karyo` after the
imports are gone. The plugin itself: `claude plugin uninstall karyo@adenine`. After `--remove --purge`, the project is
byte for byte what it was before `karyo init` (`tests/adopt.test.ts` checks it).
