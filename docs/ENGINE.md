# Engine guide (for scene authors, human or Claude)

Karyo plates are short explainer animations built from **real HTML elements** — cards, code, text, chips — animated by a deterministic clock, plus a **three.js fx layer** for what the DOM can't do well: wires between elements, outlines that draw themselves, sparks, soft light, and 3D. Every frame is a pure function of time, so a plate can be scrubbed, stepped, looped, screenshotted or exported to video and always shows the same frame.

## Running things

- Dev server: `bunx vite` → http://localhost:5180 (gallery of every scene, with the ⚙ theme menu). `?scene=<id>` shows one scene filling the window (the theater's fit; `&fill=0` keeps it in the page column), `&t=3.2` opens it paused at a time, `&theme=adenine-jade` (any theme id), `&mode=dark|light` (neutral in that mode). See Themes for what wins.
- **Stills — the main way to check your work; then LOOK at the PNGs with the Read tool:**
  `bun scripts/render.ts stills --scene <id> --t 1.2,3.4,6`
- Contact sheet of the whole clip: `bun scripts/render.ts sheet --scene <id> [--n 12 | --times a,b,c] [--cols 4]`
- Layout lint (elements leaving the stage, clipped text, scene errors): `bun scripts/render.ts lint [--scene <id>]`
- Video: `bun scripts/render.ts video --scene <id> [--fps 30] --out out/<id>.mp4` (`.gif` / `.webm` also work)
- Renders with no theme flag use adenine, the default. Add `--mode light`, `--mode dark` or `--theme <id>` (any theme id, e.g. `--theme adenine-periwinkle`) to check the others. Check at least one other theme before calling a scene done.
- Typecheck: `bunx tsc --noEmit -p tsconfig.json`
- The render script starts its own no-live-reload Vite server unless `--url` points at one. **A new scene file needs a server restart** when live reload is off. Browser: `CHROME_PATH=/path/to/chrome` or the installed Google Chrome.
- The render script prints `SCENE ERRORS` and browser errors — read them.

## Writing a scene

One file `src/scenes/<id>.ts`, default-exporting a class that extends `Scene`. It is picked up automatically (files starting with `_` are ignored, so use `_something.ts` for shared helpers).

```ts
import { Scene, type Frame, type Fx, wire, prog, ease, stagger, outline } from '../engine';

const T = { cards: 0.3, link: [1.2, 1.8] } as const;           // cue sheet, seconds

export default class Example extends Scene {
  static title = 'Client talks to server';
  static duration = 5;           // seconds
  static width = 960;            // logical stage px (default 960×540); the stage scales to fit
  static height = 540;
  static poster = 4.5;           // frame shown when the viewer prefers reduced motion
  static fx = 'under' as const;  // 'under' | 'over' | 'both' — which WebGL canvases you draw on

  build(dom: HTMLElement) {      // once: create the HTML (or adopt markup the page supplied)
    dom.innerHTML = `
      <style>.card { position: absolute; top: 200px; width: 200px; }</style>
      <div class="pl-card card" id="a" style="left: 80px">Client</div>
      <div class="pl-card card" id="b" style="left: 680px">Server</div>`;
  }

  update(f: Frame) {             // every frame: animate the HTML
    ['#a', '#b'].forEach((sel, i) => {
      const k = stagger(f.t, i, T.cards, 0.15, 0.5, ease.outExpo);
      this.$(sel).set({ opacity: k, y: 20 * (1 - k) });
    });
    this.$('#b').classes['is-lit'] = f.t > T.link[1];
  }

  draw(f: Frame, fx: Fx) {       // every frame, after layout: draw fx anchored to the HTML
    const w = wire(this.$('#a').at('right', 0.5, 4), this.$('#b').at('left', 0.5, 4), { kind: 'curve' });
    fx.under.lines.path(w, { to: prog(f.t, T.link[0], T.link[1], ease.inOutCubic), color: 'accent', width: 2, glow: 2 });
    outline(fx.under.lines, this.$('#b'), { progress: prog(f.t, 1.8, 2.3) });
  }
}
```

### The frame, in order

1. Every Node goes back to rest (x/y 0, scale 1, opacity 1, no vars/classes/text overrides).
2. `update(f)` sets Node properties.
3. The engine writes only what changed to the DOM.
4. The engine measures every Node's layout box (after text changes have reflowed).
5. `draw(f, fx)` draws the fx layers, reading positions from Nodes.
6. The fx canvases render.

### Rules

- **Deterministic.** Output must be a pure function of `f.t`. No `Math.random()` (use `hash(...)`, or `seeded(seed)` in `build()`), no `Date.now()`, no state carried between frames, no counting calls. Anything that should be "still there" at time t must be recomputed from t.
- **Set, don't accumulate.** Because Nodes reset every frame, write `node.opacity = k`, never `node.opacity -= 0.1`.
- **No CSS transitions or keyframe animations** inside a plate (the stylesheet disables them): the engine owns every change over time. Hover styles are fine.
- **Transforms belong to Nodes.** A Node writes `transform` on its element; don't also set `transform` in your CSS for that element. Transforms are applied around the element's centre (`transform-origin` default). Use a wrapper element if you need both.
- **Every element you animate or anchor to becomes a Node** via `this.$(selector | element)`. Nodes are created on first use and are positioned (`position: relative` if they were static) so measurement is exact.
- **Lay out in stage px.** The stage is a fixed logical canvas (default 960×540) scaled to fit its container, so absolute positioning in px is fine and predictable; flex/grid inside cards is fine too. Keep text ≥ 12px at 960 wide.
- **Scene CSS** goes in a `<style>` inside `build()`. Use the theme tokens (`var(--pl-accent)` …) and the engine classes, never hard-coded colours, so all themes work.
- **Colour in fx** is a theme token name (`'accent'`, `'line'`, `'fg'`, `'muted'`, `'ok'`, `'accent2'`, `'card'`, `'bg'`) or an sRGB triplet. Prefer tokens.
- Look at stills in the default (adenine) **and** the neutral light theme (`--mode light`), plus `--mode dark` or another theme (`--theme adenine-periwinkle`).
- **Deliberate clipping** passes lint: truncate text with `text-overflow: ellipsis`, and mark a scrolling region (a list that moves under a fixed window) with `data-pl-clip`; its children aren't checked against the stage edges, the region is.

## Interactive plates

A clip plays; an **interactive plate rests**. It shows a settled picture you can touch (cards to open, drag, drill into) and animates only the change you asked for. The rules:

- **Motion marks a transition of meaning, never a payload tick.** Open, step, drill, replay — nothing else moves. No loops, no idle drift.
- **One layout per state, however you got there.** Motion decides how you arrive, never where you land: with the motion dial at 0 or `prefers-reduced-motion`, every transition lands on its end state at once, and it's the same end state.
- **Nothing appears from nowhere, nothing leaves the screen, Escape is the literal reversal.**
- **The rest state is the end.** A flow at rest shows the whole trace, not an empty map.

Mechanics: `static interactive = true` and `static duration = 0.6` (the length of **one transition**, not a clip). The plate rests at `t = duration`; there is no transport bar and no autoplay.

```ts
export default class Board extends Scene {
  static interactive = true;
  static duration = 0.6;
  private morph = new Morph();                       // src/engine/interact.ts
  private state = { open: null as string | null };

  build(dom: HTMLElement) {
    dom.innerHTML = `…cards…`;
    draggable(card, this.stage, { onClick: () => this.open(card.id), onMove: ({ dx, dy }) => { /* move at rest */ this.stage.redraw(); } });
    this.morph.snap(this.targets());                  // first layout: no transition
  }
  open(id: string) { this.state.open = id; this.morph.retarget(this.targets()); this.stage.transition(); }
  update(f: Frame) {
    this.morph.progress(ease.outCubic(f.t / f.duration));   // t runs 0 → duration during a transition
    for (const [key, v] of each card) this.$(`#${key}`).set({ x: v.x, y: v.y, opacity: v.o });
  }
  onKey(e: KeyboardEvent) { if (e.key === 'Escape') { /* step back */ return true; } return false; }
  keys() { return this.state.open ? [{ keys: 'Esc', does: 'close the card' }] : []; }   // the `?` card ("Key help")
  getState() { return this.state; }
  setState(s: unknown) { /* apply, then this.morph.snap(...) or retarget from the default view */ }
  states() { return [{ name: 'overview', state: {…} }, { name: 'open-checkout', state: {…} }]; }
}
```

- `stage.transition()` replays 0 → duration once (speed from the page's **motion dial**, `setMotion(k)`; 0 = land at once). `stage.redraw()` re-renders the current frame (hover, a drag at rest). `stage.toStage(clientX, clientY)` and `stage.zoom` convert pointer coordinates to stage px; both include the viewer's zoom and pan ("Zoom and pan" below), so use them for every pointer-to-stage conversion (drag deltas ÷ `stage.zoom`, hit tests, drop points) and nothing else needs to know about zoom.
- **Still a pure function**: of (state, what was on screen when the transition began, t). `Morph` keeps the "from" and "to" values per key; `retarget()` starts from what's on screen, so interrupting a transition never jumps.
- Real DOM events are fine (clicks, hover, pointer drags via `draggable()`, focusable buttons); keys arrive through `onKey` when the plate has focus, and `keys()` lists them for the `?` card ("Key help" below). **Hover is state at rest**: set a field, `redraw()`, never a CSS transition.
- **Checkable by looking**: `states()` names representative states. `render.ts stills --scene <id> --state <name> --t 0.3,0.6` shows a transition (from the default view into that state) and its rest; `lint` checks every named state mid-transition and at rest; `list` prints the states. `setState()` should apply a state as if the viewer navigated there from the default view.

### Bench: plates you can rearrange

A plate is read-only by default. **Bench** is a mode, like Theater, in which the viewer rearranges it. A scene opts in with `static bench = true`. The Stage then shows a **Bench** button next to Theater, and the `b` key toggles it. Bench composes with Theater: you can arrange a plate while it fills the window.

- `stage.bench(on?)` toggles or forces it. `stage.inBench` reads it. The plate root carries the class `is-bench` (use `.plate.is-bench …` in scene CSS, e.g. `cursor: grab`).
- The scene hook `setBench?(on)` runs when the mode changes, before the frame is redrawn. Drop a half-finished drag or a pick there when Bench closes.
- `static benchOpen = true` starts the plate in Bench. A page overrides it per mount: `mount(el, Cls, { bench: false })`.
- In Bench, what can be moved drags (`draggable()` with an `onStart` that returns early unless `stage.inBench`). Positions persist per plate in `localStorage`, and a "Reset layout" button (shown only in Bench) returns to the automatic layout. Outside Bench, a press that moves is neither a drag nor a click.
- The model plates draw the background `grid` in Bench and `dots` outside it, so the mode can be read off the plate itself.
- **Groups drag whole.** On boards with group frames (the structure board, trace boards), a group's frame drags every card in it together: grab its label, its border or the empty area inside (a grab cursor and a faint accent frame show it; `is-gdrag` while moving). Wires re-route live. The drop writes each member's position into the same per-card layer a card's drop does, so reload, Reset layout and "Save as team layout" carry it; a splice keeps it in the splice. The move is clamped as a unit (every card stays where one card's drag may go) and may overlap other cards, as a card's drop may. A press on a wire running through the frame is the wire's (hover, pin, a splice's insert), as are the ⤢ button and a splice gesture in progress (placing a node, connecting); a click inside the frame that never moves is an ordinary click. Groups are flat (no nesting).
- Where it's used: the structure board (opens in Bench unless `benchOpen: false`; cards drag, ⌥/⇧-click picks cards, "+ tag" makes a tag, "Save as team layout" in dev), trace boards (map cards drag, their wires re-route), explainers (elements drag at the current step and keep that place on every step until reset). Tours have no Bench.

### Legends: categories and tags

The structure board, trace boards and explainers share a legend strip (`src/model/legend.ts`): **Categories** (a swatch, a name, a count) and **Tags** (a name, a count). On model plates, categories and tags come from `MNode.category` / `MNode.tags`, and tags derived at view time are added: `⚠ warnings`, `declared, not seen` (only when the model holds a recorded run: with none, `hasRuns` in model.ts, every wire is drawn solid, the line key has one row, "declared in the code", and nothing says "not seen"), `seen, not declared` (`seen, not in the code` once static analysis contributes relationships), `not exercised` and `partly exercised` after a recording that watched whole packages (docs/MODEL.md "Coverage"), one per group (`in <group>`, a nested group as `in Parent / Child`), and one per language when there is more than one. A card that folds others (docs/MODEL.md "Fold") has a `parts` section listing them, each marked ran or not exercised. The structure board adds the team's tags (`karyo.layout.json`) and your own. Explainers take `categories` / `tags` from the spec.

- Each card shows its category as a coloured left edge (`data-cat="n"` on the element; `CATEGORY_CSS`).
- **Hover** an entry: its members light up, the wires between them light, everything else dims. This is instant: state at rest and `stage.redraw()`, no transition.
- **Click** pins an entry. That is a change of meaning, so it runs a transition. Several pins show their union. Click again to unpin. Esc clears the pins, innermost first: on the board, Esc closes a panel, then clears the pins, then goes up a level (the groups view) or drills out, then drops the picked cards.
- `focusTag(id | null)` on the board, trace board and explainer APIs pins exactly one entry (`hot-path`, `cat:store`, `warnings`, `group:billing` …), or clears all pins.
- Stills: the scenes' `states()` include `legend-pin-<name>` and `legend-hover-<name>` (the hover is part of the view state so it can be rendered).

### Group navigation: a level above the cards

A big structure board starts as a **map of its groups**, one card per group, and you go into a group to see its cards. Groups are the model's own (a node's `group`; nesting from a curation file's `groups[].parent`, docs/MODEL.md "Curation"); nothing else decides them. The pure part is `src/model/board-groups.ts`; the board (`src/model/board.ts`) draws each level with its usual machinery.

- **The overview.** One **group card** per top-level group: its name, how many cards (and subgroups) it holds, its categories as colour chips with counts, a few headline members (the most connected), and its inlets and outlets: `← App 5 · Billing 2` (who calls in, how many relationships) and `→ Data 12`, as many named whole as fit and the rest as `+n` (a count is never cut). Actors (callers from outside) sit beside them as themselves; cards with no group make an `other` group. Between two group cards runs **one wire per direction**, with the number of relationships it stands for on it (a badge at the wire's middle, or the nearest place along it clear of cards, group labels and other badges); its style is the most common solid verdict under it (any seen relationship makes it solid), else the most common. Hovering it says what it means: "12 calls from App into Data" (or "5 relationships from App into Data: 3 calls and 2 reads"), how they stand ("9 seen in recorded runs · 3 declared, never seen"), the pairs under it and the recorded calls along them. Everything else is the board as usual: the legend (its counts are the cards inside the level; hovering an entry lights the group cards holding its cards), pins, Bench (group cards drag; positions are kept per level), zoom and pan, the theater, key help.
- **Inside a group.** Clicking a group card (Enter on it, `l`, Jarvis "go into App") slides into that group's own scene: its direct cards, its subgroups as group cards, laid out for the window on their own. The neighbours outside it that connect to it sit at the edges as **stubs**, compact ghost cards: **inlets** (they call in) in a column on the left, **outlets** (they are called) on the right. A stub is what the closest level holding both shows: a group (`Core`, as a group stub) or, for a card of an enclosing group, that card. Clicking a stub **slides across** to it (a card stub opens on its own level with the cursor on it). A card inside opens as usual (panel, section view, the pinned inspector); its details list every relationship, inside the group or not, and a click on one outside goes there.
- **Up a level.** The header's breadcrumb ("All groups › Orders › Store", each crumb a button), `h`, or `Esc` once nothing else is open (Esc unwinds innermost first: a gesture, a wire card, the panel, the pins, then the level), or Jarvis "up a level" / "back".
- **The move.** A change of level is one transition (`stage.transition()`, so the motion dial applies and stills can stop half way), planned from what is on screen (`planLevel`): an item on both levels glides (a group card becoming a stub keeps its place and changes shape, never stretched); entering, the group card grows toward its scene and fades while its cards grow out of it and the rest of the overview rides a camera move past the edges; going up, the cards shrink back into their group card; across, the stub grows into its scene and the old group's cards shrink into its stub. The new level is laid out on its own and the plate refits (`stage.refit`), with what was on screen mapped into the new size so nothing jumps; nothing ever leaves the stage, even mid-move. The last level's wires fade with their cards.
- **When.** `auto` (the default): a board with 28 cards or more starts on its groups, when it has two groups or more to show (a single group with no subgroups has none); a smaller board starts on every card and behaves exactly as before (its stills are unchanged). The **Groups / All cards** toggle in the plate's actions row, or `g`, switches view at any time; "All cards" is the classic board, with its in-place drill (the rail). Force either with the plate option `start: 'groups' | 'cards'` (`boardScene(model, { start })`, a kit's board plate type's `start` option) or a curation file's `"start": "groups"` (the model's `start`); the plate option wins.
- **Drill.** In the groups view `drill(group)` enters the group (`drill(null)` goes up a level); in the cards view it is the in-place drill as before. The two never mix: the groups view has no rail.
- **Splices** work on every level: open one on the overview or inside a group and it remembers that view (the level and group, Groups or every card, the drill, the selection: the splice's `view`, docs/MODEL.md "Splices"); reopening it slides back there. The banner says where you are ("Splice · caching — in Orders › Store · proposals only …") and follows you as you move: the splice is over the whole model, the view is only where you are. A card placed on empty space inside a group joins that group; placed between, before or after cards, it takes their group as usual (inside a group the splice proposes, every new card joins it). Up a level, a group card says what is proposed inside it ("+1 proposed"); a wire that stands for several relationships is not a place to insert into (go into the group). The stack of splices compares the whole model, as before.
- **Proposed groups.** A splice can propose a group (the `group` op). Its card on its level is dashed and hatched like a proposed card, says "new group · 0 cards" with a `proposed` badge and its inlets and outlets; a stub of it is marked the same. Entering it shows its scene: its proposed cards, or, with none yet, a placeholder card ("No cards yet · say “add a card called …” or press n") that holds the group's relationship, with the neighbours it is attached to as stubs. The first card proposed into it takes that relationship over. In Bench, **+ group** (beside + node, on the groups view) asks for a name, then the next click says where it goes: empty space puts it on this level, a group card inside that group, a card makes it that card's outlet (the card calls into it). Dragging a card's handle onto a proposed group's card connects the card to the group (to its entry card); onto a group of the code it says to go into it. Rename and remove work on a proposed group (removing it takes its cards); combining and the stack of splices understand proposed groups (docs/MODEL.md "Combining splices").
- **Jarvis** finds a card anywhere: focus, open, show_details go to the level that draws it, highlight goes to the closest level holding all the cards named. `describe()` lists every card of the model and every group (nested ones as `Parent / Child`), not only what the level draws.
- **API** (`BoardApi`): `enter(group | null)` (null: the overview), `up()`, `groupView('groups' | 'cards')`, `level()` → `{view, available, at, path, groups, cards, stubs: [{id, label, side, group}]}`. State: `nav: 'groups' | 'cards'` and `at` (the group entered, null for the overview); setState without them keeps the start view and goes to the level of the open card. States for stills and lint: on a board that starts on its groups, `overview`, `group-<path>` for each group (entered from the overview: mid-transition is the slide), `cards`, and the usual ones (a card opens on its level; the wire states hover the overview's busiest group wire; `splice-<id>-in-group`); on one that starts on every card, `groups` and `groups-<first group>`.

### Stack view: an ordered list of slices

`stackView(slices, o?)` (`src/model/stack.ts`) is one small interactive plate for an **ordered** list of pictures of the same thing: versions over time, layers, lanes, environments, zoom levels. Each slice is `{ id, title, subtitle?, model }` (a Karyo model); `o` is `{ title?, summary?, noun? }` (`noun` names a slice in the mode line and tooltips: `commit`, `layer` …; default `slice`). The view knows nothing about git or any domain.

- **Depth always means the order, never decoration.** The plate rests on the **last** slice (the rest state is the end: the latest version, the deepest layer). The current slice lies flat and readable, drawn like the structure map (cards, wires by source, the legend). The other slices sit behind it as thin stacked edges, each with a tab (`n · title · +a −r ~c`); how far an edge rises says how far that slice is from the current one, and the tabs run left to right in slice order. Nothing leaves the screen, and text is never read in perspective: tabs, header and legend are flat HTML above the 3D sheets, and at rest the current sheet leaves the 3D renderer altogether (Space3D's `flat` pose: plain DOM at the exact place its face-on pose projects, so its text is crisp and switching never jumps). It goes into 3D only for the length of a slide or while the stack is fanned out.
- **Moving:** ←/→ (and `j`/`k`, Home/End, `1`–`9`, a click on a tab or on a sheet's edge) slides to another slice: the stack shifts in depth, the new slice comes forward and flattens. **Fan out** (the button, or `o`) tilts the whole stack into an exploded 3D overview, slice 1 at the top, cards that changed outlined; ←/→ still picks, a click on a tab or sheet (or Enter) opens that slice flat, and `o` or Esc collapses. Motion only on these gestures; with the motion dial at 0 every change lands at once. Theater (and `?scene=<id>`, which fills the window) relays the stack out for the window with `fit` (below, "Theater"): the group bands of the shared layout move into shelves side by side for a wide window (`arrange.ts`, over the union of every slice's nodes, so a node still sits at one place on every slice), the sheets widen, the tabs and the overview are refitted, and the foot (legend, mode line) stays docked along the bottom. There is no Bench (slices are pictures, not arrangements).
- **Comparison:** one layout is computed over the union of every slice's nodes, so a node sits at the same place on every slice. The legend (`src/model/legend.ts`) adds derived entries per slice, against the previous one: **added here**, **removed here**, **changed here** (a node's kind, label, group, category, tags, sources, summary or language; a relationship's kinds, its sources, e.g. declared → declared + observed, or whether recorded runs counted it). Identity is the model's (docs/MODEL.md "Identity"): a node is its id, a relationship is its ordered pair, one wire per pair styled by its verdict. Every slice goes through `normalize` first, so a model that repeats a pair (a declared `reads` and an observed `calls`) has one relationship there and the duplicate is not reported as a change. What disappeared is drawn as a faint ghost (dashed card, dotted wire) on the slice where it went away, and every changed wire carries a glyph (`+`, `−`, `~`; its tooltip says what changed). Hovering an entry lights it at once and the mode line says what it stands for; clicking pins it (pins survive a slide); Esc clears the pins.
- **Options for a host** (a stack of splices uses them): `rest` (the slice the plate rests on, default the last), `open: {label(i), hint?(i), run(i)}` (a click on the current sheet, Enter or a toolbar button opens that slice somewhere else), `buttons` (more toolbar buttons), `diff` (what a slice is compared with: `previous`, the default, draws the neighbour diff above; `none` drops it, with its + − ~ glyphs, badges, tab counts, ghosts and legend entries, for slices whose own `marks` already say what they change against one baseline) and `words` (what the marks mean, for their legend key: `{proposed, removed, changed}`). A slice may carry `marks`, `about`, `badge` and `warning` ("Stack of splices" below); hovering a tab then shows its `about` lines in a card beside it (state `tab`).
- **API** (`stage.scene as unknown as StackApi`): `go(i)`, `next()`, `prev()` (keep the overview if it is open), `fan(on?)`, `focusTag(id | null)` (`diff:added`, `diff:removed`, `diff:changed`, `cat:<c>`, a derived id, `warn:<n>` a warning's item), `showWarning(k | null)` (pin the card of the current slice's warning item k, 0-based). State: `{ cur, fan, pins, hover, tab, warn, warnPin }`. `states()`: `slice-1`, `slice-last`, `fanned`, plus `diff-pin-added` / `diff-pin-removed` / `diff-pin-changed` / `diff-hover-changed` when the last slice has that kind of change, and `warning-card` when a slice has warning items; each is applied as if navigated from the rest state (the last slice).
- Data and diff are pure functions in `src/model/stack-diff.ts` (`stackData`, `diffModels`, `diffMembers`, `drawnWires`, `unionModel`).

**A project's history** is one use: `bun scripts/stack-from-git.ts <model.json> [--last N | --commits a,b,c] [--full] -o <out.json>` (or `just stack-history <model> <out> [flags]`) reads the file at each commit that touched it with `git show` (oldest first), following renames and moves (`git log --follow`) and reading each commit's copy under the name it had then. `--commits` keeps the order given and reads the file's current path in each, skipping a commit that doesn't have it. A commit whose copy isn't JSON or isn't a version-1 model is skipped too. It writes `{ source, slices: [{ id: sha, title: subject, subtitle: "sha · date", model }] }`. Slices keep what a map draws (nodes without their code excerpts, edges, checks); `--full` keeps flows and tours too. A scene then draws the file:

```ts
import history from '../../out/history.json';   // just stack-history karyo.model.json out/history.json --last 5
import { stackView, type StackSlice } from '../model/stack';
const h = history as unknown as { source: string; slices: StackSlice[] };
export default stackView(h.slices, { title: 'The checkout service, commit by commit', summary: `History · ${h.slices.length} commits of ${h.source}`, noun: 'commit' });
```

Slices needn't come from git: the `layers-stack` scene builds four small models by hand (one page load at the HTTP, TLS, TCP and IP layers) over the same cast of nodes.

### Theater: fitting the window

In the theater (and with `fill`) the whole plate is visible, whatever the window's shape: the Stage scales it to fit both dimensions of the space it has (the window, less a 16 px margin and the actions row). A plate whose content can be rearranged uses the space better by laying itself out for it first:

```ts
/** The space the plate may fill (CSS px), or null when it goes back to the page. Return the logical size you
 *  laid yourself out for, or nothing to keep your size. `o.chrome`: see "Chrome floor" below. */
fit?(space: { w: number; h: number } | null, o?: { chrome: number }): { w: number; h: number } | void;
```

- The Stage calls `fit(space)` on entering the theater and on every window resize there, and `fit(null)` on leaving; it then resizes its logical canvas (`stage.resize(w, h)`: frame, viewport aspect, fx canvases, a re-measured frame) and scales it to fit. `Frame.W/H` and `stage.W/H` follow.
- **Deterministic**: the layout must be a pure function of (the content, the space). Snap to it (no transition): the window changed, not the meaning.
- Lay out in the new size's px as usual; dock what belongs at an edge (a legend, a mode line) to that edge (`bottom: …` rather than a `top` computed from the default height), so it's never pushed off.
- The structure board uses it (`src/model/arrange.ts`): its group bands keep their inside (cards full size, in their columns and rows) and move into shelves side by side for a wide window. Candidates are scored by how large they can be drawn and by how many wires would run behind a card (routed as the board draws them); the default wins a near tie, so a window shaped like the page keeps the page's picture. The legend stays docked along the bottom, and no wire runs into it: a back edge whose loop would dip below its top (as drawn) runs as a bracket under the cards between its ends. A viewer's own Bench positions still win over the arrangement; Reset returns to it. The Stack view does the same with its sheets (see "Stack view"). **Trace boards** do it with their map: its group bands are arranged by the same `arrange` for the window's shape, right of the request column, under the header and above the legend and mode line (docked along the bottom), each given the room the chrome floor draws it at, so a wide window gets a wide map and nothing covers a card at any window size; on the page the map is laid out as before. A request named in the list is what the recording said its root did, else (under a root the project left undeclared: a dispatcher, a framework's entry) the first card with a category it reached, else its root's card. Selecting another request or the whole trace while zoomed in goes back to fit. **Tours** lay themselves out at the space's own shape, drawn at least at their designed size (a larger window draws the page's layout larger): code beside the text and diagram in a wide window, the diagram under the code when the window is too low for the text, code, text and diagram stacked in a tall or narrow one; the step rail is laid out `1/k` wide so the floor's boost makes it span the window, and the panels are placed with `chromeBoxFor` (below). A level of the structure board that is one band (the groups overview) may wrap its last columns into a second row when that is drawn larger and routes no wire behind a card. Explainers fit whole without a relayout.
- **Use the window's shape.** A plate with more than one way to lay itself out offers its candidates to `pickFit(space, candidates)` (`src/engine/fit.ts`): the one drawn largest wins, which is the one leaving the least of the window empty, and the first candidate (the plate's default) holds unless another is drawn more than 3% larger. `fitScaleOf(space, size)` is the scale a size gets, `fitWaste(space, size)` the share of the window it leaves empty. The structure board reserves room for its drill rail (every card outside the group drilled into); fitted to a window, the rail may wrap into up to four columns, and `pickFit` keeps the count that fits the window best, so a board with many cards is no longer forced tall (portrait) by its rail.
- **Room for the chrome.** `o.chrome` is how many times larger the chrome floor (below) will draw the plate's chrome at this fit. The Stage asks once with `{ chrome: 1 }` and, when that fit calls for a boost, again with it, so the plate can leave its edge bands that much more room: the structure board gives its legend `k ×` its height and starts its content lower by the header's extra depth, so no card is under the chrome at fit. A host page that sizes the plate itself calls `stage.fitScene(space)`, which does both passes (Jarvis does). The plate laid out with that room is drawn a little smaller, so the floor then boosts its chrome a little more than the room it left; `settleChrome(space, k, make, stage.chrome.boostAt)` (`fit.ts`) lays it out again until the two agree (the trace board and tours use it). `chromeBoxFor(drawn, W, H, k)` (`chrome.ts`) is where to lay out a lone chrome root so that the floor, boosting it k times, draws it at `drawn`: along an axis it spans, its margins are drawn k times larger; along any other it is scaled about the stage edge it sits at (`chromeSpans` says which). Keep content that doesn't reflow inside an inner clip (an `overflow: hidden` child at `inset: 0`), so the floor lays the root out narrower instead of scaling it whole.
- Check it without a window: `render.ts stills|lint --fit 1440x900` lays the plate out for that space first (export mode: no chrome floor, so `o.chrome` is 1). `dev/scripts/shot-fit.ts` measures a live page instead: the empty share of the window, the fit scale and the smallest chrome text on screen, in the theater's fill and in Jarvis, at each interface size.

### Zoom and pan: getting closer

Every interactive plate on a page can be zoomed and panned by the viewer (`src/engine/viewport.ts`, `stage.view`). It is **view state**, like a scroll position: the scene never sees it, a frame is still a pure function of t, and stills and lint render at fit unless a state sets `view`.

- **Zoom** around the pointer: a trackpad pinch (ctrl + wheel) or ⌘ / Ctrl + mouse wheel, anywhere on the plate. Keys on the focused plate: `+` / `=` in, `-` out, `0` back to fit. A small **− 100% +** control sits in the viewport's bottom-right corner (on hover and focus, and always while zoomed in); the percentage resets to fit. Zoom is relative to fit: 100% is the whole plate, up to 400%.
- **Pan** while zoomed in: drag **blank space**, two-finger scroll (a plain wheel), Space + drag from anywhere, or a middle-button drag. At fit a plain wheel is left to the page, so a docs page scrolls normally, and nothing pans. The grab cursor shows only over blank space while zoomed; a press there that never moves is still a click (a blank click still clears a wire pin); one that moves is a pan and not a click. Space alone (no drag) keeps its meaning, handed on when it is released.
- **What is blank.** The engine's answer is the plate's own backdrop (the viewport, the frame, the scene's root element) or an element marked `data-pl-blank`. A scene refines it with a hook: `isBlank?(e: PointerEvent, byDefault: boolean): boolean`. Say no for what you draw on the fx layer and take the pointer for (a wire), yes for backdrop elements you own. The structure and trace boards veto the wire under the pointer and treat a group frame's empty area as backdrop outside Bench; in Bench the frame is the group's handle (a drag there moves the group, and panning happens outside frames). Cards, buttons, frame labels, the legend, panels and the pinned inspector are never blank, so every other gesture (card and group drags, wire hover and pin, Splice placing and connecting, drill, the Stack view's clicks and keys, text selection) works the same at any zoom.
- **Coordinates.** `stage.toStage()` and `stage.zoom` include the view, so drags move a card by the pointer delta ÷ zoom and hit tests land on what is under the pointer. `stage.fitScale` is the fit alone. A card the scene places beside something in the content (a hover card, a small details panel) goes through `stage.view.overlay(at, w, h, avoid, place)`, which keeps it inside the visible part, clear of the chrome, at its fit size; at fit it is exactly `place(at, w, h, W, H, avoid)`. `view.clear()` is the visible part less the chrome bands along its edges.
- **Chrome and content.** The **content** (cards, wires, group frames, the fx layers, drop targets) zooms and pans. The **chrome** (what frames the picture: a header, a legend, a mode line, a toolbar or palette, a banner, a step rail, a code or text panel, a side panel, a list beside the picture, tabs) stays exactly where and how it is at fit, whatever the zoom: same place on screen, same size, always visible and on top. A scene marks a chrome element with `data-pl-chrome` (the outermost marked element is the root; mark the root of a group of chrome, not each piece):
  - `data-pl-chrome` — a **band**. While zoomed it gets an opaque backdrop (`--pl-bg`, reaching the stage edge when it sits within 72 px of one), so cards and wires pan *under* it and its text stays legible; the backdrop takes the pointer, so content under a band is never clickable through it. The fx layer over the HTML is masked there.
  - `data-pl-chrome="bare"` — kept at fit, no backdrop (it has its own: a tab, a card like the Stack view's about card, a palette form); the over layer is still masked there and hover cards keep clear of it.
  - `data-pl-chrome="overlay"` — kept at fit and nothing else: a click-through outline around the whole plate (the splice frame).
  - How: the frame still scales and pans the whole stage; the Stage (`src/engine/chrome.ts`, `stage.chrome`) counter-transforms each chrome root every frame with the CSS `translate` and `scale` properties, which compose outside the `transform` a Node writes, so scenes animate chrome as usual and the DOM structure is untouched. At fit nothing is written, so stills and lint are byte-identical and scenes stay pure functions of time. Chrome is in the plate's **fit coordinates**: its Nodes measure and map as at fit (`stage.chrome.pt(p)` / `box(b)` say where a point or box of chrome is drawn while zoomed; `chrome.shown()` lists the chrome as drawn now). Draw fx that belong to chrome (an outline around a lit request, a tour's step rail) on **`fx.front`**: the under layer itself at fit, and while zoomed a fit-space canvas between the backdrops and the chrome.
  - Lay out a group of chrome pieces so it has one root: a wrapper that lays nothing out itself (`position: absolute` at 0, 0 with the stage's width, `pointer-events: none` and `auto` on its children, as the tour's and explainer's top bands), or, where a wrapper would change how the plate draws, an empty element marking the band (the trace board's `.tb-colband` behind its request list, whose requests are `bare`). Check stills stay identical with `cmp`.
  - **Pan limits** account for the chrome: a band along an edge (spanning at least half of it) lets the view pan past that edge by up to its depth, scaled so the stage's edge never goes beyond the band's inner edge. At the limit every edge of the content can be brought out from under the chrome; anything visible at fit can be seen at every zoom.
  - What the plates mark: structure boards (header, Bench toolbar and its palette, splice banner and frame, the legend foot with the mode line, and the details panel in its section view; the small panel floats beside its card at fit size), trace boards (header, toolbar, request list, legend, mode line), tours and explainers (header, tools and step rail as one band; code, text or narration, legend, mode line), the Stack view (header with its conflict list, toolbar, tabs, about card, foot; the conflict card floats), the sequence view (header, foot). A board's stack of splices zooms on its own (the board leaves a zoomable plate hosted inside it its gestures and its zoom control, and keeps the host at its fit).
- **Crisp at any zoom.** The HTML is real DOM under a CSS transform, so text re-rasterizes at the new scale. The fx canvases don't stretch: zoomed in, each covers only the visible part of the stage and draws it at the zoomed pixel density (`FxLayer.resize(W, H, px, view)`), so its backing store stays viewport-sized and hairlines, halos and the background pattern stay sharp at 400%.
- **Composes with fit.** The theater, `fill`, a pinned inspector and window resizes change the fit; the view keeps its zoom relative to it (the same content stays in view) and is clamped so the plate always covers the viewport. Reset goes back to fit.
- **State.** `__karyo.getState(id)` adds `view: {zoom, x, y}` (x, y: the stage px at the viewport's top-left); `__karyo.setState(id, {…, view})` sets it, and a state without `view` leaves it as it is. A still of a zoomed view: `render.ts stills --scene <id> --state '{"view":{"zoom":3,"x":420,"y":430}}' --t 0.55`. The view is remembered for the tab in `sessionStorage` (`karyo:view:<page>:<plate>`) while zoomed in.
- **API** (`stage.view`): `get()`, `set({zoom?, x?, y?})`, `reset()`, `zoomTo(z, clientX?, clientY?)`, `zoomIn()`, `zoomOut()`, `panBy(dx, dy)` (CSS px), `focusBox(box, zoom?)` / `focusEl(el, zoom?)` (centre and zoom on a card), `rect()` (the visible part, stage px), `onChange(fn)`, `enabled`, `zoomed`. Jarvis drives it with `zoom` and `pan` (docs/JARVIS.md).
- **Where.** On for interactive plates (structure and trace boards, tours, explainers, the Stack view, the project view, Jarvis); off for clips, in export mode (no control, no gestures), and for a plate hosted inside another plate's scene (a board's stack of splices zooms with its board). `mount(…, { zoom: false })` turns it off.
- **Limits.** Content under chrome at fit (a card beside the header) is covered by its band's backdrop while zoomed until panned out from under it. There is no minimap.

### Chrome floor: chrome stays readable at any fit

The content (cards, wires, group frames) scales with the fit; at a small fit (a large plate in a small window) chrome would shrink with it until a legend or a banner's buttons were too small to read or hit. So chrome has a **floor**: it is never drawn smaller than its designed size (`CHROME_FLOOR`, 1 CSS px per stage px: chrome is designed at 11–12 px for labels and 13–14 px for body text) times the **interface size**. Chrome is what a scene marks `data-pl-chrome` (see "Zoom and pan"), plus the cards a scene places with `view.overlay()` (hover cards, the small details panel, a Stack view's conflict card).

- **How.** The chrome layer (`src/engine/chrome.ts`) draws each chrome root `k = max(fit, floor) × size / fit` times its fit size (`stage.chrome.k`), with the same CSS `translate` / `scale` counter-transform it uses while zoomed (the two compose). Each root scales about the stage edge it sits at: a header from the top-left corner, a toolbar from the top-right, a legend from the bottom; chrome along one edge keeps its order. Roots that belong together share one scale and are clamped inside the stage as a group: roots of one class (a row of tabs, a list of requests) and roots inside a band (the list on its backdrop). A group is never boosted past the stage. A root spanning half the stage, or a large panel, **keeps its span**: it is laid out narrower (`max-width` / `max-height`, its margins to the stage edges scaling with it) and drawn larger, so its text reflows (a legend wraps into more rows, a banner's message ellipsizes). A spanning root whose content doesn't reflow (placed in stage px, like a tour's step rail) is scaled whole instead, as far as the stage allows. `overlay` roots (an outline around the plate) and roots covering most of the stage (a plate hosted inside this one) keep their fit size.
- **Bands and backdrops.** While boosted, bands get their opaque backdrop at fit too (the content passes under the larger chrome, never shows through it), and the fx layer over the HTML is masked there. `fx.front` is drawn with the transform of the chrome it belongs to (the chrome root under what it draws). Pan limits grow by what the boost adds: from the first zoom step in, the view may pan past an edge by the band's drawn depth, so nothing stays hidden under it. A plate that relays out (`fit`'s `o.chrome`) leaves its bands that much room instead, so at fit nothing is covered.
- **Interface size.** S, M or L (90%, 100%, 120%), page-wide (`src/engine/uisize.ts`: `uiSize()`, `setUiSize(id)`, `stepUiSize(±1)`, `onUiSize(fn)`; kept in `localStorage` `karyo:ui-size`, M by default). It multiplies the floor and the chrome's scale: at L chrome is drawn at 120% of its designed size or of the fit, whichever is larger. Set it in the ⚙ menu (Interface size: S M L), in Jarvis's ⚙ Settings (Interface size), or with `[` / `]` on a focused plate (listed by `?`). Every plate on the page redraws (and re-fits, for the room its chrome needs) at once; another tab follows.
- **Where.** On interactive plates that fill a space of their own (`stage.fills`): the theater, `fill` (`?scene=<id>`), a host page that sizes the plate (Jarvis), and a plate hosted inside one of those (a board's stack of splices, which measures its size on screen, its host's scale included). Off for a plate in a page's column (its chrome stays at the fit, as the page laid it out; the theater is one key away), in export mode, so stills and lint are byte-identical, and for clips. Scene code that places a card beside the content uses `view.scaled` (zoomed in or boosted) and `view.cardScale` (the scale `overlay()` draws at) instead of `view.zoomed` and `1 / view.zoom`.
- **Limits.** A plate that doesn't relay out for its chrome (the Stack view) has content under its larger chrome at fit; zoom in a step and pan to see it. A trace board's request column is drawn smaller than the floor when a long request's calls are taller than the window (it never runs past the plate or over the map). A legend whose list is capped to a height shows fewer entries at L.

### Key help: `?` shows what you can press

`?` on a plate opens a card of the keys that work on it **right now**, grouped (Navigate, Card, Legend, Bench, Splice, View, Pointer …), each drawn as keycaps with what it does in the current state ("open Orders store", "leave Bench"). Keys of another mode are listed dimmed with where they work ("x · pick the card at the cursor · in Bench"). `src/engine/keyhelp.ts`, `stage.keyHelp`.

- **Opening.** `?` (⇧/) on the focused plate, or anywhere on a page with one plate (Jarvis, the project view, `?scene=<id>`) or on the plate in the theater. Never from a text field (the legend's "+ tag" name, a splice's rename and name fields, Jarvis's command box): there `?` is a character. A quiet **`? keys`** hint in the viewport's bottom-right corner opens it too; on hover and focus (and while zoomed) the zoom control takes that corner, with the same `? keys` at its right end. Both are page chrome, absent from stills.
- **Closing.** `?` again, Esc, the ✕, or a click outside the card (a click on the plate around it only closes; it never reaches the plate). While open it is a modal dialog (`role="dialog"`, `aria-modal`, labelled "Keyboard shortcuts", described by the plate's title): focus moves into it and Tab stays inside, no key reaches the plate, and focus returns to where it was. The card follows the plate while open (a mode changed by Jarvis or a click redraws it).
- **Where it sits.** In the plate's viewport, outside the zoomed frame, like the zoom control and the pinned inspector: it covers only its plate on a page of many, and keeps its native size and a readable layout at any zoom (two columns when there is room, one when narrow, scrolling when short). Theme tokens only (`--pl-card`, `--pl-line`, `--pl-accent` …), no transitions. Off in export mode and for a plate hosted in another (the host lists its keys).

**For scene authors.** Declare your keys with the hook, next to `onKey` and with the same conditions:

```ts
keys(): KeyHelpList {   // KeyHelp[] | { keys: KeyHelp[]; without?: string[] }
  return [
    { group: 'Navigate', keys: ['j', '↓', '→'], does: this.cur ? 'next card' : 'step to the first card' },
    this.st.drill ? { group: 'Navigate', keys: 'h', does: `step out of ${name}` }
                  : { group: 'Navigate', keys: 'h', does: 'step out of the group', off: true, when: 'when drilled in' },
  ];
}
```

- `KeyHelp` is `{ keys, does, when?, group?, off?, gesture?, id? }`. `keys` is one label or alternatives; write labels from this vocabulary so the check below can press them: a character (`j`, `S` = ⇧S, `?`, `+`, `-`, `=`, `,`, `.`), `⇧S`, `⌘Z` / `⌘⇧Z` / `⌘S` (⌘ reads Ctrl off Apple systems, and `onKey` should take either), `Esc`, `Enter`, `Space`, `←` `→` `↑` `↓`, `PgUp`, `PgDn`, `Home`, `End`, `Delete`, `Backspace`, a digit or a range `1–9`. A pointer gesture ("pinch", "Space + drag", "any key" while playing) is `gesture: true`: drawn as text, never pressed.
- **Context-aware, honest.** Return only what works now; a key of another mode is `off` with a `when`. A key listed as working must do something when pressed in that state; a key that does something must be listed. Keys that do the same share a line.
- **The engine adds its own lines** (with ids a scene can leave out through `without`): a clip's transport (`transport`), `b` Bench (`bench`), `f` theater and Esc leaving it (`theater`, `theater-esc`), `i` the inspector (`inspector`, dimmed "in the theater" where it can't show), `+ - 0` zoom (`zoom-in`, `zoom-out`, `fit`; − and 0 dimmed at fit), pinch / ⌘ + scroll and the pans (`zoom-pointer`, `pan`), `[ ]` the interface size (`ui-size`, "Chrome floor"), and `?`. The structure board leaves out Bench, the inspector and the theater's Esc while its stack of splices covers it (keys go to the stack there; the board forwards `f`, `?` and the zoom keys).
- **A host page** adds its own group and takes keys for itself: `stage.keyHelp.setPage({ keys: () => KeyHelp[], omit?: string[] })`. Jarvis lists hold Space to talk, the wake word, Enter and Esc in the command box, and omits the plate's `Space` lines (Space talks there).
- **Tooltips.** A button with a shortcut names it at the end of its title, in brackets: Bench "… (b)", Theater "… (f; Esc to leave)", the zoom control "Reset to fit (0)", a tour's "Next step (→, j or Enter)", Replay "… (p; any key stops)", a legend entry "… (3)", a step dot "… (2)". Do the same for a scene's own buttons.
- **API** (`stage.keyHelp`): `list()` (the groups the card shows now), `open()`, `close()`, `toggle()`, `isOpen`, `setPage(p)`, `enabled`.

### Wire hover: what does this arrow mean?

On the structure board and trace boards, hover a wire (within 6 px of the drawn path; where wires overlap, the one drawn on top wins, so hover a wire's own branch rather than a shared trunk): it thickens and lights, in its verdict's style (solid, dashed for declared-not-seen, the warning colour for seen-not-declared), both end cards light, everything else dims a little. It's state at rest, instant, no transition. A card by the pointer (kept inside the plate, off the wire's two cards) says what the path means:

- `From → To` and the relationship's kinds (`calls`, `reads`, `writes` …);
- one plain sentence, generated shape-neutrally from the kinds and the operations recorded along it (span labels, attributed to the pair as the merge counted them): "Checkout asks Orders store to create, add item, get and close.", "Report builder reads from Orders store." The relationship's own **label**, when the code gave one, replaces the sentence;
- the verdict in words (the same `verdict()` that styles the wire), the direction when data runs against the arrow ("data comes back to Admin console" for reads, the queue delivering for subscriptions);
- evidence: `recorded 8×: get ×4 · add item ×2 · create ×1 · close ×1`, `declared at <file:line of the from-node's directive>` (or "not declared · declare it at …"), and the flows it was recorded in (a trace board: the requests).

The mode line shows the same sentence while the card is up. **Click** the wire to pin the card: it stays until `Esc` (innermost first: before a panel, pins or a drill) or a click elsewhere, and lists the recorded calls (operation, duration; a trace board: the selected request's calls along it). States for stills: `wire-hover-<from->to>` and `wire-pin-<from->to>` (the hover and pointer position are part of the view state: `wire`, `wireAt`, `wirePin`). The words come from `src/model/wire-info.ts`.

**Label a relationship in code** with an edge directive; it folds into the pair's one relationship with any `calls=` / `reads=` declarations (docs/MODEL.md "Identity"):

```python
# karyo:edge from=web-app to=checkout.api kind=calls label="HTTPS"
```

(`//karyo:edge …` in Go.) Without a label the sentence is generated, so name spans after what they do (`# karyo:span node=orders.store label=create`) and the wire reads as the operations it carries.

### Card details: sections

A structure board card's details are **named sections**. The board has its own: `summary` (the summary, the code reference, the category and tags), `calls` (what it calls and what calls it) and `checks` (when there are any). A scene adds its own through the `details` hook, which returns HTML (one section, `details`), a section, or a list of them:

```ts
details: (n) => ({ id: 'endpoints', title: 'HTTP endpoints', noun: 'endpoints',
  keywords: ['routes', 'parameters', 'responses'],                 // other words that name it
  html: fullRendering(n),                                          // the section view shows this
  compact: oneLinePerItem(n) })                                    // the small card panel shows this (default: html)
```

Mark each thing a section lists with `data-item="<name>"` (an endpoint, a relationship, a check): the board counts items, measures which are on screen, and scrolls to them by name. Nothing in the engine knows what the items are.

- **The small panel** (a click on a card, `reveal()`): every section in one scrolling body; a scene's sections have an **expand ⤢** button.
- **The section view** (`openDetails(node, section)`, expand, or state `section`): an inspector docked to the side of the plate away from the card (half the plate wide, 540–880 px; nearly its full height, under the toolbar in Bench), sized to be read at theater fit. The section fills it; the others sit behind a tab row; an index of the section's items jumps to each (the ones on screen are outlined), and a line at the bottom says when there is more below. "card ⤡" goes back to the small panel, `Esc` closes. It slides in from its edge; switching tabs doesn't move it.
- **Scrolling**: the body scrolls with the wheel or trackpad (`overscroll-behavior: contain`, and a wheel over the panel never reaches the page or the plate), with the arrow keys when it has focus, and with `PgUp`/`PgDn`/`Home`/`End` from anywhere on the plate while a card is open. It is a `data-pl-clip` region, so lint accepts the overflow.
- **API** (`BoardApi`): `sections(node)` (ids, titles, counts, keywords, item names), `openDetails(node, section?)`, `detailsView()` (what is visible now, measured from the DOM: `visible` in words such as "2 of 7 endpoints fully visible, POST /orders partly; scroll for the rest", and the item names shown, partly shown and out of view), `scrollDetails('down' | 'up' | 'top' | 'bottom' | { item })`. The trace board has `openDetails(node)` (the next request touching it, unfolded) and `detailsView()` (its calls; the column always has room for them). Types: `SectionInfo`, `DetailsView` in `src/model/outline.ts`.
- **States for stills**: `section-<id>` opens the busiest card's first scene section (else its calls) as a section view.

### Kits: node kinds and plate types from a project

A project (or the shared library, `~/.adenine/karyo/kits`) can add **node kinds** (a card template, style, size, details sections, a fields schema and a legend entry for model nodes of that `kind`) and **plate types** (views composed from JSON: a board narrowed to some nodes, a trace, a tour, a sequence diagram) as a **kit**: data and templates. The one exception is a `script` plate type, which runs the kit's own JavaScript in a sandboxed frame, and only after the viewer trusts that exact version (a warning on first use, a notice on every load; docs/KITS.md "Code in kits"). Every model view draws a kit kind's card in the board's frame (category edge and ring, badges, splice marks, drag, wires, legend, sections, the pinned inspector); layouts place and route by its declared size. The built-in `sequence` kit adds the sequence plate (`src/model/sequence.ts`). Format, resolution, the views and `karyo kit new|list|check`: [docs/KITS.md](KITS.md).

### Pinned inspector: details beside the window

The section view can leave the plate and dock to the side of the **window**, like a properties panel. Pinned, it is page chrome outside the scaled stage, so its text is native size and crisp, and the plate re-fits into the space that is left (the theater's `fit`, "Theater" above).

- **Pin** with the 📌 button in a card panel's or section view's header, the `i` key on the plate, or Jarvis (`pin_inspector`, docs/JARVIS.md). The 📌 in the inspector's own header (or `i` again) unpins it: the section view goes back into the plate. `Esc` never unpins; it closes the card, and the pinned inspector shows a quiet hint ("open a card to inspect it").
- **It follows** the card you open (a click, the keyboard, Jarvis), with the same sections, tabs, item index, scrolling and "more below" line as the section view. A card opens on the section the inspector showed last when it has one, else the scene's first, else its summary. The tabs switch section; × closes the card.
- **Lock** (the padlock) freezes it on the current card while you look around: other cards then open on the plate as usual. Unlock and it follows the open card again.
- **Resize** by dragging its inner edge (or the arrow keys on it): 320 px up to 60% of the window. **Side**: the ⇆ button moves it left or right. Pinned, side and width are remembered in this browser (`localStorage` `karyo:inspector`); the lock is not.
- **Where it shows**: while the plate fills the window (the theater, `mount(…, { fill: true })`, `/?scene=<id>`) and on pages that place it (Jarvis mode puts it above the bar). A plate in a page column has no room beside it, so it has no pin until it enters the theater; there the inspector sits inside the theater's overlay.
- It has no transitions (pin, unpin, side and resize snap) and uses the plate's theme tokens, in every theme.

**For scene authors.** A scene opts in with `static inspector = true`; the Stage then makes `stage.dock` (`src/engine/dock.ts`), which owns the frame, the controls, the edge and the saved preferences, and gives the plate the rest of the window (`stage.dock.reserve()` is taken off the space the theater fits). The engine knows nothing of cards or sections: the scene writes `dock.body` (in `update()`, rebuilt only when what it shows changes) and calls `dock.setSubject(label)` when it shows something lockable, or `dock.setSubject(null, hint)` for its hint. `dock.shown`, `dock.locked`, `dock.side` are read live; the hook `dockChanged?(what)` (`'pin' | 'lock' | 'side' | 'width' | 'place'`) runs before the plate is refitted and redrawn, which is where a scene records what a lock holds. A host page that lays the dock out itself calls `dock.place(parent, true)` and follows `stage.onDock(fn)` (Jarvis: `src/jarvis/main.ts`). CSS that the scene's details use must not be scoped under `.plate-dom`: the dock lives outside it.

- The structure board (`src/model/board.ts`) shows the section view in it; `inspector()` reports `{pinned, shown, locked, side, width, node, label, section, visible, items, more}`, measured from the DOM like `detailsView()`, which in turn measures the open card wherever it is (the inspector or the plate). The trace board (`src/model/flowboard.ts`) shows the selected request's calls (its header, duration, status, the nested calls with their own durations and errors); lock holds a request while you step through others. Other plates have no inspector. Types: `InspectorView` in `src/model/outline.ts`.
- Export mode (`render.ts`, `preserve`) makes no dock, so stills and lint are unchanged.

### Splice: proposed changes, drawn in place

A **splice** is a sandbox over exactly the view you are looking at, where you propose changes ("a cache between these two", "a validator before this", "drop that") and see what the picture would be. The real diagram is never changed: the board draws `applySplice(model, splice).model` (the core, docs/MODEL.md "Splices") and goes back to the real model when you leave. Structure boards only (trace boards are read-only).

- **Entering.** The **Splice** button in the plate's actions row, `s` in Bench, or Jarvis ("splice this", "open this view in a new splice called caching", `splice_open`). It forks the current view as it is, and remembers it as the view the splice lives in (on a board with groups: the level and group; "Group navigation" above): the same plate, drill, selection and arrangement (your Bench positions still apply; drags inside the splice are the splice's own and are saved with it, never written to the real view's layout). The plate gets a **tinted frame** and a **banner**: `SPLICE · <name or untitled> — in <where you are> · proposals only · <n> changes · <the last change> · not saved | saved`, with Save, Discard and Leave. The Splice button reads "Leave splice".
- **Drawing.** Proposed cards have a dashed accent border over a light hatch, a `proposed` badge and "not in the code yet" where the code reference would be; their category edge still shows. Removed cards stay where they were as faint dashed ghosts with the name struck through; removed and **rerouted** relationships (the ones a between / before / after replaces) stay as faint dotted ghosts, and the new path is lit in the accent with long dashes (`wireStyle` `proposed`). A renamed card shows the new name and "was ~~old~~"; a moved one says where it came from. The layout is recomputed for the spliced model (the same `arrange` for the same space, the plate re-fitted with `stage.refit`), and cards **glide** there from where they are: a new card grows out of the middle of the cards it joins (an insert, out of the wire it goes into), and what goes (an undone proposal, leaving the splice) fades where it is. The legend gains **proposed**, **removed** and **renamed / moved** entries (they count cards and wires); hovering one lights exactly those cards and wires. Wire hover and the details (in the plate or the pinned inspector) work on proposed parts and say so: "proposed · not in code yet", "removed in this splice · the code still has it". The mode line leads with the last change in plain words (`describeOp`).
- **Editing (Bench).** `+ node` (or `n`, which turns Bench on) opens a small form (label, kind, category); then the next click says where it goes: **a wire** puts it between that wire's two cards, **⇧-click a card** before it, **⌥-click** after it, a plain click on a card attaches it (that card calls it), **empty space** drops it there. Esc cancels. **Drag a card's handle** (the ● on its right edge, shown on hover) onto another card to propose a relationship. **Click a card's name** to select it, then **Delete / Backspace** removes it (or disconnects a pinned wire). **Double-click a name** to rename it. **⌘Z / ⌘⇧Z** (Ctrl on other systems) undo and redo, **⌘S** saves. Each gesture is one op; an op the core can't apply isn't kept, and the banner says why (with the core's hint).
- **Replacing.** Select a card (click its name) and press `r`: the palette opens as "replace <card> with" (the kind defaults to the card's); name the new node and **Replace it** proposes a `replace` (docs/MODEL.md "Splices"): the new card takes over every wire of the old one, which stays as a struck-through ghost with its old wires as rerouted ghosts. The mode line says "Replace Audit log with Event log". Jarvis: "replace the orders store with an event store".
- **After and before a node that fans out.** ⌥-click (after) on a card with several outgoing wires adds a step it also calls, instead of rerouting every wire through the new node; ⇧-click (before) on a card several call adds a step that also calls it. With one wire (or none) the new node goes in between. The mode line says which ("Add Logger, which Checkout also calls").
- **Saving and reopening.** Save asks for a name when the splice has none (an inline field) and writes `<model's folder>/karyo/splices/<id>.splice.json` through the dev server (`id` = the name's slug; a new splice never overwrites another's file: `caching-2`). Leave asks first when there are unsaved changes; Discard asks too and deletes the saved file. The **Splices** button (dev server only) lists the saved ones, newest first, with where each lives ("in Orders › Store"), how many changes, how many have **landed** in the code (`landed`), and how many **no longer apply** over the current code; a click opens one over the current code (its warnings show in the banner, ⚠).
- **API** (`BoardApi`): `spliceView()` (with `where`, `home` and the proposed `groups`), `spliceOpen({title?, splice?, file?})`, `spliceOpenSaved(ref)`, `spliceOp(op)` → `{applied, warnings, view}`, `spliceUndo()`, `spliceRedo()`, `spliceSave(name?)`, `spliceLeave(force?)`, `spliceDiscard(force?)`, `spliceList()`. `describe()` marks nodes (`mark: proposed | removed | renamed | moved`). State: `splice: {id, title, ops}`; setState opens it as if from the real view. Options: `modelFile` (where splices are saved and what they record as their base) and `spliceExamples` (states `splice-<id>`, `-bench`, `-wire`, `-legend` for stills and lint). The session (ops, undo/redo, dirty, save, list) is `src/model/board-splice.ts`; the engine provides `stage.addAction(button)` (a scene's own button in the actions row, none in export mode) and `stage.refit(space)` / `stage.onRefit(fn)` (the content changed shape: fit it again; a host page such as Jarvis sizes it itself).
- **Stills** of a board scene with `spliceExamples`: `render.ts stills --scene <id> --state splice-caching --fit 1440x900` (and `--mode dark`, `--theme adenine-periwinkle`).

### Stack of splices: compare many, edit one at a time

A structure board with saved splices can **stack** them: a Stack view ("Stack view" above, the same plate) lifted over the board, laid out for the board's size, with the **real view in front** and one slice per splice behind it. Each slice is `applySplice(real model, splice)`: its proposals are drawn as the board draws an open splice (dashed, hatched `proposed` cards; `removed` and rerouted parts as ghosts; `renamed` / `moved` badges; proposed wires in the accent with long dashes), on one layout over every slice's nodes, so a proposed node sits in one place on every slice.

- **One baseline.** Every slice is compared with the real view, exactly as the board draws a splice: the stack passes `diff: 'none'` (`SPLICE_STACK_VIEW`, `src/model/splice-stack.ts`), so there is no neighbour diff (no + − ~ on wires, no `added here` badges, tab counts or entries). The header says what the slice changes in the key's words ("9 proposed, 4 removed").
- **The key.** The legend's Changes row is a key: each mark has an entry with its sample and what it means, and hovering one lights exactly its cards and wires (click pins it): **proposed** (a dashed accent line) "not in the code yet"; **removed** (a dotted ghost line) "ghost: removed or rerouted by the splice"; **renamed / moved** (a badge) "renamed or moved by the splice"; and one entry per kind of thing combining found on the combined slice (below): **⚠ conflict** "two splices disagree", **⚠ consequence** "a change lost or left dangling", **⇄ order** "the order changes the result", **? same name** "one name, two things?", **= same thing**, **✓ agreed** "proposed by both, shown once" and **→ follows** "follows a replacement", each counting its items and lighting their cards and wires (with several kinds on a slice the chips carry the name only; the meaning is in the chip's tooltip and each card). Conflicts and consequences use the warning colour and the dotted ⚠ look; a same-name question the accent; agreed and follows are quiet notes (muted, no ⚠ on the slice, reached from the header's list). The wire key beside it adds proposed, removed (ghost) and ⚠ samples. The same words are used in the tab cards, the header, the key, the card and Jarvis.
- **Conflicts** are drawn with their own cue besides the warning colour, which a theme may share with "seen, not declared": a conflict wire is dotted over a faint halo with a ⚠ in the middle, whatever it otherwise is (proposed, a ghost, real); a node in conflict gets a dotted ring.

- **Opening.** The **Stack** button in the Splices list (enabled with one saved splice or more) and in the splice banner, `⇧S` on the board, or Jarvis ("stack my splices", "compare caching and queueing", "combine them"). The open splice is in the stack as it is: with unsaved changes it is its own slice, marked **unsaved**; nothing is saved or thrown away for you.
- **Reading.** Hover a tab (or focus it): a card beside it says what that slice is, the splice's changes one per line (`describeOp`, naming nodes as they were just before each change), its warning, and what a click does; the mode line says the first line. ←/→, the tabs, `o` (fan out) move through the stack as in any Stack view.
- **Editing one.** A click on the front slice, Enter, or the toolbar's **Edit this splice** brings that splice back to the board (the same session as opening it; a splice you had changed comes back with its changes and undo history), and the stack fades away. The banner's **Back to stack** or `Esc` (once nothing else on the board unwinds) returns to the stack, rebuilt from what you changed, on the slice you came from. The real view's slice leaves the splice. `Esc` in the stack, or **Leave**, closes it and keeps the board as it is. You compare many and edit one at a time: changes wait while the stack covers the board.
- **Combining.** "Combine" adds one more slice, titled by its **order**, e.g. **Caching, then Queueing**, which applies the chosen splices' changes in that order as one splice (`combineSplices`, `src/model/splice-stack.ts`; docs/MODEL.md "Combining splices": each change sees what the earlier splices proposed, took away and replaced, identical proposals apply once, two different proposals with one id stay two cards). It is read-only: a click explains that and offers to open either part. What combining finds is explained the same way for every kind (what it is about, what each splice does, what the combination shows) and checked both ways round, so the words don't depend on the order: **conflicts** (two splices disagree), **consequences** (a change lost, a proposed node left dangling), the **order** (when the other order gives something else, and what), **same name** questions, and quiet notes (**agreed**, **follows** a replacement).
- **The order control.** The header shows the order and a **⇄** after it ("Caching, then Queueing ⇄"): a click recombines the other way round (its tooltip says whether that gives something else). When the order changes the result the header says "⇄ the order matters" and the list has an **order** item whose card gives what each order yields ("Cut, then Buffer: gives no Buffer · Buffer, then Cut: gives Buffer"). Jarvis: "swap the order".
- **Same thing?** A same-name card ("Two different Read caches, one in Caching (in front of Orders store) and one in Probe (in front of Billing). Same thing?") has **Treat as the same**: the combination is rebuilt with one node in both places, recorded in the stack (`stack.same` in the board's state), never in either splice file; the note that replaces it offers **Treat as different**. Jarvis: "they're the same cache".
- **The list and the card.** The combined slice's header summarises by kind ("⚠ 1 conflict · ⇄ the order matters · ? 1 same name", or quietly "→ 1 follows a replacement") and lists every item on one line, numbered, each with its kind's symbol and name. A ⚠ on a wire, a warned wire or card, or a list item shows the item's **card** (the wire card's style, `warningCardHTML` in `src/model/wire-info.ts`): "⚠ conflict 1 of 3", what it is about, its meaning, one line per splice, the combined result, the item's own button (Treat as the same) and one button per splice ("Open Caching") that opens it on the board. A note's card is quiet, a question's in the accent. Hovering lights exactly that item's cards and wires; a click pins the card, Esc or a click elsewhere closes it. The slice's `warning` carries this shape-neutrally: `{name, meaning, text, tone, details, nodes, pairs, items: [{title, who, nodes, pairs, name, sym, tone, meaning, lines: [{who, text, open}], result, actions}]}`; the Stack view's options `headAction(i)` (the header's button) and `itemAction(i, k, id)` (an item's button) are how a host answers them.
- **API** (`BoardApi`): `spliceStack({names?, combine?})`, `spliceStackOpen(ref)` (a 1-based slice, a splice's name, `real`, `combined`), `spliceStackReturn()`, `spliceStackLeave()`, `spliceStackSwap()`, `spliceStackSame(ref?, same = true)`, `spliceStackView()` → `{shown, cur, slices: [{index, title, kind, unsaved, changes, about, warning}], conflicts, explained: [{n, kind, what, splices, parts: [{splice, does}], result}], order: {now, other, matters, gives, otherGives} | null, lit: {n, pinned} | null, asking}`, `spliceStackPlate()` (the Stack view's API while it shows; Jarvis drives it). State: `stack: {splices, combine, cur, tab, shown, conflict, same}` (setState takes the ids from `spliceExamples` and `stackExamples`; `combine` is in order; `conflict` pins that item's card, 0-based). States for stills: `splice-stack`, `splice-stack-hover` (a splice's tab hovered), `splice-stack-unsaved`, `splice-stack-combined` (on the combined slice), `splice-stack-conflict` (its first item's card pinned), and one per `stackExamples` splice combined with the first example, its first item's card pinned (`splice-stack-<id>`: a dangling consequence, an agreed note, a conflict, whatever combining that pair finds), e.g. `render.ts stills --scene <id> --state splice-stack-conflict --fit 1440x900 --t 1` (and `--mode light`, `--theme adenine-periwinkle`).
- **How it is built.** The Stack view carries what a stack of what-ifs needs, shape-neutrally: a slice may carry `marks` (drawn as above), `about` (lines for its tab's card), a `badge` ("unsaved", "combined") and a `warning` (`{text, name, details, nodes, pairs}`); `stackView` options `rest` (the slice it rests on: here the real view), `open` (what a click on the current slice, Enter and its button do) and `buttons`. The board hosts that plate inside its own (`src/model/board-stack.ts`: its keys and pointer events stay out of the board; in stills the board renders it frame by frame), and the engine provides `Scene.settled()` (render.ts waits for a plate a state hosts to boot) and `stage.isExport`.

## Nodes (`src/engine/node.ts`)

`const n = this.$('#id')` — properties, all reset every frame:

| property | effect |
|---|---|
| `x`, `y` | translate (px) |
| `scale`, `sx`, `sy` | scale (uniform, per-axis) |
| `rotate` | degrees |
| `opacity` | 0..1 |
| `blur` | px of CSS blur |
| `hidden` | `visibility: hidden` (keeps its space) |
| `text` | replace the text content (e.g. typewriter, counters, status) |
| `vars['--k']` | set a CSS custom property — drive widths, colours, `scaleX(var(--k))` bars |
| `classes['is-lit']` | toggle a class for this frame |

`n.set({ opacity, y, … })` sets several at once.

Positions (in stage px, including the node's and its ancestors' animated transforms):

- `n.at('left' | 'right' | 'top' | 'bottom' | 'center', along = 0.5, gap = 0)` — a point on an edge, pushed out by `gap` px.
- `n.at(u, v)` — any point, `u, v` in 0..1 of the box.
- `n.center`, `n.bounds(pad)` (axis-aligned box), `n.box` (layout box, no transforms).

Inline elements work (a `<span>` around a word in a paragraph or a token in a `<pre>`): wrap the thing you want to point at in a span with an id.

## fx layers (`src/engine/fx.ts`)

`fx.under` is always there (a transparent canvas **under** the HTML). `fx.over` exists when `static fx = 'over' | 'both'` (**over** the HTML: outlines around inline text, rings on top of cards). `fx.front` is for fx that belong to chrome, in fit coordinates: at fit it *is* `fx.under`; while the viewer is zoomed in it is a canvas over the chrome's backdrops and under its HTML ("Zoom and pan"). Each has:

- `lines` — GPU capsule segments with an optional soft halo:
  - `seg(ax, ay, bx, by, stroke)`, `dot(x, y, d, stroke)`, `polyline(pts, stroke)`
  - `path(path, { from, to, …stroke })` — draw part of a path (draw-on effects)
  - `dashes(path, { dash, gap, offset, … })` — `offset: t * speed` makes them flow
  - `rrect(x, y, w, h, r, { progress })`, `ring(cx, cy, r, { progress })`, `arrow(p, angle, size)`
  - stroke = `{ width = 1.5, color = 'line', alpha = 1, glow = 0 }` (glow = halo radius px, scaled by the theme's `--pl-glow`)
- `bg` — the background pass: `bg.pattern = 'dots' | 'grid' | 'none'`, `bg.patternAlpha`, `bg.spacing`, and `bg.light(x, y, r, k, rgb)` for up to 8 soft pools of light per frame (they glow through gaps between cards). Theme grain is applied here.

Wires and shapes (`src/engine/geom.ts`): `wire(a, b, { kind: 'curve' | 'elbow' | 'straight', radius, tension, bend, from, to })` returns a `Path` with `.length`, `.at(u)` (point + angle), `.atLength(px)`, `.slice(u0, u1)`. Also `rrectPath`, `circlePath`, `new Path(points)`.

Motifs (`src/engine/motifs.ts`):

- `comet(lines, t, headAt, { scale, color, tail, embers, seed })` — a hot head, a tail retracing where it has been, and embers peeling off. `headAt(tb)` must return where the head was at any earlier time `tb` (or null): the tail and embers are placed from those times, so the result doesn't depend on render order.
- `pulseRing(lines, point, t, t0, { r0, r1, dur })` — arrival ring after `t0`.
- `packets(lines, path, t, { speed, spacing, size })` — dots flowing along a wire.
- `outline(lines, node, { progress, pad, radius, glow })` — a rounded rect drawing itself around a real element.
- `lightUnder(bg, node, k, rgb, spread)` — soft light behind an element.

## Text (`src/engine/text.ts`)

- `splitText(el, 'words' | 'chars')` in `build()` → spans (class `pl-w` / `pl-c`); animate each with `this.$(span)`. Nested markup survives; whitespace stays as text so wrapping and copy/paste behave.
- `typed(text, k)`, `typedAt(text, t, t0, cps)` — typewriter strings for `node.text`.
- `stagger(t, i, t0, step, dur, ease)` — 0..1 progress for item i of a list.
- `countTo(a, b, k, decimals)` — number tweens as text.

## Timing (`src/engine/util.ts`)

`prog(t, a, b, ease)` (clamped eased progress), `ease.*` (`outExpo`, `inOutCubic`, `outBack`, `outElastic`, …, plus builders `ease.power(p)`, `ease.out(f)`, `ease.inOut(f)`, `ease.spring(freq, damping)`), `keys(t, [[t, v, ease], …])` keyframes, `springStep(t - t0, freq, damping)` (a damped spring's response, overshooting then settling on 1), `pulse(t, t0, halfLife)`, `lerp`, `clamp`, `remap`, `smoothstep`, `hash(...)`, `seeded(seed)`, `noise1`, `noise2`, `fbm`.

Write a cue sheet (`const T = { … }`) at the top of each scene and derive everything from it; retiming is then a one-line change. Prefer strong eases (`outExpo`, `inOutCubic`, springs), holds, then snaps — not linear drifts.

## 3D (`src/engine/space3d.ts`)

`this.space = new Space3D(this.stage, { fov: 35 })` in `build()`, then `space.add(el, restPose)` for each element. Elements stay live HTML rendered by three.js's CSS3DRenderer.

- World units are CSS px, origin at the stage centre, **+y up**, +z toward the viewer.
- Per frame (in `update`): `space.pose(el, { x, y, z, rx, ry, rz, scale, opacity })` (unset fields keep the rest pose) and the camera `space.cam = { yaw, pitch, roll, dolly, panX, panY }` (degrees / px; everything resets to rest each frame).
- In `draw`: `space.at(el, u, v)` and `space.quad(el)` give projected stage-px points to wire and outline 3D elements; `space.project(x, y, z)` for any world point.
- `flat: true` in a pose asks for the element to be drawn as plain DOM (no 3D transform, so text is rasterized crisply) whenever the pose is face-on (z = 0, no rotation, scale 1) and the camera is at rest; otherwise it stays in 3D. It is placed exactly where the 3D pose projects, so switching never jumps. Use it for a sheet read at rest (`space.isFlat(el)` tells which it is this frame).
- `space.resize(w, h)` follows a new logical size (a theater relayout); the space does it on its own before a frame when the stage's size changed, so call it yourself only to measure projections for a size the stage hasn't taken yet (inside `fit`).
- Don't use Node transforms on elements inside the 3D scene (the renderer owns their transform) and don't use `node.at()` for them; classes, text and vars on them and their children are fine.

## Themes (`src/engine/karyo.css`)

Tokens on `.plate`: `--pl-bg --pl-fg --pl-muted --pl-line --pl-accent --pl-accent-2 --pl-ok --pl-card --pl-card-border --pl-radius --pl-shadow --pl-font --pl-font-display --pl-font-mono --pl-glow --pl-grain`.

**Category palette**: `--pl-cat-1 … --pl-cat-8`, `--pl-cat-other`, and a pattern cue `--pl-cat-n-fill` (a `background-image`, laid over the colour). Categories take slots in a fixed order and are never cycled. Past the eighth, the first seven keep their slots and the rest share "other" (`--pl-cat-other`, a neutral), never a generated hue. The neutral light and dark steps (green, pink, yellow, violet, red, blue, aqua, orange) are checked with a palette validator against the card surfaces (`#ffffff` light, `#171b22` dark). Adjacent pairs pass protan/deutan separation at ΔE ≥ 9.2 (light) and ≥ 9.4 (dark), and normal vision at ≥ 19.3. Taken as all pairs, the first three slots clear the target in light mode (ΔE 16.2), but in dark mode they sit in the 6–8 floor band (6.9). Three light-mode steps sit under 3:1 on white, so a category is never shown by colour alone: the legend names it and the card panel lists it. The blue and orange slots come late, so the first categories don't read as the accent (lit) or the warning colour. A theme whose categories share colours tells them apart by a pattern too (`--pl-cat-n-fill`, e.g. solid, wide hatch, fine hatch); none of the shipped themes needs one, so every fill is `none`. Categories are for CSS only; the fx layers don't read them.

- **adenine** (the default on every Karyo page): `data-plate-theme="adenine"`. The clean dark structure with hairlines, tight corners, no drop shadows and a whisper of grain (`--pl-grain`), system fonts, a sea-foam/cyan accent, and label colours carried onto card borders and kind labels (`--pl-cat-ring`, `--pl-cat-kind`). Every `data-plate-theme` starting `adenine` gets this base; the themes below override its colours only.
- **More adenine themes**: `adenine-periwinkle`, `adenine-jade`, `adenine-alt` ("Adenine alt": adenine tuned in OKLCH for calm; `adenine-v2` is also accepted for it), `adenine-lavender`, `adenine-glacier`, `adenine-seafoam`, `adenine-graphite`. Each is an accent, surfaces tinted toward it, and labels kept clear of it and apart under colour-blind simulation.
- **neutral**: light, and dark under `prefers-color-scheme: dark`; `data-theme="light" | "dark"` on `<html>` or the plate forces one. No `data-plate-theme`.

Every theme draws in system fonts (`--pl-font`, `--pl-font-display`, `--pl-font-mono`).

A plate can also carry its own `data-plate-theme` / `data-theme`. It applies when `<html>` has the neutral theme; a theme of the adenine family on `<html>` wins over the plate's.

### The theme picker (`src/engine/theme-pick.ts`)

One ordered list, `THEMES`, used by every page: **Adenine, Periwinkle, Jade**; then Adenine alt, Lavender, Glacier, Seafoam, Graphite; then Neutral · auto, Neutral · light, Neutral · dark (ids `adenine`, `adenine-periwinkle`, `adenine-jade`, `adenine-alt`, `adenine-lavender`, `adenine-glacier`, `adenine-seafoam`, `adenine-graphite`, `neutral`, `neutral-light`, `neutral-dark`). Each entry is an id (what is stored), a label, the `data-plate-theme` value (null for neutral), a `data-theme` mode and its menu section (Adenine, More themes, Neutral).

- **On load** (`initTheme(q)`): a URL `&theme=` on the list wins (with `&mode=` beside it; a neutral id such as `neutral-dark` sets its mode); otherwise a URL `&mode=light|dark` forces neutral in that mode; otherwise the stored choice (`localStorage` `karyo:theme`); otherwise **adenine**. An id that isn't on the list, in a link or a stored choice, opens the default (adenine), silently. So `render.ts --mode dark` / `--theme adenine-jade` mean what they say, and a render with no flag is adenine. The renderer's export mode (`&export=1`) skips the stored choice, so stills never depend on a browser profile. Other ids are also accepted, stored or in links (`adenine-v2` → `adenine-alt`, `neutral-auto` → `neutral`).
- **The settings button** (`themePicker()`): a small ⚙ button whose menu lists the themes in order, then the interface size (S M L: "Chrome floor"; choosing one keeps the menu open), each with a swatch of its accent on its background, read from karyo.css (in a hidden frame, so the page's current theme doesn't leak into the reading), and the current one checked. Choosing one applies it at once (the stage re-reads its tokens when `<html>`'s attributes change), stores it, and drops `theme`/`mode` from the address so a reload keeps it. Arrow keys, Home/End and Esc work in the menu.
- **Where it is**: the headers of the gallery (`index.html`) and the project view (`karyo view`), `explain.html` (hidden in export mode), and a Theme select in Jarvis's existing ⚙ settings panel (`themeOptionsHtml()`, grouped by menu section), with an Interface size select under it. A standalone explainer (`src/explainer/build.ts`) has no module imports, so it inlines the list, built from `THEMES` at build time, as a Theme select with the same precedence and default.
- Other helpers: `applyTheme(id)`, `currentTheme()`, `pickTheme(id)`, `onThemePick(fn)`, `themeById(id)`, `themeTokens(props)` (each theme's value of any tokens; `themeSwatches()` reads the menu's swatches with it).

A new theme is a CSS block redefining the tokens; the fx layers pick them up automatically (theme changes re-render the current frame).

Engine classes for scene HTML (not to be confused with kits, docs/KITS.md): `.pl-card` (+ `.is-lit`), `.pl-label`, `.pl-title`, `.pl-h1`, `.pl-body`, `.pl-muted`, `.pl-accent`, `.pl-mono`, `.pl-chip` (+ `.is-lit`), `.pl-code` with `.ln` lines (+ `.is-lit`) and `.tok-k` / `.tok-s` / `.tok-c`, `.pl-caret`.

## Embedding on a page

```html
<link rel="stylesheet" href="…/karyo.css">      <!-- bundled when you import the engine -->
<div id="fig"></div>
<script type="module">
  import { mount } from './engine';
  import RequestFlow from './scenes/request-flow';
  mount(document.getElementById('fig'), RequestFlow, { autoplay: true, loop: true, controls: true });
</script>
```

- Markup already inside the mount element is moved into the stage's HTML layer before `build()` runs, so a page can author the content semantically and the scene only animates it (it stays readable without JS).
- Options: `autoplay`, `loop`, `controls` (play/pause, scrubber, time), `start`, `rate`.
- **Bench** (scenes with `static bench = true`): a Bench button next to Theater (and the `b` key). `mount(…, { bench: true | false })` chooses how the plate opens (default: the scene's `static benchOpen`). See "Bench" above.
- **Theater**: every plate gets a Theater button (and the `f` key) that lifts it out of the page to fill the window. The **whole plate is always on screen**, scaled to fit both dimensions, never scrolled; a scene that can relayout for the window's aspect does so first (see "Theater: fitting the window" above). `Esc` leaves, after an interactive scene has unwound its own state, and the plate returns to its page size. `theater: false` turns it off (export mode does). From code: `stage.theater(on?)`.
- **Inspector** (scenes with `static inspector = true`): the pinned inspector beside the window, in the theater and with `fill` (`i`, 📌). See "Pinned inspector" above.
- **Fill**: `mount(…, { fill: true })` makes the plate the page: the theater's fit from the start and on every resize, with no Theater button. The gallery uses it for one scene on its own (`/?scene=<id>`), except in export mode (render.ts keeps the native stage size) or with `&fill=0` (the plate in the page column, with its Theater button).
- Keyboard on a focused plate: Space/K play-pause, `,` `.` step a frame, ←/→ ±0.1 s (shift ±1 s), Home/End; `f` theater, `b` Bench, `i` pins the inspector; on interactive plates `+` / `-` zoom, `0` resets to fit and `[` / `]` set a smaller / larger interface (the chrome floor's size).
- **Zoom and pan** (interactive plates): pinch or ⌘-wheel, drag blank space, the corner control. `zoom: false` turns it off. See "Zoom and pan" above.
- Plates pause rendering off-screen, create their WebGL canvases lazily and release far-away ones (browsers cap live contexts at ~16).
- Reduced motion: no autoplay; the plate shows `static poster`.
