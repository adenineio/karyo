# Explainers in Claude artifacts

Ask Claude to publish an explainer as an artifact (`/karyo:artifact`) and it builds the explainer as a page, publishes it as a
claude.ai artifact (private until you share it), and records the link in your project. After that, whenever Claude
changes that explainer, it republishes it to the **same** artifact URL, so a link you shared keeps showing the
current version.

The skill is `/karyo:artifact` (`skills/artifact/SKILL.md`). It also runs when you ask for an explainer's artifact
to be updated, or which explainers are linked.

## Who can publish

**Only Claude, in a session, can publish**, with its Artifact tool. Karyo never publishes and never talks to
claude.ai. The `karyo` CLI prepares the page, keeps the record, and tells Claude what is stale. So:

- A change Claude makes in a session with the plugin is republished in that session. The Stop hook reminds it if it
  forgot.
- A change made outside Claude (by hand, or in a session without the plugin) is not republished as it happens. The
  next Claude session with the plugin says, at its start, which linked explainers are out of date, and republishes
  them when you ask.
- Karyo can't see claude.ai. An artifact edited, re-shared or deleted there is not noticed.
- Only the artifact's owner, or someone it was shared with for editing, can republish it. Anyone else's Claude says
  it is stale and that the owner must republish.
- Without an Artifact tool (an API session, a host without artifacts), Claude builds the page and hands you the
  HTML file instead.

## Commands

All take `--json` and `--project <dir>` (default: the git repo you're in, else the working directory).

| command | does |
|---|---|
| `karyo artifact build <spec>` | builds the explainer for an artifact frame into `<project>/.karyo/artifacts/<id>.html` and prints its path, size, sha256 and title. Exits 1 on spec errors or over 16 MB. Says whether it is linked and whether the linked artifact already shows this exact page |
| `karyo artifact link <spec> <url> [--hash H]` | records that the spec is published at that artifact URL. The hash is the published page's sha256: by default that of the last `artifact build` of the spec. Re-linking replaces the entry |
| `karyo artifact unlink <spec>` | forgets the link (a spec that's gone can be named by its recorded path). The artifact itself stays on claude.ai |
| `karyo artifact status` | every linked explainer as `up-to-date` or `stale` (with the reason), then the explainers that aren't linked |
| `karyo build <spec> --target artifact` | the same page as `artifact build`, written where `build` writes, with no record |

A spec is **stale** when the page built from it now differs from the one published:

- **the explainer changed:** its spec or its components changed since it was published.
- **newer Karyo runtime:** only Karyo changed, and republishing is optional.
- **the spec is gone:** unlink it, or link it again at its new path.
- **it doesn't build:** fix the spec first.

## Files

| path | what | commit it? |
|---|---|---|
| `karyo/artifacts.json` | the link record: `{ "karyo": "artifacts/1", "artifacts": [ … ] }`, one entry per linked explainer: `spec` (project-relative), `url`, `hash` (sha256 of the published page), `content` (sha256 of its explainer data, to tell a content change from a runtime one), `title`, `publishedAt` | yes: then everyone's Claude republishes to the same pages |
| `.karyo/artifacts/<id>.html` | the last page built for an artifact | no (the folder has its own `.gitignore`) |
| `.karyo/artifacts/<id>.review.txt` | the same page with Karyo's runtime swapped for a marker (after checking it byte for byte): what Claude reads before publishing, about 15 KB instead of 0.7 MB | no |
| `.karyo/artifacts/.stop-memo.json` | which stale states the Stop hook already reported, per session | no |

## The hooks

The plugin's `hooks/hooks.json` runs `scripts/plugin/artifact-hook.sh` on **Stop** and **SessionStart**. In a project
without `karyo/artifacts.json` the script exits before starting bun (a few milliseconds). Otherwise it runs
`karyo artifact hook stop|session-start`, which never fails the session.

- **Stop:** when the turn touched an explainer (a tool input naming a `*.explainer.json`, or a linked explainer's
  files changed since the turn's prompt) and a linked explainer is stale because its content changed, its spec is
  gone or it doesn't build, Claude is stopped **once**. The reason names the exact commands and the URL to
  republish to. It never blocks when `stop_hook_active` is set (Claude is already continuing because of it), and
  never twice in a session for the same stale state, so a session that can't republish isn't nagged.
- **SessionStart:** when linked explainers are stale for any reason, one line of context names them.

## The page

The artifact build is the same self-contained page as `karyo build`, made for a sandboxed frame:

- Everything is inline (the runtime, styles, the explainer and its images), and nothing is fetched.
- The `<title>` is the explainer's title in two to four words.
- It opens in adenine, whatever the system's colour scheme; the Theme select offers Adenine and Fresh. The page fetches no font: the faces Adenine and Fresh draw in are inlined (about 0.26 MB).
- The theater asks for real fullscreen and falls back to filling the frame when the frame doesn't allow it.
- Storage is optional: where it is blocked, choices just aren't remembered.
- At most 16 MB.

`just artifact-smoke <spec>` (`scripts/smoke-artifact.ts`) checks a build inside a sandboxed iframe at phone and
desktop width, in light and dark.

**On phones.** The explainer is its desktop layout scaled down to the width, with a 16 px gutter and no sideways
scroll, so its text is small. In the theater on a phone, the enlarged controls (legend, zoom, the mode line) can
cover part of the plate. Explainers don't relayout for narrow screens yet.
