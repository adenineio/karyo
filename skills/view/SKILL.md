---
name: view
description: Open the project's Karyo view, a local web page that draws the project's Karyo model (a structure board with Bench and Splice, recorded flows as trace boards, tours) and lists its explainers. Use when the user asks to open, show, serve or see the Karyo view, board, map or docs of the project, or where to look at what Karyo drew. Also use it to turn a project's `# karyo:` directives into the model the view draws.
argument-hint: "[project dir]"
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" view)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" view *)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" status)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" stop)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" stop *)
---

# The Karyo view

`karyo` below is the plugin's CLI, run by its full path: `"${CLAUDE_PLUGIN_ROOT}/cli/karyo"` (it isn't on PATH).

1. Run `karyo view $ARGUMENTS` (no argument: the git repo you're in, else the working directory). It starts the
   view server for that project on a free port in 5782–5799, or reuses the one already running, and prints the
   URL plus what it found: model files (`*.model.json`) and explainers (`*.explainer.json`).
2. Give the user the URL (`http://localhost:<port>/project.html`) in one line, and say what it shows. Add `--open`
   only if they asked you to open the browser.
3. If it found nothing to draw:
   - The project has `# karyo:node` directives in Python (`grep -rn "# karyo:" --include=*.py .`): run
     `karyo model scan` (every package holding a directive, or name them: `karyo model scan <package-dir>`). It
     writes fragments to `.karyo/` and the model to `karyo.model.json`, and prints the reconcile warnings; relay
     those briefly. Then tell the user to reload the page.
   - Fragments already in `.karyo/` (from recorded runs): `karyo model build`.
   - Neither: explain that Karyo draws from a model (directives, docs: `${CLAUDE_PLUGIN_ROOT}/docs/MODEL.md`) or
     from explainers (the karyo-explain skill), and offer to start one. Don't add directives unasked.
4. The first run of a fresh install sets up Karyo's JS dependencies in the plugin's data dir (never in the
   project). If it says bun is missing, pass on the install command it prints.

The server keeps running after this turn. `karyo status` lists the running servers; `karyo stop` stops this
project's (`--all`: every one). Splices and the team layout saved from the page go into the project's own `karyo/`
folder and `karyo.layout.json`: dev-time files, never imported by the project's code.
