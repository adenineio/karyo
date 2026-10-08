---
name: docket
description: Keep the project's docket — one sheet per repository (shared by every worktree and branch) of things that need the user's attention later: decisions to make, things to review, things to come back to before a milestone. Use this whenever the user says "put this on the docket", "docket this", "add that to the docket", "remind me to decide/review/come back to…before <milestone>", asks "what's on the docket", "what do I need to decide before beta", "show D-12", or says "close D-12, we decided…", "reopen D-3", "move D-5 to review". Also use it when the user asks what's still open or pending for the project, even without saying "docket".
---

# The docket

`karyo` below is the plugin's CLI, run by its full path: `"${CLAUDE_PLUGIN_ROOT}/cli/karyo"` (it isn't on PATH;
if that path comes out empty, `"${CLAUDE_SKILL_DIR}/../../cli/karyo"` is the same file).

The docket is a plain Markdown sheet per repository, kept outside the repo (`~/.adenine/karyo/dockets/`, versioned in its own git history). Every worktree and branch of the repo writes to the same sheet, and each item records where it came from — branch, commit, worktree, Claude Code session — automatically. It exists so the user can make decisions on their own schedule instead of losing them in a session's scrollback.

All reads and writes go through the `karyo docket` CLI; never edit the file directly (the CLI takes a lock, writes atomically and commits, so parallel sessions in other worktrees don't clobber each other). Inside a Karyo checkout `just docket …` works too. Pass `--json` when you need to read fields back reliably.

## Adding ("put this on the docket")

Only add when the user asks, or when you offered ("want me to put that on the docket?") and they said yes — the docket is the user's list of what needs *them*, so unrequested items dilute it.

Write the item from the conversation, so the user never has to dictate it:

- **Summary** — one line, **in the user's own phrasing**, lightly cleaned. People often dictate, so their words can arrive with fillers ("uh", "um", "you know", "like", "I guess"), false starts, repeated words, run-ons and speech-to-text slips ("sink" for "sync"). Remove those, fix grammar and obvious mis-transcriptions, tighten to one line — and stop there. Keep their words, their framing and their level of certainty; don't add next steps, conclusions, causes or claims they didn't make, and don't turn a note into a question unless they posed a choice. The docket is their record of what they said needed them; a summary that says more than they did quietly changes the decision.
  - Dictated: "uh the search index it still like rebuilds everything you know on every save instead of just the changed note, not urgent" → "Search index still rebuilds everything on every save instead of just the changed note" (not "…— make it incremental": they didn't say to).
  - Dictated: "i need to decide um whether the export endpoint is admin only or or we just hide it in the menu" → "Decide whether the export endpoint is admin-only or just hidden in the menu".
- **Kind** — always pass `--kind`, because it decides the section the user scans:
  - `decision` — a choice between options only the user can make.
  - `review` — something built or written that needs their eyes.
  - `later` — not actionable now; come back to it (often "before X").
  - Listen for the verb: "look at / check / go over" → `review`; "decide / choose / X or Y" → `decision`; "think about / someday / not now / come back to" → `later`. A deadline ("before the demo") doesn't change the kind — it goes in `--before`.
- **Why** (`--why`) — one short sentence on why it needs the user or what's at stake, taken from what they or the conversation actually said (same light cleanup). Skip it if the summary already says it or nobody gave a reason — don't invent one.
- **Before** (`--before`) — only when a milestone, date or event was mentioned ("before the demo", "beta", "Friday"). Pass their words as they said them; milestones follow no convention and nothing parses them.
- **Ref** (`--ref file:line`) — when a specific place in code or a doc is involved.

The CLI fills in branch, commit, worktree, session name and date itself — don't pass them.

```sh
karyo docket add "Pick a sync format: JSON patches or a CRDT?" \
  --kind decision --why "it fixes how offline edits merge" --before "beta" --ref src/sync/format.ts:12
```

Then confirm in one line with the id: "Added **D-15** (needs a decision, before beta)." If the user put several things on the docket at once, add each as its own item.

## Reading ("what's on the docket")

`karyo docket list` (open items, grouped by section), `--kind decision|review|later|closed`, `--before "<milestone>"`, `--all` to include closed; `karyo docket show D-14` for one item; `karyo docket milestones` for what's due before what.

Read it back short and grouped the way the sheet is — the user is scanning for what needs them:

```
Needs a decision (2)
  D-14  Sync conflicts: last write wins or merge field by field?      · before beta
  D-15  Pick a sync format: JSON patches or a CRDT?                   · before beta
To review (1)
  D-12  Review the conflict-merge code                                · from feat/sync
```

Mention where an item came from (branch/worktree/session) only when it helps — e.g. when items came from several worktrees or the user asks. If the list is empty, say so in one line. `karyo docket path` / `open` give the file itself if the user wants to read or edit it by hand (hand edits are fine and are kept).

## Closing, reopening, editing

- **Close** with what was decided or done, in a few words, in the user's terms (same light cleanup; don't add reasons they didn't give): `karyo docket close D-14 "merge field by field; revisit if it gets slow"`. If they only said "close D-14", ask what was decided unless it's obvious from the conversation — a closed item without its resolution loses the point of having tracked it.
- **Reopen**: `karyo docket reopen D-3`.
- **Edit** fields: `karyo docket edit D-9 --before "beta"` (`--summary`, `--kind`, `--before`, `--why`, `--ref`; `""` clears before/why/ref; a new `--kind` moves the item to that section).

## In Cowork

The docket lives in Karyo's home, which in Cowork is inside the session's sandbox and may not outlast it. The first
time in a session, ask once whether to keep the docket in their folder; if yes, start every docket command with
`KARYO_HOME="<their folder>/Karyo"` (the sheet is a Markdown file there, `dockets/<name>.md`, with its history beside
it) and pass `--repo "<their folder>"`. Without a shell but with Karyo's MCP tools, the `docket` tool does the same
(`folder`: their folder as that tool sees it). Read items back in plain words.

Ids look like `D-14` (`14` and `d-14` also work). An unknown id exits with code 2 and an error — say so and offer `list`.
