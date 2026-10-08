---
name: artifact
description: Put a Karyo explainer in a Claude artifact (a private claude.ai page the user can share) and keep that artifact current. Use when the user asks to add, put, publish or share an explainer as or in a Claude artifact, to update or republish an explainer's artifact, or which explainers are linked to artifacts; also when a Karyo hook says a linked explainer is stale.
argument-hint: "[explainer spec]"
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" artifact *)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" validate *)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" stills *)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" lint *)
---

# Explainers in Claude artifacts

`karyo` below is the plugin's CLI, run by its full path: `"${CLAUDE_PLUGIN_ROOT}/cli/karyo"` (it isn't on PATH;
if that path comes out empty, `"${CLAUDE_SKILL_DIR}/../../cli/karyo"` is the same file).

**Who does what.** Only you, in a session, can publish: with your **Artifact tool**. Karyo never publishes. It builds the page (`karyo artifact build`), keeps the link record (`karyo/artifacts.json` in the project, meant to be committed), and its hooks tell you when a linked explainer has changed since it was published. Every command takes `--json`. The details are in `${CLAUDE_PLUGIN_ROOT}/docs/ARTIFACTS.md`.

Start with `karyo artifact status`: it lists each explainer as `up-to-date`, `stale` (with the reason) or `unlinked`, with the url of each linked one.

## First publish (the explainer is unlinked)

1. **Check it.** `karyo validate <spec>` must have no errors. `karyo stills <spec> --step all`, then **Read every PNG** and fix what looks wrong (the karyo-explain skill's rules). `karyo lint <spec>` must say `no issues`. Never publish an explainer whose stills you haven't looked at.
2. **Build.** `karyo artifact build <spec> --json` writes `.karyo/artifacts/<id>.html` in the project and prints its `html` path, `bytes`, `hash` (sha256) and `title`. The page needs no network: everything is inline, and it opens in the adenine theme (the viewer can switch to fresh).
3. **Read before you publish.** Never publish a page you haven't read. The page is mostly Karyo's runtime (about 0.7 MB of minified engine), so the build also writes a **review copy**, `review` in its output (`.karyo/artifacts/<id>.review.txt`, about 15 KB): the same page with the runtime swapped for a one-line marker, after checking byte for byte that it is this install's own runtime. **Read the whole review copy** (the spec's text, the theme and mount scripts) instead of the page. When `runtimeVerified` is `false`, the runtime wasn't recognised: read the whole page or don't publish. Never skip the read, even when asked to.
4. **Publish** with the Artifact tool: `file_path` = the `html` path, a one-sentence `description` (the spec's summary), and a short generic `icon` (`diagram`, `chart`, `map`, `book`). Its `<title>` is already the explainer's title in two to four words. Leave out `url`: this makes a new artifact.
5. **Link.** `karyo artifact link <spec> <url>` with the artifact url the publish returned. It records the hash of the page you just built, so build and publish the same file.
6. **Hand over** the url, in one line, and say the link is kept in `karyo/artifacts.json` (worth committing, so the team republishes to the same page).

## Already linked: republish to the same url

When `status` says `stale`, or the user asks for the artifact to be updated:

1. Check, build and read the review copy as above (steps 1 to 3).
2. Publish with the Artifact tool, passing **`url` = the recorded url** and `file_path` = the new build. Never publish a linked explainer without its `url`: that makes a second artifact and the old link goes stale for good.
3. Re-link with the new hash: `karyo artifact link <spec> <url>`.
4. Say it is updated, with the url.

If the publish is refused because the page changed on claude.ai since (someone else republished it), don't force it: say so, and ask the user whether to overwrite that version.

`stale` with "newer Karyo runtime" means only Karyo changed, not the explainer: republishing is optional, so ask. A spec that is gone: `karyo artifact unlink <spec>` (the artifact stays where it is; say so).

## When you can't publish

- **No Artifact tool in this session** (an API session, a host without artifacts): build it anyway and hand over the `.karyo/artifacts/<id>.html` path. The user can open it in a browser or publish it from a Claude session. Don't run `link` for a page nobody published.
- **In Cowork**, keep the project in the user's folder: pass `--project "<their folder>"` to every `karyo artifact`
  command, so the link record (`karyo/artifacts.json`) is kept there and outlasts the session. Without an Artifact
  tool, build the plain page into their folder (`karyo build <spec> -o "<their folder>/<Title>.html"`), present it
  with your file-presenting tool when you have one, and say in plain words that it's a file they can open or send.
- **No edit access**: only the artifact's owner, or someone it was shared with for editing, can republish. If the Artifact tool refuses because of permissions, don't retry and don't make a copy unasked: say the artifact is stale and that its owner must republish it (`/karyo:artifact` in their session).

## The hooks

- **Stop**: when a turn touched an `*.explainer.json` and a linked explainer is now stale, Karyo stops you once with the exact commands and the url to republish to. Do it, or explain why you can't (above). It never asks twice for the same change.
- **Session start**: when linked explainers are stale (edited by hand, or by a session without the plugin), one line of context says which. Mention it when it bears on what the user asks; don't republish unasked.

## Limits (say them when they matter)

- Karyo can't see claude.ai: an artifact edited or deleted there isn't noticed. Edits made to a spec outside Claude are caught at the next session start, not as they happen.
- On a phone, the explainer is its desktop layout scaled down to fit the width, so its text is small. In the theater on a phone, the enlarged controls (legend, zoom, the mode line) can cover part of the plate. It reads best on a wider screen.
- An artifact holds at most 16 MB: `karyo artifact build` fails over that (large images are the usual cause).
