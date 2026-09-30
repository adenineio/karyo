---
name: jarvis
description: Start Jarvis mode, Karyo's local voice control of plates (OpenAI Whisper on this machine plus a claude -p brain), for the current project, and print the page to open.
argument-hint: "[project dir] [--spec <explainer>]"
disable-model-invocation: true
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" jarvis)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" jarvis *)
  - Bash("${CLAUDE_PLUGIN_ROOT}/cli/karyo" stop)
---

# Jarvis mode

`karyo` below is the plugin's CLI, run by its full path: `"${CLAUDE_PLUGIN_ROOT}/cli/karyo"` (it isn't on PATH).

Run `karyo jarvis $ARGUMENTS`.
It starts, or reuses, the project's view server and the Jarvis server on free local ports, and prints the page URL.

- The first run installs Jarvis's Python env (openai-whisper and torch, a few minutes) into the plugin's data dir,
  and the Whisper model (large-v3-turbo, about 1.5 GB) is fetched the first time the page connects, only from
  OpenAI's official URL, SHA-256 checked. Tell the user this before the first run, and that it needs `uv`
  (the command prints how to install it if it's missing).
- Give the user the URL and the one instruction that matters: hold Space to talk. Everything runs on 127.0.0.1.
- Each spoken question that isn't a direct command costs one `claude -p` turn in this project, read-only.
- `karyo stop` stops the servers.

Full reference: `${CLAUDE_PLUGIN_ROOT}/docs/JARVIS.md`.
