---
name: karyo-explain
description: Make a visual, step-by-step explainer of anything with Karyo, shipped as one self-contained HTML file. Use when the user asks to explain, visualize, illustrate or walk through something visually (a concept, a system, an algorithm, a process, a codebase, a timeline, a comparison), or asks for an explainer, an animated diagram, a visual guide or a step-through.
---

# Karyo explainers

`karyo` below is the plugin's CLI, run by its full path: `"${CLAUDE_PLUGIN_ROOT}/cli/karyo"` (it isn't on PATH;
if that path comes out empty, `"${CLAUDE_SKILL_DIR}/../../cli/karyo"` is the same file).

A Karyo explainer is a JSON spec (`*.explainer.json`): **elements** (instances of components: cards, chips, metrics, charts, code, figures, …) on a board, **links** between them, and **steps** that change what is shown, lit, dimmed, linked and framed. Karyo validates it, renders each step to a PNG you can look at, and builds one self-contained HTML file (no server or network needed) that steps through it with smooth transitions.

Use it when a picture that builds up step by step explains better than prose: how parts connect, what happens in order, what changes between states. For a single static table, or a chart that never changes, plain Markdown or an artifact is simpler.

The full format is in `${CLAUDE_PLUGIN_ROOT}/docs/EXPLAINERS.md`. Read it before your first spec in a session. `karyo --help` prints that path and every command. The first command of a fresh install sets up Karyo's dependencies (in the plugin's data dir, never the user's project); if it reports bun missing, tell the user how to install it (it prints the command) rather than working around it.

## The loop

```sh
karyo new my-topic --title "How X works" --template steps   # or blank | graph
# edit my-topic/my-topic.explainer.json
karyo validate my-topic            # fix every error; the hints say how
karyo stills my-topic --step all   # prints one PNG path per step
```

1. **Plan the steps first**: 3–8 steps, one idea each. Write the step titles as a list before any JSON.
2. `karyo new <dir>` writes `<dir>/<dir>.explainer.json` (valid as written) and an empty `components/`. Replace its elements, links and steps with yours.
3. `karyo components` lists what you can use; `karyo component show <name>` gives its props schema and an example. Use built-ins before making a component.
4. `karyo validate <spec>`: issues come as a JSON pointer, a message and often a hint (`did you mean "card"?`). Exit 1 means errors. Fix them all; take the warnings seriously too.
5. `karyo stills <spec> --step all` renders every step at rest. **Read every PNG with the Read tool** and fix what looks wrong: clipped or overlapping text, a crowded step, a label too small, a step that says two things, a link that crosses the whole board. Re-render the steps you changed (`--step 3` or `--step 2-4`). Check the other theme too (`--theme fresh`), and `--mode light` if the explainer may be seen on a light page.
6. `karyo lint <spec>`: layout problems in every step (elements off the stage, clipped text). It must say `no issues`.
7. `karyo build <spec>` writes `<id>.html` next to the spec (`-o file.html` puts it elsewhere) and prints its size. Hand over that path. If the user wants it in a Claude artifact (a link to share), follow the **artifact** skill (`/karyo:artifact`): it builds the artifact page, publishes it with your Artifact tool, records the link in `karyo/artifacts.json`, and republishes to the same url when the explainer changes.

`karyo view` serves the project's web view on a free local port and prints its URL: every explainer in the project (and its Karyo model, if it has one), live. `karyo open <spec>` builds the file and opens it in the browser. Every command takes `--json`. A `<spec>` argument can be the spec file or the folder holding it.

## In Cowork or Claude Desktop

Here the person is often not a developer. Talk about the explainer (its steps, what each one shows), not about JSON,
commands, tools or file paths, and never show a `/sessions/…` path. You are in Cowork when your shell's home or the
user's folders are under `/sessions/`, or you have a tool for presenting files to the user.

- **The same loop runs in Cowork's shell.** The first Karyo command of a session sets Karyo up there (its own bun,
  its libraries and a headless browser for the stills): about a minute, once per session. Say so once, in a
  sentence, before it starts. Read every still, as above.
- **Keep their work in their folder.** Make the explainer's folder inside the folder the user shared with you (else
  the session's outputs folder), so it outlasts the session. Build the page there with a plain file name:
  `karyo build <spec> -o "<their folder>/<Title>.html"`. It opens in any browser, offline, and can be sent to anyone.
- **Hand it over** with your file-presenting tool when you have one (it previews in the conversation), and say the
  file's name and that it's in their folder. For a link they can share, the **artifact** skill publishes it when you
  have an Artifact tool.
- **Pictures** they give you (in their folder, or uploaded): copy each into `<explainer folder>/images/` and use
  `images/<name>` as the `src` of an `image` or `figure` element. The page carries them inline.
- **If setup fails**, the command says why. Without internet access for code (an account or organisation setting in
  Cowork), say in plain words that Karyo needs it once per session to set itself up, and that an admin can allow it.
  Then, if you have Karyo's MCP tools (`check_setup`, `new_explainer`, `preview_explainer`, …; a session running on
  the user's own computer), use them instead: the same loop, with `preview_explainer` returning the stills as images
  and `build_explainer` saving the page (`save_to`, a folder that exists where the tool runs).
- **No live pages**: `karyo serve`, `karyo view` and `karyo open` need a browser on the same machine, which Cowork's
  shell doesn't have. Build the file instead.

## Writing the spec

```json
{
  "karyo": "explainer/1",
  "id": "compound-interest",
  "title": "Compound interest",
  "summary": "Money that earns money grows faster every year.",
  "layout": { "kind": "flow", "direction": "right", "gap": 64 },
  "elements": [
    { "id": "start", "type": "metric", "props": { "label": "Start", "prefix": "$", "value": 1000 } },
    { "id": "rate", "type": "chip", "props": { "text": "5% / year", "tone": "accent" } },
    { "id": "end", "type": "metric", "props": { "label": "After 10 years", "prefix": "$", "value": 1000 } }
  ],
  "links": [{ "id": "grow", "from": "start", "to": "end", "label": "×1.05 each year" }],
  "steps": [
    { "title": "You start with $1,000", "text": "The **principal**.", "show": ["start"] },
    { "title": "It earns 5% a year", "add": ["rate"], "emphasize": ["rate"] },
    { "title": "Ten years later", "add": ["end"], "set": { "end": { "value": 1628.89 } }, "emphasize": ["end"], "dim": "others" },
    { "title": "The whole picture", "show": "*" }
  ]
}
```

- **Layouts:** `flow` (the default), `grid` (`columns`), `graph` (layered by links), `stack`, `free` (`at: {x, y}` on each element). `at: {w, h}` sizes any element. `groups` draw a labelled frame around their members (`"group": "<id>"` on each). A step can switch `layout`, and the board glides to it. **A step's `layout` stays in effect for every later step until another step sets one**, so after a one-off `stack` or `flow` step, set the graph layout again explicitly.
- **Step fields:** `show` (a list, or `"*"`), `add`, `hide`, `emphasize`, `dim` (`"others"` or a list), `connect` (link ids or `"a->b"`; by default every link whose ends are both visible is drawn), `focus` (an element id, a group id or `{x, y, w, h}`), `set` (prop changes, cumulative: numbers count, bars grow and charts move to new data between steps), `title` and `text` (markdown-lite).
- **Legend:** top-level `categories: [{ "id", "label" }]` (colour follows the order, 8 at most) and `tags: [{ "id", "label", "description" }]`. On each element, `"category": "<id>"` (one) and `"tags": ["<id>", …]`. A legend strip under the board lists them. The viewer hovers an entry to light its elements and clicks to pin it. It shows whenever categories or tags exist; `"legend": false` hides it. Use categories for *what kind of thing* an element is (e.g. service / store / queue) and tags for sets that cut across kinds (e.g. "in context"). An unknown category or tag id is a validation error.
- A spec without `steps` is one step that shows everything. A custom component must be listed in `uses`. Unknown keys are errors.

## Charts

When a step is about numbers that change, use a chart component rather than drawing one: `line`, `bars`, `donut` or `sparkline` (details in EXPLAINERS.md, "Charts").

- `line`: a trend over time or any ordered x (months, years, dates as `"2025-03"`); up to four or five series.
- `bars`: comparing categories. `"stacked": true` when the totals matter; `"orient": "horizontal"` for long names or many bars.
- `donut`: shares of one whole, six slices or fewer. Close values compare better as bars.
- `sparkline`: a small trend beside a number, stacked in a column with metrics or cards.
- One number is a `metric`, not a chart.

```json
{ "id": "sales", "type": "bars", "props": {
    "title": "Cups sold", "x": ["Mon", "Tue", "Wed", "Thu", "Fri"],
    "series": [{ "id": "tea", "label": "Tea", "category": "hot", "values": [40, 42, 38, 51, 64] },
               { "id": "juice", "label": "Juice", "values": [12, 15, 14, 20, 31] }] } }
```

Then let the steps do the explaining: `"emphasize": ["sales/tea"]` lights one series and fades the rest of the chart, `"sales/Fri"` one category, `"sales/tea@Fri"` one bar; `"set": { "sales": { "stacked": true } }` or new `series` values animate the change; `"annotations": [{ "type": "line", "y": 50, "label": "Target" }]` (in props or a `set`) adds a reference line, `"type": "band"` a shaded range, `"type": "callout"` a note on one point. Colours come from the spec's `categories` (a series names one with `category`), never from props. Read the stills: lint reports chart labels that collide or fall outside the chart; widen the element (`at.w`) or show fewer bars when it does.

## Rules

- **The rest state is the end state.** Each step settles into a still frame, and that frame is what people read (and what stills show). Motion happens only between steps.
- **One idea per step.** If the title needs "and", split the step.
- **At most about 7 elements visible per step.** Use `hide`, `dim: "others"` or a `layout` change to keep each step readable.
- **Short prose.** A step's `text` is one or two sentences. Put the words on the board only when they are the thing being explained.
- **Build up, then show the whole.** Start small, add one thing per step, and end with a step that shows everything with nothing dimmed.
- **Look before you ship.** Never build without reading the stills of every step.

## A custom component

Make one only when no built-in shows the idea well (a queue lane, a gauge, a protocol frame, …).

```sh
karyo component new queue-lane --global          # ~/.adenine/karyo/components: every explainer on this machine
karyo component new queue-lane --project my-topic  # my-topic/components: this explainer only
karyo component check queue-lane --spec my-topic   # metadata, props schema, the example through the validator
```

A component is a folder `<name>/` holding three files:

- `component.json`: `name`, a one-sentence `description`, `version`, `props` (a JSON Schema object: `required`, `additionalProperties: false`, and a `description` on each non-obvious prop), optional `size: {w, h?}` and `motion` (`appear`, `emphasize`, `count`, `draw`), and an `example` (its props), which `check` validates.
- `template.html` in the template language: `{{prop}}` (escaped text), `{{{prop}}}` (markdown-lite), `{{svg prop}}` (a sanitized inline SVG), `{{#each items}}…{{this}} {{this.x}} {{@index}} {{@number}}…{{/each}}`, `{{#if prop}}…{{else}}…{{/if}}`, `{{#unless prop}}…{{/unless}}`, `{{#has prop}}…{{/has}}` (is set: 0 and false count, unlike `#if`), and `{{! comment }}`. Motion hooks: `data-k-num="prop"` counts a number, `data-k-scale="value/max"` drives `--k` (0 to 1), and `data-k-draw` on an SVG path draws it on.
- `style.css`: scoped automatically (`.box` becomes `.kc-<name> .box`; `:host` is the element itself, e.g. `:host(.is-lit)` when emphasized, `:host(.is-dim)` when dimmed). Use **theme tokens only**: `var(--pl-bg|fg|muted|line|accent|accent-2|ok|card|card-border|radius|font|font-display|font-mono)` and `color-mix()` of them, so light, dark and every theme work. **No CSS transitions or animations**: the engine owns every change over time. The validator warns about them and about hard-coded colours. Let the box fill the element (`height: 100%`). Start from the engine classes `pl-card`, `pl-label`, `pl-title`, `pl-chip`, `pl-code`, `pl-mono`, `pl-muted`.

Then add the name to the spec's `uses` and use it as an element `type`. Components resolve from `<spec dir>/components`, then `$KARYO_COMPONENTS`, then `~/.adenine/karyo/components`, then the built-ins. The first match wins.

## A kit: a node kind or plate type the project needs

When a project's model has a kind of thing Karyo draws plainly (a service, a queue, a table, a lane, a sensor) and its card should say more, or the project needs a plate that doesn't exist yet (the structure board narrowed to one kind, a sequence diagram of each flow), make a **kit** rather than a one-off scene. Kits are data and templates, never code; the format is in `${CLAUDE_PLUGIN_ROOT}/docs/KITS.md` (read it first).

```sh
karyo kit list                         # what the project already sees: its kits, the shared ones, the built-ins
karyo kit new queues --kind queue      # <project>/karyo/kits/queues: kit.json + kinds/queue/ (card, style, a section)
karyo kit check queues                 # schema, the card and sections rendered with the example, theme tokens
```

- A kind is a component with a `node` block and a fixed `size`: its card template renders the card's inside (keep `.mm-top`, `.mm-kind`, `.mm-name`, `.mm-ref`), sees the node's `fields`, `node.*` and `stats.*` (relationships, recorded calls, the operations recorded on it), and adds details sections (`data-item` on what they list). The model's nodes use it by `kind=<word>` in their directives.
- A plate type is one entry in kit.json: a `view` (`board`, `trace`, `tour`, `sequence`), what it is drawn `from` (`model`, `flow`, `tour`) and a `filter`. `karyo view` lists it for every model, flow or tour.
- `--global` puts a kit in the shared library (`~/.adenine/karyo/kits`) for every project on the machine; a project's own kit wins over a shared one of the same name.
- Look at it: `karyo view`, open the board, and Read a screenshot or the stills; `karyo kit check` must report no errors.

## Where things are

- Format and rules: `${CLAUDE_PLUGIN_ROOT}/docs/EXPLAINERS.md`. Schema: `${CLAUDE_PLUGIN_ROOT}/spec/karyo-explainer.schema.json` (new specs point `$schema` at it).
- Built-in components: `${CLAUDE_PLUGIN_ROOT}/components/` (`karyo components` lists them).
- Kits: `${CLAUDE_PLUGIN_ROOT}/docs/KITS.md`, the schema `${CLAUDE_PLUGIN_ROOT}/spec/karyo-kit.schema.json`, the built-in kits in `${CLAUDE_PLUGIN_ROOT}/kits/`.
- The plugin also runs the same engine as an MCP server (`karyo`; tools `mcp__plugin_karyo_karyo__*`). Claude Desktop starts it on the user's computer, and so does a Cowork session that runs there (not one in the cloud). In Claude Code, and in Cowork's shell, prefer the CLI loop above: the stills are files you Read.
