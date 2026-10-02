# Kits: node kinds and plate types any project can add

A **kit** adds to Karyo without touching Karyo. It is a folder of data and templates (and, for one kind of plate, the kit's own JavaScript, which runs only once the user trusts it: "Code in kits") that contributes

- **node kinds**: how a model node of that `kind` is drawn (its card template, style and size), its details sections, the schema of its own data (`fields`) and its legend entry; and/or
- **plate types**: new plates made from the engine's views (a structure board narrowed to some nodes, a trace board, a tour, a sequence diagram), drawn from a project's model.

The name is "kit", not "plugin": Karyo itself ships as a Claude Code plugin (docs/PACKAGING.md), and a kit is much smaller than that. (The engine's CSS helper classes, `.pl-card`, `.pl-label` …, are "engine classes" in docs/ENGINE.md for the same reason.)

A kit kind is a component (docs/EXPLAINERS.md, "Components"): the same `component.json`, `template.html` and `style.css`, the same template language and CSS scoping. An explainer can use a kit kind as an element type, and a model node is drawn with it. Components and kit kinds are one concept, found along the same kind of path.

Karyo is shape-neutral, and kits are where a domain goes. The engine knows nothing about topics, queues or tables; a project's kit does.

## On disk

```
<project>/karyo/kits/<kit>/            a kit (the shared library and the built-ins have the same layout)
  kit.json                             name, description, version, its kinds, its plate types
  kinds/<kind>/                        one folder per node kind: a component
    component.json                     the component format plus a `node` block and a required size
    template.html                      the card's inside
    style.css                          scoped to the card, its sections and its mini
    <section>.html                     a details section's template (named in component.json)
```

Schema: [`spec/karyo-kit.schema.json`](../spec/karyo-kit.schema.json) (kit.json; its `$defs/kind` is a kind's component.json). Start one with `karyo kit new <name>`.

### kit.json

```jsonc
{
  "$schema": "…/spec/karyo-kit.schema.json",
  "karyo": "kit/1",
  "name": "topics",                      // the folder's name
  "description": "A node kind for message topics, and a board of the topics alone.",
  "version": "0.1.0",
  "kinds": ["topic"],                    // folders under kinds/ (omitted: all of them)
  "plates": [
    { "id": "topics", "title": "Topics", "description": "…",
      "view": "board", "from": "model",
      "filter": { "kinds": ["topic"], "neighbours": true } }
  ]
}
```

### A node kind: `kinds/<kind>/component.json`

```jsonc
{
  "name": "topic",
  "description": "A named channel that services publish to and subscribe from.",
  "version": "0.1.0",
  "props": { "type": "object", "properties": { "retention": { "type": "string" } } },   // the schema of the node's `fields`
  "size": { "w": 208, "h": 112 },        // required: boards lay out and route by it (w 120–400, h 48–240)
  "example": { "retention": "7d" },      // example fields: `karyo kit check` renders the card and sections with them
  "node": {
    "label": "topic",                    // the kind's name on its cards (default: the kind)
    "plural": "topics",                  // its legend entry (default: label + "s")
    "glyph": "▦",                        // ≤ 2 characters, for small places (the tour's map, sequence lanes, the legend)
    "category": "messaging",             // the category its nodes take when they declare none
    "sections": [{ "id": "recorded", "title": "recorded", "noun": "messages", "keywords": ["published"], "template": "recorded.html" }],
    "mini": "mini.html",                 // optional: a template for small places
    "exampleNode": { "label": "Order events", "summary": "…", "ref": { "file": "orders/events.py", "line": 32 } }
  }
}
```

### The card template

`template.html` renders the card's **inside**; the board draws the frame, so a kit card keeps everything a card has: the category's coloured edge and the adenine ring and kind tint (`--pl-cat-ring`, `--pl-cat-kind`), check badges, a splice's `proposed` / `removed` / `renamed` / `moved` marks, hover, pins, Bench drag and group drag. Keep the four hooks the board uses:

| class | what the board does with it |
|---|---|
| `.mm-top` | puts the check badges (and a splice's mark) in it |
| `.mm-kind` | tints it with the category (`--pl-cat-kind`) |
| `.mm-name` | a splice renames the node there (double-click) |
| `.mm-ref` | a splice says there what it does ("not in the code yet") |

What a template sees:

| name | what |
|---|---|
| your fields | the node's `fields` (MNode.fields), with the props schema's `default`s filled in |
| `node.*` | `id`, `kind`, `kindLabel`, `label`, `summary`, `category`, `tags`, `lang`, `group`, `where` (the short file:line the default card shows, or "declared elsewhere"), `file`, `symbol`, `proposed`, `sources` |
| `stats.*` | from the model around it: `in`, `out` (relationships), `calls` (recorded calls into it), `ops` (`[{label, count}]`, the operations recorded on it, busiest first), `opsCount`, `callers`, `callees` (labels) |

A topic card (`karyo/kits/topics/kinds/topic/template.html`):

```html
<div class="mm-top"><span class="mm-kind">{{node.kindLabel}}</span><span class="mm-lang">{{node.lang}}</span></div>
<div class="mm-name">{{node.label}}</div>
<div class="use">{{#if stats.opsCount}}<b>{{stats.opsCount}}</b> used · {{stats.calls}}× called{{else}}not seen running{{/if}}</div>
{{#if stats.opsCount}}<div class="ops" data-pl-clip>{{#each stats.ops}}<span class="op">{{label}}</span>{{/each}}</div>{{/if}}
<div class="mm-ref">{{node.where}}</div>
```

A card has the kind's fixed size; what doesn't fit must be clipped on purpose (`text-overflow: ellipsis`, or `data-pl-clip` on a region), or lint reports it. A broken template never blanks the board: the card says "template error" and why.

### Sections and style

A section template sees the same names and renders inside the card's details (the small panel, the section view, the pinned inspector), after the board's own (`summary`, `calls`, `checks`) and before a scene's `details`. Mark each thing it lists with `data-item="<name>"`: the board counts them, reports which are on screen and scrolls to them.

`style.css` is scoped three times: to the card (`.kc-<kind>`; `:host` is the card itself), to its sections (`.ks-<kind>`) and to its mini (`.km-<kind>`); `:host` rules apply to the card only. **Theme tokens only** (`var(--pl-*)` and `color-mix()` of them): a hard-coded colour is an error in `karyo kit check`, a transition or animation a warning (the engine owns time). Don't set `transform` or `position` on `:host`: the board places the card.

### Fields: a kind's own data

A node carries its kind's data in `fields` (`spec/karyo-model.schema.json`); the merge keeps it like any other key. Any fragment writer can set it: a hand-written fragment, another language's SDK, a generator. The Python and Go directives have no `fields` key (see Gaps). Kinds that draw from the model itself (`stats.*`, like the topic card above) need no fields at all.

### Node kinds in the model

A node's `kind` is one of the model's (`service`, `function`, `store`, `queue`, `external`, `actor`, `module`) or **any other lowercase word**, which a kit may draw. The Python directives (`# karyo:node … kind=topic`), the Python decorator and the Go scan accept one, unless it reads as a typo of a built-in kind (`kind=servce` is still a `directive-invalid` warning with "did you mean 'service'"). A kind no kit adds is drawn with the default card. A kit may also restyle a built-in kind (a project kit named `store` redraws every store). Splices may propose a node of a kit kind (the palette lists the kits' kinds).

## Plate types

A plate type is declarative: it picks one of the engine's **views**, what one plate is drawn **from**, which nodes it keeps, and the view's options. Nothing in a kit runs, with one exception: a `script` plate, drawn by the kit's own JavaScript once the user trusts it ("Code in kits" below).

| view | from | what it draws | options |
|---|---|---|---|
| `board` | `model` | the structure board (Bench, Splice, theater, pinned inspector, group navigation) | `bench` (open in Bench), `start` (`groups` or `cards`: docs/ENGINE.md "Group navigation") |
| `trace` | `flow` | a recorded flow on its map (trace board) | |
| `tour` | `tour` | a tour's timeline | |
| `sequence` | `flow` | a recorded flow as a sequence diagram (below) | `durations`, `group`, `fold` (`auto`, `none` or groups of node ids) |
| `script` | `model`, `flow` or `tour` | whatever the kit's script draws, in a sandboxed frame, after the user trusted it ("Code in kits") | anything (the script gets them) |

`filter` (board and sequence) keeps a node when it matches every list given: `kinds`, `categories`, `tags`, `groups`; `neighbours: true` adds the nodes one relationship away (never two). The built-in kit `kits/sequence` adds the `sequence` plate type; the built-in kit `kits/radial` adds `radial` (a `script` plate: the groups as a ring and their nodes around it); a project kit such as `topics` above adds `topics` (the board with only the topics and their neighbours).

**Where plate types show.** The project view (`karyo view`) lists every plate type the project's kits offer, one per model, per recorded flow or per tour, next to the model's own plates (`#plate=<model>::<type>::<flow or tour>`). In the gallery, a scene file composes one: `export default kitPlate(kitsFor(model), 'sequence', model, { flow: 'checkout' })`. A kit plate is an ordinary plate: theater, the ⚙ theme picker, stills and lint (`render.ts --scene <id> --state …`) work as for any other.

### The sequence view (`src/model/sequence.ts`)

One recorded flow as lanes and messages. A lane per node the flow touched (its entry first, then in the order each is first called; lane heads carry the node's kind, a kit kind's glyph, the category edge and, when the flow crosses languages, the language), a message per recorded call in start order (labelled with what the span says it did, and how long it took; a failed call in the warning colour), an activation bar for as long as each call ran (nested calls on one lane step right), and a band per top-level call. At rest it shows the whole flow from the top. Hover a call: it lights with its two lanes and the mode line says it. Click pins it (a card: from → to, the operation, duration, status, when, nested calls, the error, the callee's summary); ←/→ (`j`/`k`) step the pin through the calls, scrolling it into view; Esc unpins, then clears the legend's pins. Hover a lane head or a legend entry (categories, kit kinds, tags, `✕ failed calls`): its calls light. The body scrolls under the fixed lane heads (wheel, PgUp/PgDn, Home/End); the theater lays the lanes out for the window and shows as many calls as fit. States: `rest`, `message-pin`, `message-hover`, `message-pin-last`, `lane-hover`, `scrolled-end` (long flows), `legend-hover-…`, `legend-pin-…`. API (`SequenceApi`): `go(i | null)`, `next()`, `prev()`, `focusTag(id)`, `highlight(ids)`, `describe()` (plate kind `sequence`; Jarvis's generic step, focus and highlight actions work on it), `folds()`, `expand(unit | null)`, `collapse(unit?)`.

#### Folding

A long flow touches many nodes; a lane for each makes a plate too wide to read. So lanes that belong together **fold** into one lane the viewer can expand, and no participant is hidden. The rule (`src/model/sequence-fold.ts`, derived from the model and the flow, never from names):

1. **What the model already groups.** Lanes that the model's fold draws as one node (`parent` + `fold`, from a producer or a curation file's `fold`), named after the parent ("Checkout's 4 parts", "part of Checkout" above it); then the lanes of a nested curation group (a group with a `parent`), named after the group. Two lanes or more.
2. **Otherwise, sibling leaves.** Three lanes or more that are called only from the same one lane in this flow, make no calls of their own in this flow, and share a category (or, when they have none, a kind). Named for what they share: the category's plural, "5 stages", with "called by Order router" above the head; else "Order router's 5 steps".

Never folded: the flow's entry, and any lane a failed call touched (its caller or callee), so an error stays in view. `fold: 'auto'` (the default) folds only when it helps: when the flow has more lanes than fit comfortably across the plate's default width (about 1440 px at the default lane pitch, so 8) or more than 10. `fold: 'none'` keeps every lane. Explicit groups (`"fold": [["orders.cart", "orders.tax"]]`) fold as given, whatever the lane count, still never the entry or a failed lane.

The folded lane stands at its first member's place, drawn as a stack of cards: its name and ⤢, then the first members' names and a count ("Normalize +4"). Every call to a member lands on it, labelled with the member ("Normalize: normalize()"); activation bars nest as on any lane, and a call between two members loops back to the lane. Hover its head: the members are listed with their calls, and the mode line names them. Click the head (Enter or Space when it has focus, ⤢, or its legend entry): it expands into its members' lanes, which glide apart while the plate refits wider (`stage.refit`, `stage.transition`); a bracket over them reads "⤡ fold · 5 stages · called by Order router" and folds them back, as do the legend entry and Esc (after unpinning). The legend has one entry per folded lane ("⧉ 5 stages folded · click to expand"), and the mode line at rest leads with the same words. Which lanes are expanded is view state (`expanded: ["fold:<first member>"]`), so stills show both: states `folded`, `expanded`, `fold-hover` (the members listed), `fold-message-pin` and `expanded-message-pin`, e.g. `render.ts stills --scene <id> --state expanded --t 1`. Jarvis: `drill {group: "stages"}` ("expand the stages") expands a folded lane (`describe().groups` lists them), `back` or `drill {group: "out"}` folds them back.

## Resolution

Kits are found like components, nearest first. The first kit, kind or plate type of a name wins; a later one of the same name is hidden, with a warning that names both (the page's console, `karyo kit list`, `bundleKits().warnings`):

1. **the project**: `karyo/kits/` in the model's (or spec's) folder, or the nearest folder above it that has one, stopping at the repository root (source `project`)
2. **`$KARYO_KITS`**: folders separated by `:` (source `env`)
3. **the shared library**: `$KARYO_HOME/kits`, by default `~/.adenine/karyo/kits` (source `adenine`)
4. **the built-ins**: the plugin's `kits/` (source `builtin`)

A kit of the same name hides the farther one whole; a kind or plate type of the same name hides the farther one only. For explainers, kit kinds join the component path at their kit's place (a project kit's kind before a shared component of the same name).

**In the browser**, kits come from the dev server: `import kits from 'virtual:karyo-kits'` is the page's set (`$KARYO_KITS`, the shared library, the built-ins, and in project mode the project's), which every entry point sets first (`src/kits/boot.ts`); `virtual:karyo-kits/<repo-relative folder>` puts that folder's project kits first. A scene that draws a project of its own binds them to its model (`useKits(model, kits)`); every view then takes `kitsFor(model)` (or an explicit `kits` option). Every kit file is watched: an edit reloads the page; a new kit folder needs a server restart. `vite build` bakes the kits it finds into the static site.

## Code in kits: the JavaScript escape hatch

**Kits are data and templates, except for one thing: a `script` plate type runs the kit's own JavaScript.** Everything else (kinds, sections, the other views) stays declarative: a kind is a template in the same small, logic-less language as components, with SVG sanitized and markdown-lite escaped. Prefer that. When a plate needs something the views can't do and belongs in Karyo for everyone, it belongs in the engine as a new view (as `sequence` is), shape-neutral and reviewed. A script plate is for what is particular to one project or one person.

Kits resolve from the project folder, and `karyo view` opens projects you just cloned, so a project kit's script is code from whoever wrote that repository, running in your browser beside a local server that can write files. Karyo therefore **never runs a kit's code without the user's consent for that exact version, warns every time it loads, and runs it sealed off from the page and the server.**

### A script plate

```jsonc
// kit.json
"plates": [
  { "id": "radial", "title": "Radial", "description": "…",
    "view": "script", "from": "model",        // or "flow" / "tour": one plate per flow or tour, as for the other views
    "script": "plates/radial.js",             // an ES module inside the kit's folder (.js or .mjs, plain names, ≤ 1 MB, UTF-8;
                                              //   a plain file, symlinks only within the kit; kit.json too)
    "deterministic": true,                    // it draws the same picture from the same inputs: stills and lint may render it
    "size": { "w": 960, "h": 600 },           // the plate's logical size (default 960 × 600)
    "options": { … } }                        // anything; the script gets it as ctx.plate.options
]
```

The script is one self-contained ES module (it can't import other files: its frame can't fetch anything). The API is small and it gets **data, not Karyo's internals**:

```js
export function render(host, ctx) { … }     // draw into host (a <div> the size of the plate, less the notice bar)
export function update(host, ctx) { … }     // optional: new inputs (theme, state, size); default: render again from scratch
export function dispose(host) { … }         // optional: the plate is going away

ctx = {
  model,              // the model (JSON; kit kinds' default categories filled in); also flow or tour for those plates
  plate,              // { id, title, kit, options }
  theme,              // the theme's values: bg, fg, muted, line, accent, accent2, ok, card, cardBorder, radius, shadow,
                      //   font, fontDisplay, fontMono, cat: [8 colours], catOther; the frame's :root also has them as
                      //   var(--pl-…), so the script's CSS and SVG can use the tokens as a scene's do
  size,               // { w, h } in px
  state,              // the view state it last emitted (null at first; stills and setState set it)
  emit(type, data),   // 'state': keep a view state (JSON, ≤ 100 kB): the plate's getState/setState carry it, and the
                      //   script is updated with it; 'status': one line (≤ 300 chars) shown in the notice bar
}
```

Draw in the theme's tokens and categories take the board's colour slots (sorted names, 1…8, the rest "other"), as `kits/radial/plates/radial.js` shows. A plate is interactive: the script handles its own pointer events; the plate's keys (Esc, `f`, zoom) stay the host's. **Stills**: a `deterministic` script is rendered like any plate (the plate is ready once it has drawn; states are the host's `rest`, `review`, `review-source`, plus `{ "script": … }` for the script's own state, e.g. `render.ts stills --scene <id> --state '{"script":{"pin":"orders.store"}}'`). A script that doesn't declare `deterministic` is replaced in stills and lint by a notice that says so. `karyo kit check` parses each script as the frame loads it (it must export `render` and import nothing) and warns that the kit runs code.

### What the user sees

- **Not trusted yet**: the plate shows a **warning panel** instead, and the script is never loaded. It names the kit and where it comes from ("this project (…)", "your kits (~/.adenine/…)", "your KARYO_KITS folders (…)", "built into Karyo"), says what running it means in plain words:

  > This kit runs its own JavaScript in this page. It can read the diagram's data and, because Karyo's local server is running, could try to change files in this project. Only trust kits whose code you have read or whose author you trust.

  then what Karyo does to limit it (a safety net, not a reason to trust), every file it would run (kit.json and its scripts) with its size and **sha256**, each with **View source** (read-only, highlighted, inline), and two buttons: **Trust this version** and **Not now**. "Not now" leaves a placeholder; its button opens the panel again. A kit that changed since it was trusted says so and marks the files that changed. Everything is a real button: Tab, Enter and Space work, and Esc closes the source, then means "Not now".
- **Trusted** (or built in): the script runs, and a **notice stays on the plate for as long as it does**: `⚠ runs code from kit probe · trusted 2030-04-29 · this project (…)` (a built-in kit: `trusted automatically · built into Karyo`). The notice is a button: it opens the same panel as a review, with **Take trust back** (not for built-ins).
- A kit's script that fails, or doesn't draw within 10 s, leaves a plain message on the plate; so does one that navigates its own frame away (it is removed).

### Trust

- **Where**: `$KARYO_HOME/trust.json`, by default `~/.adenine/karyo/trust.json` (docs/PACKAGING.md), written atomically, mode 600. Never in a project, and nothing in a project is read for trust, so **a repository can't trust itself**.
- **What**: one entry per kit, keyed by its folder's real path (symlinks followed) and a **hash of its code**: the sha256 of each of kit.json and its scripts, combined (`kitHashInput` in `src/kits/warning.ts`: a format line, then each path and sha256, kit.json first, then by path). Change one byte in any of them, move the kit, or clone the repository elsewhere, and Karyo asks again. Trusting a new version replaces the old entry. Templates and CSS don't run and aren't part of the hash.
- **Built-in kits** (the plugin's `kits/`) are trusted automatically, and their notice says so. A kit of the same name nearer to the project hides a built-in one whole, and is then that kit, not trusted.
- **From the page**: "Trust this version" posts `{dir, hash}` to the dev server, which accepts it only for a kit folder it has served to a page and only when the hash is what is on disk now (a kit that changed after the page loaded is refused: reload and review again). Before it runs anything, the page re-hashes the text it holds (`crypto.subtle`) and checks it against the hashes; a mismatch runs nothing. A page holding a version that is no longer on disk is told so and runs nothing.
- **From the terminal**: `karyo kit trust <name|dir>` prints the same warning, where the kit is from, each file with its sha256, the version's hash and what is trusted now, then asks `y/N` (`--yes` skips the question; without a terminal it refuses unless `--yes`). `karyo kit untrust <name|dir>` takes it back. `karyo kit list` marks every kit that runs code and whether this version is trusted. `karyo view` prints a warning line when the project sees kits with code, with how to review them.

### The sandbox

The script runs in an `<iframe sandbox="allow-scripts">` with no `allow-same-origin`, so it has an opaque origin: it can't reach the page's DOM, storage, cookies or the local server's token, can't navigate the page, open windows or submit forms. Its document carries a Content-Security-Policy: `default-src 'none'`, `connect-src 'none'` (no fetch, XHR, WebSocket, EventSource or beacon), images and fonts from `data:` only, scripts only the bootstrap (by nonce) and the kit's module (a `blob:` it makes from the text it is sent). The iframe's `csp` attribute requires that policy of anything shown in the frame, so if the script navigates its frame away, the browser refuses to show the new document (it never runs), and Karyo removes the frame when it sees the second load. Messages: the bootstrap says `hello` once by `window.postMessage`; the host answers once with `run` (the source and ctx) and a `MessagePort`; everything after (`update`, `dispose`; `rendered`, `state`, `status`, `error`) goes over that port only, so a document that replaced the bootstrap's is not heard. The host reads only those types, caps sizes and shows text as text. There is no in-page mode.

### The local server

Separately from kits, and whatever runs in the page, Karyo's dev server (`vite.config.ts`, `src/kits/devserver.ts`) guards every `/__karyo/…` endpoint (the path matched in any case and parsed as the endpoints parse it, since the router ignores case; a target with dot segments or encoded separators that names them is refused, since the router doesn't resolve those):

- the request must name a loopback host (`localhost`, `127.0.0.1`, `[::1]`; Vite also refuses other hosts), which stops DNS rebinding;
- a browser request from **another origin is refused**, whatever the method (preflights included), and so is the `null` origin of a sandboxed frame; `Sec-Fetch-Site` must be `same-origin` (or `none`, a typed URL) when present;
- a request that **changes something** (splice save and delete, the team layout, trust) or asks about trust must carry the **per-server token**: a random value made when the server starts and put in every page it serves (`<meta name="karyo-token">`), sent as `x-karyo-token` by the page's own requests (`src/kits/devtoken.ts`, installed by `src/kits/boot.ts`, so the board and Splice send it without code of their own).

Tools that aren't browsers (the CLI's reads) send no Origin and can still read; a write needs the token.

### Threat model and limits

- **What it protects**: an untrusted kit's code never runs. A trusted kit's code runs sealed: it can't write through Karyo's server (no token, a null origin, and its CSP allows no requests), can't read the page, its storage or its cookies, and can't navigate the page or open windows. The server refuses other origins even when they carry a token they read from Karyo's page (Vite answers cross-origin reads from other localhost ports). A page inside another site's frame can't trust a kit (its Trust button is off and says why), so another site can't steer a click onto it (clickjacking). The source viewer marks invisible and direction-changing characters (`⟦U+202E⟧`, "Trojan Source") and says when a file has them; so does `karyo kit trust`, and the terminal output shows control characters in kit names and descriptions as `⟦U+001B⟧` rather than obeying them. The `karyo` launcher runs bun with `--no-env-file --config=/dev/null`, so a cloned project's `bunfig.toml` (a preload script) and `.env` (`NODE_OPTIONS`, `KARYO_HOME` …) never reach Karyo; the `just karyo` / `just kit` recipes do the same.
- **What it doesn't**: trusting a kit means trusting its author with what the frame allows. A trusted script sees the whole model it is handed (every node, relationship, recorded flow and code excerpt in it) and **could send it away**: by navigating its own frame to a URL carrying it (browsers have no sandbox flag against a frame navigating itself; the request is sent before the new document is refused), or through channels a CSP doesn't cover, such as WebRTC (STUN to any address) and prerender hints (`<link rel=prerender>`). Treat what a trusted kit is handed as shared with its author. It can also load more code from the data it is handed (`import()` of a `blob:` it makes, which the frame's CSP allows for its own module), so the hash pins the script, not everything it may do; a script that does this is visible when you read it. It can draw anything inside its plate, including a convincing fake of Karyo's own UI there (the notice bar above it is the host's, and says which kit is drawing), and burn CPU or memory in its frame. The sandbox relies on the browser (Chrome-class iframe sandboxing and CSP); a browser bug is out of scope. Anything else on your machine that can run code (another process, a malicious dependency) is outside this model: it can read the token from a page, or write files directly.
- **A built site** (`vite build`): there is no local server and so no trust store; built-in kits still run (trusted automatically), anything else shows the warning and can't be trusted there.
- **Fonts**: the frame can't load web fonts. A theme's web font, if a page loads one, isn't there; the script draws in the system's fonts.
- **Node kinds** can't run scripts: a kind is a template. A card drawn by a script would need a sandboxed frame per card in every view that draws cards (boards, trace boards, the Stack view, tours, sequence lanes); see Gaps.

## Commands

| | |
|---|---|
| `karyo kit new <name> [--project [dir] \| --global] [--kind K]` | scaffold a kit with one node kind (card, style, a section, a fields schema, an example): `--project` (the default) in `<dir>/karyo/kits`, `--global` in `$KARYO_HOME/kits` |
| `karyo kit list [--project <dir>]` | every kit the project sees, nearest first, with its kinds, plate types and what a nearer one hides; a kit that runs code is marked `⚠ runs JavaScript (…)` with whether this version is trusted |
| `karyo kit check <name\|dir>` | kit.json against the schema; each kind's component.json, its example against its fields schema, its card, sections and mini rendered with the example (as the board renders them), the four hooks, theme-token-only CSS; each plate type's view and source; a script plate's script (parses, exports `render`, imports nothing; a warning that it runs code; one without `deterministic`). Exit 1 on errors |
| `karyo kit trust <name\|dir> [--project <dir>] [--yes]` | the warning, where the kit is from, each file it runs with its sha256 and the version's hash; asks y/N, then keeps this version in `$KARYO_HOME/trust.json` |
| `karyo kit untrust <name\|dir> [--project <dir>]` | take trust back (every version of that kit folder) |

In this repo: `just kit …` (the same CLI), `just kit-test` (`tests/kits.test.ts`: resolution order, collisions, the schema and the check, kind rendering and sizes; `tests/kit-scripts.test.ts`: code and its hash, the trust store in a sandboxed home, reading scripts safely, the server's guard and trust endpoint, and in Chrome that an untrusted script never runs).

## Modules

| module | exports |
|---|---|
| `src/kits/types.ts` | `KitManifest`, `KindMeta`, `PlateType`, `KitBundle`, `PLATE_VIEWS` |
| `src/kits/library.ts` (bun) | `loadKits(opts)`, `bundleKits(lib)`, `readKit`, `scaffoldKit(dir, name, {kind})`, `findProjectKits(dir)`, `homeKitsDir()`, `BUILTIN_KITS_DIR` |
| `src/kits/check.ts` (bun) | `checkKit(dir)` |
| `src/kits/registry.ts` (pure) | `KitSet` (`kind`, `size`, `cardInner`, `sections`, `mini`, `css`, `decorate`, `plates`), `modelStats`, `setDefaultKits`, `useKits`, `kitsFor` |
| `src/kits/plates.ts` | `kitPlate(kits, id, model, {flow, tour}, opts)`, `plateInstances(model, kits)`, `filterNodes`, `subModel` |
| `src/model/sequence.ts` | `sequenceScene(model, flowId, opts)`, `SequenceApi` |
| `src/model/sequence-fold.ts` (pure) | `flowLanes(flow, keep)`, `foldLanes(model, flow, lanes, calls, fold)`, `FoldUnit`, `SequenceFold`, `isSequenceFold` |
| `src/kits/warning.ts` (pure) | the warning's words (`KIT_CODE_WARNING`, `KIT_CODE_SANDBOX`, `KIT_TRUST_WHERE`, `whereWords`, `noticeWords`, `localDay`), `kitHashInput`, `validScriptPath` |
| `src/kits/code.ts` (bun) | `readKitCode(dir, manifest, problems)`, `kitHash`, `sha256`, `scriptsOf`, `tildePath` |
| `src/kits/trust.ts` (bun) | the trust store: `trustFile(env)`, `readTrust`, `trustState(file, dir, hash, source?, files?)`, `grantTrust`, `revokeTrust`, `realDir` |
| `src/kits/devserver.ts` (bun) | `guardMiddleware(token)`, `checkRequest`, `trustMiddleware({file, known})`, `newToken`, `TOKEN_HEADER` |
| `src/kits/devtoken.ts` | `installDevToken()` (the page's own `/__karyo/…` requests carry the token), `devToken()` |
| `src/kits/trust-client.ts` | `trustStatus`, `trustGrant`, `trustRevoke`, `verifyCode` (the page re-hashes before running) |
| `src/kits/sandbox.ts` | `KitSandbox` (the sealed frame and its messages), `ScriptCtx` |
| `src/kits/script-plate.ts` | `scriptPlate(kits, plate, model, {title, flow, tour})`: the warning panel, placeholder, notice, review and the running frame; `ScriptPlateApi` (`trustView`, `trustThis`, `notNow`, `review`, `revoke`), `highlight` |

The views that draw kit kinds: `cardHTML(n, kits)` and `layout(model, …, kits)` in `src/model/scenes.ts` (the structure map and flow replay), the structure board, the trace board, the Stack view (and a board's stack of splices), the tour's map and the sequence view. Layouts take each card's size from its kind: a column is as wide as its widest card, a column's cards stack at their own heights, and a forward wire turns in the gutter past the column's widest card.

## Gaps

- **Fields from directives.** `fields` travel in fragments and the model, but the Python and Go directives can't set them (there is no `field.<name>=` key); a hand-written fragment or a generator can.
- **Colours across plates.** A board narrowed by a filter numbers its categories among the nodes it keeps, so a category's colour can differ from the full board's. The sequence view keeps the model's numbering.
- **The explainer's node scope.** In an explainer, a kind's `stats.*` are zero and `node.*` comes from the element (its id, label, category, tags).
- **Scripts for node kinds.** Only plate types can run a script. A kind's card drawn by its own code would need a sandboxed frame per card, in every view that draws cards (boards, trace boards, the Stack view, tours' maps, sequence lanes), and a place for the warning on a board. A kind stays a template.
- **A frame can leave, and talk.** A trusted script can send what it was given out through its frame's navigation, WebRTC or a prerender hint (Threat model). A MessagePort `close` signal and a CSP hash-only policy (no `blob:`) would narrow it further.
- **Web fonts in the frame.** A script plate draws with the system's fonts; a web font the page loads isn't there.
- **Size.** A script plate has a fixed size (`size`); the theater scales it rather than laying it out for the window.
