# Explainers

An **explainer** is an interactive Karyo plate about any topic. You write it as one JSON file (a *spec*): **elements** (instances of reusable **components**) on a board, **links** between them, and **steps** that change what is shown, lit, dimmed, linked and framed. The viewer steps through it like a slideshow in which only the change moves: elements come and go, the camera glides, links draw on, numbers count. Everything is real HTML, so text is selectable and the page works without animation. The motion follows the engine's interactive-plate rules (docs/ENGINE.md, "Interactive plates").

Workflow (Claude: do all of it; look at the PNGs):

1. Write `<name>.explainer.json`. Put `"$schema": "<path>/spec/karyo-explainer.schema.json"` in it so editors can check it as you type.
2. Validate: the `karyo` CLI (`karyo validate <spec>`), or `validateSpec()` from bun. Fix every error. Read the warnings.
3. Stills of every step at rest: `just explainer-stills <spec>`. For one transition: `bun scripts/render.ts stills --spec <spec> --state step-3 --t 0.35,0.7` (the transition from step 1 into step 3, then its rest). **Read the PNGs.**
4. Lint: `just explainer-lint <spec>`. It reports elements outside the stage, clipped text, elements cut off by the board edge, overlapping elements, content bigger than its box, and narration too tall for its panel. It must report no issues.
5. Check the other look: add `--theme fresh` to the stills (and `--mode light` for the plain neutral tokens).
6. Ship it as one file: `just explainer-html <spec> out/<name>.html`. The file opens from `file://` and needs no network at all: no remote fonts or scripts (the themes' own faces are inlined).
7. Smoke-test what ships: `just explainer-smoke out/<name>.html` (or pass the spec; it is built to a temp file). It lands every step (no errors, clean lint), then drives the keys, a station, play and its interruption, the theater, the page API and motion 0.

Dev preview: `just dev`, then `http://localhost:5180/explain.html?spec=<absolute or repo-relative path>` (`&theme=fresh`, `&mode=dark`, `&step=3`). The page lists validation issues above the plate.

## The spec

```jsonc
{
  "$schema": "../../../spec/karyo-explainer.schema.json",
  "karyo": "explainer/1",               // required, exactly this
  "id": "compound-interest",            // required: letters, digits, _ . : -
  "title": "Compound interest",         // required
  "summary": "One line, **markdown-lite** inline",
  "note": "Optional: a short footer line on every step, e.g. **Names and files here are made-up examples.**",
  "size": { "w": 1600, "h": 900 },      // logical stage px (default 1600×900); the plate scales to fit
  "narration": "side",                  // side (default) | bottom | none: where each step's prose goes
  "timeline": true,                     // stations strip, one per step (default: true when > 1 step)
  "uses": ["rate-dial"],                // custom components needed (built-ins need no listing)
  "layout": { "kind": "graph", "direction": "right", "gap": 28 },
  "groups": [{ "id": "inputs", "label": "What you choose" }],
  "categories": [{ "id": "input", "label": "inputs" }, { "id": "result", "label": "results" }],
  "tags": [{ "id": "yearly", "label": "changes every year", "description": "tooltip" }],
  "legend": true,                       // default: shown when there are categories or tags
  "elements": [
    { "id": "rate", "type": "card", "group": "inputs", "label": "Rate",
      "category": "input", "tags": ["yearly"],
      "props": { "title": "5% a year", "body": "Paid on **the balance**." },
      "at": { "w": 250 } }
  ],
  "links": [{ "id": "r-b", "from": "rate", "to": "balance", "label": "× 1.05", "style": "accent" }],
  "steps": [
    { "id": "s1", "title": "Pick a rate", "text": "Markdown-lite prose.",
      "show": ["rate"], "emphasize": ["rate"] }
  ]
}
```

Unknown keys are errors (the validator suggests the nearest name).

### Elements

| key | meaning |
|---|---|
| `id` | unique; steps, links and focus refer to it |
| `type` | component name (built-in or from a library) |
| `props` | checked against the component's `props` schema; schema `default`s fill in missing props |
| `at` | `w` / `h`: size in px, honoured by every layout. Without `w` the element uses the component's `size.w`, and a component with no `size` takes its natural width. Without `h` the element takes the tallest natural height across its steps. `x` / `y` are used by the `free` layout only. |
| `group` | a group id: members get a dashed, labelled frame that follows them |
| `label` | accessible name (default: `props.title`, then `props.label`, then `id`) |
| `category` | a category id from `categories`: a coloured bar on the element's left, and its legend entry |
| `tags` | tag ids from `tags`: the legend can light and pin them |

### Layouts (`layout`, and per step)

Positions are in **board px**. The camera frames the result, so the origin doesn't matter.

| kind | placement |
|---|---|
| `flow` (default) | rows (`direction: "right"`) or columns (`"down"`) that wrap at the board's width / height; lines centred |
| `grid` | `columns` columns (default √n); cells as wide as their widest member, rows as tall as their tallest |
| `stack` | one row or one column, centred across |
| `graph` | layered by links (longest path from the sources): callers before callees; `right` = layers are columns, `down` = rows. Layers leave room for the widest link label. |
| `free` | each element's `at.x` / `at.y`; elements without them continue in a row below |

`gap` (px) defaults to 32, or 56 when there are groups. `scope`: `"all"` (default) lays out every element once, so positions stay stable and hidden elements keep their place. `"visible"` lays out only the step's visible elements, so the layout **glides** as elements come and go. A step's own `layout` switches the layout from that step on, and the change glides.

### Links

`{ id, from, to, label?, style? }`, where `style` is `solid` (default, muted), `dashed`, `accent` (accent colour with a glow) or `warn` (the second accent). A link runs side to side between the two element boxes, as a curve with an arrowhead. Its label is an HTML chip at the midpoint. A plain link turns accent when either end is emphasized.

### Steps

Each step resolves to a full state. Keys:

| key | meaning |
|---|---|
| `title`, `text` | the station label and the narration (`text` is markdown-lite) |
| `show` | the visible set: an id list or `"*"`. Omitted: the previous step's set (the first step: every element). |
| `add`, `hide` | then added to / removed from that set |
| `emphasize` | lit: an outline draws around them and a light glows under them. An entry `"chart/part"` lights one part of a chart instead (see Charts) |
| `dim` | `"others"` (every visible element not emphasized) or an id list: faded to ~0.3. An entry `"chart/part"` fades one part of a chart |
| `connect` | the links drawn in this step: link ids, or ad-hoc `"a->b"`. Default: every link whose ends are both visible. |
| `focus` | camera framing: an element id (zoom ≤ 1.5), a group id (its frame, zoom ≤ 1.5) or a board rect `{x,y,w,h}` (exact fit). Default: fit the visible elements and group frames, never zooming in (scale ≤ 1). With a focus, anything the view would cut at its edge (an element, a group frame, or a link to either) fades right back instead of showing a clipped sliver; it returns in full when the camera pulls back. |
| `set` | `{ elementId: { prop: value } }`: prop changes, **cumulative** from step to step (going back reverts them). Numeric props the component tweens count to the new value. Other changes swap the element's content. |
| `layout` | a relayout from this step on |

With no `steps`, an explainer is a single step showing everything.

### Legend: categories and tags

`categories: [{ id, label? }]` and `tags: [{ id, label?, description? }]` at the top level. Each element names at most one `category` and any number of `tags`. A category's colour comes from its position in the list: the first uses `--pl-cat-1`, the second `--pl-cat-2`, and so on to 8 (docs/ENGINE.md, "Themes"). With more than 8, the rest share one neutral "other" swatch, and the validator warns about it. The legend strip sits under the board and shows **Categories** (swatch, label, element count) and **Tags** (label, count). It appears whenever there are categories or tags; `"legend": false` hides it while keeping the category bars.

- Hover an entry to light its elements at once. The links between two lit elements turn accent, the rest fade, and each member gets a quiet outline.
- A chart whose series or slices use a category is one of its members. Lighting the category lights those series inside the chart (see Charts) rather than outlining the whole chart.
- Click an entry to pin it (a transition). Several pins show their union, and clicking again unpins. Esc clears the pins before it leaves the theater.
- While a highlight is on, a step's own emphasis (outline and light) fades on the elements the highlight leaves out.
- The validator reports an unknown `category` or tag id as an error, with a "did you mean" hint. It warns about categories or tags that no element uses, and about more than 8 categories.
- Stills: `legend-pin-<tag id>` (the tag pinned on the step that shows most of its elements) and `legend-hover-<category id>`, next to `step-1` … `step-N`.

## What moves (motion verbs)

One transition takes ≈0.7 s (ease out cubic), from what was on screen to the new step. With the motion dial at 0 or `prefers-reduced-motion`, it lands at once on the same end state.

- **appear**: an arriving element fades in with a 14 px rise where it lands. A leaving one fades out where it is, early in the transition.
- **glide**: positions (relayout), group frames and the camera interpolate.
- **emphasize**: the outline draws around the element (and undraws when it stops being emphasized), with light underneath. The component gets the class `is-lit` on its root (`:host(.is-lit)` in its CSS).
- **dim**: opacity eases to ~0.3. The root gets `is-dim`.
- **draw**: new links draw on from their source, in the second half of the transition, and then their arrowhead and label appear. SVG shapes marked `data-k-draw` draw on when their element appears.
- **count**: numbers marked `data-k-num` count from 0 when their element appears, and from the old value when a step `set`s a new one. `data-k-scale` values (bars) grow the same way.
- **chart**: a chart grows in when it appears (bars from the baseline, lines drawn from the left, a donut swept round) and moves to new data when a step `set`s it (see Charts).

Keys on a focused plate: ←/→ or j/k and Enter step, Home/End, 1–9 jump, `p` plays (it chains the steps, pausing on each one long enough to read its prose; any key or click stops it), `f` opens the theater, `b` toggles Bench, and Esc stops play, then clears legend pins, then leaves the theater. Stations and the ‹ Play › buttons are clickable. Page API: `stage.scene` implements `ExplainerApi` (`go(i)`, `next()`, `prev()`, `play()`, `step`, `stepCount`, `focusTag(id | null)`).

**Bench** (the Bench button, or `b`): the viewer can drag any element the current step shows. A moved element keeps its new place on every step. This is the viewer's override, stored per explainer (`localStorage`, key `karyo:explainer:<id>`). On release the group frames and the camera glide to fit, and "Reset layout" (shown in Bench once something has moved) returns to the spec's layout. Outside Bench the plate is read-only.

## Components

A component is a folder `<name>/` with three files:

- **`component.json`**: `{ "name", "description", "version", "props": <JSON Schema object>, "size"?: { "w", "h"? }, "motion"?: ["appear","emphasize","count","draw"], "example"?: { …props } }`. `props` is how the validator checks elements, so give it `required`, `additionalProperties: false` and `default`s. `example` must validate: tests and the CLI render it. A prop that holds a picture is marked `"format": "image"` (as `image` and `figure` mark `src`): only those are inlined as data: URIs when the spec is bundled, so text that happens to end in `.png`, such as a file name in a file tree, stays text. A prop named `src` with no `format` is treated as an image too.
- **`template.html`**: real HTML in the template language below. Start from the engine classes (`pl-card`, `pl-label`, `pl-title`, `pl-chip`, `pl-code`, `pl-mono`, `pl-muted`) so every theme works.
- **`style.css`**: scoped by the loader (see below). Theme tokens only (`var(--pl-bg|fg|muted|line|accent|accent-2|ok|card|card-border|radius|font|font-display|font-mono)`, `color-mix()` of them). **No transitions or animations**: the engine owns time. The validator warns about them, about hard-coded colours and about remote `url()`s.

Scaffold one with `scaffoldComponent(dir, name)` (the CLI wraps it).

### Template language

```
{{prop}}                 escaped text (arrays join with ", "; objects render nothing)
{{{prop}}}               markdown-lite: escaped, then paragraphs, "- " / "1. " lists, **bold**, *italic*, `code`, ==mark==, [text](https-or-relative-url)
{{svg prop}}             an inline <svg> string, sanitized (no <script>, on* handlers, <foreignObject>, javascript: urls)
{{a.b}}                  a nested value
{{#each items}}…{{this}} {{this.x}} {{@index}} {{@number}}…{{/each}}
{{#if prop}}…{{else}}…{{/if}}     {{#unless prop}}…{{/unless}}     {{! comment }}
{{#has prop}}…{{else}}…{{/has}}   is set: true for any value but a missing one or null (0, false and "" count)
```

Inside `{{#each}}`, a bare name resolves against the current item first, then outwards to the element's props. Falsy values are `false`, `null`, missing, `""`, `0` and `[]`, so a number that may be 0 belongs in `{{#has}}`, not `{{#if}}`. A malformed template (unclosed block, stray `{{else}}`, unknown tag) is a validation error that gives the line number.

### Engine hooks (attributes in a template)

| attribute | effect |
|---|---|
| `data-k-num="prop"` | the element's text is `prop`, counted (see **count**). `data-k-decimals="2"` fixes the decimals (default: as many as the values have). `data-k-group` (not `="false"`) adds thousands separators from 1,000 up. |
| `data-k-scale="value/max"` | sets `--k` = value / max (0..1, tweened) on the element: drive `transform: scaleX(var(--k))`. Either side may be a prop or a number (`value/100`). |
| `data-k-draw` | on an SVG shape: drawn on when its element appears (the engine sets `pathLength="1"` and the dash offset). |
| `data-k-chart="kind"` | the element is drawn as a chart (`line`, `bars`, `donut`, `sparkline`) from the element's props (see Charts). |
| `data-k-code` | on a `<pre>` holding code: `data-lang` (py, go, ts; others tint like ts), `data-start` (first line number) and `data-focus` ("2, 3") → numbered lines with a light keyword/string/comment tint and lit focus lines. |

### CSS scoping rule

Every selector in `style.css` is prefixed with `.kc-<name> ` (the element's root, which also has `.kx-el`): `.title` → `.kc-name .title`. `:host` is the root itself: `:host` → `.kc-name`, `:host(.is-lit)` → `.kc-name.is-lit`, and a leading `&` likewise (`&:hover` → `.kc-name:hover`). `@media` / `@supports` / `@container` / `@layer` blocks are scoped inside. `@keyframes`, `@font-face` and `@import` are dropped. The root has an explicit width and height (see `at`), so let the component's own box fill it (`height: 100%`) when it draws a card. `url(./file.png)` in a component's CSS is inlined when bundled.

### Built-ins (`components/`)

| name | props (required in bold) | notes |
|---|---|---|
| `card` | **title**, body (md), kicker, icon (≤ 4 chars) | w 280 |
| `text` | **md**, size sm/md/lg/xl, align | no frame; w 360 |
| `callout` | **md**, tone note/warn/ok, title | tinted, with a coloured edge; w 340 |
| `code` | **code**, lang, focus [line numbers], start, title | uses `data-k-code`; w 520 |
| `image` | **src**, **alt**, caption, frame | data: URI or path relative to the spec; w 360 |
| `metric` | **label**, **value** (number), unit, prefix, delta, tone plain/up/down, decimals, grouping | value counts; w 240 |
| `table` | **rows** [[…]], columns, caption | w 420 |
| `list` | **items** (md), ordered, title, frame | w 320 |
| `chip` | **text**, tone plain/accent/warn/ok | natural width |
| `kv` | **pairs** [{k, v}], title | w 300 |
| `quote` | **text**, cite | w 420 |
| `figure` | svg or src (one required), alt, caption | `data-k-draw` paths draw on; w 360 |
| `bar` | **value**, max (100), label, unit, prefix, decimals, tone, grouping | grows via `data-k-scale`; w 360 |
| `line` | **x**, **series** [{id, label, category, values}], area, labels, zero, min, max, unit, prefix, format, decimals, annotations, title, caption, summary | a chart; 720 × 420 |
| `bars` | **x**, **series**, stacked, orient vertical/horizontal, labels, min, max, unit, prefix, format, decimals, annotations, title, caption, summary | a chart; 720 × 420 |
| `donut` | **slices** [{id, label, value, category}], total, unit, prefix, format, decimals, title, caption, summary | a chart; 560 × 300 |
| `sparkline` | **values**, label, value, unit, prefix, decimals, format, area, category, zero, min, max, frame, summary | a small chart in a row; w 380 |

### Charts

`line`, `bars`, `donut` and `sparkline` draw charts as SVG inside the plate, with no chart library. The data lives in the element's props and the component schema checks it; the validator adds the checks a schema can't (a series with fewer values than `x`, an `x` value twice, a callout at an `x` that isn't there, a category nobody declared), each with a hint.

```jsonc
{ "id": "usage", "type": "line", "props": {
    "title": "Water used each month",
    "x": ["Jan", "Feb", "Mar", "Apr", "May", "Jun"],            // labels, numbers, or ISO dates ("2025-03") for a time axis
    "series": [
      { "id": "garden", "label": "Garden", "category": "outdoor", "values": [2, 3, 6, 11, 15, 18] },
      { "id": "house", "label": "House", "values": [9, 9, 8, 9, 8, 9] }
    ],
    "unit": "m³",
    "annotations": [{ "type": "line", "y": 10, "label": "Typical" }]
} }
```

- **Which chart.** `line` for change over time or any ordered x, several series at most four or five. `bars` to compare categories: `stacked` when the totals matter, `orient: "horizontal"` when the names are long or there are many. `donut` for parts of a whole, six slices or fewer (for close values, bars read better). `sparkline` for a trend beside a number, with no axes, sized to sit in a column next to metrics or cards. A single number is a `metric`, not a chart.
- **Colours** come from the spec, never from props. A series (or slice) with a `category` takes that category's colour and label; the others take the category colours in the order they first appear in the element, across all steps, so a series keeps its colour when others come and go. Text is always in the theme's ink, never in a series colour. Two or more series get a legend; up to four lines also get their last value at the end. Categories that only charts use still count as used. Hovering or pinning a category in the legend strip lights its series (or slices) inside each chart that shows it this step, fading the chart's other parts in place of the step's own part emphasis; a chart that shows none of it fades with the other elements.
- **Numbers**: `unit` follows the value (a word such as `kWh` with a space and as the value axis's title; `%` or `°C` attached). `prefix` goes before (`$`). `format` is `number` (default), `percent` (0.25 shows as 25%) or `compact` (12,400 as 12.4K). Without `decimals`, values print at the data's own precision. The value axis starts at zero for bars, and for lines unless `"zero": false` asks it to fit the data (a sparkline fits its data unless `"zero": true`); `min` / `max` fix it. Ticks are round numbers; dates are UTC, with month and year ticks.
- **Annotations** (`line`, `bars`): `{ "type": "line", "y": 300, "label": … }` is a reference line, `"x": "Jul"` a vertical marker; `{ "type": "band", "y": [a, b] }` or `"x": ["Jun", "Aug"]` shades a range; `{ "type": "callout", "series": "garden", "x": "Jun", "label": "Peak" }` rings a point and boxes a note beside it (without `label`, the value). Give an annotation an `id` and a later step can move it: it glides.
- **Steps.** `set` new data (a whole `series`, `slices`, `values` or `annotations` list, or a switch such as `stacked`) and the chart tweens to it: bars grow and shrink, lines move point by point, a series that arrives draws on and one that leaves retracts, arcs resize, the value axis rescales while its old and new ticks crossfade, and a switch between grouped and stacked bars slides. Parts are named `element/part` in `emphasize` and `dim`: a series or slice by its `id` (else its `label`), an x position by its value as written (`"usage/Mar"`), one point as `"usage/garden@Mar"`. Emphasizing a part keeps it at full strength and fades the rest of the chart (a line chart marks an emphasized x with a column and the values there; a donut pulls the slice out and shows its share in the middle); the chart itself gets no outline and `dim: "others"` leaves it alone. A `dim` entry fades just that part. Like `emphasize`, it lasts one step.
- **Accessibility.** The SVG is hidden from screen readers; beside it each chart carries its numbers as a visually hidden table, and a sentence that says what is plotted, the range and the extremes, what the step highlights and what the annotations mark. `summary` replaces the sentence. With reduced motion (or the motion dial at 0) a chart lands on its new data at once. Some light-mode category colours are under 3:1 against white, so a chart never relies on colour alone: the legend, the end labels, the tooltip and the table carry every series by name.
- **Hover** (on a live page, never in stills or exports): a line or sparkline shows a crosshair and every series' value at the nearest x; a bar or a slice shows its own value.
- **Size**: charts use their component's size unless `at` says otherwise; lint reports a chart label that sits outside the chart or on top of another label, so a crowded chart shows up before anyone sees it. On a board of several charts the camera scales them down: two side by side read well, four start to get small.
- **Your own chart component**: a template that holds `<div data-k-chart="line|bars|donut|sparkline"></div>` gets the chart drawn into that element from the element's props, so a custom component can frame a chart its own way (the element needs a height: set `size.h` or give the div one in CSS).

### Library resolution

Components are looked up in this order. The first match wins, and later copies are reported as **shadowed** (a bundle warning names both):

1. `<spec dir>/components/` (source `project`), then any `extra` folders the caller passes (also `project`)
2. `$KARYO_COMPONENTS`: folders separated by `:` (source `env`)
3. `~/.adenine/karyo/components/` (source `adenine`)
4. the repo's `components/` (source `builtin`)

A custom component (any name that isn't a built-in) must be listed in `uses`, so tools can install it together with the explainer. Leaving it out is a warning.

**Kit kinds are components too** (docs/KITS.md). A kit's node kind (`karyo/kits/<kit>/kinds/<kind>/`, found from the spec's folder upwards, then `$KARYO_KITS`, `~/.adenine/karyo/kits` and the built-in kits) joins this path at its kit's place, so an explainer can use it as an element `type`: its props are the kind's fields, it is drawn in a card frame at the kind's size, and its template's `node.*` is the element (id, label, category, tags). `loadLibrary({ kits: false })` leaves kits out.

## Starting points

- **`karyo new <path> --template blank|steps|graph`** writes a spec to start from (default `steps`): one card, a four-step `flow` of cards, or a four-step `graph`.
- **A custom component:** `karyo component new <name>` scaffolds a folder (`component.json`, `template.html`, `style.css`) with a title, a counting number and a note, ready to edit. A trick worth knowing: the template language can't do arithmetic, and `data-k-scale` is a plain `value/max`, clamped to 0..1. So a bar centred on zero, such as a temperature reading, is two halves: `value/max` grows right from the zero mark and `value/min` grows left, each half's width set by `flex-grow: calc(-1 * {{min}})` / `{{max}}` in an inline style. A project-scoped component sits next to the spec, in `components/`, and is listed in `uses`.

In a `free` layout every position is yours. Render once, read the element sizes (the stills show them), then place the elements so rows align and links have room for their labels. A rect `focus` is an exact fit: give it the view's aspect, or the camera fits the tighter side and shows more than you meant. On a 1600 × 900 stage with a summary line, the view is 1504 × 481 with bottom narration and 1064 × 654 with side narration.

## Modules (for tools)

| module | exports |
|---|---|
| `src/explainer/types.ts` | `ExplainerSpec`, `ElementSpec`, `LinkSpec`, `StepSpec`, `LayoutSpec`, `ComponentMeta`, `BundledComponent`, `LibraryComponent`, `Library`, `LibraryLike`, `Issue`, `ExplainerBundle`, `BUILTINS`, `SPEC_VERSION` |
| `src/explainer/validate.ts` | `validateSpec(spec: unknown, lib: LibraryLike): Issue[]` (pure; bun, node, browser), `explainerSchema`, `withDefaults` |
| `src/explainer/library.ts` | `loadLibrary(opts?: { specDir?, extra?, adenineDir?, builtinDir?, env? }): Promise<Library & { problems }>`, `scaffoldComponent(dir, name): Promise<string>`, `BUILTIN_DIR` |
| `src/explainer/template.ts` | `renderTemplate(tpl, props): string`, `parseTemplate`, `mdLite`, `mdInline`, `sanitizeSvg`, `scopeCss(css, name)`, `cssProblems(css)`, `tweenProps(tpl)`, `esc` |
| `src/explainer/bundle.ts` | `bundleSpec(specPath, opts?): Promise<{ spec, components, issues }>` |
| `src/explainer/build.ts` | `buildHtml(specPath, outFile, opts?): Promise<{ file, bytes, issues, title, target }>`, `renderHtml(specPath, opts?)` (the page as a string), `ensureRuntime()`; `opts.target: 'artifact'` builds for a Claude artifact frame ([ARTIFACTS.md](ARTIFACTS.md)) |
| `src/explainer/scene.ts` | `explainerScene(bundle: { spec, components }): SceneClass` (browser), `ExplainerApi` |
| `src/explainer/standalone.ts` | the runtime entry: `KaryoExplainer.mount(el, bundle, opts?)`, `.api(stage)`, `.setMotion(k)` |
| `src/explainer/resolve.ts`, `layout.ts`, `jsonschema.ts` | step resolution, board layouts, the JSON Schema subset checker |
| `src/explainer/chart/` | the chart layer, pure except `dom.ts`: `scale.ts` (nice ticks, linear, weighted bands and points, UTC date ticks), `format.ts` (numbers, percent, compact, dates; no locale), `data.ts` (props → frames, part names, `chartIssues`), `tween.ts` (`lerpFrame`, `birthFrame`), `render.ts` (`renderChart(frame, w, h, measure)` → SVG and hover geometry, `CHART_CSS`), `a11y.ts` (summary and table), `dom.ts` (`ChartView`: the frames on screen, hover, lint) |

Issues are `{ path: <JSON pointer into the spec>, level: 'error' | 'warn', message, hint? }`.

The runtime for `buildHtml` is a Vite IIFE build of `standalone.ts` (engine, three.js and CSS, ~0.6 MB), cached in `dist/runtime/` under a hash of its sources. `vite build` empties `dist/`, and the next `buildHtml` rebuilds the runtime (≈0.3 s).

States for stills and lint are `step-1` … `step-N`. Each is applied as if the viewer had navigated there from step 1.
