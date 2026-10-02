---
name: demo
description: Open the demo that ships with Karyo, "Claude Code, explained": a series of 21 short Karyo explainers plus a map of the order to read them in, built to HTML pages and opened in the browser. Use when the user asks to see, show, launch or open the Karyo demo, an example of what Karyo makes, the Claude Code explainer(s) or the "Claude Code explained" series, or which demos Karyo has.
argument-hint: "[demo name]"
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" demo)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" demo *)
---

# The Karyo demo

`karyo` below is the plugin's CLI, run by its full path: `"${CLAUDE_PLUGIN_ROOT}/cli/karyo"` (it isn't on PATH).

1. Run `karyo demo claude-code` (or `karyo demo $ARGUMENTS` when the user named another demo; `karyo demo` alone
   lists the demos that ship). It builds every page of the series to a self-contained HTML file in the plugin's data
   dir (never in the project), prints progress and the path of `index.html`, and opens that page, the series' map,
   in the default browser. Later runs reuse the build until Karyo's version or the demo changes (`--force` rebuilds).
2. Tell the user in a line or two what opened: the map of "Claude Code, explained", 21 short explainers in five
   tracks (start here; the text world; how Claude Code works; setting up your world; reaching beyond your machine),
   each card linking to its explainer. In an explainer, ←/→ step through it and `f` is theater. Give the printed
   `index.html` path too, so they can reopen it later. Every company, person and file in the series is a made-up
   example.
3. If the user doesn't want a browser window (say, on a remote machine), add `--no-open` and give them the path.
4. The first run of a fresh install may set up Karyo's JS dependencies in the plugin's data dir first. If it says bun
   is missing, pass on the install command it prints. A build error names the file and the problem: relay it as is.

To make an explainer of their own afterwards, the karyo-explain skill takes over.
