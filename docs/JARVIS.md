# Jarvis mode

Local voice control of Karyo plates. The page shows a plate at theater size with a bar along the bottom. You hold **Space** to talk (push-to-talk, as in Claude Code), or say the **wake word** ("adenine" by default; it can be changed and switched on or off in the page's ⚙ settings, which also hold the page-wide Theme choice, shared with every Karyo page). Your speech goes to a local Whisper, and the text goes to a long-lived `claude -p` session (Opus). That session drives the page through a small MCP server, **karyo-view**, and answers spoken questions as **captions**, reading the project with Read, Grep and Glob to ground its answers.

It covers navigation, spoken questions answered as captions, and splices (proposed changes drawn in a sandbox, compared and combined in a stack, "Actions" below). Everything runs on this machine, bound to 127.0.0.1. None of it ships to production: the site build doesn't include the server, and a documented project needs nothing from it.

```
page (jarvis.html) ──ws://127.0.0.1:5190/ws──▶ jarvis serve ──▶ Whisper (official, turbo, MPS/CPU)
      ▲   ▲                                      │  fast path ──▶ action
      │   └──── action / action_result ◀─────────┤
      │                                          └──▶ claude -p (stream-json, Opus, cwd = project)
      │                                                  │ Read / Grep / Glob over the project
      └── caption, activity, status ◀── stream events ───┤
                                                         └─▶ karyo-view MCP (stdio) ──HTTP──▶ POST /action, GET /view
```

## Running it

- From the Claude Code plugin, in any project: `karyo jarvis` (or `/karyo:jarvis`) starts the project's view server and the Jarvis server on free ports (5782–5799), with the project as the directory Claude reads, and prints the page URL (`jarvis.html?ws=…`, plus `&spec=` for an explainer). Its Python env and the Whisper weights live in the plugin's data dir (`KARYO_WHISPER_MODELS`); `karyo stop` ends both. docs/PACKAGING.md.
- `just jarvis` starts the server on 127.0.0.1:5190 with the repository as the project. It prints the page URL, `http://localhost:5180/jarvis.html`, which needs `just dev` running. The page opens `?scene=<id>` (default `layers-stack`, a Stack view) or an explainer with `?spec=<path>`; an unknown scene names the interactive plates it has. Flags pass through: `--port`, `--project <dir>` (the directory Claude reads), `--model` (default `opus`), `--effort`, `--device cpu|mps`, `--no-whisper` (typed commands only), `--no-brain` (fast path only), `--allow-origin <origin>`, and `-v`.
- Without just: `cd integrations/jarvis && uv run python -m jarvis serve [--port 5190] [--project <dir>]`.
- `just jarvis-test` runs the unit and protocol tests. `just jarvis-test --e2e` runs only the opt-in end-to-end test (it costs one Opus turn): a recorded utterance (the wake word, then a request) goes through the real server, official Whisper and a real `claude -p`, whose karyo-view drives a fake page reporting a small invented board. It checks that the wake word was heard and the transcript accepted, that Claude took at least one action, and that the turn ended on a final caption with no errors. It needs the Whisper weights and a clip at `integrations/jarvis/.models/clips/c1.wav`, and skips without them.
- `GET /health` reports `{ok, page, whisper: <device>|"?"|null, brain}`.
- `?` on the page (anywhere but the command box) shows the keys: Jarvis's own (hold Space to talk, the wake word, Enter and Esc in the command box) and the plate's, without its Space lines (docs/ENGINE.md "Key help").

## Whisper: the source rule

Speech recognition uses **only OpenAI's official Whisper**:

- the `openai-whisper` package from PyPI (pinned to `20250625` in `integrations/jarvis/pyproject.toml` and `uv.lock`);
- the model `turbo` (= large-v3-turbo), loaded with `whisper.load_model("turbo", download_root="integrations/jarvis/.models")`. The loader fetches the weights from OpenAI's CDN only when the file is missing, and checks the SHA-256 against the hash in the official URL every time it loads:
  - URL: `https://openaipublic.azureedge.net/main/whisper/models/aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a/large-v3-turbo.pt`
  - SHA-256: `aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a`

Weights never come from anywhere else: no Hugging Face mirrors, no converted or quantized ports, and no third-party wake-word models. The wake word is matched in the transcript, not by a separate model. `.models/` is git-ignored.

The model loads once, in a background thread at startup. It loads on CPU and then moves to MPS when MPS is available, because the official loader builds a sparse tensor that MPS can't hold. It falls back to CPU if MPS fails. `integrations/jarvis/bench.py` times transcription on your machine. Settings: `language="en"`, `fp16=False`, `condition_on_previous_text=False`, `temperature=0`, and `initial_prompt` = `"<Wake word>. Adenine. Karyo. Jarvis mode."` followed by the page's `vocab` (deduplicated, at most 600 characters). The prompt steers Whisper towards the wake word's spelling and the plate's names. Audio arrives as 16 kHz float32, so ffmpeg is not used.

**The silence gate.** With a prompt, Whisper turns silence or steady noise into a vocabulary word ("Orders store."). The no-speech probability doesn't catch this: it reads 0.0 on silence once a prompt is set. So an energy gate runs first. It needs at least 0.2 s of 30 ms frames that are loud (RMS > 0.03) or clearly above the clip's own noise floor (3× its 10th-percentile RMS, and > 0.01). A clip that fails the gate never reaches Whisper. A transcript that repeats several prompt phrases in a row is also dropped.

## Protocol

One WebSocket, `ws://127.0.0.1:5190/ws`, carrying JSON text frames. One page at a time: a second connection replaces the first, and the first is closed with code 4000.

**Page → server**

| message | meaning |
|---|---|
| `{"type":"hello","scene":"<id>","vocab":["Orders store",…],"settings":{"wakeWord":"adenine","wakeEnabled":false}}` | Sent on connect. `vocab` feeds Whisper's prompt. Answered with `status idle "connected"`. |
| `{"type":"audio","mode":"ptt"\|"wake","sampleRate":16000,"pcm":"<base64 float32 LE mono>"}` | One utterance. Other sample rates are resampled. At most 60 s is used. |
| `{"type":"text","text":"…"}` | A typed command. Never needs the wake word, but it is stripped if present. |
| `{"type":"settings","settings":{…}}` | Merged into the current settings. `wakeWord` changes the matcher at once. |
| `{"type":"view","snapshot":{…}}` | What's on screen (plate kind, nodes, groups, tags and steps with ids and labels, the selection). Sent on change, including a scroll that changes which details are visible. |
| `{"type":"action_result","id":"…","ok":true,"state":{…}}` / `{…,"ok":false,"error":"…"}` | The answer to an `action`. `state` is the selection; with a card open it includes the details **as measured on screen**: `section` (the section view's, or null), `sections` (`[{id,title,count}]`), `visible` ("7 of 7 fields", "2 of 7 fields fully visible, total partly; scroll for the rest"), `items` (`{shown, partly, hidden}` names) and `more` (`{above, below}`). On a structure or trace board it also carries `inspector`: `{pinned, shown, locked, side, node, label, section, visible, items, more}`, the pinned inspector measured the same way (`node` null and `visible` saying why while it shows its hint), and, on a board with groups to show, `level`: `{view: "groups" \| "cards", at, path, groups, stubs}` (the group entered and the path from "All groups", the level's group cards and its stubs as "Core (calls in)"; `drill` is then the group entered). |

**Server → page**

| message | meaning |
|---|---|
| `{"type":"status","state":"idle"\|"transcribing"\|"thinking"\|"acting","detail":"…"}` | `detail` is the action's name while acting, the lookup line while Claude reads, `"connected"` after hello, or `"no speech"` when the silence gate dropped a clip. |
| `{"type":"transcript","text":"…","wake":bool,"accepted":bool}` | What Whisper heard. `accepted:false` means wake mode heard speech without the wake word, or heard the wake word with nothing after it. Show it faintly and do nothing. |
| `{"type":"action","id":"…","name":"…","args":{…}}` | Do this and answer with `action_result` within 10 s. |
| `{"type":"activity","text":"focused Orders store"}` | One line per thing done. An action that succeeded is described with labels in place of ids, taken from the latest view. A refused one reads `couldn't <name>: <error>`. Claude's lookups read `read src/model/board.ts`, `searched for "…"` and `looked at the view`. |
| `{"type":"caption","text":"…","final":bool}` | Claude's reply, streamed. Partials carry the whole text so far, so the page replaces the caption rather than appending. `final:true` closes a text block. A turn can have more than one block; the last final one is the answer. |
| `{"type":"error","message":"…"}` | Bad audio or message, transcription failure, Claude unreachable or restarting, or a failed turn. |

A typical spoken question: `status transcribing` → `transcript` → `status thinking` → (`status acting` → `action` → `activity` → `status thinking`)* → `caption` partials → `caption final` → `status idle`.

**Loopback HTTP** (used by karyo-view; refused unless the client is on loopback and any `Origin` is a loopback page):

- `POST /action` with `{"name","args"}`, which must be `application/json`. The server forwards it to the page as an `action`, waits up to 10 s for the `action_result`, and returns `{"id","ok","state"}` or `{"id","ok":false,"error"}`. With no page connected it returns `ok:false`, "no Karyo page is connected". An unknown action name gets a 400.
- `GET /view` returns `{"connected","scene","snapshot"}`, the latest snapshot.

## Actions

The page implements these. For an action the current plate doesn't support, it returns `ok:false` with a message; Claude sees that message as a tool error and can say so.

| name | args | does |
|---|---|---|
| `focus` | `{target}`: a node or group id or label | centre and light it, dim the rest |
| `open` | `{node}` | open its card or panel |
| `close` | `{}` | close the open card or panel |
| `drill` | `{group}` | go inside a group: on a structure board in its groups view (docs/ENGINE.md "Group navigation"), slide into that group's scene; `out` (or `up`) goes up a level, `top` (or `all groups`, `overview`) to the overview; in the cards view, the in-place drill. On a sequence diagram, expand a folded lane ("expand the stages"); `out` folds it back |
| `back` | `{}` | back one level: close what is open, clear pins, then up a level (a sequence diagram: fold its expanded lanes back, "collapse the stages") |
| `groups` | `{on?: bool}` | a structure board's view: `true` the groups (one card per group, from the overview), `false` every card; omitted toggles. Fails on a board with no groups to show |
| `highlight` | `{tag?: string, nodes?: string[]}` | light a tag's nodes and/or a list of nodes |
| `clear` | `{}` | clear focus, highlights and pins |
| `show_details` | `{node, section?, item?}` | open the card's details. With `section` (an id, a title or a keyword: "fields", "inputs", "operations", "calls", "checks", "code" …, matched loosely over the sections' ids, titles and keywords), that section opens as a section view (docs/ENGINE.md "Card details: sections"); with `item`, it scrolls to that item (one operation, say). `node` may also be an item's exact name ("refund" → the card that lists it). An unknown section fails with the card's sections and the cards that have one |
| `scroll` | `{to: "down" \| "up" \| "top" \| "bottom" \| <item>}` | scroll the open card's details (a page, an end, or an item to the top); fails at an end with "nothing more to scroll to" |
| `step` | `{to: number \| "next" \| "prev"}` | move through steps, stops or slices |
| `select` | `{index: number \| null}` | select an entry of the plate's list (a trace plate's runs); `null` clears |
| `theater` | `{on: bool}` | enter or leave the theater |
| `fan` | `{on: bool}` | fan a stack out, or collapse it |
| `bench` | `{on: bool}` | Bench on or off |
| `pin_inspector` | `{on?: bool, lock?: bool, side?: "left" \| "right"}` | pin the inspector (the section view) to the side of the window, or unpin it (`on: false`); `lock` holds it on what it shows while other cards open on the plate (`false` follows again); `side` moves it. `lock` or `side` alone pin it too. Locking with nothing shown fails ("nothing to lock"). Structure and trace boards only (docs/ENGINE.md "Pinned inspector") |
| `zoom` | `{to?: "in" \| "out" \| "fit" \| <percent>, target?}` | zoom the view (docs/ENGINE.md "Zoom and pan"): a step in or out, back to fit, or to a percentage (100 = fit, up to 400); with `target` (a node, or a structure board's group), centre it and zoom so it fills about half the view. The view only: nothing opens or changes. `out` at fit does what `clear` does (back to the overview), so the old "zoom out" phrase keeps its meaning. The state's `zoom` reports the zoom in percent |
| `pan` | `{direction: "left" \| "right" \| "up" \| "down", amount?}` | move a zoomed-in view that way by `amount` of the view (default 0.4). At fit it fails ("nothing to pan; zoom in first") |
| `splice_open` | `{name?, new?, group?}` | open a splice (docs/ENGINE.md "Splice"): a sandbox over exactly this view where changes are only proposed; it remembers this view (the group you are in). With `name`, a saved splice of that name opens over the current code and slides into the view it lives in, else a new one gets the name; `new: true` always starts a new one ("splice this": no name, asked for on save). `group`: go into that group first ("splice the Orders group"; `top`: the overview). `spliceNote` says where. Fails while another splice has unsaved changes |
| `splice_group` | `{label, parent?, outlet_of?, inlet_of?, kind?, first?, show?}` | propose a new group (docs/MODEL.md "Splices", the `group` op): inside the group you are in, or under `parent` (`top`: the top level); `outlet_of` X: X calls into it, `inlet_of` X: it calls X; `first`: its first card. Then, unless `show: false`, the view slides into the new group and `spliceNote` says exactly what is there ("now inside Orders › Notifications (a proposed group): no cards yet; at the edges: Orders API calls in (left)") |
| `splice_add` | `{label, kind?, category?, summary?, group?, between?: [a, b], before?, after?, attach?: {to, dir?, kind?}}` | propose a node: between two connected nodes, before or after one, attached to one, or on its own. Refs are ids or labels, loosely (the adapter's fuzzy match; proposed nodes count). `group` (a proposed one counts) puts it in that group; inside a group, a card with no place (any card, inside a proposed group) joins the group you are in; the first card in a proposed group takes over its relationship |
| `splice_connect` / `splice_disconnect` | `{from, to, kind?, label?}` / `{from, to}` | propose a relationship, or propose removing one (it stays as a ghost) |
| `splice_remove` / `splice_rename` / `splice_move` | `{node}` or `{group}` / `{node or group, label}` / `{node, group}` | propose removing (a ghost), renaming or moving a node; `group`: remove a proposed group (with its cards) or rename a group. A name that is no node but a group acts on the group |
| `splice_replace` | `{node, with, existing?, kind?, summary?}` | propose swapping `node` for a new node named `with` (its kind defaults to the old one's), or for a node on the plate (`existing: true`): it takes over every relationship; the old one stays as a ghost. "replace the orders store with an event log". In karyo-view the parameter is `with_node` |
| `splice_undo` / `splice_redo` | `{}` | take the last change back / put it back |
| `splice_save` | `{name?}` | save it into the model's `karyo/splices/` (a name is needed once); `spliceNote` says where |
| `splice_leave` | `{force?}` | back to the real view; fails with unsaved changes unless `force` |
| `splice_discard` | `{}` | throw the splice away, and its saved file |
| `splice_list` | `{}` | the saved splices: `splices: [{id, title, ops, landed, noLongerApply, updated, file}]` |
| `splice_stack` | `{splices?: string[], combine?: bool \| string[]}` | stack splices over the board (docs/ENGINE.md "Stack of splices"): the real view first, then `splices` by name in that order (every saved one when omitted; the open splice as it is, marked unsaved when it has changes), and with `combine` one more, read-only slice applying them in order (`true`: all of them), which it then shows. The Stack view then answers `step`, `fan`, `focus`, `highlight`; `back` (or Esc) leaves it |
| `splice_stack_open` | `{slice}` | a slice (its number, a splice's name, `real`, `combined`) back on the board: that splice opens, ready to edit, with any unsaved changes it had. The combined slice is read-only: it fails, naming its splices (and the page asks which to open) |
| `splice_stack_return` / `splice_stack_leave` | `{}` | back to the stack from the board (rebuilt with what changed) / close the stack, the board as it is |
| `splice_stack_conflict` | `{n?: number \| string \| null}` | light one item of the combined slice (a conflict, consequence, order, same-name question or note) and open its card (goes to the combined slice first): `n` as the header numbers them (default 1), or words naming what it is about ("the queueing one"); `null` closes the card. Its `spliceNote` says it in words, with its kind: "item 1 of 1 (follows) is lit, its card open: Cache now fronts Event log. …" |
| `splice_stack_swap` | `{}` | combine the same splices in the other order (the combined slice's ⇄); `spliceNote`: "now Queueing, then Caching: the same result as the other order", or, when the order matters, what each order gives |
| `splice_stack_same` | `{n?, same?}` | two different proposals with one name (a same-name item, by number or words): treat them as one node, in this combination only (never in either splice file); `same: false` undoes it. "they're the same cache" |


Every splice action answers with the selection's `splice: {id, title, dirty, ops, last, warnings, file, landed, where, home, groups}` (`last` is the last change in words, from `describeOp`; `warnings` are changes that no longer apply) and, where it has something to say, `spliceNote` (what it did, or a warning the change raised). A change the splice can't apply fails with the core's reason and hint ("there is no relationship between Checkout and Orders store to insert into …"). Snapshots mark nodes (`mark: proposed | removed | renamed | moved`) and carry `splice` (null in the real view) and `spliceStack` (`{shown, cur, slices: [{index, title, kind, unsaved, changes, about, warning}], conflicts, explained: [{n, kind, what, splices, parts: [{splice, does}], result}], order: {now, other, matters, gives, otherGives} | null, lit: {n, pinned} | null, asking}`, null without a stack): `explained` is each item in the words its card shows, with its kind (conflict, consequence, order, same name, same thing, agreed, follows), `order` the combination's order and whether the other order gives something else, `lit` which item is lit now. While the stack is on screen the snapshot is the Stack view's (`plate: stack`, its slices as steps); changes to a splice wait until a slice is opened on the board (`splice_stack_open`). The actions that read or write files (open by name, save, discard, list) answer asynchronously; the page awaits them. In karyo-view, `splice_connect` and `splice_disconnect` take `from_node` and `to_node` (Python can't name a parameter `from`); the page's action takes `from` / `to`.

**Splices and groups, by voice.** "Splice this" opens the view on screen in a new splice (the fast path; it remembers the group you are in), and "open the caching splice" slides back into the view a saved one lives in. "Create a new group called Notifications and attach it to the orders API as an outlet" → `splice_group {label, outlet_of}`: the group goes inside the group you are in ("add a group … under Orders" → `parent`), and the view slides into it; the caption says where you are and what is proposed there, from `spliceNote`. "Put a Mailer card in it" → `splice_add {label, group}` (its first card takes over the group's relationship); "show me the new group" / "take me there" → `drill {group}` (`splice.groups` lists the proposed groups). Captions describe proposals as proposals and say only what the turn's own actions did.

karyo-view (`uv run python -m jarvis mcp [--url http://127.0.0.1:5190]`, stdio, MCP Python SDK v2) exposes `view()` and one tool per action, with typed arguments, a pydantic output (`{ok, state}`), and a `ToolError` carrying the page's message on failure. Its descriptions are shape-neutral: a node, a group, a tag, a step.

## Wake word and fast path

**Wake word.** The wake word is a setting (`wakeWord`, default `adenine`; `wakeEnabled` toggles wake mode on the page). The server matches it at the start of the transcript. It lowercases the text and strips punctuation. Then it joins the first one to three words and accepts the result if it is within edit distance ≤ 2 of the wake word (≤ 1 for wake words of three to five letters, exact under three). Words of five letters or more also match on their consonant skeleton at about the same length: "add an ain" → `adn` = `adenine` → `adn`. One leading filler ("hey", "ok") is allowed. Examples that match: "Adonine", "a denine", "Add an AIN", "Adenin", "Hey Adenine". Examples that don't: "Adding nine nodes", "Aden", "a dinner", and the word anywhere but the start.

The wake word is stripped before the rest goes on. In `wake` mode, an utterance without it gets `accepted:false`. In `ptt` mode it is never required, but it is stripped if said. Utterances under two characters are ignored.

**Fast path.** These commands, said alone, skip Claude and send one action:

| said | action |
|---|---|
| back, go back | `back` |
| up a level, go up a level, up one level, go up, level up | `drill {group:"out"}` |
| all groups, show the groups, back to the overview, go to the top, groups view | `groups {on:true}` |
| all cards, show all cards, show every card, cards view | `groups {on:false}` |
| next, next step | `step {to:"next"}` |
| previous, prev, previous step | `step {to:"prev"}` |
| clear | `clear` |
| zoom in, closer | `zoom {to:"in"}` |
| zoom out | `zoom {to:"out"}` (at fit: back to the overview, as `clear`) |
| reset zoom, zoom to fit, fit, show everything | `zoom {to:"fit"}` |
| pan left / right / up / down, move left …, look left … | `pan {direction}` |
| theater, full screen | `theater {on:true}` |
| exit theater, leave theater, exit full screen | `theater {on:false}` |
| fan out | `fan {on:true}` |
| collapse | `fan {on:false}` |
| scroll, scroll down, page down | `scroll {to:"down"}` |
| scroll up, page up | `scroll {to:"up"}` |
| scroll to the top, back to the top | `scroll {to:"top"}` |
| scroll to the bottom, scroll to the end | `scroll {to:"bottom"}` |
| pin the inspector, pin inspector, dock the inspector, pin the panel, pin the details | `pin_inspector {on:true}` |
| unpin, unpin the inspector, undock the inspector, unpin the panel | `pin_inspector {on:false}` |
| pin the inspector (to the) left / right, move the inspector to the left / right | `pin_inspector {on:true, side}` |
| lock the inspector, lock it / unlock the inspector, unlock it | `pin_inspector {lock:true}` / `{lock:false}` |
| undo, undo that, undo it, undo the last change, take that back | `splice_undo` |
| redo, redo that, redo it | `splice_redo` |
| leave the splice, exit the splice, close the splice, back to the real view | `splice_leave` |
| save the splice, save this splice | `splice_save` |
| splice this, splice this view, splice here, open this view in a new splice | `splice_open {new:true}` (a name is asked for on save) |
| stack my splices, stack the splices, compare my splices, show the splice stack | `splice_stack` |
| back to the stack, return to the stack | `splice_stack_return` |
| leave the stack, close the stack, exit the stack | `splice_stack_leave` |
| swap the order, switch the order, reverse the order, try the other order | `splice_stack_swap` (the activity line is its `spliceNote`: the new order and whether the result changed) |

A leading or trailing "please" is allowed. Anything longer ("go back to the pipeline") goes to Claude. Claude never sees a fast-path command run, so the next message it gets starts with a `[quick commands since your last turn, already done (not by you): "splice this" → …]` line (the last six, each with what it did), and its captions don't claim them.

## The brain and its sandbox

The server starts one `claude -p` at startup, with cwd set to `--project`:

```
claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose
  --model opus --mcp-config '<karyo_view: this Python, -m jarvis mcp --url http://127.0.0.1:<port>>' --strict-mcp-config
  --tools Read,Grep,Glob --allowedTools "mcp__karyo_view__*,Read,Grep,Glob" --permission-mode dontAsk
  --setting-sources "" --no-session-persistence --append-system-prompt <jarvis/prompt.py>
```

- **What it can do.** The only built-in tools that exist are Read, Grep and Glob (`--tools`). The only MCP server is karyo-view (`--strict-mcp-config`). `dontAsk` refuses anything not pre-allowed instead of prompting. `--setting-sources ""` keeps user and project hooks and plugins out of the loop. So it can't edit files, run commands or fetch the web, and the prompt tells it so.
- **Messages.** Each accepted utterance becomes one user message, prefixed with a `[page · scene <id> · …]` line. That line carries the view snapshot when it changed since the last message (up to 4000 characters of JSON; beyond that, "call view"), and otherwise says it is unchanged. Navigation then usually takes a single model step.
- **The prompt** (`jarvis/prompt.py`). For navigation, act with one or a few tool calls and reply in at most one short sentence. For questions, look things up (the view, the model file, `karyo:` directives in code) and answer in at most three short, plain sentences, pointing the view at the answer. Call `view` when unsure. When the user asks for a part of a card ("the fields", "the inputs", "its operations", "what it calls", "the code", "the checks"), target that section (`show_details {node, section}`). **Say only what is on screen**: describe what the action result's `visible` / `items` report, never "all of it" unless it says so; when only part is visible, say so and offer to scroll. The prompt also says the section view is the inspector, which `pin_inspector` pins beside the window (it then follows the card that opens unless locked), and that the state's `inspector` reports what it shows (only a hint when nothing is open). It maps "zoom in / out", "reset zoom" and "zoom to X" to `zoom` (`{target}` for a node) and "pan left …" to `pan`, which change only how close the viewer is.
- **Splices.** The prompt says: "open this view in a new splice (called X)" is `splice_open {name, new: true}`, "open the X splice" is `splice_open {name}`; inside a splice, propose changes only with the splice tools, describe them as proposals, never claim they exist in the code, and pass on a failed action's hint. For a stack: "stack my splices" is `splice_stack {}`, "compare caching and queueing" names them, "combine them" adds `combine: true`, "open the queueing one" is `splice_stack_open {slice}`, "back to the stack" and "leave the stack" return and close; say which slices show, which is unsaved, and the combined slice's conflicts in the words given, and offer to open a part of the read-only combination. The stack's terms are proposed and removed, and one word per kind of finding (conflict, consequence, order, same name, same thing, agreed, follows), used as the plate uses them; agreed and follows are notes, never called conflicts. "What's the conflict?" / "explain the conflicts" is answered from `spliceStack.explained`: its kind, what it is about, what each splice does, what the combination shows, after `splice_stack_conflict {n}` lights the one explained; the caption says which one is lit, and when only notes are found, says there is no conflict. When `spliceStack.order.matters`, the caption says what the other order gives. "Swap the order" is `splice_stack_swap`; "they're the same cache" is `splice_stack_same`. "Replace the orders store with an event log" is `splice_replace`. Phrasings that name splices ("compare caching and queueing", "combine them", "open the queueing one") are left to Claude; only the stack phrasings in the fast-path table and "swap the order" are fast paths.
- **Restarts.** If the process dies, a turn in flight ends with an `error`, and the process restarts with backoff (1 s, doubling to 30 s). The next message goes to the new session, which has lost the conversation so far.

## Turn log

The server logs every turn at INFO on the `jarvis.turn` logger (stderr, with `-v` for more):

```
jarvis.turn typed "show me the fields of the orders store"            (or: transcript "…" accepted=True wake=False mode=ptt (whisper 0.81 s))
jarvis.turn turn 1 start "show me the fields of the orders store"
jarvis.turn turn 1 action show_details {"node": "orders.store", "section": "fields"} → ok section=fields visible="2 of 7 fields fully visible, total partly; scroll for the rest" (0.02 s, at 1.9 s)
jarvis.turn turn 1 lookup read karyo.model.json
jarvis.turn turn 1 caption "The orders store's fields are open. …" (at 3.8 s)
jarvis.turn turn 1 end ok: 3.8 s total, first action at 1.9 s, first caption at 3.8 s, 1 action(s) (0 failed), 1 lookup(s)
jarvis.turn fast path "scroll down" → scroll {"to": "down"}
```

A refused action logs `→ error "<the page's message>"`. A turn lost to a crashed `claude` logs `turn N lost: …`.

## Security

The server binds 127.0.0.1 only. The WebSocket and the HTTP endpoints refuse any `Origin` that isn't a loopback page (`http://localhost:*`, `127.0.0.1`, `[::1]`, plus any `--allow-origin`), because a web page elsewhere must not reach a session that can read the project. `POST /action` also requires `application/json`, which a cross-site form can't send without a preflight. Clients that send no `Origin` (karyo-view, curl, tests) are allowed, since they are already on this machine.

## Limits

- English only; one utterance at a time through Whisper; one page at a time.
- Utterances that arrive while Claude is still answering are queued in the same session. There is no barge-in or cancel.
- Captions only, no speech output.
- The page draws a built-in scene (`?scene=`) or an explainer (`?spec=`), not a project's model board.
- The fast path matches exact phrases; everything else costs a model turn, which takes a few seconds.
- The wake-word matcher is lexical, so an unusual wake word may need its own spellings in `vocab`.

Files: `integrations/jarvis/jarvis/` (`server.py` protocol and HTTP, `stt.py` Whisper, `audio.py`, `wake.py`, `fastpath.py`, `brain.py`, `prompt.py`, `view_mcp.py`, `__main__.py`), `integrations/jarvis/tests/`, `justfile` (`jarvis`, `jarvis-test`).
