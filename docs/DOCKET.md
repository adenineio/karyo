# The docket

The docket is a per-project sheet of items that need your attention. They're the decisions to make, the things to review, and the things to come back to before a milestone. Claude Code sessions add to it ("put this on the docket"), and so do you, from the shell. Karyo never renders it as a plate. It's a plain Markdown file that you can read and edit by hand.

Each repository has one docket. Every worktree, every branch and every clone of that repo uses the same file. So a session in `notes-app-sync` and a session in `notes-app-search` add to one list, and each item records where it came from.

## Storage

- **Home**: `$KARYO_HOME`, default `~/.adenine/karyo`. Dockets live in `<home>/dockets/`.
- **File**: `<repo-name>-<rootsha8>.md`, plus a sidecar `<repo-name>-<rootsha8>.json`.
  - `rootsha8` is the first 8 hex digits of the repo's root commit (`git rev-list --max-parents=0 HEAD`). When there are several roots, as in merged histories, the oldest by committer date wins.
  - `repo-name` is the basename of the main worktree, which is the directory holding the common `.git` (`git rev-parse --path-format=absolute --git-common-dir`). A worktree at `~/code/notes-app-sync` of the repo `~/code/notes-app` resolves to `notes-app-<sha8>.md`.
  - Outside git, or in a repo with no commits yet, the key is the directory's basename plus an 8-hex hash of its absolute path. Every command then prints a warning (in `--json`, it's in `warnings`).
- **Sidecar** (`.json`): what the Markdown doesn't show. It holds `lastId`, the highest id ever handed out, and per item the full worktree path and the Claude Code session ids (`worktreePath`, `sessionId`, `closedSessionId`). `--json` output includes them. If you delete the sidecar, only those extras are lost: ids continue from the highest one in the file.
- **History**: the home is a git repository. It's initialized on first use with a repo-local identity (`Karyo docket <docket@karyo.invalid>`, `commit.gpgsign=false`), and every change is committed: `docket: add D-14 · notes-app`, `docket: close D-14 · …`, and so on. Hand edits get their own commit (`docket: hand edit · <repo>`). It's made just before the next command's change, or right after `karyo docket open` when the editor blocks. Nothing is ever pushed. If git is missing or a commit fails, the change is still written and the command warns.

## Format

```markdown
# Docket · notes-app
<!-- karyo docket · repo root 3f9c2e1a · edit freely; keep the **D-n** ids -->

Milestones: beta (the first testers) · 1.0 — anything you like, no format

## Needs a decision
- [ ] **D-14** Sync conflicts: last write wins, or merge field by field?
  before: beta · from: feat/sync @ 3c1e9a2 · worktree: notes-app-sync · session: sync-session · ref: src/sync/merge.ts:48 · 2026-05-14
  > Why: last write wins drops edits made offline on two devices.

## To review
- [ ] **D-12** …

## Come back to
- [ ] **D-9** …

## Closed
- [x] **D-7** Storage format — decided: SQLite, one file per notebook · closed 2026-05-14 · session: sync-session
  kind: decision · from: main @ 7572f54 · worktree: notes-app · 2026-05-02
```

- **Kinds** map to sections: `decision` → "Needs a decision", `review` → "To review", `later` → "Come back to". An open item's kind is the section it sits in, so moving an item by hand changes its kind. `add` defaults to `decision`.
- **Item line**: `- [ ] **D-<n>** <summary>`. Ids increase per docket and are never reused, even after you delete an item by hand.
- **Metadata line** (captured by `add`), with fields separated by ` · `:
  - `before:` names the milestone the item should be dealt with before. It's free text in any form. The `Milestones:` line is your own prose, and nothing parses it.
  - `from: <branch> @ <short sha>` records what was checked out; a detached HEAD records the sha only.
  - `worktree:` is the worktree directory's name (the full path is in the sidecar and in `--json`).
  - `session:` names the Claude Code session. Karyo reads `$CLAUDE_PID`, then `name` from `~/.claude/sessions/<pid>.json` (override the dir with `$KARYO_CLAUDE_SESSIONS`). It falls back to the first 8 characters of `$CLAUDE_CODE_SESSION_ID`, and leaves the field out outside Claude Code. `--session <name>` overrides it.
  - `ref:` is an optional `file:line`.
  - The last field is the date the item was added.
  - Keys that Karyo doesn't know are kept, in order.
- **`> Why:`** is an optional line with the reason.
- **Closed items** move to the top of "Closed", in the form `— <resolution> · closed <date> · session: <who>`. Their metadata line gains `kind:`, so `reopen` knows where to send them back. The resolution is everything after the last ` — ` on the line. Karyo writes an em dash inside a resolution as an en dash (`–`), so it reads back the same.

## CLI

`karyo docket <command> [--repo <dir>] [--json]`, or `just docket …` inside the Karyo checkout. It works from any directory inside any worktree. `--repo` points it at another repository.

| command | does |
|---|---|
| `add "<summary>" [--kind decision\|review\|later] [--why …] [--before …] [--ref file:line] [--session <name>]` | adds an item at the end of its section; prints the new id and the file |
| `list [--all] [--kind decision\|review\|later\|closed] [--before …]` | lists open items grouped as in the file (`--all` adds closed ones; `--before` matches case-insensitively) |
| `show D-14` | shows everything about one item (ids also work as `d-14` or `14`) |
| `close D-14 "<resolution>"` | closes the item with what was decided or done |
| `reopen D-14` | sends the item back to its kind's section and drops the resolution |
| `edit D-14 [--summary …] [--kind …] [--before …] [--why …] [--ref …]` | changes fields; `""` clears `before`, `why` or `ref`, and a new kind moves an open item |
| `milestones` | lists the distinct `before` values with open counts (and closed counts in `--json`), plus the `Milestones:` prose |
| `path` | prints the docket's path (the file may not exist yet) |
| `open` | creates the file if needed and opens it in `$VISUAL` / `$EDITOR`, then commits your edits; with no editor set, uses the OS opener (`open`, `xdg-open`) |

Every command honours `--json`: one JSON document on stdout, with `warnings` and, for changes, `commit`. Errors come back as `{"error": …}`. The exit codes follow the rest of the CLI: 0 for success, 2 for a usage error (unknown id, bad `--kind`, closing a closed item) or a crash. An item in JSON has these fields: `id n status kind section summary why before from branch sha worktree worktreePath session sessionId ref date resolution closed closedSession closedSessionId extra notes`.

## Concurrency

Every change runs under one lock for the whole home: `<home>/.docket.lock`, created with `O_EXCL`. All dockets share the home repo's git index, so the lock covers every docket. A waiting command retries every 15–50 ms, for up to 15 s (`$KARYO_DOCKET_LOCK_TIMEOUT_MS`). A lock is stale, and gets broken, when its holder's pid is gone or it's older than a minute. Under the lock, the command runs these steps in order:

1. Commit any pending hand edits.
2. Read the file.
3. Apply the change.
4. Write the sidecar and the Markdown atomically (a temp file, then rename).
5. Commit.

Two sessions in different worktrees can add at the same moment and neither loses an item. The tests check this with 20 parallel `add` processes. Reads (`list`, `show`, `milestones`, `path`) take no lock. Because the writes are atomic, a read never sees a half-written file.

## Editing by hand

Edit freely. The parser is tolerant, and a rewrite changes only the items a command touched.

- **Kept as they are**: prose anywhere, extra blank lines, reordered items, unknown sections (their items still show in `list`, under their own heading), notes, and nested bullets indented under an item. An item that no command touched is written back byte for byte.
- **Required**: keep the `**D-n**` ids. An item is a line starting with `- [ ] **D-<n>**` or `- [x] **D-<n>**`, followed by the indented lines under it. A checkbox without an id is ordinary text.
- **Placement**: a new item goes after the last item of its section. A missing section is recreated in the canonical order (decision, review, later, closed).
- **Ticking by hand**: `[x]` in an open section counts as closed, and an unticked item under "Closed" counts as closed too.
- **Restrictions**: fields are single-line, and ` · ` separates them. Karyo writes a ` · ` inside a value as ` / `.

Key files: `src/docket/format.ts` (pure parse, format and edits), `src/docket/store.ts` (repo identity, session capture, lock, atomic write, home repo), `src/docket/cli.ts` (the commands), `cli/karyo.ts` (`docket` subcommand), `tests/docket.test.ts` (`just docket-test`).
