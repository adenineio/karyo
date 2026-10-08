// The structure board: a Karyo model as interactive cards instead of a movie (docs/ENGINE.md,
// "Interactive plates"). It rests on the settled picture and moves only when you change what it
// means: open a card (its panel unfolds in place), drill into a group (the rest folds into a rail),
// pin a legend entry, reset the layout. Under the cards, the legend: categories (each card's
// coloured left edge) and tags (declared in the code, derived from the model, the team's, yours).
// Hovering an entry lights its cards at once; clicking pins it. The board is read-only until you
// enter Bench (`b`, docs/ENGINE.md "Bench"): then cards (and whole groups, by their frame) drag, ⌥/⇧-click picks cards, "+ tag" makes
// a tag from them. Positions come in layers: the viewer's own (localStorage) over the team's
// committed arrangement (karyo.layout.json) over the auto layout. Reset restores positions, never
// content (tags survive).
import { Scene, Morph, draggable, ease, clamp, pickPath, pathCrossings, pickFit, fitScaleOf, wire as wirePath, zoomKeys, type Frame, type Fx, type SceneClass, type Stage, type Vals, type Path, type DockChange, type KeyHelp, type KeyHelpList, DOCK_ICON } from '../engine';
import { checksFor, pairKey, foldView, isImport, hasRuns, type Model, type MNode, type Wire, type MCheck, type NodeKind, type EdgeKind } from './model';
import { groupLabel } from './curation';
import { layout, cardHTML, cardKits, boxOf, cssId, esc, legendHTML, MAP_CSS, CARD_W, CARD_H, SIDE, TOP, type Layout, type CardKits } from './scenes';
import { kitsFor, type KitSet } from '../kits/registry';
import { boardRoute, railRoute, type Rect } from './board-route';
import { arrange, type Arrangement, type ArrangeOpts } from './arrange';
import { callsByPair, wireInfo, wireCardHTML, placeCard, WIRE_CSS, WIRE_CARD_W, NOT_A_WIRE, type WireInfo, type RecordedCall } from './wire-info';
import { emptySplice, spliceOp, applySplice, SPLICE_DIR, type Splice, type SpliceOp, type SpliceMarks, type SplicePlace } from './splice';
import { SpliceSession, listSplices, loadSplice, deleteSplice, viewTarget, SPLICE_CSS, type SpliceView, type SpliceEntry, type SpliceViewState } from './board-splice';
import { spliceStack, SPLICE_STACK_VIEW, type SpliceLayer, type SpliceStack } from './splice-stack';
import { stackView, type StackState } from './stack';
import { StackHost, STACK_HOST_CSS } from './board-stack';
import { modelLegend, litMembers, pinnedMembers, resolveEntry, lineKey, LegendStrip, LEGEND_CSS, type LegendEntry, type LineKeyRow } from './legend';
import { outlineTags, highlightEntry, HIGHLIGHT, inspectorOff, type PlateOutline, type SectionInfo, type DetailsView, type InspectorView } from './outline';
import { separateLanes, lerpPath, type LaneRoute } from './lanes';
import { hierarchy, levelView, planLevel, repOf, clampRect, startView, aggregateInfo, groupCardInner, stubInner, isGroupItem, GPRE, GCARD, OUTSIDE, GROUPS_CSS, bbox, type Hier, type LevelView, type LevelItem, type R } from './board-groups';

export interface TeamTag { id: string; name: string; members: string[] }
/** A committed author arrangement (a karyo.layout.json beside the model). A `bins` key (same shape) is also accepted and read as tags. */
export interface TeamLayout { positions: Record<string, { x: number; y: number }>; tags?: TeamTag[]; bins?: TeamTag[] }
export interface BoardOpts {
  title?: string;
  /** localStorage key: the viewer layer lives at `karyo:board:<key>`. */
  key: string;
  /** The committed author arrangement. */
  layout?: TeamLayout;
  /** Repo-relative path of that file, for the dev-only "Save as team layout" button. */
  layoutFile?: string;
  /** More of a card's details: HTML (one section, "details") or named sections (docs/ENGINE.md "Card details: sections").
   *  They follow the board's own sections (summary, calls, checks). */
  details?: (n: MNode) => string | DetailSection | DetailSection[] | null | undefined;
  /** Extra CSS for what `details` renders. */
  css?: string;
  /** Open in Bench (default true: a structure board is a workbench; a docs page may pass false). */
  benchOpen?: boolean;
  /** Splices (docs/ENGINE.md "Splice"): the model file this board draws (repo-relative, e.g.
   *  `docs/karyo.model.json`). Splices record it as their base and are saved next to it, in `karyo/splices/`
   *  (dev server only). Without it the board still opens splices, but can't save or list them. */
  modelFile?: string;
  /** Example splices for stills and lint: each is a state `splice-<id>` (states()). */
  spliceExamples?: Splice[];
  /** What the example states (stills and lint) lead with: a legend tag to pin (default: the first declared tag) and a
   *  wire to hover and pin, as `from->to` (default: the one with the most recorded calls). */
  lead?: { tag?: string; wire?: string };
  /** More example splices, only for stacks of splices in stills and lint (combined with the first example: states
   *  `splice-stack-<id>`, showing what combining finds). */
  stackExamples?: Splice[];
  /** The kits it draws node kinds with (docs/KITS.md); default: the model's (`kitsFor`). */
  kits?: KitSet;
  /** What it starts on (docs/ENGINE.md "Group navigation"): `groups` (one card per group, entered level by level),
   *  `cards` (every card), or `auto` (the default: the model's `start`, else groups when the board is big). */
  start?: 'auto' | 'groups' | 'cards';
  /** How the groups view draws its wires (docs/ENGINE.md "Group navigation", Lanes): `shared` (the default: wires share
   *  runs, a fan-out leaves on one trunk) or `separate` (every wire on its own track). The viewer's toggle (the Lanes
   *  button, `w`) wins and is remembered per board; the URL's `&lanes=` wins over both. */
  lanes?: LaneMode;
  /** The groups view's count badges say what they count ("14 calls", "1 call") instead of the bare number. Off by
   *  default; the URL's `&units=1` turns it on for a preview. */
  badgeUnits?: boolean;
  /** What a count badge counts, for its unit and the legend's line key: default `call`/`calls` when every relationship
   *  on the level is a call, else `relationship`/`relationships`. */
  countNoun?: { one: string; many: string };
}
/** How a board's groups view routes its wires: sharing runs, or each on its own track. */
export type LaneMode = 'shared' | 'separate';
/** A named part of a card's details. Items inside it (`data-item="<name>"`) are what it counts, reports as
 *  visible or not, and scrolls to. */
export interface DetailSection {
  id: string;
  title: string;
  /** The full rendering: the section view (a roomy inspector) shows this. */
  html: string;
  /** A shorter rendering for the ordinary card panel (default: `html`). */
  compact?: string;
  /** What its items are called ("tools"); default "items". */
  noun?: string;
  /** Other words that name it ("schemas", "inputs"): `openDetails` and Jarvis match them along with the title. */
  keywords?: string[];
}
/** What a page can call on a mounted board (`stage.scene as unknown as BoardApi`). */
export interface BoardApi {
  /** Open that card's panel (stepping out of a drill if the card is folded into the rail). */
  reveal(nodeId: string): void;
  /** Pin exactly this legend entry (a tag id such as `hot-path`, a category `cat:store`, a derived id); null clears every pin. */
  focusTag(tagId: string | null): void;
  /** Close the open panel. */
  close(): void;
  /** Drill into a group: in the groups view, enter it (its own scene slides in; null goes up a level); in the cards
   *  view, its cards fill the board and the rest fold into the rail (null steps out). */
  drill(groupId: string | null): void;
  /** Group navigation (docs/ENGINE.md "Group navigation"): enter a group's own scene (null: the overview of the
   *  top-level groups), switching to the groups view if needed. False for an unknown group. */
  enter(groupId: string | null): boolean;
  /** Up a level (to the enclosing group, then the overview). False at the top or in the cards view. */
  up(): boolean;
  /** Switch between the groups view and every card; false when the board has no groups to show. */
  groupView(view: 'groups' | 'cards'): boolean;
  /** The groups view's lanes: `shared` or `separate` (no argument: the other one); the wires glide to their new routes.
   *  False when the board has no groups to show. */
  setLanes(mode?: LaneMode): boolean;
  /** Where group navigation is: the view, the group entered and its path, what the level shows. */
  level(): BoardLevel;
  /** Light exactly these cards (an ad-hoc pin, replacing the others); null or [] removes it. */
  highlight(nodeIds: string[] | null): void;
  /** Escape: unwind the innermost thing (a pinned wire card, the panel, the pins, the drill, the picked cards). False when there was nothing. */
  back(): boolean;
  /** What is on the plate, as plain data (src/model/outline.ts). */
  describe(): PlateOutline;
  /** Open a card's details: with a section, as a section view (that section large, the others behind a tab row);
   *  without, as the ordinary panel. An unknown section id opens the ordinary panel. */
  openDetails(nodeId: string, section?: string | null): void;
  /** A card's detail sections (ids, titles, keywords, item names). */
  sections(nodeId: string): SectionInfo[];
  /** What the open card's details show right now, measured from the DOM; null when no card is open. */
  detailsView(): DetailsView | null;
  /** Scroll the open details: a page down or up, to the top or bottom, or to an item by name. False when nothing moved or it wasn't found. */
  scrollDetails(to: 'down' | 'up' | 'top' | 'bottom' | { item: string }): boolean;
  /** The pinned inspector (docs/ENGINE.md "Pinned inspector"): pinned or not, locked, its side, and what it shows as measured on screen. */
  inspector(): InspectorView;
  // ---- splices (docs/ENGINE.md "Splice"): a sandbox of proposed changes over this view; the real diagram is never changed
  /** The open splice (its name, how many changes, the last one in words, warnings), or null outside one. */
  spliceView(): SpliceView | null;
  /** Fork exactly this view into a new splice (`title` names it), or open `splice` (e.g. a saved one, `file`: where it is). */
  spliceOpen(o?: { title?: string; splice?: Splice; file?: string | null }): SpliceView;
  /** Open a saved splice by id or title (loose), over the current code. */
  spliceOpenSaved(ref: string): Promise<{ ok: boolean; view?: SpliceView; error?: string }>;
  /** Apply one change. One that can't apply isn't kept (`applied` false; `warnings` say why). Throws outside a splice. */
  spliceOp(op: SpliceOp): { applied: boolean; warnings: string[]; view: SpliceView };
  spliceUndo(): boolean;
  spliceRedo(): boolean;
  /** Save it (named `name`, or as it is named) into the model's `karyo/splices/`. */
  spliceSave(name?: string): Promise<{ ok: boolean; file?: string; error?: string }>;
  /** Back to the real view. False (nothing happens) when there are unsaved changes, unless `force`. */
  spliceLeave(force?: boolean): boolean;
  /** Throw the splice away: its unsaved changes and its saved file. `ok` false (nothing happens) when there is something
   *  to lose, unless `force`; `deleted`: the file it removed. */
  spliceDiscard(force?: boolean): Promise<{ ok: boolean; deleted: string | null; error?: string }>;
  /** The saved splices, each applied over the current code (changes, landed, warnings). */
  spliceList(): Promise<{ ok: boolean; entries: SpliceEntry[]; error?: string }>;
  // ---- a stack of splices (docs/ENGINE.md "Stack of splices"): compare many, edit one at a time
  /** Stack the splices in a Stack view over the board: the real view first, then the saved splices (`names`: only those,
   *  in that order), the open splice's unsaved changes as they are (marked unsaved, never thrown away), and with
   *  `combine` one more, read-only slice combining them in order (true: every splice in the stack; names: those). */
  spliceStack(o?: { names?: string[]; combine?: boolean | string[] }): Promise<{ ok: boolean; view?: SpliceStackView; error?: string }>;
  /** Bring a slice back to the board (a 1-based index, a splice's name, "real" or "combined"): that splice opens, ready
   *  to edit (with any unsaved changes it had); the real view leaves the splice. A combined slice is read-only: it fails
   *  and says which splices to open instead. */
  spliceStackOpen(ref: number | string): { ok: boolean; view?: SpliceView | null; error?: string };
  /** Back to the stack from the board (after opening one of its slices); false when there is no stack to go back to. */
  spliceStackReturn(): boolean;
  /** Leave the stack: the board stays as it is (the splice last opened stays open). */
  spliceStackLeave(): boolean;
  /** The stack: its slices, which one is current, whether it is on screen; null when there is none. */
  spliceStackView(): SpliceStackView | null;
  /** The stack's own plate (a Stack view, `StackApi`) while it is on screen, else null. */
  spliceStackPlate(): unknown | null;
  /** Combine the same splices in the other order (the combined slice's ⇄); fails when nothing is combined. */
  spliceStackSwap(): { ok: boolean; view?: SpliceStackView; error?: string };
  /** Two different proposals with one name (a `same name` item: its 1-based number, or words matching it; default the
   *  first): treat them as the same thing in this combination (`same` false: as different again). Never written to
   *  either splice. */
  spliceStackSame(ref?: number | string, same?: boolean): { ok: boolean; view?: SpliceStackView; error?: string };
}
/** Where group navigation is (docs/ENGINE.md "Group navigation"). */
export interface BoardLevel {
  /** `groups`: one card per group, entered level by level; `cards`: every card. `available` false: the board has no groups to show. */
  view: 'groups' | 'cards';
  available: boolean;
  /** The group entered (null: the overview of the top-level groups, or the cards view). */
  at: string | null;
  /** Labels from the top down, the overview first ("All groups", "App", "Data"). */
  path: string[];
  /** In a splice: the group entered is one the splice proposes. */
  proposed?: boolean;
  /** On this level: its group cards (`proposed`: a splice proposes it), its cards, and the stubs at its edges (inlets call
   *  in, outlets are called). */
  groups: { id: string; label: string; proposed?: boolean }[];
  cards: string[];
  stubs: { id: string; label: string; side: 'in' | 'out'; group: string | null }[];
}
/** A stack of splices as a page (or Jarvis) reads it. Slices are 1-based, as the tabs number them. */
export interface SpliceStackView {
  /** On screen (false: you are on the board, editing one of its slices; Esc goes back to it). */
  shown: boolean;
  cur: number;
  slices: { index: number; title: string; kind: 'real' | 'splice' | 'combined'; unsaved: boolean; changes: number; about: string[]; warning: string | null }[];
  /** What combining found, in words, numbered as the combined slice's header lists them (conflicts first). */
  conflicts: string[];
  /** Each one explained (the words its card shows): its kind (conflict, consequence, order, same name, same thing,
   *  agreed, follows), what it is about, the splices, what each does to it, and what the combination ended up as. */
  explained: { n: number; kind: string; what: string; splices: string[]; parts: { splice: string; does: string }[]; result: string }[];
  /** The combined slice's order ("Caching, then Queueing"), whether the other order gives something else, and
   *  what it gives; null when nothing is combined. */
  order: { now: string[]; other: string[]; matters: boolean; gives: string | null; otherGives: string | null } | null;
  /** The conflict whose card is on screen (lit), 1-based, and whether it is pinned; null when none is. */
  lit: { n: number; pinned: boolean } | null;
  /** A question the stack is asking (the combined slice is read-only …), or null. */
  asking: string | null;
}
export interface BoardState {
  open: string | null;
  /** The open card's section shown as a section view (null: the ordinary panel). */
  section?: string | null;
  drill: string | null;
  /** Pinned legend entries (their union is lit). */
  pins: string[];
  /** Cards picked for "+ tag" (Bench). */
  picked: string[];
  cursor: string | null;
  /** The legend entry under the pointer (lit at once; part of the state so stills can show it). */
  hover?: string | null;
  /** Bench on / off (applied to the stage). */
  bench?: boolean;
  /** The wire under the pointer (its `pairKey`; shown at once, like the legend hover) and where the pointer is. */
  wire?: string | null;
  wireAt?: { x: number; y: number } | null;
  /** The wire whose card is pinned (a click on the wire; Esc or a click elsewhere closes it). */
  wirePin?: string | null;
  /** The open splice (docs/ENGINE.md "Splice"): its name and changes; null in the real view. */
  splice?: { id: string; title: string; ops: SpliceOp[] } | null;
  /** A stack of splices (docs/ENGINE.md "Stack of splices"): the splices in it (ids), the ones combined, the current slice
   *  (0-based) and the tab under the pointer; `shown` false while you edit one of its slices on the board. setState takes
   *  the ids from `spliceExamples`. */
  stack?: { splices: string[]; combine?: string[]; cur?: number; tab?: number | null; shown?: boolean; conflict?: number | null; same?: string[] } | null;
  /** Group navigation (docs/ENGINE.md "Group navigation"): the view (`groups` or every card) and, in groups, the group
   *  entered (null: the overview). Absent on a board with no groups to show; setState without them keeps the start view,
   *  going to the open card's group when one is open. */
  nav?: 'groups' | 'cards';
  at?: string | null;
  /** The groups view's wires: sharing runs or each on its own track (a view preference, like Bench: setState without it
   *  keeps the current one). Absent on a board with no groups to show. */
  lanes?: LaneMode;
}

type XY = { x: number; y: number };
/** An arrangement fitted to a space (`fit`): the drill rail's columns, where the content starts, the legend's room. */
type Fitted = ReturnType<typeof arrange> & { cols: number; top: number; foot: number; w: number; h: number };
interface Viewer { positions: Record<string, XY>; tags: TeamTag[]; lanes?: LaneMode }
interface CardV { x: number; y: number; sx: number; sy: number; o: number; d: number }

const DUR = 0.55;
/** A level of the groups view, fitted to a space, is drawn no larger than this (CSS px per px) unless the whole board is. */
const LEVEL_MAX = 1;
const LEG_H = 150, CHIP_W = 200, CHIP_H = 28, CHIP_GAP = 6, PANEL_W = 380, PANEL_GAP = 14;
const RAIL_GAP = 12;
/** Where a drilled-in group starts, right of the rail (its columns of chips). */
const mainX = (cols: number) => SIDE + cols * CHIP_W + (cols - 1) * RAIL_GAP + 56;
/** The header's depth: the chrome floor draws it k times deeper, and a fitted board leaves the content that much lower. */
const HEAD_D = TOP;
const SEC_MIN_W = 540, SEC_MAX_W = 880, SEC_PAD = 16, SEC_TOP = 76;   // the section view: an inspector docked to one side of the plate
const DIM_OPEN = 0.72, DIM_PIN = 0.25, DIM_HOVER = 0.35, DIM_LEGEND = 0.22, DIM_WIRE = 0.55;

/** A section as the board holds it (DetailSection, normalised). `own`: one of the board's (summary, calls, checks). */
interface Sec { id: string; title: string; html: string; compact?: string; noun: string; keywords: string[]; count: number | null; own: boolean }
const unesc = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!);
/** The item names in a section's HTML (its `data-item` attributes), in order. */
const itemsIn = (html: string) => [...html.matchAll(/data-item="([^"]*)"/g)].map((m) => unesc(m[1]!));
const cssAttr = (s: string) => s.replace(/["\\]/g, '\\$&');
const blank = (): BoardState => ({ open: null, section: null, drill: null, pins: [], picked: [], cursor: null, hover: null, wire: null, wireAt: null, wirePin: null });
const uniq = <T,>(xs: T[]) => [...new Set(xs)];
/** A box as a memo key: exact (a number's string is that number, so equal keys are equal boxes). */
const rectKey = (r: { x: number; y: number; w: number; h: number }) => `${r.x},${r.y},${r.w},${r.h}`;

export function boardScene(model: Model, o: BoardOpts): SceneClass {
  // Each mounted board gets its own closure over the model it draws: a splice (docs/ENGINE.md "Splice") re-derives
  // that model on one plate without touching another plate of the same scene. The first mount uses the class the
  // module already built (its statics are the scene's); later mounts build their own.
  const First = boardClass(model, o);
  let firstUsed = false;
  function Board(this: unknown, stage: Stage) { if (!firstUsed) { firstUsed = true; return new First(stage); } return new (boardClass(model, o))(stage); }
  Object.setPrototypeOf(Board, First);
  Board.prototype = First.prototype;
  return Board as unknown as SceneClass;
}

/** Where a wire's count badge sits (its box, stage px): at the middle of the wire unless that covers a card, a group's
 *  label or another badge, else the nearest place along the wire that is clear (the least covered when none is). `len`:
 *  the count's digits (the badge is 10.5 px monospace, 6 px padding and a border a side). */
export function badgeAt(p: Path, len: number, avoid: Rect[], badges: Rect[], W: number, H: number, soft?: { wires: Path[] }): Rect {
  // (a badge on a lane between rows of cards just meets their edges: up to 0.75 px is touching, not covering; two badges
  // keep 4 px apart)
  const w = 14 + 6.4 * len, h = 18.5;
  const boxAt = (t: number) => { const m = p.at(t); return { x: m.x - 3 - 3.4 * len, y: m.y - 9, w, h }; };
  const over = (b: Rect, r: Rect, M: number) => Math.max(0, Math.min(b.x + w + M, r.x + r.w) - Math.max(b.x - M, r.x)) * Math.max(0, Math.min(b.y + h + M, r.y + r.h) - Math.max(b.y - M, r.y));
  const cover = (b: Rect) => {
    let a = Math.max(0, -b.x) * h + Math.max(0, b.x + w - W) * h + Math.max(0, -b.y) * w + Math.max(0, b.y + h - H) * w;
    for (const r of avoid) a += over(b, r, -0.75);
    for (const r of badges) a += over(b, r, 4);
    return a;
  };
  // softer wishes, after what it covers (separate lanes, or a badge with its unit): keep off other wires, sit on a level run
  // when the pill is wider than it is tall (a long pill across a vertical track covers its neighbours)
  const softCost = (b: Rect, t: number) => {
    if (!soft) return 0;
    let c = 0;
    for (const q of soft.wires) if (pathCrossings(q, [b]) > 0) c++;
    const a = p.at(t);
    if (w > h * 1.6 && Math.abs(Math.sin(a.angle)) > 0.5) c += 0.5;
    return c;
  };
  let best = boxAt(0.5), bc = cover(best), bs = softCost(best, 0.5);
  const ts = [0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.12, 0.88, ...(soft ? [0.46, 0.54, 0.38, 0.62, 0.3, 0.7, 0.22, 0.78, 0.15, 0.85, 0.09, 0.91] : [])];
  for (const t of ts) {
    if (bc === 0 && bs === 0) break;
    const b = boxAt(t), c = cover(b);
    if (c > bc) continue;
    const sc = softCost(b, t);
    if (c < bc || sc < bs) { best = b; bc = c; bs = sc; }
  }
  return best;
}

function boardClass(baseModel: Model, o: BoardOpts) {
  const teamTags: TeamTag[] = (o.layout?.tags ?? o.layout?.bins ?? []).filter((t) => t && typeof t.id === 'string' && Array.isArray(t.members));
  const team = { positions: o.layout?.positions ?? {}, tags: teamTags };
  const gName = (gid: string) => (gid === '·outside' ? 'outside' : groupLabel(model, gid));
  // What the board draws: the model (or, in a splice, the spliced model with ghosts of what it removed) and everything
  // derived from it. `derive` reassigns these; every use reads the current binding.
  let model = baseModel;
  // kit kinds (docs/KITS.md): their cards, sizes, sections and legend entries; the same kits for every model derived here
  const kits = o.kits ?? kitsFor(baseModel);
  let kx!: CardKits;
  let L!: Layout, byId!: Map<string, MNode>, gOf!: Map<string, string>, groups!: Layout['groups'], members!: Map<string, string[]>, groupRank!: Map<string, number>;
  let wires!: Wire[], nbrs!: Map<string, Set<string>>, nodeChecks!: Map<string, MCheck[]>, calls!: Map<string, RecordedCall[]>, wireByKey!: Map<string, Wire>;
  let arrangeOpts!: (cols: number, k: number) => ArrangeOpts, DEFAULT!: ReturnType<typeof arrange>, ML!: ReturnType<typeof modelLegend>;
  /** How many cards the drill rail may hold (every card outside the smallest group). */
  let maxRail = 0;
  /** How the cards view (every card) is arranged: a level of the groups view is never drawn larger than the cards view
   *  would be in the same space. Its sizes per space, memoised. */
  let CARDS: { rail: number; opts: (cols: number, k: number) => ArrangeOpts; memo: Map<string, { w: number; h: number }> } | null = null;
  // Group navigation (docs/ENGINE.md "Group navigation", board-groups.ts): every card of the model (`Lc`, what the cards
  // view draws) and, in the groups view, the level drawn (`LV`: group cards, cards, stubs). In the cards view L is Lc and
  // the real maps are the drawn ones.
  let Lc!: Layout, realById!: Map<string, MNode>, realWires!: Wire[], realWireByKey!: Map<string, Wire>, realNbrs!: Map<string, Set<string>>, realCalls!: Map<string, RecordedCall[]>;
  let hier!: Hier;
  let LV: LevelView | null = null;
  let view: 'groups' | 'cards' = 'cards';
  let at: string | null = null;
  /** In a splice: what each node and relationship is (proposed, removed …), and the labels before a rename. */
  let marks: SpliceMarks | null = null;
  /** What each card folds (docs/MODEL.md "Fold"): the nodes drawn as part of it, e.g. a type's methods. */
  let parts = new Map<string, MNode[]>();
  /** Static analysis contributed relationships (automatic mode): the words say "in the code", not "declared". */
  let statics = false;
  /** The model holds a recorded run (model.ts `hasRuns`): without one, wires are solid and nothing says "not seen". */
  let runs = true;
  const wasLabel = new Map<string, string>(), wasGroup = new Map<string, string>();
  const infoMemo = new Map<string, WireInfo>();
  const label = (id: string) => byId.get(id)?.label ?? realById.get(id)?.label ?? id;
  /** A real card's group (drawn or not). */
  const gOfAny = (id: string) => gOf.get(id) ?? hier.leaf(id);
  /** A card's slot in the auto layout (its column: the map router's layer). Cards sit wherever the morph puts them. */
  const slot = (id: string) => L.pos.get(id)!;
  const nodeMark = (id: string) => marks?.nodes[id] ?? null;
  /** In a splice: a proposed group's placeholder card (it stands for the group until a card is proposed into it). */
  const isPh = (id: string) => !!marks?.placeholders?.[id];
  /** In a splice: a group it proposes. */
  const isPropGroup = (g: string | null | undefined) => !!g && marks?.groups?.[g] === 'proposed';
  const wireMark = (key: string) => LV?.marks.get(key) ?? marks?.edges[key] ?? null;
  /** A group card or a stub on the current level (null: a card, or the cards view). */
  const itemOf = (id: string): LevelItem | null => { const it = LV?.items.get(id); return it && it.role !== 'node' ? it : null; };
  const infoOf = (key: string) => {
    let i = infoMemo.get(key);
    if (!i) {
      const under = LV?.under.get(key);
      i = under ? aggregateInfo(wireByKey.get(key)!, under, calls.get(key) ?? [], label, { runs }) : wireInfo(wireByKey.get(key)!, calls.get(key) ?? [], { label, node: (id) => byId.get(id), statics, runs });
      const m = wireMark(key);
      if (m === 'proposed') i = { ...i, verdictText: 'proposed · not in code yet', at: null, where: under ? i.where : null };
      else if (m) i = { ...i, verdictText: m === 'rerouted' ? 'rerouted in this splice (the proposal replaces this path)' : 'removed in this splice' };
      infoMemo.set(key, i);
    }
    return i;
  };
  function derive(m0: Model, mk: SpliceMarks | null) {
    CARDS = null;
    // folded nodes (a type's methods, until a curation file unfolds them) are drawn as part of their parent;
    // kit kinds (docs/KITS.md) get their default categories
    const fv = foldView(m0);
    const m = kits.decorate(fv.model);
    parts = fv.parts;
    statics = m.edges.some((e) => !isImport(e) && e.sources.includes('extracted'));
    runs = hasRuns(m);
    model = m; marks = mk;
    Lc = layout(m, undefined, 0, 480, kits);
    kx = cardKits(m, kits);
    realById = new Map(Lc.nodes.map((n) => [n.id, n]));
    realWires = Lc.wires;
    realWireByKey = new Map(realWires.map((w) => [w.key, w]));
    realNbrs = new Map<string, Set<string>>(Lc.nodes.map((n) => [n.id, new Set<string>()]));
    for (const w of realWires) { realNbrs.get(w.from)!.add(w.to); realNbrs.get(w.to)!.add(w.from); }
    nodeChecks = new Map(Lc.nodes.map((n) => [n.id, checksFor(m, n.id)]));
    // what each wire means (wire-info.ts): the recorded calls along it, by the relationship they were counted on
    realCalls = callsByPair(m);
    // (a group that goes, e.g. a proposed one when the splice is left: back to the closest group still there)
    const was = at !== null && hier ? hier.chain(at) : [];
    // a group a splice proposes has its card (and its own scene) even before a card is proposed into it
    hier = hierarchy(Lc.nodes, m.groups, mk ? Object.entries(mk.groups ?? {}).filter(([, v]) => v === 'proposed').map(([g]) => g) : []);
    if (at !== null && !hier.all.has(at)) at = was.find((g) => hier.all.has(g)) ?? null;
    if (!hier.available) { view = 'cards'; at = null; }
    wasLabel.clear(); wasGroup.clear();
    if (mk) for (const n of baseModel.nodes) {
      const now = realById.get(n.id);
      if (now && mk.nodes[n.id] === 'renamed' && (n.label ?? n.id) !== (now.label ?? now.id)) wasLabel.set(n.id, n.label ?? n.id);
      if (now && mk.nodes[n.id] === 'moved') wasGroup.set(n.id, n.kind === 'actor' ? 'outside' : n.group ?? 'other');
    }
    // what the model says: categories, declared tags, tags derived at view time (over every card: the same colours on every level)
    const gc = new Map(Lc.nodes.map((n) => [n.id, n.kind === 'actor' ? '·outside' : n.group ?? 'other']));
    ML = modelLegend({
      // (a proposed group's placeholder is no card: it counts in no entry)
      nodes: Lc.nodes.filter((n) => !mk?.placeholders?.[n.id]), wires: realWires, groups: Lc.groups.map((g) => g.id), groupOf: (id) => gc.get(id)!, groupName: gName, statics, runs,
      // cards that ran, but fold parts that never did: a partial run must never read as a complete one
      partly: new Set(Lc.nodes.filter((n) => n.exercised && (parts.get(n.id) ?? []).some((p) => p.exercised === false)).map((n) => n.id)),
      kindEntry: (k) => (kits.kind(k) ? { name: kits.plural(k), glyph: kits.glyph(k) } : null),
      warned: new Set(Lc.nodes.filter((n) => nodeChecks.get(n.id)!.some((c) => c.level === 'warn')).map((n) => n.id)),
    });
    deriveLevel();
  }
  /** What the current level draws: every card (the cards view), or one level of the groups view. */
  function deriveLevel() {
    LV = view === 'groups' ? levelView({ Lc, hier, at, kits, marks }) : null;
    L = LV ? LV.L : Lc;
    byId = LV ? new Map(L.nodes.map((n) => [n.id, n])) : realById;
    gOf = new Map(L.nodes.map((n) => [n.id, n.kind === 'actor' ? '·outside' : n.group ?? 'other']));
    groups = L.groups;
    members = new Map(groups.map((g) => [g.id, L.nodes.filter((n) => gOf.get(n.id) === g.id).map((n) => n.id)]));
    groupRank = new Map(groups.map((g, i) => [g.id, i]));
    // one wire per caller→callee pair (model.ts wiresOf): its kinds, sources, count and verdict; a group's, one per pair of items
    wires = L.wires;
    if (LV) {
      nbrs = new Map<string, Set<string>>(L.nodes.map((n) => [n.id, new Set<string>()]));
      for (const w of wires) { nbrs.get(w.from)!.add(w.to); nbrs.get(w.to)!.add(w.from); }
      wireByKey = new Map(wires.map((w) => [w.key, w]));
      calls = new Map(realCalls);
      for (const [k, ws] of LV.under) calls.set(k, ws.flatMap((w) => realCalls.get(w.key) ?? []));
    } else { nbrs = realNbrs; wireByKey = realWireByKey; calls = realCalls; }
    infoMemo.clear();
    // stage: the auto layout, room for a drilled group beside the rail, the rail itself, the legend
    // the plate around the arranged content (arrange.ts): the legend docks along the bottom, below the body. Fitted to a
    // space (docs/ENGINE.md "Theater"), the rail may wrap into columns, and the legend (and header) take k times their
    // room when the chrome floor draws them k times larger
    const optsOf = (Lx: Layout, level: boolean) => {
      const gs = Lx.groups, n = Lx.nodes.length, inG = (g: Layout['groups'][number]) => Lx.nodes.filter((x) => (x.kind === 'actor' ? '·outside' : x.group ?? 'other') === g.id).length;
      const rail = level ? 0 : Math.max(0, ...gs.map((g) => n - inG(g)));
      const maxGW = level ? 0 : Math.max(0, ...gs.map((g) => g.w)), maxGH = Math.max(0, ...gs.map((g) => g.h));
      return { rail, opts: (cols: number, k: number): ArrangeOpts => {
        const minW = Math.max(960, mainX(cols) + maxGW + SIDE), minBodyH = Math.max(480 - 40, TOP + Math.ceil(rail / cols) * (CHIP_H + CHIP_GAP) + 24, TOP + maxGH + 24);
        return { wires: Lx.wires, padRight: SIDE - 14, padBottom: 24 + LEG_H * k, minW, minH: minBodyH + LEG_H * k };
      } };
    };
    const here = optsOf(L, !!LV);
    maxRail = here.rail;
    arrangeOpts = here.opts;
    DEFAULT = arrange(L, null, arrangeOpts(1, 1));
    if (!CARDS) CARDS = { ...(LV ? optsOf(Lc, false) : here), memo: new Map() };
  }
  derive(baseModel, null);
  // where it starts: the plate's option, the model's `start`, else the groups when the board is big
  const START = startView(o.start, baseModel, hier, Lc.nodes.length);
  const START_AT: string | null = null;
  if (START === 'groups') { view = 'groups'; at = START_AT; deriveLevel(); }
  const SK = `karyo:board:${o.key}`;
  // the groups view's lanes and badge units (docs/ENGINE.md "Group navigation"): a URL flag wins (previews and stills)
  const URLQ = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const URL_LANES: LaneMode | null = URLQ?.get('lanes') === 'separate' ? 'separate' : URLQ?.get('lanes') === 'shared' ? 'shared' : null;
  const UNITS = !!o.badgeUnits || URLQ?.get('units') === '1';
  const isTag = (t: unknown): t is TeamTag => !!t && typeof (t as TeamTag).id === 'string' && typeof (t as TeamTag).name === 'string' && Array.isArray((t as TeamTag).members);
  const loadViewer = (): Viewer => {
    try {
      const v = JSON.parse(localStorage.getItem(SK) ?? 'null');
      // `bins` (the same list under another name) is also accepted
      if (v && typeof v === 'object') return { positions: v.positions ?? {}, tags: (Array.isArray(v.tags) ? v.tags : Array.isArray(v.bins) ? v.bins : []).filter(isTag), ...(v.lanes === 'shared' || v.lanes === 'separate' ? { lanes: v.lanes } : {}) };
    } catch { /* storage unavailable: no viewer layer */ }
    return { positions: {}, tags: [] };
  };
  const DEV_SAVE = !!(import.meta.env?.DEV && o.layoutFile);
  /** Splices are saved next to the model (its folder's `karyo/splices/`), through the dev server. */
  const SPLICE_HOME = o.modelFile ? o.modelFile.replace(/\/?[^/]*$/, '') : null;
  const SPLICE_DIR_REL = SPLICE_HOME !== null ? `${SPLICE_HOME ? `${SPLICE_HOME}/` : ''}${SPLICE_DIR}` : null;
  const DEV = !!import.meta.env?.DEV;
  /** What a splice records as its base: the model file, else the project's name. */
  const o_modelRef = o.modelFile ?? `${baseModel.project ?? 'model'}`;
  const groupHTML = (g: Layout['groups'][number]) => `<div class="mm-group bd-group" id="g-${cssId(g.id)}"><div class="bd-gl"><span class="pl-label">${esc(g.label)}</span><button type="button" class="bd-drill" data-drill="${esc(g.id)}" aria-label="Drill into ${esc(gName(g.id))}" title="Drill into ${esc(gName(g.id))} (l)">⤢</button></div></div>`;
  const chipHTML = (n: MNode) => `<div class="bd-chip" id="h-${cssId(n.id)}" role="button" tabindex="-1" data-node="${esc(n.id)}" title="${esc(label(n.id))}"><span class="nm">${esc(label(n.id))}</span><span class="g">${esc(gName(gOf.get(n.id)!))}</span></div>`;
  /** In a splice, what it does to a card, as its details say it (a proposal is never passed off as code). */
  const spNote = (id: string) => {
    const mk = nodeMark(id);
    if (!mk) return '';
    const t = mk === 'proposed' ? 'proposed in this splice · not in the code yet'
      : mk === 'removed' ? 'removed in this splice · the code still has it'
      : mk === 'renamed' ? `renamed in this splice · the code calls it ${wasLabel.get(id) ?? '?'}`
      : `moved in this splice · the code has it in ${gName(wasGroup.get(id) ?? '?')}`;
    return `<p class="sp-note ${mk}">${esc(t)}</p>`;
  };
  // what a proposed node may be: the model's kinds, then the kits' (docs/KITS.md)
  const NODE_KINDS: NodeKind[] = [...new Set<string>(['service', 'function', 'store', 'queue', 'external', 'actor', ...kits.kinds])] as NodeKind[];
  /** Which marks a splice legend entry lights (its wires). */
  const ENTRY_MARKS: Record<string, string[]> = { 'splice:proposed': ['proposed'], 'splice:removed': ['removed', 'rerouted'], 'splice:changed': [] };

  const CSS = /* css */ `
    .bd-toolbar { position: absolute; right: ${SIDE}px; top: 38px; display: flex; gap: 8px; z-index: 30; }
    .bd-btn { font: 500 11px/1 var(--pl-font-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--pl-fg); background: var(--pl-card); border: 1px solid var(--pl-line); border-radius: min(var(--pl-radius), 6px); padding: 7px 10px; cursor: pointer; white-space: nowrap; }
    .bd-btn:hover { border-color: var(--pl-fg); }
    .bd-btn.is-ok { border-color: var(--pl-accent); color: var(--pl-accent); }
    .bd-btn.is-bad { border-color: var(--pl-accent-2); color: var(--pl-accent-2); }
    .plate-dom button:focus-visible, .plate-dom input:focus-visible, .bd-card:focus-visible, .bd-chip:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: 2px; }
    .mm-group.bd-group { left: 0; top: 0; width: var(--w, 0px); height: var(--h, 0px); pointer-events: none; }
    .bd-group > .bd-gl { position: absolute; left: 12px; top: 4px; display: flex; align-items: center; gap: 4px; pointer-events: auto; }
    .bd-group > .bd-gl > .pl-label { position: static; }
    /* Bench: a group frame (its border, empty area or label) drags the whole group; a wire under the pointer still wins */
    .plate.is-bench .mm-group.bd-group { pointer-events: auto; cursor: grab; transition: border-color 120ms, background-color 120ms; }
    .plate.is-bench .bd-group > .bd-gl > .pl-label { cursor: grab; }
    .plate.is-bench .plate-dom:not(.wh-over):not(.bd-moving):not(.sp-placing):not(.sp-linking) .bd-group:hover, .plate.is-bench .bd-group.is-gdrag { border-color: color-mix(in srgb, var(--pl-accent) 60%, var(--pl-line)); background-color: color-mix(in srgb, var(--pl-accent) 4%, transparent); }
    .plate.is-bench .bd-group.is-gdrag, .plate.is-bench .bd-group.is-gdrag > .bd-gl > .pl-label { cursor: grabbing; }
    .plate-dom.wh-over .bd-group { cursor: pointer; }
    .plate-dom.sp-placing .bd-group, .plate-dom.sp-placing .bd-group > .bd-gl > .pl-label { cursor: copy; }
    .bd-drill { font: 13px/1 var(--pl-font-mono); background: transparent; color: var(--pl-muted); border: 1px solid transparent; border-radius: 4px; padding: 1px 4px; cursor: pointer; }
    .bd-drill:hover { color: var(--pl-fg); border-color: var(--pl-line); }
    .mm-card.bd-card { cursor: grab; user-select: none; touch-action: none; z-index: 2; }
    .mm-card.bd-card.is-open { z-index: 6; }
    .mm-card.bd-card.is-drag { z-index: 9; cursor: grabbing; }
    .mm-card.bd-card.is-cursor { outline: 2px solid var(--pl-accent); outline-offset: 3px; }
    .bd-card .mm-top { justify-content: flex-start; }
    .bd-card .mm-lang { margin-left: auto; }
    .bd-badges { display: flex; gap: 4px; }
    .bd-badge { font: 600 10px/1 var(--pl-font-mono); padding: 2px 5px; border-radius: 999px; white-space: nowrap; }
    .bd-badge.warn { background: var(--pl-accent-2); color: var(--pl-card); }
    .bd-badge.info { border: 1px solid var(--pl-card-border); color: var(--pl-muted); }
    .mm-card.is-actor .bd-badges { position: absolute; right: 10px; top: 8px; }
    .bd-chip { position: absolute; left: 0; top: 0; width: ${CHIP_W}px; height: ${CHIP_H}px; box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 0 10px; background: var(--pl-card); color: var(--pl-fg); border: 1px solid var(--pl-card-border); border-radius: min(var(--pl-radius), 8px); cursor: pointer; z-index: 3; user-select: none; }
    .bd-chip .nm { flex: 1; min-width: 0; font: 600 12px/1 var(--pl-font-display); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bd-chip .g { font: 10px/1 var(--pl-font-mono); color: var(--pl-muted); white-space: nowrap; }
    .bd-chip.is-lit { border-color: var(--pl-accent); }
    .bd-panel { position: absolute; left: 0; top: 0; width: ${PANEL_W}px; max-height: 560px; box-sizing: border-box; z-index: 20; padding: 12px 14px 12px; display: flex; flex-direction: column; gap: 8px; cursor: default; }
    .bd-ph { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .bd-x { font: 16px/1 var(--pl-font); background: transparent; color: var(--pl-muted); border: 1px solid transparent; border-radius: 4px; padding: 2px 7px; cursor: pointer; }
    .bd-x:hover { color: var(--pl-fg); border-color: var(--pl-line); }
    .bd-pt { font: 700 18px/1.2 var(--pl-font-display); }
    .bd-sum { margin: 0; font-size: 13px; line-height: 1.45; }
    .bd-ref { display: flex; align-items: center; gap: 8px; font: 12px/1.3 var(--pl-font-mono); color: var(--pl-muted); }
    .bd-ref code { flex: 1; min-width: 0; overflow-wrap: anywhere; font: inherit; }
    .bd-copy { font: 500 10px/1 var(--pl-font-mono); text-transform: uppercase; letter-spacing: 0.06em; background: transparent; color: var(--pl-muted); border: 1px solid var(--pl-line); border-radius: 4px; padding: 4px 6px; cursor: pointer; }
    .bd-body { position: relative; overflow: auto; overscroll-behavior: contain; min-height: 0; display: grid; gap: 10px; align-content: start; padding-right: 4px; outline: none; }
    .bd-body:focus-visible { box-shadow: inset 0 0 0 2px var(--pl-accent); border-radius: 4px; }
    .bd-sh { display: flex; align-items: center; gap: 6px; }
    .bd-exp { font: 500 10px/1 var(--pl-font-mono); letter-spacing: 0.06em; text-transform: uppercase; background: transparent; color: var(--pl-muted); border: 1px solid var(--pl-line); border-radius: 4px; padding: 3px 6px; cursor: pointer; margin-left: auto; }
    .bd-exp:hover { color: var(--pl-fg); border-color: var(--pl-fg); }
    .bd-sub { margin: 4px 0 1px; }
    .bd-panel.is-section { max-height: none; gap: 10px; padding: 14px 18px 12px; }
    .bd-panel.is-section .bd-pt { font-size: 22px; }
    .bd-panel.is-section .bd-sum { font-size: 14px; }
    .bd-panel.is-section .bd-body { flex: 1; font-size: 15px; gap: 12px; }
    .bd-panel.is-section .bd-edge, .bd-panel.is-section .bd-link { font-size: 14px; }
    .bd-panel.is-section .bd-tag { font-size: 11.5px; }
    .bd-panel.is-section .bd-check { font-size: 14px; }
    .bd-tabs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-bottom: 8px; border-bottom: 1px solid var(--pl-card-border); }
    .bd-tab { font: 500 12px/1 var(--pl-font-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--pl-muted); background: transparent; border: 1px solid var(--pl-line); border-radius: 999px; padding: 6px 10px; cursor: pointer; white-space: nowrap; }
    .bd-tab:hover { color: var(--pl-fg); border-color: var(--pl-fg); }
    .bd-tab[aria-selected="true"] { color: var(--pl-accent); border-color: var(--pl-accent); }
    .bd-tab .c { margin-left: 6px; opacity: 0.75; }
    .bd-tabs .bd-exp { margin-left: auto; }
    .bd-jump { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font: 11px/1 var(--pl-font-mono); color: var(--pl-muted); }
    .bd-jump button { font: 12.5px/1 var(--pl-font-mono); color: var(--pl-muted); background: transparent; border: 1px solid var(--pl-card-border); border-radius: 4px; padding: 4px 6px; cursor: pointer; }
    .bd-jump button:hover { color: var(--pl-fg); border-color: var(--pl-fg); }
    .bd-jump button.is-shown { color: var(--pl-fg); border-color: var(--pl-accent); }
    .bd-more { font: 12px/1.3 var(--pl-font-mono); color: var(--pl-muted); text-align: right; min-height: 14px; }
    .bd-panel.is-docked { position: static; width: auto; height: auto; max-height: none; flex: 1; min-height: 0; z-index: auto; padding: 14px 18px 12px; }
    .bd-dockpin { display: inline-grid; place-items: center; padding: 3px 5px; margin-left: auto; }
    .bd-dockpin + .bd-x { margin-left: 0; }
    .bd-ph > .pl-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .plate-dock button.bd-tab:focus-visible, .plate-dock .bd-body:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: 2px; }
    .bd-sec { display: grid; gap: 3px; }
    .bd-sec > .pl-label { margin: 0 0 2px; }
    .bd-edge { display: flex; align-items: center; gap: 6px; font: 12px/1.3 var(--pl-font-mono); min-width: 0; }
    .bd-link { font: 600 12px/1.3 var(--pl-font); background: none; border: 0; padding: 0; color: var(--pl-fg); cursor: pointer; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .bd-link:hover { color: var(--pl-accent); text-decoration: underline; }
    .bd-glyph { flex: none; width: 18px; height: 0; border-top: 2px solid var(--pl-line); }
    .bd-glyph.dash { border-top-style: dashed; }
    .bd-glyph.idle { border-top-style: dotted; opacity: 0.75; }
    .bd-part { display: flex; align-items: baseline; gap: 8px; font: 12px/1.5 var(--pl-font-mono); }
    .bd-part .bd-tag { font-size: 10px; }
    .bd-part > code { flex: none; }
    .bd-part-at { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bd-glyph.warn { border-color: var(--pl-accent-2); }
    .bd-tag { flex: none; font: 10px/1 var(--pl-font-mono); color: var(--pl-muted); border: 1px solid var(--pl-card-border); border-radius: 999px; padding: 2px 6px; white-space: nowrap; }
    .bd-tag.warn { color: var(--pl-accent-2); border-color: var(--pl-accent-2); }
    .bd-none { font: 12px/1.3 var(--pl-font-mono); color: var(--pl-muted); }
    .bd-check { font-size: 12px; line-height: 1.4; }
    .bd-check b { font: 600 11px/1 var(--pl-font-mono); color: var(--pl-muted); margin-right: 4px; }
    .bd-check.warn b { color: var(--pl-accent-2); }
    .bd-foot { position: absolute; left: ${SIDE}px; right: ${SIDE}px; bottom: 14px; height: ${LEG_H - 18}px; box-sizing: border-box; border-top: 1px dashed var(--pl-line); padding-top: 10px; display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto auto; column-gap: 32px; row-gap: 8px; z-index: 4; }
    .bd-foot > .lg { grid-column: 1; }
    .bd-foot .lg-cats .lg-list { --lg-max-h: 28px; }
    .bd-mode { grid-column: 1; font: 12px/1.3 var(--pl-font-mono); color: var(--pl-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bd-mode::before { content: '▸ '; color: var(--pl-accent); }
    .bd-foot .mm-legend { position: static; grid-column: 2; grid-row: 1 / span 2; align-content: start; padding-top: 6px; }
    /* the groups view's line key: what a count on a wire means, and what a wire looping back means */
    .mm-legend .bd-lk[hidden] { display: none; }
    .bd-foot .mm-legend.has-lk { padding-top: 0; gap: 3px; line-height: 1.15; height: 0; overflow: visible; }
    .mm-legend i.lk-n { width: 26px; height: auto; box-sizing: border-box; border: 1px solid var(--pl-line); border-radius: 999px; padding: 0; text-align: center; font: 600 9px/10px var(--pl-font-mono); font-style: normal; color: var(--pl-muted); background: var(--pl-bg); }
    .mm-legend i.lk-back { width: 26px; height: 8px; box-sizing: border-box; border: 2px solid var(--pl-line); border-top: 0; border-radius: 0 0 10px 10px; }
    .mm-legend i.lk-back.is-left { height: 0; border: 0; border-top: 2px solid var(--pl-line); border-radius: 0; position: relative; }
    .mm-legend i.lk-back.is-left::before { content: ''; position: absolute; left: -2px; top: -5px; border: 4px solid transparent; border-left: 0; border-right: 6px solid var(--pl-line); }
    .bd-lgs { display: flex; flex-wrap: wrap; gap: 4px; }
    .bd-lgs .lg-e { height: 22px; font-size: 11px; padding: 0 7px; }
    .bd-toolbar [hidden] { display: none; }
    .plate:not(.is-bench) .mm-card.bd-card { cursor: pointer; }
    .mm-card.bd-card.is-picked { outline: 2px dashed var(--pl-accent); outline-offset: 3px; }
    .bd-chip.is-picked { outline: 2px dashed var(--pl-accent); outline-offset: 2px; }
    ${LEGEND_CSS}
    ${WIRE_CSS}
    ${SPLICE_CSS}
    ${STACK_HOST_CSS}
    ${GROUPS_CSS}
    ${kits.css()}
    ${o.css ?? ''}
  `;

  const railOrderOf = (drill: string | null, pos: (id: string) => XY) =>
    drill === null ? new Map<string, number>() : new Map(L.nodes.filter((n) => gOf.get(n.id) !== drill)
      .sort((a, b) => groupRank.get(gOf.get(a.id)!)! - groupRank.get(gOf.get(b.id)!)! || pos(a.id).y - pos(b.id).y || pos(a.id).x - pos(b.id).x)
      .map((n, i) => [n.id, i]));

  return class BoardScene extends Scene implements BoardApi {
    static title = o.title ?? `${model.project ?? 'Project'}: structure board`;
    static width = DEFAULT.W;
    static height = DEFAULT.H;
    static duration = DUR;
    static interactive = true;
    static bench = true;
    static benchOpen = o.benchOpen ?? true;
    static inspector = true;
    static fx = 'under' as const;

    private morph = new Morph();
    private pm = new Morph();
    /** Where bands sit for the space the plate has (the page: the default; the theater: fitted to the window). */
    private arr: Arrangement = DEFAULT.a;
    private W = DEFAULT.W;
    private H = DEFAULT.H;
    private get bodyH() { return this.H - this.fitted.foot; }
    private fitMemo = new Map<string, Fitted>();
    /** How the board is fitted to its space: the rail's columns, how far down the content starts, the legend's room. */
    private fitted: Fitted = { ...DEFAULT, cols: 1, top: TOP, foot: LEG_H, w: DEFAULT.W, h: DEFAULT.H };
    private st: BoardState = blank();
    // ---- group navigation (docs/ENGINE.md "Group navigation")
    /** Where items that left with the last change of level are going (they fade there). */
    private levelGone = new Map<string, Vals>();
    /** The last level's wires, drawn fading while the change of level runs. */
    private prevWires: Wire[] = [];
    /** The count badges on wires that stand for several relationships, by wire key. */
    private wnEl = new Map<string, HTMLElement>();
    private scopedMemo: { src: LegendEntry[]; lv: LevelView | null; out: LegendEntry[] } | null = null;
    private viewBtns: { groups: HTMLButtonElement; cards: HTMLButtonElement } | null = null;
    private viewer: Viewer = loadViewer();
    /** The groups view's wires: sharing runs (the default) or each on its own track. The URL wins, then the viewer's
     *  remembered choice (never in export mode: stills don't depend on a browser profile), then the board's option. */
    private lanes: LaneMode = URL_LANES ?? ((!this.stage.isExport && this.viewer.lanes) || o.lanes || 'shared');
    /** A change of lanes glides the wires over one transition: from the routes of that mode, or (a change while gliding)
     *  from the paths on screen when it began. */
    private laneFrom: { mode: LaneMode; paths?: Map<string, Path> } | null = null;
    private laneBtn: HTMLButtonElement | null = null;
    private hover: string | null = null;
    private drag: { id: string; start: XY; cur: XY } | null = null;
    /** Bench: a group dragged by its frame: where each (unfolded) member started, and the delta so far (the same for all). */
    private gdrag: { gid: string; start: Map<string, XY>; d: XY } | null = null;
    /** The click that ends a group drag lands on the plate: it is not a click on a wire or on empty space. */
    private eatClick = false;
    private drillOff: XY = { x: 0, y: 0 };
    private panelFor: string | null = null;
    private panelBuilt: string | null = null;
    /** The visible items as last measured (a scroll that changes them redraws). */
    private shownSig: string | null = null;
    private legend!: LegendStrip;
    /** The wires as last drawn (hit testing: which wire is under the pointer). */
    private wirePaths = new Map<string, Path>();
    /** Each wire's route as last drawn, with the inputs it was routed from (`routeKey`). A route is a pure function of
     *  them, so while they are unchanged (at rest, a hover, zoom and pan) it is reused instead of routed again. */
    private routeMemo = new Map<string, { k: string; p: Path }>();
    /** The cards' boxes free routing kept out from behind last frame, and a number that changes whenever they do. */
    private obstacleSig = '';
    private obstacleGen = 0;
    private wireCardFor = '';
    private entryList: LegendEntry[] = [];
    /** The ad-hoc entry `highlight()` pins (not drawn in the legend strip). */
    private spot: LegendEntry | null = null;
    private el!: { panel: HTMLElement; mode: HTMLElement; reset: HTMLButtonElement; save: HTMLButtonElement | null };
    /** The pinned inspector (docs/ENGINE.md "Pinned inspector"): the card it is locked on (and its section) … */
    private dockLock: { id: string; sec: string } | null = null;
    /** … the section it showed last (the next card opens on it when it has one), and what its DOM was built for. */
    private dockSec: string | null = null;
    private dockBuilt: string | null = null;
    // ------------------------------------------------------------------ splice (docs/ENGINE.md "Splice")
    /** The open splice, or null in the real view (which a splice never changes). */
    private sp: SpliceSession | null = null;
    /** It was given a name (or opened from a file); an untitled one asks for a name when saved. */
    private spNamed = false;
    /** Ids with DOM: what is drawn now, and what a splice took away (faded out, hidden, ready to come back). */
    private cardDom = new Set<string>();
    private groupDom = new Set<string>();
    /** The space the plate was last laid out for (null: the page). */
    private space: { w: number; h: number } | null = null;
    /** Placing a node from the palette: the next click says where it goes. */
    private placing: { label: string; kind: NodeKind; category?: string; group?: boolean } | null = null;
    /** Dragging from a card's handle to another card: a proposed relationship. */
    private linking: { from: string; at: XY; over: string | null } | null = null;
    private renaming: string | null = null;
    /** The banner asks for a name, or to confirm throwing changes away. */
    private spAsk: 'name' | 'discard' | 'leave' | null = null;
    /** What the last splice action said (saved, a warning): shown in the banner for a moment. */
    private spMsg: { text: string; bad: boolean } | null = null;
    private spMsgTimer: ReturnType<typeof setTimeout> | 0 = 0;
    // ---- a stack of splices (docs/ENGINE.md "Stack of splices")
    /** The stack: its layers (the splices in it, each with its live session when it has one), what it combines, the slices
     *  built from them and the one you are on. It outlives the stack's plate while you edit one of its slices. */
    private stk: { layers: (SpliceLayer & { file: string | null; session: SpliceSession | null })[]; combine: number[]; built: SpliceStack; cur: number; same: string[] } | null = null;
    /** The stack's plate over the board, while it shows. */
    private host: StackHost | null = null;
    /** The host fades in (opening) or out (a slice went back to the board, or the stack was left) over one transition. */
    private hostFade: 'in' | 'out' | null = null;
    /** Splice sessions with unsaved changes you stepped away from through the stack (by file, or `open:<id>`): kept, never
     *  silently thrown away, and shown as "unsaved" the next time the stack is built or that splice opens. */
    private stash = new Map<string, SpliceSession>();
    /** How many splices are saved next to the model (null: not asked yet): the Stack buttons need one. */
    private savedCount: number | null = null;
    private spEl!: { title: HTMLElement; sub: HTMLElement; warn: HTMLElement; msg: HTMLElement; name: HTMLInputElement; ask: HTMLElement; q: HTMLElement; yes: HTMLButtonElement; acts: HTMLElement; save: HTMLButtonElement; stack: HTMLButtonElement; add: HTMLButtonElement; gadd: HTMLButtonElement; pal: HTMLFormElement; rename: HTMLInputElement; btn: HTMLButtonElement | null; list: HTMLButtonElement | null; pop: HTMLElement | null };

    // ------------------------------------------------------------------ layers & tags
    private saveViewer() { try { localStorage.setItem(SK, JSON.stringify(this.viewer)); } catch { /* not persisted */ } }
    /** Where a card rests in the arrangement for the current space (the auto layout, fitted to the plate's aspect). */
    private home(id: string): XY { return this.arr.pos.get(id)!; }
    /** A card's size (a kit kind's own, docs/KITS.md). */
    private box(id: string) { return boxOf(L, id); }
    private clampCard(p: XY, body = true, b: { w: number; h: number } = { w: CARD_W, h: CARD_H }): XY { return { x: clamp(p.x, 8, this.W - b.w - 8), y: clamp(p.y, 8, (body ? this.bodyH : this.H) - b.h - 8) }; }
    /** Where a card's position is kept: its id in the cards view; per level in the groups view (a level is its own scene). */
    private posKey(id: string) { return LV ? `@${at ?? ''}|${id}` : id; }
    /** Where a card rests when nothing is drilled: viewer → team → auto. */
    private pos(id: string): XY {
      const p = this.stored(id);
      return (p && this.stale().get(this.posKey(id)) !== p ? p : null) ?? this.home(id);
    }
    /** A card's kept position (the splice's, the viewer's, the team's), if it has one. */
    private stored(id: string): XY | undefined {
      const k = this.posKey(id);
      return LV ? this.sp?.positions[k] ?? this.viewer.positions[k] : this.sp?.positions[k] ?? this.viewer.positions[k] ?? team.positions[k];
    }
    /** Positions made on this plate (a drag, a card placed): always kept, whatever they cover. */
    private made = new WeakSet<XY>();
    private madeHere<T extends XY>(p: T): T { this.made.add(p); return p; }
    private staleFor = { sig: '', keys: new Map<string, XY>() };
    /** Kept positions that no longer fit (docs/ENGINE.md "Theater"): a position is in stage px of the arrangement it was
     *  made in, and the plate may since be arranged for another space (a splice saved in one window, opened in another).
     *  When a position loaded with the page or the splice, not moved since, now falls outside the plate or onto another
     *  card, every loaded position of its source (the splice's, the viewer's, the team's) is set aside for the cards'
     *  places in this arrangement. Positions made on this plate are always kept. Returns them by key. */
    private stale(): Map<string, XY> {
      const srcs: Record<string, XY>[] = [this.sp?.positions, this.viewer.positions, team.positions].filter((x): x is Record<string, XY> => !!x);
      const sig = `${this.arr.key}|${this.W}x${this.H}|${view}|${at}|${L.nodes.length}|${srcs.map((s) => Object.keys(s).length).join(',')}|${this.sp?.splice.id ?? ''}`;
      if (sig === this.staleFor.sig) return this.staleFor.keys;
      const old = (p: XY) => !this.made.has(p);
      // a source's loaded positions were made together, for one arrangement: when one of them no longer fits, they all
      // give way to this arrangement (a mix would put the splice's cards half here, half there), and again for the next
      // source whose positions the cards now at home would cover
      const keys = new Map<string, XY>(), off = new Set<Record<string, XY>>();
      const hit = (a: Rect, b: Rect) => a.x < b.x + b.w + 4 && b.x < a.x + a.w + 4 && a.y < b.y + b.h + 4 && b.y < a.y + a.h + 4;
      const srcOf = (id: string) => { const k = this.posKey(id); return srcs.find((src) => src[k] !== undefined && (LV ? src !== team.positions : true)); };
      for (let pass = 0; pass <= srcs.length; pass++) {
        const raw = new Map<string, { r: Rect; src: Record<string, XY> | null }>();
        for (const n of L.nodes) {
          const p = keys.has(this.posKey(n.id)) ? undefined : this.stored(n.id), b = this.box(n.id), q = p ?? this.home(n.id);
          // (a position moved on this plate is never set aside, and a card dropped over one moves nothing)
          if (q) raw.set(n.id, { r: { x: q.x, y: q.y, w: b.w, h: b.h }, src: p && old(p) ? srcOf(n.id) ?? null : null });
        }
        let more = false;
        for (const [id, v] of raw) {
          if (!v.src || off.has(v.src)) continue;
          const c = this.clampCard(v.r, true, v.r);
          const out = Math.abs(c.x - v.r.x) > 1 || Math.abs(c.y - v.r.y) > 1;
          if (out || [...raw].some(([o, w]) => o !== id && (w.src || !this.stored(o) || keys.has(this.posKey(o))) && hit({ ...c, w: v.r.w, h: v.r.h }, w.r))) { off.add(v.src); more = true; }
        }
        if (!more) break;
        for (const n of L.nodes) { const k = this.posKey(n.id), p = this.stored(n.id), src = srcOf(n.id); if (p && src && off.has(src) && old(p)) keys.set(k, p); }
      }
      this.staleFor = { sig, keys };
      return keys;
    }
    private folded(id: string) { return this.st.drill !== null && gOf.get(id) !== this.st.drill; }
    /** Where a (not folded) card rests in the current view. */
    private placed(id: string): XY {
      const p = this.pos(id);
      return this.st.drill ? this.clampCard({ x: p.x + this.drillOff.x, y: p.y + this.drillOff.y }, true, this.box(id)) : this.clampCard(p, true, this.box(id));
    }
    private computeDrillOff(g: string): XY {
      const ps = members.get(g)!.map((id) => this.pos(id));
      return { x: mainX(this.fitted.cols) + 14 - Math.min(...ps.map((p) => p.x)), y: this.fitted.top + 22 - Math.min(...ps.map((p) => p.y)) };
    }
    /** Your tags, minus any the team file already carries (after "Save as team layout"). */
    private mine() { return this.viewer.tags.filter((t) => !team.tags.some((x) => x.id === t.id)); }
    /** Every legend entry: categories, then tags (declared, derived, the team's, yours). */
    private rebuildEntries() {
      const known = (ids: string[]) => uniq(ids).filter((id) => byId.has(id));
      this.entryList = [
        ...ML.categories, ...this.spliceEntries(), ...ML.kinds, ...ML.declared, ...ML.derived,
        ...team.tags.map((t): LegendEntry => ({ id: t.id, name: t.name, kind: 'team', hint: 'team tag (committed layout)', members: known(t.members) })),
        ...this.mine().map((t): LegendEntry => ({ id: t.id, name: t.name, kind: 'mine', hint: 'your tag (this browser)', members: known(t.members) })),
      ];
      this.st.pins = this.st.pins.filter((p) => this.entries().some((e) => e.id === p));
      if (this.st.hover && !this.entryList.some((e) => e.id === this.st.hover)) this.st.hover = null;
    }
    private entries() { const es = this.spot ? [...this.entryList, this.spot] : this.entryList; return LV ? this.scoped(es) : es; }
    private entry(id: string | null | undefined) { return id ? (LV ? this.scoped(this.entryList) : this.entryList).find((e) => e.id === id) : undefined; }
    /** The groups view: each entry's cards inside the level, lighting what draws them (a card, or the group card it is
     *  in); its count says how many cards. Entries with nothing on the level go (your and the team's tags stay). */
    private scoped(es: LegendEntry[]): LegendEntry[] {
      const memo = this.scopedMemo;
      if (memo && memo.src === es && memo.lv === LV) return memo.out;
      const lv = LV!, inside = new Set(hier.under(at));
      const out = es.flatMap((e): LegendEntry[] => {
        const real = e.members.filter((id) => inside.has(id));
        if (!real.length && e.kind !== 'team' && e.kind !== 'mine' && e.id !== HIGHLIGHT) return [];
        return [{ ...e, members: uniq(real.map((id) => lv.rep.get(id) ?? id).filter((id) => byId.has(id))), count: e.count ?? real.length }];
      });
      this.scopedMemo = { src: es, lv: LV, out };
      return out;
    }
    private renderLegend() {
      this.rebuildEntries();
      const list = LV ? this.scoped(this.entryList) : this.entryList;
      const cats = list.filter((e) => e.kind === 'category');
      this.legend.render(cats, list.filter((e) => e.kind !== 'category'));
      this.panelBuilt = null;
    }

    // ------------------------------------------------------------------ targets
    private targets(): Map<string, Vals> {
      const m = new Map<string, Vals>();
      const rail = railOrderOf(this.st.drill, (id) => this.pos(id));
      const pinned = pinnedMembers(this.entries(), this.st.pins);
      const near = this.st.open ? new Set([this.st.open, ...nbrs.get(this.st.open)!]) : null;
      for (const n of L.nodes) {
        const d = pinned ? (pinned.has(n.id) ? 1 : DIM_PIN) : near ? (near.has(n.id) ? 1 : DIM_OPEN) : 1;
        const ri = rail.get(n.id);
        if (ri !== undefined) {
          // the rail: one column on the page; fitted to a wide window, as many as keep it within the body
          const rows = Math.ceil(Math.max(1, maxRail) / this.fitted.cols), col = Math.floor(ri / rows);
          const cx = SIDE + col * (CHIP_W + RAIL_GAP), cy = this.fitted.top + (ri % rows) * (CHIP_H + CHIP_GAP), b = this.box(n.id);
          m.set(`c:${n.id}`, { x: cx + CHIP_W / 2 - b.w / 2, y: cy + CHIP_H / 2 - b.h / 2, sx: CHIP_W / b.w, sy: CHIP_H / b.h, o: 0, d });
          m.set(`h:${n.id}`, { x: cx, y: cy, o: 1, d });
        } else {
          const p = this.placed(n.id), b = this.box(n.id);
          m.set(`c:${n.id}`, { x: p.x, y: p.y, sx: 1, sy: 1, o: 1, d });
          m.set(`h:${n.id}`, { x: p.x + b.w / 2 - CHIP_W / 2, y: p.y + b.h / 2 - CHIP_H / 2, o: 0, d });
        }
      }
      return this.goneTargets(m);
    }
    /** Cards with DOM that the drawn model no longer has: they fade where they are. */
    private goneTargets(m: Map<string, Vals>) {
      for (const id of this.cardDom) {
        if (byId.has(id)) continue;
        const t = this.levelGone.get(id) ?? this.morph.target(`c:${id}`);
        if (t) m.set(`c:${id}`, { ...t, o: 0 });
      }
      return m;
    }
    private ptargets() { return new Map<string, Vals>([['p', { o: this.st.open ? 1 : 0 }]]); }
    /** Change of meaning: glide from what's on screen to the new resting layout. */
    private go() { this.morph.retarget(this.targets()); this.pm.retarget(this.ptargets()); this.stage.transition(); }
    private snapAll() { this.morph.snap(this.targets()); this.pm.snap(this.ptargets()); }

    // ------------------------------------------------------------------ actions
    private open(id: string) {
      if (itemOf(id)) { this.enterItem(id); return; }
      if (!byId.has(id)) { if (realById.has(id)) this.reveal(id); return; }
      if (this.st.open === id) return this.close();
      if (this.st.open) this.pm.snap(new Map([['p', { o: 0 }]]));   // the old panel folds away at once; the new one unfolds from its card
      this.st.open = id; this.st.section = null; this.panelFor = id; this.st.cursor = id;
      this.go();
    }
    close() { if (!this.st.open) return; this.st.open = null; this.st.section = null; this.go(); }
    drill(groupId: string | null) {
      if (!LV) { this.drillTo(groupId); return; }
      if (groupId === null) { this.up(); return; }
      this.enter(groupId);
    }
    highlight(nodeIds: string[] | null) {
      const ids = uniq((nodeIds ?? []).filter((id) => realById.has(id)));
      // the groups view: go to the level that holds them all (one group's cards: inside it)
      if (LV && ids.length) { const lv = this.levelFor(ids); if (lv !== at) this.navTo('groups', lv); }
      const had = this.st.pins.includes(HIGHLIGHT);
      this.spot = ids.length ? highlightEntry(ids) : null;
      if (!ids.length && !had) return;
      this.st.pins = ids.length ? [HIGHLIGHT] : this.st.pins.filter((p) => p !== HIGHLIGHT);
      this.go();
    }
    describe(): PlateOutline {
      return {
        kind: 'board', title: BoardScene.title,
        // the groups view: every card of the model (Jarvis finds a card in another group and goes there) and every group
        // (a proposed group's placeholder is its empty state, not a card)
        nodes: Lc.nodes.filter((n) => !isPh(n.id)).map((n) => ({ id: n.id, label: label(n.id), group: gOfAny(n.id) ?? null, category: n.category ?? null, tags: [...(n.tags ?? [])], ...(nodeMark(n.id) ? { mark: nodeMark(n.id)! } : {}) })),
        groups: (LV ? [...hier.all].sort().map((g) => ({ id: g, label: hier.path(g).join(' / ') })) : groups.map((g) => ({ id: g.id, label: gName(g.id) }))).map((g) => (isPropGroup(g.id) ? { ...g, mark: 'proposed' } : g)),
        tags: outlineTags(this.entries()),
        steps: [],
      };
    }
    reveal(nodeId: string) {
      if (itemOf(nodeId) && isGroupItem(nodeId)) { this.enterItem(nodeId); return; }
      if (!realById.has(nodeId)) return;
      // the groups view: a card on another level (or a stub here) is opened where it is drawn as itself
      if (LV && LV.items.get(nodeId)?.role !== 'node') this.navTo('groups', hier.levelOf(nodeId));
      if (this.folded(nodeId)) this.st.drill = null;
      if (this.st.open === nodeId && !this.st.section) { this.go(); return; }
      if (this.st.open) this.pm.snap(new Map([['p', { o: 0 }]]));
      this.st.open = nodeId; this.st.section = null; this.panelFor = nodeId; this.st.cursor = nodeId;
      this.go();
    }
    focusTag(tagId: string | null) {
      const id = tagId === null ? null : resolveEntry(this.entries(), tagId);
      if (tagId !== null && !id) return;
      const pins = id ? [id] : [];
      if (JSON.stringify(pins) === JSON.stringify(this.st.pins)) return;
      this.st.pins = pins;
      this.go();
    }
    /** Click on a legend entry: pin it, or unpin it (several pins show their union). */
    private togglePin(id: string) {
      const e = this.entry(id);
      if (!e) return;
      this.st.pins = this.st.pins.includes(id) ? this.st.pins.filter((p) => p !== id) : [...this.st.pins, id];
      this.go();
    }
    private setHover(id: string | null) {
      if (this.drag || this.gdrag) return;
      if (id === this.st.hover) return;
      this.st.hover = id;
      this.stage.redraw();
    }
    private drillTo(g: string | null) {
      if (g === this.st.drill || (g !== null && !members.has(g))) return;
      this.st.drill = g;
      if (g) this.drillOff = this.computeDrillOff(g);
      if (this.st.cursor && this.folded(this.st.cursor)) this.st.cursor = null;
      this.go();
    }
    // ------------------------------------------------------------------ group navigation (docs/ENGINE.md "Group navigation")
    enter(groupId: string | null): boolean {
      if (!hier.available) return false;
      if (groupId === null) { this.navTo('groups', null); return true; }
      const g = hier.all.has(groupId) ? groupId : isGroupItem(groupId) && hier.all.has(groupId.slice(GPRE.length)) ? groupId.slice(GPRE.length) : null;
      if (g === null) return false;
      this.navTo('groups', g);
      return true;
    }
    up(): boolean {
      if (!LV || at === null) return false;
      this.navTo('groups', hier.parent(at));
      return true;
    }
    groupView(v: 'groups' | 'cards'): boolean {
      if (!hier.available) return false;
      if (v === view) return true;
      // to the groups: the level of the open card, else the overview
      const o = this.st.open;
      this.navTo(v, v === 'groups' && o ? hier.levelOf(o) : null);
      return true;
    }
    level(): BoardLevel {
      const path = view === 'groups' ? ['All groups', ...hier.path(at)] : [];
      const its = LV ? [...LV.items.values()] : [];
      return {
        view, available: hier.available, at: LV ? at : null, path, ...(LV && isPropGroup(at) ? { proposed: true } : {}),
        groups: its.filter((it) => it.role === 'group').map((it) => ({ id: it.ref, label: hier.label(it.ref), ...(isPropGroup(it.ref) ? { proposed: true } : {}) })),
        cards: (LV ? its.filter((it) => it.role === 'node').map((it) => it.id) : L.nodes.map((n) => n.id)).filter((id) => !isPh(id)),
        stubs: its.filter((it) => it.role.startsWith('stub')).map((it) => ({ id: it.id, label: label(it.id), side: it.side!, group: it.role === 'stub-group' ? it.ref : null })),
      };
    }
    /** A click (or Enter) on a group card goes into it; on a stub, across to what it stands for. */
    private enterItem(id: string) {
      const it = itemOf(id);
      if (!it) return;
      if (it.role === 'stub-node') { this.navTo('groups', hier.levelOf(it.ref)); this.st.cursor = it.ref; this.stage.redraw(); return; }
      this.navTo('groups', it.ref);
    }
    /** The level that holds every one of these cards as itself, or the closest one above them. */
    private levelFor(ids: string[]): string | null {
      const chains = ids.map((id) => { const l = hier.levelOf(id); return l === null ? [] : hier.chain(l); });
      return chains[0]!.find((g) => chains.every((c) => c.includes(g))) ?? null;
    }
    /** What a drawn item stands for: its real cards. */
    private membersOf(id: string): string[] { return LV?.items.get(id)?.members ?? [id]; }
    /** Change level (or view) as a move of the camera, from what is on screen: see `planLevel`. `play` false: set it up
     *  without starting the transition (setState: the caller renders t); `snap`: land at once. */
    private navTo(v: 'groups' | 'cards', a: string | null, o: { play?: boolean; snap?: boolean } = {}) {
      if (v === 'cards') a = null;
      if (a !== null && !hier.all.has(a)) return;
      if (v === view && a === at) return;
      if (!hier.available && v === 'groups') return;
      // what is on screen now, in client px (the plate may change size: the new level is laid out on its own)
      const Z0 = this.stage.zoom || 1, o0 = this.stage.toStage(0, 0), ox0 = -o0.x * Z0, oy0 = -o0.y * Z0;
      const before = new Map<string, { r: R; o: number; members: string[]; box: { w: number; h: number } }>();
      for (const id of this.cardDom) {
        if (!byId.has(id)) continue;
        const val = this.morph.value(`c:${id}`) as unknown as CardV | undefined;
        if (!val || val.o < 0.02) continue;
        const b = this.box(id), w = b.w * val.sx, h = b.h * val.sy;
        before.set(id, { r: { x: ox0 + (val.x + b.w / 2 - w / 2) * Z0, y: oy0 + (val.y + b.h / 2 - h / 2) * Z0, w: w * Z0, h: h * Z0 }, o: val.o, members: this.membersOf(id), box: b });
      }
      const oldLV = LV, oldAt = at, oldView = view, oldWires = wires;
      view = v; at = a;
      deriveLevel();
      this.fitMemo.clear();
      // the new level fitted like any other (the window's shape, the chrome floor's room)
      const r = this.fitFor(this.space, this.chromeK);
      this.arr = r.a; this.W = r.W; this.H = r.H; this.fitted = r;
      this.levelGone.clear();
      this.syncCards();
      this.fixState();
      this.renderLegend();
      this.panelBuilt = null; this.dockBuilt = null; this.wireCardFor = '';
      // the new level at rest first (a refit draws a frame); what is on screen was measured above
      this.morph.snap(this.targets()); this.pm.snap(this.ptargets());
      if (this.stage.view.zoomed) this.stage.view.reset();
      this.stage.refit(this.space);
      if (o.snap) { this.prevWires = []; this.snapAll(); this.stage.redraw(); return; }
      // client px → the new level's stage px
      const s1 = (this.stage.viewport.clientWidth || this.stage.W) / this.stage.W, Zs = this.stage.zoom || 1, o1 = this.stage.toStage(0, 0);
      const ox1 = -o1.x * Zs, oy1 = -o1.y * Zs;
      const toNew = (q: R): R => ({ x: (q.x - ox1) / s1, y: (q.y - oy1) / s1, w: q.w / s1, h: q.h / s1 });
      const tg = this.targets();
      const after = new Map<string, { r: R; members: string[] }>();
      for (const n of L.nodes) { const t = tg.get(`c:${n.id}`)!, b = this.box(n.id); after.set(n.id, { r: { x: t.x!, y: t.y!, w: b.w, h: b.h }, members: this.membersOf(n.id) }); }
      const bef = new Map([...before].map(([id, x]) => [id, { r: toNew(x.r), o: x.o, members: x.members }]));
      // the camera: entering a group, its card becomes the new scene; going up, the scene becomes its card; across, the stub
      const inner = (lv: LevelView | null, m: Map<string, { r: R }>) => bbox([...m].filter(([id]) => { const it = lv?.items.get(id); return !it || !it.role.startsWith('stub'); }).map(([, x]) => x.r));
      const repIn = (lv: LevelView | null, g: string) => { const m = hier.under(g)[0]; return m === undefined ? undefined : lv ? lv.rep.get(m) : m; };
      let focus: { from: R; to: R } | null = null;
      if (oldView === 'groups' && v === 'groups' && oldAt !== a) {
        const deeper = a !== null && (oldAt === null || hier.chain(a).includes(oldAt));
        const higher = oldAt !== null && (a === null || hier.chain(oldAt).includes(a));
        if (deeper || (!higher && a !== null)) { const fid = repIn(oldLV, a!), from = fid ? bef.get(fid)?.r : undefined, to = inner(LV, after); if (from && to) focus = { from, to }; }
        if (!focus && oldAt !== null) { const tid = repIn(LV, oldAt), to = tid ? after.get(tid)?.r : undefined, from = inner(oldLV, bef); if (from && to) focus = { from, to }; }
      }
      const bounds = { x: 8, y: 8, w: this.W - 16, h: this.bodyH - 16 };
      const plan = planLevel({ before: bef, after, focus, bounds });
      const vals = (q: R, b: { w: number; h: number }, op: number, d: number): Vals => ({ x: q.x + q.w / 2 - b.w / 2, y: q.y + q.h / 2 - b.h / 2, sx: q.w / b.w, sy: q.h / b.h, o: op, d });
      const now = new Map<string, Vals>();
      for (const n of L.nodes) {
        const t = tg.get(`c:${n.id}`)!, st = plan.start.get(n.id)!;
        now.set(`c:${n.id}`, vals(st.r, this.box(n.id), st.o, t.d!));
        now.set(`h:${n.id}`, { ...tg.get(`h:${n.id}`)!, o: 0 });
      }
      for (const [id, q] of plan.gone) {
        // (from inside the new stage: a smaller plate may not reach where it was)
        const b = before.get(id)!.box, x = bef.get(id)!;
        now.set(`c:${id}`, vals(clampRect(x.r, bounds), b, x.o, 1));
        this.levelGone.set(id, vals(q, b, 0, 1));
      }
      this.morph.snap(now);
      const keys = new Set(wires.map((w) => w.key));
      this.prevWires = oldWires.filter((w) => !keys.has(w.key));
      this.morph.retarget(this.targets()); this.pm.retarget(this.ptargets());
      if (o.play !== false) this.stage.transition();
    }
    /** A group card's content: its cards and subgroups, categories, a few members, and the wires into and out of it. */
    private groupData(it: LevelItem) {
      const ms = it.members.filter((id) => realById.has(id) && !isPh(id));
      const cats = new Map<string, { slot: number; name: string; n: number }>();
      for (const id of ms) { const c = realById.get(id)!.category; if (!c) continue; const e = cats.get(c) ?? cats.set(c, { slot: ML.slotOf.get(id) ?? 0, name: c, n: 0 }).get(c)!; e.n++; }
      const deg = (id: string) => realNbrs.get(id)?.size ?? 0;
      const headline = [...ms].filter((id) => nodeMark(id) !== 'removed').sort((x, y) => deg(y) - deg(x) || label(x).localeCompare(label(y))).slice(0, 3).map(label);
      const n = (w: Wire) => LV?.under.get(w.key)?.length ?? 1;
      const io = (ws: Wire[], end: (w: Wire) => string) => ws.map((w) => [label(end(w)), n(w)] as [string, number]).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
      return {
        label: hier.label(it.ref), cards: ms.length, groups: hier.children(it.ref).length,
        cats: [...cats.values()].sort((x, y) => y.n - x.n || x.name.localeCompare(y.name)), headline,
        ins: io(wires.filter((w) => w.to === it.id), (w) => w.from), outs: io(wires.filter((w) => w.from === it.id), (w) => w.to),
        proposed: ms.filter((id) => nodeMark(id) === 'proposed').length, proposedGroup: isPropGroup(it.ref),
      };
    }
    private togglePick(id: string) {
      if (!this.stage.inBench || itemOf(id)) return;
      const c = this.st.picked;
      this.st.picked = c.includes(id) ? c.filter((x) => x !== id) : [...c, id];
      this.stage.redraw();
    }
    private resetLayout() {
      if (this.sp) this.sp.positions = {};
      else { this.viewer.positions = {}; this.saveViewer(); }
      if (this.st.drill) this.drillOff = this.computeDrillOff(this.st.drill);
      this.go();
    }
    private createTag(name: string) {
      if (!this.st.picked.length) { this.stage.viewport.focus({ preventScroll: true }); this.stage.redraw(); return; }
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tag';
      let id = `mine-${slug}`;
      for (let i = 2; this.entries().some((e) => e.id === id); i++) id = `mine-${slug}-${i}`;
      this.viewer.tags.push({ id, name, members: [...this.st.picked] });
      this.st.picked = [];
      this.saveViewer();
      this.renderLegend();
      this.stage.viewport.focus({ preventScroll: true });
      this.stage.redraw();
    }
    private deleteTag(id: string) {
      this.viewer.tags = this.viewer.tags.filter((t) => t.id !== id);
      this.saveViewer();
      const wasPinned = this.st.pins.includes(id);
      if (this.st.hover === id) this.st.hover = null;
      this.renderLegend();
      if (wasPinned) this.go(); else this.stage.redraw();
    }
    private async saveTeam(btn: HTMLButtonElement) {
      const positions: Record<string, XY> = {};
      for (const n of Lc.nodes) { const p = this.viewer.positions[n.id] ?? team.positions[n.id]; if (p) positions[n.id] = { x: Math.round(p.x), y: Math.round(p.y) }; }
      const tags: TeamTag[] = [
        ...team.tags.map((t) => ({ id: t.id, name: t.name, members: [...t.members] })),
        ...this.mine().map((t) => ({ id: t.id, name: t.name, members: [...t.members] })),
      ];
      let ok = false, msg = 'save failed';
      try {
        const r = await fetch(`/__karyo/layout?file=${encodeURIComponent(o.layoutFile!)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ positions, tags }) });
        ok = r.ok; msg = ok ? `saved to ${o.layoutFile!.split('/').pop()}` : `save failed (${r.status})`;
      } catch { /* dev server unreachable */ }
      btn.textContent = msg;
      btn.classList.toggle('is-ok', ok); btn.classList.toggle('is-bad', !ok);
      setTimeout(() => { btn.textContent = 'Save as team layout'; btn.classList.remove('is-ok', 'is-bad'); }, 2200);
    }
    /** Cards you can step through, in reading order. */
    private readingOrder() {
      const t = this.targets();
      return L.nodes.filter((n) => !this.folded(n.id)).map((n) => {
        const v = t.get(`c:${n.id}`)!;
        return { id: n.id, x: v.x!, y: v.y! };
      }).sort((a, b) => Math.round(a.y / 40) - Math.round(b.y / 40) || a.x - b.x).map((p) => p.id);
    }
    private moveCursor(step: number) {
      const ids = this.readingOrder();
      if (!ids.length) return;
      const i = this.st.cursor ? ids.indexOf(this.st.cursor) : -1;
      this.st.cursor = ids[i < 0 ? (step > 0 ? 0 : ids.length - 1) : (i + step + ids.length) % ids.length]!;
      if (document.activeElement !== this.stage.viewport) this.stage.viewport.focus({ preventScroll: true });
      this.stage.redraw();
    }
    /** Bench on / off (from the stage): leaving Bench drops a drag and the picked cards. */
    setBench(on: boolean) {
      if (!on) { this.st.picked = []; if (this.drag || this.gdrag) { this.drag = null; this.gdrag = null; this.snapAll(); } }
    }
    /** Theater relayout (docs/ENGINE.md "Theater"): bands arranged for the window's aspect, and the drill rail wrapped
     *  into the columns that use it best (`pickFit`); null = the page's default. With `chrome` (the chrome floor draws
     *  chrome that much larger) the legend and the header get that much more room, so they cover no card at fit.
     *  The arrangement is where cards rest; the viewer's own positions still win, and Reset returns to it. */
    fit(space: { w: number; h: number } | null, o?: { chrome?: number }) {
      this.space = space ? { w: space.w, h: space.h } : null;
      this.chromeK = Math.max(1, Math.round((o?.chrome ?? 1) * 100) / 100);
      const r = this.fitFor(this.space, this.chromeK);
      if (r.a.key !== this.arr.key || r.W !== this.W || r.H !== this.H || r.cols !== this.fitted.cols || r.top !== this.fitted.top) {
        this.arr = r.a; this.W = r.W; this.H = r.H; this.fitted = r;
        this.drag = null; this.gdrag = null;
        if (this.st.drill) this.drillOff = this.computeDrillOff(this.st.drill);
        this.snapAll();
      }
      this.host?.refit(this.W, this.H);
      return { w: this.W, h: this.H };
    }
    private chromeK = 1;
    /** The cards view's plate for a space (the rail in the columns that fit it best), as `fitFor` lays it out. */
    private cardsSize(space: { w: number; h: number }, k: number, top: number): { w: number; h: number } {
      const C = CARDS!, key = `${Math.round(space.w)}x${Math.round(space.h)}@${k}`;
      let r = C.memo.get(key);
      if (r) return r;
      const make = (cols: number) => { const x = arrange(Lc, space, C.opts(cols, k)); return { w: x.W, h: x.H + top }; };
      const cands = [make(1)];
      for (let c = 2; c <= 4 && Math.ceil(C.rail / c) < Math.ceil(C.rail / (c - 1)); c++) cands.push(make(c));
      r = pickFit(space, cands);
      C.memo.set(key, r);
      return r;
    }
    private fitFor(space: { w: number; h: number } | null, k: number): Fitted {
      const key = `${space ? `${Math.round(space.w)}x${Math.round(space.h)}` : 'page'}@${k}`;
      let r = this.fitMemo.get(key);
      if (r) return r;
      const top = Math.round(HEAD_D * (k - 1));
      const make = (cols: number): Fitted => {
        const x = !space && cols === 1 && k === 1 ? DEFAULT : arrange(L, space, arrangeOpts(cols, k));
        // the content starts `top` lower: below the header the floor draws deeper
        const a = top ? { ...x.a, pos: new Map([...x.a.pos].map(([id, p]) => [id, { ...p, y: p.y + top }])), bottom: x.a.bottom + top } : x.a;
        return { a, W: x.W, H: x.H + top, cols, top: TOP + top, foot: LEG_H * k, w: x.W, h: x.H + top };
      };
      // the rail in 1 … 4 columns (each one fewer row than the last), on the page in one
      const cands = [make(1)];
      if (space) for (let c = 2; c <= 4 && Math.ceil(maxRail / c) < Math.ceil(maxRail / (c - 1)); c++) cands.push(make(c));
      r = space ? pickFit(space, cands) : cands[0]!;
      // a level of the groups view (a few group cards) fitted to a large space would be drawn far past its designed size:
      // it is drawn no larger than its designed size (1 CSS px per px) or the whole board's scale in that space, whichever
      // is larger, on a plate that fills the space, its content in the middle; so a level never looks zoomed in
      if (LV && space && CARDS) {
        const ref = Math.max(LEVEL_MAX, fitScaleOf(space, this.cardsSize(space, k, top)));
        if (fitScaleOf(space, r) > ref * 1.01) {
          const W2 = Math.ceil(space.w / ref), H2 = Math.ceil(space.h / ref);
          const dx = Math.round((W2 - r.W) / 2), dy = Math.round((H2 - r.H) / 2);
          const a = { ...r.a, pos: new Map([...r.a.pos].map(([id, p]) => [id, { ...p, x: p.x + dx, y: p.y + dy }])), right: r.a.right + dx, bottom: r.a.bottom + dy };
          r = { ...r, a, W: W2, H: H2, w: W2, h: H2 };
        }
      }
      this.fitMemo.set(key, r);
      return r;
    }

    // ------------------------------------------------------------------ build
    build(dom: HTMLElement) {
      const langs = [...new Set((model.producers ?? []).map((p) => p.lang))].join(' + ');
      const kinds = NODE_KINDS.map((k) => `<option value="${k}">${k}</option>`).join('');
      dom.innerHTML = `<style>${MAP_CSS}${CSS}</style>
        <header class="mm-head" data-pl-chrome><div class="pl-label">Structure board${langs ? ` · from ${esc(langs)} code` : ''}</div><h1 class="pl-title">${esc(o.title ?? `How ${model.project ?? 'the project'} fits together`)}</h1>${hier.available ? '<nav class="bd-crumbs" aria-label="Group levels" hidden></nav>' : ''}</header>
        <div class="bd-toolbar" data-pl-chrome><button type="button" class="bd-btn sp-add" data-sp="palette" hidden title="Propose a new node (n): name it, then click where it goes">+ node</button><button type="button" class="bd-btn sp-add" data-sp="gpalette" hidden title="Propose a new group: name it, then click where it goes (empty space: here · a group card: inside it · a card: an outlet of it)">+ group</button><button type="button" class="bd-btn" data-reset title="Put every card back where the team layout (or the auto layout) has it. Tags are kept.">Reset layout</button>${DEV_SAVE ? `<button type="button" class="bd-btn" data-save title="Write positions and tags to ${esc(o.layoutFile!)} (dev server only)">Save as team layout</button>` : ''}</div>
        <form class="pl-card sp-pal" data-pl-chrome="bare" style="right:${SIDE}px" hidden aria-label="Propose a node">
          <div class="pl-label sp-pal-h">propose a node</div>
          <input type="hidden" name="replaces"><input type="hidden" name="mode">
          <label>label <input name="label" required autocomplete="off" placeholder="e.g. Cache"></label>
          <label class="sp-nodeonly">kind <select name="kind">${kinds}</select></label>
          <label class="sp-nodeonly">category <input name="category" autocomplete="off" list="sp-cats" placeholder="optional"></label>
          <datalist id="sp-cats"></datalist>
          <div class="sp-row"><button type="button" class="bd-btn" data-sp="palclose">Cancel</button><button type="submit" class="bd-btn is-ok">Place it</button></div>
          <p class="sp-hint sp-nodeonly">then click a wire to put it between its two cards · ⇧-click a card: before it · ⌥-click: after it · click a card: it calls the new one · click empty space: drop it there · to swap a card for a new one, select it and press r</p>
          <p class="sp-hint sp-grouponly">then click where it goes: empty space: a group here · a group card: a group inside it · a card: an outlet of that card (it calls the new group)</p>
        </form>
        <div class="pl-card bd-panel" id="bd-panel" role="dialog" aria-label="Details"></div>
        <div class="pl-card wh-card" id="wh-card" role="status" aria-live="polite"></div>
        <input class="sp-rename" hidden aria-label="New name (Enter proposes it, Esc cancels)">
        <div class="sp-frame" data-pl-chrome="overlay" aria-hidden="true"></div>
        <div class="sp-banner" data-pl-chrome role="region" aria-label="Splice: proposed changes only">
          <span class="sp-tag">Splice</span><span class="sp-title"></span><span class="sp-sub"></span><span class="sp-warn" hidden></span><span class="sp-msg" aria-live="polite"></span>
          <input class="sp-name" hidden aria-label="Name this splice" placeholder="name it, then Enter">
          <span class="sp-ask" hidden><span class="sp-q"></span><button type="button" class="bd-btn" data-sp="yes"></button><button type="button" class="bd-btn" data-sp="no">Keep</button></span>
          <span class="sp-acts"><button type="button" class="bd-btn" data-sp="stack" title="Compare the saved splices in a Stack view (⇧S)">Stack</button><button type="button" class="bd-btn is-primary" data-sp="save">Save</button><button type="button" class="bd-btn" data-sp="discard" title="Throw this splice away (its saved file too)">Discard</button><button type="button" class="bd-btn" data-sp="leave" title="Back to the real view">Leave</button></span>
        </div>
        <div class="bd-foot" data-pl-chrome>
          <div class="bd-mode" aria-live="polite"></div>
          <div class="mm-legend">${legendHTML(model)}<span class="bd-lk" data-lk="n" hidden><i class="lk-n" aria-hidden="true">N</i><span class="t"></span></span><span class="bd-lk" data-lk="back" hidden><i class="lk-back" aria-hidden="true"></i><span class="t"></span></span></div>
        </div>`;
      const q = <T extends HTMLElement>(s: string) => dom.querySelector<T>(s)!;
      this.el = { panel: q('#bd-panel'), mode: q('.bd-mode'), reset: q<HTMLButtonElement>('[data-reset]'), save: dom.querySelector<HTMLButtonElement>('[data-save]') };
      const foot = q('.bd-foot');
      this.legend = new LegendStrip(foot, {
        onHover: (id) => this.setHover(id),
        onToggle: (id) => this.togglePin(id),
        onDelete: (id) => this.deleteTag(id),
        onCreate: (name) => this.createTag(name),
      });
      foot.prepend(this.legend.el);
      this.buildSpliceChrome(dom);
      this.buildViewToggle();
      this.syncCards();
      this.renderLegend();
      // wires: hover shows what one means, a click pins that card (docs/ENGINE.md "Wire hover")
      dom.addEventListener('pointermove', (e) => this.wireMove(e));
      this.stage.viewport.addEventListener('pointerleave', () => { if (this.st.wire) { this.st.wire = null; this.st.wireAt = null; this.stage.redraw(); } });
      dom.addEventListener('click', (e) => this.wireClick(e));
      // the details scroll under the wheel / trackpad; the wheel never reaches the page (or the plate) from here
      this.el.panel.addEventListener('wheel', (e) => {
        e.stopPropagation();
        const b = (e.target as HTMLElement).closest<HTMLElement>('.bd-body');
        const dy = e.deltaY;
        if (!b || (dy < 0 && b.scrollTop <= 0) || (dy > 0 && b.scrollTop + b.clientHeight >= b.scrollHeight - 1) || b.scrollHeight <= b.clientHeight) e.preventDefault();
      }, { passive: false });
      dom.addEventListener('click', (e) => this.onDetailsClick(e, false));
      // the pinned inspector's content is the same details, outside the plate: the same clicks, the same wheel
      const dock = this.stage.dock;
      if (dock) {
        dock.body.addEventListener('click', (e) => this.onDetailsClick(e, true));
        dock.body.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
      }
      this.snapAll();
    }

    /** "Groups / All cards" in the plate's actions row (docs/ENGINE.md "Group navigation"), where the board has groups. */
    private buildViewToggle() {
      if (!hier.available) return;
      const wrap = document.createElement('span');
      wrap.className = 'bd-viewtg';
      wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-label', 'View');
      const mk = (v: 'groups' | 'cards', text: string, title: string) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'plate-btn'; b.textContent = text; b.title = title;
        b.addEventListener('click', () => { this.groupView(v); this.stage.viewport.focus({ preventScroll: true }); });
        wrap.append(b); return b;
      };
      const groupsB = mk('groups', 'Groups', 'One card per group: click one to go into it (g)'), cards = mk('cards', 'All cards', 'Every card on one board (g)');
      if (this.stage.addAction(wrap)) this.viewBtns = { groups: groupsB, cards };
      // the groups view's lanes: wires sharing runs, or each on its own track
      const lb = document.createElement('button'); lb.type = 'button'; lb.className = 'plate-btn bd-lanes';
      lb.addEventListener('click', () => { this.setLanes(); this.stage.viewport.focus({ preventScroll: true }); });
      if (this.stage.addAction(lb)) { this.laneBtn = lb; this.syncLaneBtn(); }
    }
    private syncLaneBtn() {
      const b = this.laneBtn;
      if (!b) return;
      const sep = this.lanes === 'separate', text = `Lanes: ${this.lanes}`;
      if (b.textContent !== text) b.textContent = text;
      const pressed = String(sep);
      if (b.getAttribute('aria-pressed') !== pressed) b.setAttribute('aria-pressed', pressed);
      const title = sep ? 'Each wire on its own track. Click for shared lanes: wires share runs, a quieter picture (w)' : 'Wires share runs (a quieter picture). Click for separate lanes: each wire on its own track, easy to follow by eye (w)';
      if (b.title !== title) b.title = title;
      if (b.hidden !== !LV) b.hidden = !LV;
    }
    /** The groups view's lanes (docs/ENGINE.md "Group navigation"): `shared` or `separate`, or the other one. The wires glide
     *  to their new routes over one transition; the choice is remembered for this board. */
    setLanes(m?: LaneMode): boolean {
      if (!hier.available) return false;
      const next: LaneMode = m ?? (this.lanes === 'shared' ? 'separate' : 'shared');
      if (next === this.lanes) return true;
      // changed while gliding: from the paths on screen, so nothing jumps
      const gliding = !!this.laneFrom && this.stage.t < this.stage.duration;
      this.laneFrom = gliding ? { mode: this.lanes, paths: new Map(this.wirePaths) } : { mode: this.lanes };
      this.lanes = next;
      this.viewer.lanes = next; this.saveViewer();
      this.syncLaneBtn();
      if (LV) this.stage.transition(); else { this.laneFrom = null; this.stage.redraw(); }
      return true;
    }
    // ------------------------------------------------------------------ cards' DOM (a splice adds cards, and takes them away again)
    private cardEl(id: string) { return this.stage.dom.querySelector<HTMLElement>(`#${cssId(id)}`); }
    /** Every group and card of the drawn model has DOM (a card, its rail chip, its group's frame), filled for what it is
     *  now. DOM for what a splice took away stays, faded out and hidden, so it can come back where it was. */
    private syncCards() {
      const dom = this.stage.dom, at = this.el.panel;
      const add = (html: string) => { const t = document.createElement('template'); t.innerHTML = html; dom.insertBefore(t.content, at); };
      for (const g of groups) {
        if (!this.groupDom.has(g.id)) { add(groupHTML(g)); this.groupDom.add(g.id); this.wireGroup(g.id); continue; }
        const l = dom.querySelector<HTMLElement>(`#g-${cssId(g.id)} .bd-gl > .pl-label`);
        if (l && l.textContent !== g.label) l.textContent = g.label;
      }
      for (const n of L.nodes) {
        if (!this.cardDom.has(n.id)) {
          if (!this.cardEl(n.id)) add(cardHTML(n, kx).replace('class="pl-card', 'style="left:0;top:0" class="pl-card bd-card') + chipHTML(n));
          this.cardDom.add(n.id);
          this.wireCard(n.id);
        }
        this.fillCard(n);
      }
      // the groups view: a count badge on each wire that stands for several relationships
      if (LV) for (const k of LV.under.keys()) if (!this.wnEl.has(k)) { const e = document.createElement('span'); e.className = 'bd-wn'; e.setAttribute('aria-hidden', 'true'); dom.insertBefore(e, at); this.wnEl.set(k, e); }
      const cats = this.stage.dom.querySelector('#sp-cats');
      if (cats) cats.innerHTML = ML.categories.filter((e) => e.id !== 'cat:·other').map((e) => `<option value="${esc(e.name)}">`).join('');
    }
    /** A card's content for what it is now: its label, category edge, check badges and, in a splice, what the splice does to it. */
    private fillCard(n: MNode) {
      const card = this.cardEl(n.id)!, chip = this.stage.dom.querySelector<HTMLElement>(`#h-${cssId(n.id)}`)!;
      const it = itemOf(n.id);
      if (it) { this.fillItem(card, chip, n, it); return; }
      const mk = nodeMark(n.id), ph = isPh(n.id);
      const sig = JSON.stringify([n.label, n.kind, n.group, n.category, mk, ph, wasLabel.get(n.id), wasGroup.get(n.id), ML.slotOf.get(n.id), nodeChecks.get(n.id)!.length, n.exercised]);
      if (card.dataset.sig === sig) return;
      card.dataset.sig = sig;
      // back from a group card or a stub (the groups view): the card's own look and size
      if (card.classList.contains('bd-gcard') || card.classList.contains('bd-stub')) { card.classList.remove('bd-gcard', 'bd-stub'); card.style.width = ''; card.style.height = ''; }
      card.classList.toggle('sp-ph', ph);
      if (ph) {
        // a proposed group's empty state: no cards yet, and how to add one (its relationships wait on it)
        const gl = hier.label(n.group ?? '');
        card.innerHTML = `<div class="mm-top"><span class="mm-name">No cards yet</span><span class="sp-badge proposed">proposed</span></div><div class="sp-empty">say “add a card called …” or press n</div>`;
        card.title = `${gl}: a proposed group with no cards yet`;
        for (const c of ['is-ext', 'is-actor', 'is-idle', 'sp-removed', 'sp-renamed', 'sp-moved']) card.classList.remove(c);
        card.classList.add('sp-proposed');
        card.setAttribute('aria-label', `${gl}: a proposed group with no cards yet`);
        delete card.dataset.cat;
        const nm = chip.querySelector('.nm')!, g = chip.querySelector('.g')!;
        nm.textContent = `${gl} (empty)`; g.textContent = gName(gOf.get(n.id)!); chip.title = gl;
        return;
      }
      const t = document.createElement('template');
      t.innerHTML = cardHTML(n, kx);
      const fresh = t.content.firstElementChild as HTMLElement;
      card.innerHTML = fresh.innerHTML;
      card.title = fresh.getAttribute('title') ?? '';
      for (const c of ['is-ext', 'is-actor']) card.classList.toggle(c, fresh.classList.contains(c));
      card.classList.toggle('is-idle', n.exercised === false);
      for (const m of ['proposed', 'removed', 'renamed', 'moved']) card.classList.toggle(`sp-${m}`, mk === m);
      card.setAttribute('aria-label', `${n.kind} ${label(n.id)}${mk ? ` (${mk} in this splice)` : ''}${n.exercised === false ? ' (not exercised by the recorded runs)' : ''}`);
      const slot = ML.slotOf.get(n.id);
      if (slot !== undefined) card.dataset.cat = String(slot); else delete card.dataset.cat;
      const top = card.querySelector('.mm-top'), ref = card.querySelector<HTMLElement>('.mm-ref');
      const cs = nodeChecks.get(n.id)!, warn = cs.filter((c) => c.level === 'warn').length, info = cs.length - warn;
      if (cs.length) {
        const b = document.createElement('span');
        b.className = 'bd-badges';
        b.innerHTML = `${warn ? `<span class="bd-badge warn" title="${warn} warning(s)">⚠ ${warn}</span>` : ''}${info ? `<span class="bd-badge info" title="${info} note(s)">ⓘ ${info}</span>` : ''}`;
        (top ?? card).append(b);
      }
      // in a splice: a badge, and the reference line says what the splice does (a proposal has no code to point at)
      if (mk) {
        const b = document.createElement('span');
        b.className = `sp-badge ${mk}`;
        b.textContent = mk;
        if (top) top.insertBefore(b, top.querySelector('.mm-lang')); else card.append(b);
        if (ref) {
          ref.classList.toggle('sp-new', mk === 'proposed'); ref.classList.toggle('sp-was', mk === 'renamed');
          if (mk === 'proposed') ref.textContent = 'not in the code yet';
          else if (mk === 'removed') ref.textContent = 'removed in this splice';
          else if (mk === 'renamed') ref.innerHTML = `was <s>${esc(wasLabel.get(n.id) ?? '')}</s>`;
          else if (mk === 'moved') ref.textContent = `moved here from ${gName(wasGroup.get(n.id) ?? '')}`;
        }
      }
      const h = document.createElement('span');
      h.className = 'sp-handle';
      h.title = 'Drag to another card to propose a relationship';
      card.append(h);
      const nm = chip.querySelector('.nm')!, g = chip.querySelector('.g')!;
      nm.textContent = label(n.id); g.textContent = gName(gOf.get(n.id)!); chip.title = label(n.id);
    }
    /** A group card or a stub (the groups view): what it stands for, at its own size. */
    private fillItem(card: HTMLElement, chip: HTMLElement, n: MNode, it: LevelItem) {
      const stub = it.role !== 'group', g = it.role === 'group' || it.role === 'stub-group';
      const real = realById.get(it.ref);
      const html = it.role === 'group' ? groupCardInner(this.groupData(it))
        : stubInner({ kind: g ? 'group' : real?.kind ?? 'card', label: g ? hier.label(it.ref) : label(it.ref), side: it.side ?? 'in', ...(g ? { cards: it.members.filter((id) => realById.has(id) && !isPh(id)).length } : {}), proposed: g ? isPropGroup(it.ref) : nodeMark(it.ref) === 'proposed' });
      const b = this.box(n.id);
      const sig = `lv|${it.role}|${b.w}x${b.h}|${html}`;
      if (card.dataset.sig === sig) return;
      card.dataset.sig = sig;
      card.innerHTML = html;
      for (const c of ['is-ext', 'is-actor', 'is-idle', 'sp-proposed', 'sp-removed', 'sp-renamed', 'sp-moved', 'sp-ph']) card.classList.remove(c);
      card.classList.toggle('bd-gcard', !stub); card.classList.toggle('bd-stub', stub);
      card.classList.toggle('sp-proposed', g ? isPropGroup(it.ref) : nodeMark(it.ref) === 'proposed');
      card.style.width = `${b.w}px`; card.style.height = `${b.h}px`;
      const slotN = !g ? ML.slotOf.get(it.ref) : undefined;
      if (slotN !== undefined) card.dataset.cat = String(slotN); else delete card.dataset.cat;
      const name = g ? hier.label(it.ref) : label(it.ref);
      card.title = it.role === 'group' ? `${name}: go into this group (Enter)` : `${it.side === 'in' ? 'calls in' : 'called from here'}: ${name} · click to go across`;
      const pg = g && isPropGroup(it.ref) ? 'proposed ' : '';
      card.setAttribute('aria-label', it.role === 'group' ? `${pg}group ${name}, ${it.members.filter((id) => !isPh(id)).length} cards: go into it` : `${it.side === 'in' ? 'inlet' : 'outlet'} ${pg}${name}: go across to it`);
      const nm = chip.querySelector('.nm')!, gg = chip.querySelector('.g')!;
      nm.textContent = name; gg.textContent = gName(gOf.get(n.id)!); chip.title = name;
    }
    /** A card's (and its chip's) listeners: open, pick, drag, hover, focus; in a splice, the connect handle and rename. */
    private wireCard(id: string) {
      const card = this.cardEl(id)!, chip = this.stage.dom.querySelector<HTMLElement>(`#h-${cssId(id)}`)!;
      card.dataset.node = id;
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-expanded', 'false');
      const press = (e: MouseEvent) => this.cardPress(id, e);
      draggable(card, this.stage, {
        onClick: press,
        // the connect handle is its own gesture
        handle: (e) => !(e.target as HTMLElement).closest('.sp-handle'),
        // read-only outside Bench: a press that moves is neither a drag nor a click
        onStart: () => { if (!this.stage.inBench || this.folded(id) || !byId.has(id)) return; const p = this.placed(id); this.drag = { id, start: p, cur: p }; this.hover = null; this.st.hover = null; },
        onMove: ({ dx, dy }) => {
          if (!this.drag) return;
          this.drag.cur = this.clampCard({ x: this.drag.start.x + dx, y: this.drag.start.y + dy }, true, this.box(this.drag.id));
          this.stage.redraw();
        },
        onEnd: () => this.drop(),
      });
      card.addEventListener('pointerdown', (e) => { if ((e.target as HTMLElement).closest('.sp-handle')) this.startLink(id, e); });
      card.addEventListener('dblclick', (e) => { if (this.sp && this.stage.inBench && !itemOf(id) && (e.target as HTMLElement).closest('.mm-name')) this.startRename(id); });
      card.addEventListener('pointerenter', () => { if (!this.drag && !this.gdrag && byId.has(id)) { this.hover = id; this.stage.redraw(); } });
      card.addEventListener('pointerleave', () => { if (this.hover === id) { this.hover = null; this.stage.redraw(); } });
      card.addEventListener('focus', () => { if (byId.has(id)) { this.st.cursor = id; this.stage.redraw(); } });
      chip.addEventListener('click', press);
      chip.addEventListener('pointerenter', () => { if (!this.drag && !this.gdrag && byId.has(id)) { this.hover = id; this.stage.redraw(); } });
      chip.addEventListener('pointerleave', () => { if (this.hover === id) { this.hover = null; this.stage.redraw(); } });
    }
    /** A click on a card: placing a proposed node (where it goes), selecting by its name in a splice, picking (⌥/⇧ in Bench), else open. */
    private cardPress(id: string, e: MouseEvent) {
      if (!byId.has(id)) return;
      // placing a proposed group: a group card is where it goes (inside it), a card makes it that card's outlet
      if (this.sp && this.placing?.group) {
        const it = itemOf(id);
        if (it?.role === 'group') this.placeGroup({ into: it.ref });
        else if (it?.role === 'stub-group') this.flash('that is a group outside this one: click empty space, a group card here, or a card', true);
        else if (isPh(id)) this.placeGroup({});
        else if (nodeMark(it?.ref ?? id) === 'removed') this.flash(`${label(it?.ref ?? id)} is removed in this splice; pick another card`, true);
        else this.placeGroup({ outletOf: it?.ref ?? id });
        return;
      }
      // the groups view: a group card goes into it, a stub across (placing a proposed card carries on there)
      if (itemOf(id)) { this.enterItem(id); return; }
      if (this.sp && this.placing) {
        if (nodeMark(id) === 'removed') { this.flash(`${label(id)} is removed in this splice; pick another card`, true); return; }
        // a proposed group's empty state: the card goes into that group (and takes over its relationships)
        if (isPh(id)) { this.placeAt(null, undefined, gOfAny(id)); return; }
        this.placeAt(e.shiftKey ? { before: id } : e.altKey ? { after: id } : { attach: { to: id, dir: 'in' } });
        return;
      }
      if (this.sp && this.stage.inBench && (e.target as HTMLElement).closest?.('.mm-name')) { this.st.cursor = id; this.stage.viewport.focus({ preventScroll: true }); this.stage.redraw(); return; }
      if (this.stage.inBench && (e.altKey || e.shiftKey)) return this.togglePick(id);
      this.open(id);
    }
    /** A click in the details (the plate's panel, or the pinned inspector: `inDock`) or on the plate's own buttons. */
    private onDetailsClick(e: MouseEvent, inDock: boolean) {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-level],[data-drill],[data-reset],[data-save],[data-close],[data-copy],[data-goto],[data-pin],[data-section],[data-unsection],[data-jump],[data-dockpin]');
      if (!t) return;
      const d = t.dataset;
      const dv = inDock ? this.dockView() : null;
      if (d.level !== undefined) { this.navTo('groups', d.level || null); this.stage.viewport.focus({ preventScroll: true }); }
      else if (d.drill !== undefined) this.drillTo(this.st.drill === d.drill ? null : d.drill);
      else if (d.reset !== undefined) this.resetLayout();
      else if (d.save !== undefined) void this.saveTeam(t as HTMLButtonElement);
      else if (d.close !== undefined) { this.close(); this.stage.viewport.focus({ preventScroll: true }); }
      else if (d.goto !== undefined) this.open(d.goto);
      else if (d.pin !== undefined) this.togglePin(d.pin);
      else if (d.dockpin !== undefined) { this.stage.dock?.pin(true); this.stage.viewport.focus({ preventScroll: true }); }
      else if (inDock && dv && d.section !== undefined) {
        // a tab in the inspector: its own section (locked), or the open card's (following)
        if (this.dockLock) { this.dockLock = { ...this.dockLock, sec: d.section }; this.dockSec = d.section; this.stage.redraw(); }
        else this.openDetails(dv.id, d.section);
        this.dockBody()?.focus({ preventScroll: true });
      }
      else if (d.section !== undefined || d.unsection !== undefined) {
        if (!this.st.open) return;
        this.openDetails(this.st.open, d.section ?? null);
        // the button that was clicked is gone with the old panel: keys go to the new details (arrows scroll, Esc closes)
        // (the new panel may still be hidden until its first frame: the plate holds the keys until then)
        this.stage.viewport.focus({ preventScroll: true });
        setTimeout(() => this.el.panel.querySelector<HTMLElement>('.bd-body')?.focus({ preventScroll: true }), 120);
      }
      else if (d.jump !== undefined) {
        const b = inDock ? this.dockBody() : this.el.panel.querySelector<HTMLElement>('.bd-body');
        if (b) { this.scrollBody(b, { item: d.jump }); this.markShownAll(); }
      }
      else if (d.copy !== undefined) {
        void navigator.clipboard?.writeText(d.copy).then(() => { t.textContent = 'copied'; setTimeout(() => { t.textContent = 'copy'; }, 1400); }, () => { t.textContent = 'failed'; });
      }
    }
    /** Drop after a drag: the card rests where it was let go (inside the board). */
    private drop() {
      const dg = this.drag;
      if (!dg) return;
      const key = `c:${dg.id}`;
      this.drag = null;
      const p = this.clampCard(dg.cur, true, this.box(dg.id));
      const at = this.st.drill ? { x: p.x - this.drillOff.x, y: p.y - this.drillOff.y } : p;
      // in a splice, arrangement stays in the splice (saved with it); the real view's positions are never touched
      if (this.sp) this.sp.positions[this.posKey(dg.id)] = this.madeHere(at);
      else { this.viewer.positions[this.posKey(dg.id)] = this.madeHere(at); this.saveViewer(); }
      if (p.y !== dg.cur.y || p.x !== dg.cur.x) {
        const t = this.targets(); t.set(key, { ...t.get(key)!, x: dg.cur.x, y: dg.cur.y });
        this.morph.snap(t); this.morph.retarget(this.targets()); this.stage.transition();
      } else { this.morph.snap(this.targets()); this.stage.redraw(); }
    }
    /** A group frame's listeners (Bench): its border, empty area or label drags every card of the group together. */
    private wireGroup(gid: string) {
      const fr = this.stage.dom.querySelector<HTMLElement>(`#g-${cssId(gid)}`)!;
      draggable(fr, this.stage, {
        // not its ⤢ button, not a wire under the pointer (a click pins it, or places a proposed node on it), not while a
        // splice gesture is under way (placing a node, connecting two cards)
        handle: (e) => this.stage.inBench && !(e.target as HTMLElement).closest('button') && !this.placing && !this.linking && !this.wireAt(e).key,
        onStart: () => this.startGroupDrag(gid),
        onMove: ({ dx, dy }) => {
          const g = this.gdrag;
          if (!g) return;
          // the group moves as a unit: the delta is clamped so every member stays inside the board, as one card's drag does
          const ps = [...g.start].map(([id, p]) => ({ ...p, ...this.box(id) }));
          const lo = { x: 8 - Math.min(...ps.map((p) => p.x)), y: 8 - Math.min(...ps.map((p) => p.y)) };
          const hi = { x: this.W - 8 - Math.max(...ps.map((p) => p.x + p.w)), y: this.bodyH - 8 - Math.max(...ps.map((p) => p.y + p.h)) };
          g.d = { x: clamp(dx, Math.min(0, lo.x), Math.max(0, hi.x)), y: clamp(dy, Math.min(0, lo.y), Math.max(0, hi.y)) };
          this.stage.redraw();
        },
        onEnd: () => this.dropGroup(),
      });
    }
    private startGroupDrag(gid: string) {
      if (!this.stage.inBench || this.drag || !members.has(gid)) return;
      const ids = members.get(gid)!.filter((id) => byId.has(id) && !this.folded(id));
      if (!ids.length) return;
      this.gdrag = { gid, start: new Map(ids.map((id) => [id, this.placed(id)])), d: { x: 0, y: 0 } };
      this.hover = null; this.st.hover = null; this.st.wire = null; this.st.wireAt = null;
      this.stage.redraw();
    }
    /** Drop after a group drag: every member rests where it was let go, in the same layer a card's drop writes. */
    private dropGroup() {
      const g = this.gdrag;
      if (!g) return;
      this.gdrag = null;
      this.eatClick = true;
      setTimeout(() => { this.eatClick = false; }, 0);
      if (g.d.x || g.d.y) {
        // in a splice, arrangement stays in the splice (saved with it); the real view's positions are never touched
        const into = this.sp ? this.sp.positions : this.viewer.positions;
        for (const [id, p0] of g.start) {
          const p = { x: p0.x + g.d.x, y: p0.y + g.d.y };
          into[this.posKey(id)] = this.madeHere(this.st.drill ? { x: p.x - this.drillOff.x, y: p.y - this.drillOff.y } : p);
        }
        if (!this.sp) this.saveViewer();
      }
      this.morph.snap(this.targets()); this.stage.redraw();
    }

    // ------------------------------------------------------------------ wires
    /** The wire under a pointer event (null over a card, a button, the legend …). */
    private wireAt(e: MouseEvent): { key: string | null; at: { x: number; y: number } } {
      const at = this.stage.toStage(e.clientX, e.clientY);
      const t = e.target as HTMLElement | null;
      if (!t || t.closest(NOT_A_WIRE) || t.closest('.sp-pal, .sp-banner, .sp-rename, select, label')) return { key: null, at };
      return { key: pickPath(this.wirePaths, at, Math.max(4, 6 / this.stage.zoom)), at };
    }
    private wireMove(e: PointerEvent) {
      if (this.drag || this.gdrag || this.legend.naming) return;
      const { key, at } = this.wireAt(e);
      if (key === this.st.wire && !key) return;
      this.st.wire = key; this.st.wireAt = key ? at : null;
      this.stage.redraw();
    }
    private wireClick(e: MouseEvent) {
      if (this.eatClick) { this.eatClick = false; return; }
      if ((e.target as HTMLElement).closest('.wh-card')) return;
      if (this.sp && this.placing) {
        // placing a proposed node: a wire puts it between its two cards; empty space drops it there
        const t = e.target as HTMLElement, { key, at } = this.wireAt(e);
        if (this.placing.group) {
          if (key) { this.flash('a group goes on empty space, into a group card, or as a card\'s outlet (click the card)', true); return; }
          if (!t.closest('.mm-card, .bd-chip, .bd-panel, .bd-foot, .bd-toolbar, .bd-gl, .sp-pal, .sp-banner, .sp-rename, button, input, select, label')) this.placeGroup({}, at);
          return;
        }
        if (key && LV?.under.has(key)) { this.flash('that wire stands for several relationships: go into a group, then put the card between two of its cards', true); return; }
        if (key) {
          const w = wireByKey.get(key)!, m = wireMark(key);
          if (m === 'removed' || m === 'rerouted') { this.flash('that wire is gone in this splice; pick a live one', true); return; }
          this.placeAt({ between: [w.from, w.to] });
          return;
        }
        if (!t.closest('.mm-card, .bd-chip, .bd-panel, .bd-foot, .bd-toolbar, .bd-gl, .sp-pal, .sp-banner, .sp-rename, button, input, select, label')) this.placeAt(null, at);
        return;
      }
      const { key } = this.wireAt(e);
      if (key) this.st.wirePin = this.st.wirePin === key ? null : key;
      else if (this.st.wirePin) this.st.wirePin = null;
      else return;
      this.stage.redraw();
    }
    /** The wire whose card shows: the hovered one, else the pinned one. */
    private shownWire(): string | null { const k = this.st.wire ?? this.st.wirePin ?? null; return k && wireByKey.has(k) ? k : null; }

    // ------------------------------------------------------------------ state
    getState(): BoardState {
      const sp = this.sp ? { id: this.sp.splice.id, title: this.spNamed ? this.sp.title : '', ops: [...this.sp.splice.ops] } : null;
      const pl = this.stk, hs = this.host?.scene?.getState();
      const stack = pl ? { splices: pl.layers.map((l) => l.splice.id), combine: pl.combine.map((i) => pl.layers[i]!.splice.id), cur: hs?.cur ?? pl.cur, tab: hs?.tab ?? null, shown: !!this.host && this.hostFade !== 'out', conflict: hs?.warnPin ?? null, ...(pl.same.length ? { same: [...pl.same] } : {}) } : null;
      return { ...this.st, pins: [...this.st.pins], picked: [...this.st.picked], bench: this.stage.inBench, splice: sp, stack, ...(hier.available ? { nav: view, at: LV ? at : null, lanes: this.lanes } : {}) };
    }
    setState(raw: unknown) {
      const s = { ...blank(), ...(raw && typeof raw === 'object' ? raw as Partial<BoardState> : {}) };
      if (typeof s.bench === 'boolean') this.stage.bench(s.bench);
      // the lanes are a view preference: kept unless asked for; a change glides from the old routes (as navigated)
      if ((s.lanes === 'shared' || s.lanes === 'separate') && s.lanes !== this.lanes && hier.available) { this.laneFrom = { mode: this.lanes }; this.lanes = s.lanes; this.syncLaneBtn(); }
      // as if navigated from the overview (the real view): start there, then transition into s
      this.st = blank(); this.drag = null; this.gdrag = null; this.hover = null;
      this.placing = null; this.linking = null; this.renaming = null; this.spAsk = null;
      if (this.sp) { this.sp = null; this.remodel(false); }
      this.dropHost(); this.stk = null;
      // back to the level the board starts on, at once
      if (view !== START || at !== START_AT) this.navTo(START, START_AT, { snap: true });
      this.snapAll();
      const sp = s.splice && typeof s.splice === 'object' && Array.isArray(s.splice.ops) ? s.splice : null;
      if (sp) {
        const title = typeof sp.title === 'string' ? sp.title : '';
        const base = emptySplice({ model: o_modelRef, commit: null }, {}, { ...(title ? { title } : {}), ...(typeof sp.id === 'string' && sp.id ? { id: sp.id } : {}), now: '2026-01-01T00:00:00.000Z' });
        this.sp = new SpliceSession(baseModel, { ...base, ops: sp.ops }, {});
        this.spNamed = !!title;
        this.remodel(false);
      }
      const ids = (xs: unknown) => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string') : []);
      // group navigation: the view and level asked for, else the open card's level, else where the board starts
      if (hier.available) {
        const nv = s.nav === 'groups' || s.nav === 'cards' ? s.nav : view;
        let na: string | null = nv === 'groups' ? at : null;
        if (nv === 'groups') {
          if (typeof s.at === 'string' && hier.all.has(s.at)) na = s.at;
          else if (s.at === null) na = null;
          else if (s.open && realById.has(s.open)) na = hier.levelOf(s.open);
          else if (typeof s.drill === 'string' && hier.all.has(s.drill)) na = s.drill;
        }
        if (nv !== view || na !== at) this.navTo(nv, na, { play: false });
      }
      // a wire named by its cards, drawn here as the wire between what draws them (a group's)
      const wk = (k: string | null | undefined) => {
        if (!k || wireByKey.has(k) || !LV) return k && wireByKey.has(k) ? k : null;
        const w = realWireByKey.get(k), a = w && LV.rep.get(w.from), b = w && LV.rep.get(w.to);
        const k2 = a && b ? pairKey(a, b) : null;
        return k2 && wireByKey.has(k2) ? k2 : null;
      };
      const card = (id: string | null | undefined) => !!id && byId.has(id) && !itemOf(id);
      s.wire = wk(s.wire); s.wirePin = wk(s.wirePin);
      this.st = {
        open: card(s.open) ? s.open! : null,
        section: card(s.open) && typeof s.section === 'string' ? s.section : null,
        drill: !LV && s.drill && members.has(s.drill) ? s.drill : null,
        pins: ids(s.pins).map((p) => resolveEntry(this.entries(), p)).filter((p): p is string => !!p),
        picked: this.stage.inBench ? ids(s.picked).filter(card) : [],
        cursor: s.cursor ?? null,
        hover: s.hover ? resolveEntry(this.entries(), s.hover) : null,
        wire: s.wire && wireByKey.has(s.wire) ? s.wire : null,
        wireAt: s.wire && s.wireAt && typeof s.wireAt.x === 'number' ? { x: s.wireAt.x, y: s.wireAt.y } : null,
        wirePin: s.wirePin && wireByKey.has(s.wirePin) ? s.wirePin : null,
      };
      if (this.st.drill) this.drillOff = this.computeDrillOff(this.st.drill);
      if (this.st.open) this.panelFor = this.st.open;
      this.morph.retarget(this.targets()); this.pm.retarget(this.ptargets());
      // a stack of the example splices (stills): `unsaved` marks some of them unsaved, as an open splice with changes shows
      const sk = s.stack && typeof s.stack === 'object' && Array.isArray(s.stack.splices) ? s.stack as NonNullable<BoardState['stack']> & { unsaved?: string[] } : null;
      if (sk) {
        const exs = [...(o.spliceExamples ?? []), ...(o.stackExamples ?? [])];
        const layers = sk.splices.map((id) => exs.find((x) => x.id === id)).filter((x): x is Splice => !!x)
          .map((x) => ({ key: `example:${x.id}`, file: null, title: x.title, splice: x, unsaved: !!sk.unsaved?.includes(x.id), session: null }));
        if (layers.length) {
          const combine = (sk.combine ?? []).map((id) => layers.findIndex((l) => l.splice.id === id)).filter((i) => i >= 0);
          const cur = typeof sk.cur === 'number' ? sk.cur : 0;
          this.openStack(layers, combine, cur, { cur, ...(typeof sk.tab === 'number' ? { tab: sk.tab } : {}), ...(typeof sk.conflict === 'number' ? { warnPin: sk.conflict } : {}) }, ids(sk.same));
          if (sk.shown === false) this.dropHost();
        }
      }
    }
    states() {
      // over every card of the model (the groups view's states open a card on its level, and go into groups)
      const L = Lc, nbrs = realNbrs, byId = realById, wires = realWires, wireByKey = realWireByKey, slot = (id: string) => Lc.pos.get(id)!;
      const G = START === 'groups';
      // the busiest card with the scene's own details (any kind but an actor, an external or a module)
      const svc = L.nodes.filter((n) => !['actor', 'external', 'module'].includes(n.kind)).sort((a, b) => Number(!!o.details?.(b)) - Number(!!o.details?.(a)) || nbrs.get(b.id)!.size - nbrs.get(a.id)!.size)[0] ?? L.nodes[0];
      const out: { name: string; state: BoardState }[] = [{ name: 'overview', state: blank() }];
      if (svc) out.push({ name: `open-${svc.id}`, state: { ...blank(), open: svc.id, cursor: svc.id } });
      // the section view: the scene's first section when it has one (e.g. a service's endpoints), else the calls
      const kitSecs = (id: string) => new Set(kits.sections(byId.get(id)!).map((x) => x.id));
      if (svc) { const sec = this.sectionsOf(svc.id).find((x) => !x.own && !kitSecs(svc.id).has(x.id)) ?? this.sectionsOf(svc.id).find((x) => x.id === 'calls')!; out.push({ name: `section-${sec.id}`, state: { ...blank(), open: svc.id, cursor: svc.id, section: sec.id } }); }
      // kit kinds (docs/KITS.md): the kind's legend entry pinned, and its first section on its busiest card
      for (const k of kits.kinds) {
        const ns = L.nodes.filter((n) => n.kind === k).sort((a, b) => nbrs.get(b.id)!.size - nbrs.get(a.id)!.size || a.id.localeCompare(b.id));
        if (!ns.length) continue;
        out.push({ name: `kind-${k}`, state: { ...blank(), pins: [`kind:${k}`] } });
        const ks = kits.sections(ns[0]!)[0];
        if (ks) out.push({ name: `kind-${k}-${ks.id}`, state: { ...blank(), open: ns[0]!.id, cursor: ns[0]!.id, section: ks.id } });
      }
      const sl = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      // the groups view: each group entered (the change of level runs mid-transition); the cards view: the drill
      if (G) for (const gg of [...hier.all].sort((a, b) => hier.path(a).join('/').localeCompare(hier.path(b).join('/'))).slice(0, 8)) out.push({ name: `group-${sl(hier.path(gg).join(' '))}`, state: { ...blank(), at: gg } });
      else { const g = svc ? hier.leaf(svc.id) : Lc.groups[0]?.id; if (g) out.push({ name: `drill-${gName(g)}`, state: { ...blank(), drill: g } }); }
      const slug = (e: LegendEntry) => e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const all = G ? this.entryList : this.entries();
      // a declared tag (the one the scene leads with when it names one), a category, a derived tag
      const tag = (o.lead?.tag ? all.find((e) => e.id === o.lead!.tag) : undefined) ?? all.find((e) => e.kind === 'tag') ?? all.find((e) => e.kind === 'team');
      const cat = all.find((e) => e.kind === 'category');
      const der = all.find((e) => e.id.startsWith('group:'));
      if (tag) out.push({ name: `legend-pin-${slug(tag)}`, state: { ...blank(), pins: [tag.id] } });
      if (cat) out.push({ name: `legend-hover-${slug(cat)}`, state: { ...blank(), hover: cat.id } });
      if (cat && tag) out.push({ name: 'legend-pin-2', state: { ...blank(), pins: [cat.id, tag.id] } });
      else if (der) out.push({ name: `legend-pin-${slug(der)}`, state: { ...blank(), pins: [der.id] } });
      const svcAt = G && svc ? hier.levelOf(svc.id) : null;
      const two = [...L.nodes].filter((n) => n.kind !== 'actor' && (!G || hier.levelOf(n.id) === svcAt)).sort((a, b) => slot(a.id).y - slot(b.id).y || slot(a.id).x - slot(b.id).x).slice(0, 2).map((n) => n.id);
      // a wire hovered, and one pinned: the one the scene leads with when it names one, else the most recorded calls
      // (the groups view: on the overview, the wire between groups that stands for the most relationships)
      const top = (id: string) => repOf(hier, id, null).item, agg = new Map<string, number>();
      if (G) for (const w of wires) { const a = top(w.from), b = top(w.to); if (a !== b) agg.set(pairKey(a, b), (agg.get(pairKey(a, b)) ?? 0) + 1); }
      const wk = G ? [...agg].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
        : (o.lead?.wire && wireByKey.has(o.lead.wire) ? o.lead.wire : undefined) ?? [...wires].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))[0]?.key;
      if (wk) out.push({ name: `wire-hover-${wk}`, state: { ...blank(), wire: wk } }, { name: `wire-pin-${wk}`, state: { ...blank(), wirePin: wk } });
      const warnW = G ? undefined : wires.find((w) => w.style === 'warn') ?? wires.find((w) => w.style === 'dashed');
      if (warnW) out.push({ name: `wire-hover-${warnW.key}`, state: { ...blank(), wire: warnW.key } });
      out.push({ name: 'pick-2', state: { ...blank(), picked: two, bench: true, ...(G ? { at: svcAt } : {}) } });
      out.push({ name: 'bench-off', state: { ...blank(), bench: false } });
      // splices (docs/ENGINE.md "Splice"): each example as proposed, and in Bench; its first proposed wire hovered; its legend's "proposed" hovered
      for (const ex of o.spliceExamples ?? []) {
        const sp = { id: ex.id, title: ex.title, ops: ex.ops };
        const r = applySplice(baseModel, ex), pw = Object.entries(r.marks.edges).find(([, m]) => m === 'proposed')?.[0];
        out.push({ name: `splice-${ex.id}`, state: { ...blank(), splice: sp } });
        out.push({ name: `splice-${ex.id}-bench`, state: { ...blank(), splice: sp, bench: true } });
        // the groups view: the proposals are inside a group; there the proposed wire, and the splice as that group shows it
        const pn = r.model.nodes.find((n) => r.marks.nodes[n.id] === 'proposed'), pat = G && pn?.group && hier.all.has(pn.group) ? pn.group : null;
        if (pw) out.push({ name: `splice-${ex.id}-wire`, state: { ...blank(), splice: sp, wire: pw, ...(pat ? { at: pat } : {}) } });
        out.push({ name: `splice-${ex.id}-legend`, state: { ...blank(), splice: sp, hover: 'splice:proposed' } });
        if (pat) out.push({ name: `splice-${ex.id}-in-group`, state: { ...blank(), splice: sp, at: pat } });
      }
      // a stack of the example splices (docs/ENGINE.md "Stack of splices"): on the real view; a splice's tab hovered (what
      // it changes); one of them unsaved; and combined, on the combined slice with its conflict warning
      const ids = (o.spliceExamples ?? []).map((x) => x.id);
      if (ids.length) {
        out.push({ name: 'splice-stack', state: { ...blank(), stack: { splices: ids, cur: 0 } } });
        out.push({ name: 'splice-stack-hover', state: { ...blank(), stack: { splices: ids, cur: 0, tab: 1 } } });
        out.push({ name: 'splice-stack-unsaved', state: { ...blank(), stack: { splices: ids, cur: 1, unsaved: [ids[0]!] } as BoardState['stack'] } });
      }
      if (ids.length >= 2) {
        out.push({ name: 'splice-stack-combined', state: { ...blank(), stack: { splices: ids, combine: ids, cur: ids.length + 1 } } });
        // its first item's card, pinned (what each splice does, the outcome)
        out.push({ name: 'splice-stack-conflict', state: { ...blank(), stack: { splices: ids, combine: ids, cur: ids.length + 1, conflict: 0 } } });
      }
      // the first example combined with each stack example (what combining finds: a conflict, a consequence, the order, an
      // agreement, a same-name question), the combined slice with its first item's card pinned
      for (const ex of ids.length ? o.stackExamples ?? [] : []) {
        const two = [ids[0]!, ex.id];
        out.push({ name: `splice-stack-${ex.id}`, state: { ...blank(), stack: { splices: two, combine: two, cur: 3, conflict: 0 } } });
      }
      // group navigation (docs/ENGINE.md "Group navigation"): every card, from a board that starts on its groups; the
      // groups, from one that starts on every card
      // the lanes (docs/ENGINE.md "Group navigation"): every wire on its own track, on the overview and inside the first group
      if (G) {
        out.push({ name: 'lanes-separate', state: { ...blank(), lanes: 'separate' } });
        const g0 = [...hier.all].sort((a, b) => hier.path(a).join('/').localeCompare(hier.path(b).join('/')))[0];
        if (g0) out.push({ name: `lanes-separate-group-${sl(hier.path(g0).join(' '))}`, state: { ...blank(), lanes: 'separate', at: g0 } });
      }
      if (G) out.push({ name: 'cards', state: { ...blank(), nav: 'cards' } });
      else if (hier.available) {
        out.push({ name: 'groups', state: { ...blank(), nav: 'groups', at: null } });
        const t0 = hier.children(null)[0];
        if (t0) out.push({ name: `groups-${sl(hier.label(t0))}`, state: { ...blank(), nav: 'groups', at: t0 } });
      }
      return out;
    }

    // ------------------------------------------------------------------ splice (docs/ENGINE.md "Splice")
    private buildSpliceChrome(dom: HTMLElement) {
      const q = <T extends HTMLElement>(s: string) => dom.querySelector<T>(s)!;
      const button = (text: string, title: string) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'plate-btn sp-btn'; b.textContent = text; b.title = title; return b; };
      const b = button('Splice', 'Open this view in a new splice: a sandbox for proposed changes; the real diagram never changes (s in Bench)');
      b.setAttribute('aria-pressed', 'false');
      const shown = this.stage.addAction(b);
      b.addEventListener('click', () => { if (this.host) this.spliceStackLeave(); if (this.sp) this.askLeave(); else this.spliceOpen(); });
      let list: HTMLButtonElement | null = null, pop: HTMLElement | null = null;
      if (shown && SPLICE_DIR_REL !== null && DEV) {
        list = button('Splices', `Saved splices (${SPLICE_DIR_REL}): open one over the current code`);
        list.setAttribute('aria-haspopup', 'dialog'); list.setAttribute('aria-expanded', 'false');
        this.stage.addAction(list);
        pop = document.createElement('div');
        pop.className = 'sp-pop';
        pop.hidden = true;
        pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Saved splices');
        this.stage.root.append(pop);
        list.addEventListener('click', () => void this.togglePop());
        pop.addEventListener('click', (e) => this.onPopClick(e));
        pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); void this.togglePop(false); list!.focus(); } });
        document.addEventListener('pointerdown', (e) => { const t = e.target as Node; if (pop && !pop.hidden && !pop.contains(t) && !list!.contains(t)) void this.togglePop(false); });
      }
      this.spEl = {
        title: q('.sp-title'), sub: q('.sp-sub'), warn: q('.sp-warn'), msg: q('.sp-msg'), name: q<HTMLInputElement>('.sp-name'), ask: q('.sp-ask'), q: q('.sp-q'),
        yes: q<HTMLButtonElement>('[data-sp="yes"]'), acts: q('.sp-acts'), save: q<HTMLButtonElement>('[data-sp="save"]'), stack: q<HTMLButtonElement>('[data-sp="stack"]'), add: q<HTMLButtonElement>('[data-sp="palette"]'), gadd: q<HTMLButtonElement>('[data-sp="gpalette"]'),
        pal: q<HTMLFormElement>('.sp-pal'), rename: q<HTMLInputElement>('.sp-rename'), btn: shown ? b : null, list, pop,
      };
      dom.addEventListener('click', (e) => { const t = (e.target as HTMLElement).closest<HTMLElement>('[data-sp]'); if (t) this.onSpliceButton(t.dataset.sp!); });
      const E = this.spEl;
      E.pal.addEventListener('submit', (e) => { e.preventDefault(); this.startPlacing(); });
      E.pal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closePalette(); } });
      E.name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void this.saveNamed(E.name.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.spAsk = null; this.stage.viewport.focus({ preventScroll: true }); this.stage.redraw(); }
      });
      E.rename.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.endRename(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.endRename(false); }
      });
      E.rename.addEventListener('blur', () => { if (this.renaming) this.endRename(false); });
      if (SPLICE_DIR_REL !== null && DEV && !this.stage.isExport) void this.countSaved();
    }
    /** How many splices are saved (the Stack buttons need one), from the dev server's list. */
    private async countSaved() {
      try {
        const r = await fetch(`/__karyo/splices?dir=${encodeURIComponent(SPLICE_DIR_REL!)}`);
        const j = await r.json();
        if (Array.isArray(j)) { this.savedCount = j.length; this.stage.redraw(); }
      } catch { /* no dev server: no count, the buttons stay off */ }
    }
    private onSpliceButton(k: string) {
      switch (k) {
        case 'palette': return this.openPalette();
        case 'gpalette': return this.openPalette(null, true);
        case 'palclose': return this.closePalette();
        case 'stack': return void (this.stk && !this.host ? this.spliceStackReturn() : this.spliceStack());
        case 'save': return void this.saveFromBanner();
        case 'discard': return this.askDiscard();
        case 'leave': return this.askLeave();
        case 'yes': { const a = this.spAsk; this.spAsk = null; if (a === 'leave') this.spliceLeave(true); else if (a === 'discard') void this.spliceDiscard(true); else this.stage.redraw(); return; }
        case 'no': this.spAsk = null; this.stage.viewport.focus({ preventScroll: true }); this.stage.redraw(); return;
      }
    }
    /** A short message where it will be seen: the banner in a splice, else the mode line, for a few seconds. */
    private flashAny(text: string) {
      if (this.sp) { this.flash(text, true); return; }
      if (this.noteTimer) clearTimeout(this.noteTimer);
      this.note = text;
      this.noteTimer = setTimeout(() => { this.note = null; this.noteTimer = 0; this.stage.redraw(); }, 6000);
      this.stage.redraw();
    }
    private note: string | null = null;
    private noteTimer: ReturnType<typeof setTimeout> | 0 = 0;
    /** A short message in the banner (saved, a change that didn't apply …), for a few seconds. */
    private flash(text: string | null, bad = false) {
      if (this.spMsgTimer) clearTimeout(this.spMsgTimer);
      this.spMsg = text ? { text, bad } : null;
      this.spMsgTimer = text ? setTimeout(() => { this.spMsg = null; this.spMsgTimer = 0; this.stage.redraw(); }, bad ? 6000 : 3500) : 0;
      this.stage.redraw();
    }
    /** What a splice remembers of the view it lives in (reopening it lands there): the level and group, with the
     *  breadcrumb's words, Groups or every card, the drill, the selection, and its own arrangement. */
    private spliceViewState(): SpliceViewState {
      return {
        ...(hier.available ? { nav: view, at: LV ? at : null, path: LV && at !== null ? hier.path(at) : [] } : {}),
        drill: this.st.drill, open: this.st.open, section: this.st.section ?? null, cursor: this.st.cursor,
        positions: { ...(this.sp?.positions ?? {}) },
      };
    }
    /** Where you are, in the breadcrumb's words ("Orders › Notifications", "All groups", "every card"). */
    private whereWords(): string {
      if (LV) return at === null ? 'All groups' : hier.path(at).join(' › ');
      if (this.st.drill) return gName(this.st.drill);
      return hier.available ? 'every card' : '';
    }
    spliceView(): SpliceView | null {
      if (!this.sp) return null;
      const pg = Object.entries(marks?.groups ?? {}).filter(([, v]) => v === 'proposed').map(([g]) => g).filter((g) => hier.all.has(g) || groups.some((x) => x.id === g));
      return {
        ...this.sp.view(), title: this.spNamed ? this.sp.title : 'untitled', where: this.whereWords(),
        groups: pg.map((g) => ({ id: g, label: hier.label(g), path: hier.path(g).join(' › '), cards: hier.under(g).filter((id) => !isPh(id)).length })),
      };
    }
    spliceOpen(o: { title?: string; splice?: Splice; file?: string | null } = {}): SpliceView {
      const splice = o.splice ?? emptySplice({ model: o_modelRef, commit: null }, this.spliceViewState(), o.title?.trim() ? { title: o.title.trim() } : {});
      const v = (splice.view && typeof splice.view === 'object' ? splice.view : {}) as { drill?: unknown; nav?: unknown; at?: unknown; positions?: Record<string, XY> };
      this.spAsk = null; this.placing = null; this.linking = null; this.renaming = null;
      // a saved splice you stepped away from (through the stack) with unsaved changes comes back with them
      const kept = o.file ? this.stash.get(o.file) : undefined;
      if (kept) this.stash.delete(o.file!);
      this.sp = kept ?? new SpliceSession(baseModel, splice, { file: o.file ?? null, saved: !!o.splice && !!o.file, positions: o.splice && v.positions && typeof v.positions === 'object' ? v.positions : {} });
      this.spNamed = !!o.title?.trim() || !!o.splice;
      this.flash(null);
      if (!o.splice) { this.remodel(); return this.spliceView()!; }
      // a saved splice reopens in the view it lives in: its level and group (it slides in; a group the splice proposes
      // too), its drill and its selection; an older splice that doesn't say opens at the top level
      const tgt0 = viewTarget(splice.view, { available: hier.available, start: START, has: () => true });
      if (!tgt0.drill || LV) this.st.drill = null;
      if (tgt0.drill && !LV && tgt0.nav === 'cards') this.st.drill = tgt0.drill;
      this.remodel();
      const tgt = viewTarget(splice.view, { available: hier.available, start: START, has: (g) => hier.all.has(g) });
      if (hier.available) this.navTo(tgt.nav, tgt.at);
      if (!LV && tgt.drill && members.has(tgt.drill) && this.st.drill !== tgt.drill) this.drillTo(tgt.drill);
      const card = (id: string | null) => !!id && byId.has(id) && !itemOf(id);
      if (card(tgt.open)) { this.st.open = tgt.open; this.st.section = tgt.section; this.panelFor = tgt.open; this.st.cursor = tgt.open; this.go(); }
      else if (card(tgt.cursor)) { this.st.cursor = tgt.cursor; this.stage.redraw(); }
      return this.spliceView()!;
    }
    async spliceOpenSaved(ref: string): Promise<{ ok: boolean; view?: SpliceView; error?: string }> {
      const l = await this.spliceList();
      if (!l.ok) return { ok: false, error: l.error };
      const f = (x: string) => x.toLowerCase().replace(/^\s*the\s+/, '').replace(/\s+splice$/, '').replace(/[^a-z0-9]+/g, '');
      const want = f(ref);
      const hit = l.entries.find((e) => f(e.id) === want || f(e.title) === want) ?? l.entries.find((e) => !!want && (f(e.title).includes(want) || f(e.id).includes(want)));
      if (!hit) return { ok: false, error: `no saved splice is called "${ref}"; saved: ${l.entries.map((e) => e.title || e.id).join(', ') || 'none'}` };
      if (!hit.splice) return { ok: false, error: `${hit.file} can't be read: ${hit.error ?? 'unknown'}` };
      if (this.sp?.dirty) return { ok: false, error: `the open splice "${this.spliceView()!.title}" has unsaved changes; save it or leave it (splice_leave) first` };
      return { ok: true, view: this.spliceOpen({ splice: hit.splice, file: hit.file }) };
    }
    spliceOp(op: SpliceOp): { applied: boolean; warnings: string[]; view: SpliceView } {
      if (!this.sp) throw new Error('not in a splice: open one first (spliceOpen)');
      const r = this.sp.push(op);
      if (r.applied) { this.flash(r.warnings.length ? `⚠ ${r.warnings[0]}` : null, true); this.remodel(); }
      else this.flash(`not applied: ${r.warnings[0] ?? 'nothing changed'}`, true);
      return { ...r, view: this.spliceView()! };
    }
    spliceUndo(): boolean {
      if (!this.sp?.undo()) { if (this.sp) this.flash('nothing to undo'); return false; }
      this.flash(null); this.remodel(); return true;
    }
    spliceRedo(): boolean {
      if (!this.sp?.redoOne()) { if (this.sp) this.flash('nothing to redo'); return false; }
      this.flash(null); this.remodel(); return true;
    }
    async spliceSave(name?: string): Promise<{ ok: boolean; file?: string; error?: string }> {
      const sp = this.sp;
      if (!sp) return { ok: false, error: 'not in a splice' };
      if (name?.trim()) { sp.name(name); this.spNamed = true; }
      if (!this.spNamed) return { ok: false, error: 'the splice has no name yet: save it with one' };
      if (SPLICE_DIR_REL === null) return { ok: false, error: 'this board has no model file to keep splices next to' };
      // a new splice never overwrites another one's file: a taken id gets -2, -3 …
      if (!sp.file) {
        const l = await this.spliceList();
        const taken = new Set(l.entries.map((e) => e.file.split('/').pop()!.replace(/\.splice\.json$/, '')));
        const id0 = sp.splice.id;
        for (let i = 2; taken.has(sp.splice.id); i++) sp.splice.id = `${id0}-${i}`;
      }
      const r = await sp.save(SPLICE_DIR_REL, this.spliceViewState());
      this.flash(r.ok ? `saved · ${r.file}` : `not saved: ${r.error}`, !r.ok);
      if (r.ok) { this.stash.delete(`open:${sp.splice.id}`); void this.countSaved(); }
      return r;
    }
    private async saveFromBanner() {
      if (!this.sp) return;
      if (!this.spNamed) { this.spAsk = 'name'; this.stage.redraw(); this.spEl.name.value = ''; this.spEl.name.focus({ preventScroll: true }); return; }
      await this.spliceSave();
    }
    private async saveNamed(name: string) {
      if (!name.trim()) return;
      this.spAsk = null;
      this.stage.viewport.focus({ preventScroll: true });
      await this.spliceSave(name);
    }
    spliceLeave(force = false): boolean {
      if (!this.sp) return true;
      if (this.sp.dirty && !force) return false;
      this.exitSplice();
      return true;
    }
    async spliceDiscard(force = false): Promise<{ ok: boolean; deleted: string | null; error?: string }> {
      const sp = this.sp;
      if (!sp) return { ok: true, deleted: null };
      if ((sp.dirty || sp.file) && !force) return { ok: false, deleted: null, error: 'there is something to lose (unsaved changes or a saved file)' };
      const file = sp.file;
      this.stash.delete(this.spKey(sp));
      this.exitSplice();
      if (!file) return { ok: true, deleted: null };
      this.savedCount = null; void this.countSaved();
      const r = await deleteSplice(file);
      return r.ok ? { ok: true, deleted: file } : { ok: true, deleted: null, error: `left the splice, but ${file} wasn't deleted: ${r.error}` };
    }
    async spliceList(): Promise<{ ok: boolean; entries: SpliceEntry[]; error?: string }> {
      if (SPLICE_DIR_REL === null) return { ok: false, entries: [], error: 'this board has no model file to keep splices next to' };
      return listSplices(SPLICE_DIR_REL, baseModel);
    }
    private askLeave() {
      if (!this.sp) return;
      if (this.spliceLeave()) return;
      this.spAsk = 'leave'; this.stage.redraw();
      this.spEl.yes.focus({ preventScroll: true });
    }
    private askDiscard() {
      const sp = this.sp;
      if (!sp) return;
      if (!sp.dirty && !sp.file) { void this.spliceDiscard(true); return; }
      this.spAsk = 'discard'; this.stage.redraw();
      this.spEl.yes.focus({ preventScroll: true });
    }
    private exitSplice() {
      this.sp = null;
      this.spAsk = null; this.placing = null; this.linking = null; this.renaming = null;
      this.spEl.rename.hidden = true; this.spEl.pal.hidden = true;
      this.flash(null);
      this.remodel();
      this.stage.viewport.focus({ preventScroll: true });
    }
    /** The drawn model changed (a splice opened, changed or closed): derive it again, give new cards DOM, lay out for the
     *  same space, and glide there from what is on screen. What appears grows out of where it joins the picture (an insert,
     *  out of the wire it goes into); what goes fades where it is. `animate` false: land at once (setState). */
    private remodel(animate = true) {
      const now = new Map<string, Vals>();
      for (const id of this.cardDom) for (const k of [`c:${id}`, `h:${id}`]) { const v = this.morph.value(k); if (v) now.set(k, { ...v }); }
      const live = new Set(byId.keys());
      derive(this.sp ? this.sp.drawn : baseModel, this.sp ? this.sp.result.marks : null);
      this.fitMemo.clear();
      const r = this.fitFor(this.space, this.chromeK);
      this.arr = r.a; this.W = r.W; this.H = r.H; this.fitted = r;
      this.syncCards();
      this.fixState();
      this.renderLegend();
      const tg = this.targets();
      for (const n of L.nodes) {
        if (live.has(n.id) && now.has(`c:${n.id}`)) continue;
        const t = tg.get(`c:${n.id}`)!;
        const near = [...nbrs.get(n.id)!].map((x) => now.get(`c:${x}`)).filter((v): v is Vals => !!v && (v.o ?? 0) > 0.5);
        const c: Vals = near.length && (t.o ?? 0) > 0.5
          ? { x: near.reduce((a, v) => a + v.x!, 0) / near.length, y: near.reduce((a, v) => a + v.y!, 0) / near.length, sx: 0.35, sy: 0.35, o: 0, d: t.d! }
          : { ...t, sx: (t.sx ?? 1) * 0.8, sy: (t.sy ?? 1) * 0.8, o: 0 };
        now.set(`c:${n.id}`, c);
        now.set(`h:${n.id}`, { ...tg.get(`h:${n.id}`)!, o: 0 });
      }
      this.morph.snap(now);
      this.panelBuilt = null; this.dockBuilt = null; this.wireCardFor = '';
      // the plate's size follows the content (a new column widens it), laid out for the same space
      this.stage.refit(this.space);
      if (animate) this.go();
    }
    /** After the drawn model changed: let go of what no longer exists (an open card, a drill, a pinned wire …). */
    private fixState() {
      const st = this.st;
      // the groups view: a card opens, picks and connects only where it is drawn as itself
      const card = (id: string) => byId.has(id) && !itemOf(id);
      if (st.open && !card(st.open)) { st.open = null; st.section = null; }
      if (st.cursor && !byId.has(st.cursor)) st.cursor = null;
      st.picked = st.picked.filter(card);
      if (LV) st.drill = null;
      if (st.drill && !members.has(st.drill)) st.drill = null;
      if (st.drill) this.drillOff = this.computeDrillOff(st.drill);
      if (st.wire && !wireByKey.has(st.wire)) { st.wire = null; st.wireAt = null; }
      if (st.wirePin && !wireByKey.has(st.wirePin)) st.wirePin = null;
      if (this.panelFor && !byId.has(this.panelFor)) this.panelFor = null;
      if (this.hover && !byId.has(this.hover)) this.hover = null;
      if (st.hover && !this.entries().some((e) => e.id === st.hover)) st.hover = null;
      if (this.dockLock && !realById.has(this.dockLock.id)) { this.dockLock = null; this.stage.dock?.lock(false); }
      if (this.spot) { const m = this.spot.members.filter((id) => realById.has(id)); this.spot = m.length ? highlightEntry(m) : null; if (!m.length) st.pins = st.pins.filter((p) => p !== HIGHLIGHT); }
      this.drag = null; this.gdrag = null;
    }
    /** The splice's legend entries: what it proposes, what it removes (or reroutes), what it renames or moves. Hovering one
     *  lights exactly those cards and wires. */
    private spliceEntries(): LegendEntry[] {
      const mk = marks;
      if (!mk) return [];
      const nodes = (ms: string[]) => Object.entries(mk.nodes).filter(([id, m]) => ms.includes(m) && realById.has(id)).map(([id]) => id);
      const edges = (ms: string[]) => Object.entries(mk.edges).filter(([k, m]) => ms.includes(m) && realWireByKey.has(k)).map(([k]) => realWireByKey.get(k)!);
      // a relationship between two cards the splice leaves alone lights those two cards
      const ends = (ws: Wire[]) => ws.filter((w) => !mk.nodes[w.from] && !mk.nodes[w.to]).flatMap((w) => [w.from, w.to]);
      const entry = (id: string, name: string, hint: string, ns: string[], ws: Wire[]): LegendEntry => ({ id, name, kind: 'splice', hint, members: uniq([...ns, ...ends(ws)]), count: ns.length + ws.length });
      const pn = nodes(['proposed']), pw = edges(['proposed']), rn = nodes(['removed']), rw = edges(['removed', 'rerouted']), cn = nodes(['renamed', 'moved']);
      return [
        entry('splice:proposed', 'proposed', 'proposed in this splice · not in the code yet', pn, pw),
        entry('splice:removed', 'removed', 'removed or rerouted in this splice: drawn as faint ghosts', rn, rw),
        entry('splice:changed', 'renamed / moved', 'renamed or moved in this splice', cn, []),
      ].filter((e) => (e.count ?? 0) > 0);
    }
    // ---- editing in Bench: the palette, placing, connecting, renaming, deleting
    /** The palette: name a node, then place it; with `replaces` (a card), the new node takes that card's place at once. */
    private openPalette(replaces: string | null = null, group = false) {
      if (!this.sp) return;
      if (!this.stage.inBench) this.stage.bench(true);
      this.placing = null;
      const f = this.spEl.pal;
      (f.elements.namedItem('replaces') as HTMLInputElement).value = replaces ?? '';
      (f.elements.namedItem('mode') as HTMLInputElement).value = group ? 'group' : '';
      f.classList.toggle('is-group', group);
      (f.elements.namedItem('label') as HTMLInputElement).placeholder = group ? 'e.g. Notifications' : 'e.g. Cache';
      f.querySelector('.sp-pal-h')!.textContent = replaces ? `replace ${label(replaces)} with` : group ? 'propose a group' : 'propose a node';
      f.querySelector<HTMLButtonElement>('[type="submit"]')!.textContent = replaces ? 'Replace it' : 'Place it';
      if (replaces) (f.elements.namedItem('kind') as HTMLSelectElement).value = NODE_KINDS.includes(byId.get(replaces)?.kind as NodeKind) ? byId.get(replaces)!.kind : 'service';
      f.hidden = false;
      (f.elements.namedItem('label') as HTMLInputElement).focus({ preventScroll: true });
      this.stage.redraw();
    }
    private closePalette() {
      if (this.spEl.pal.hidden) return;
      this.spEl.pal.hidden = true;
      this.stage.viewport.focus({ preventScroll: true });
      this.stage.redraw();
    }
    private startPlacing() {
      const f = this.spEl.pal, get = (n: string) => (f.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement).value.trim();
      const lbl = get('label');
      if (!lbl || !this.sp) return;
      const cat = get('category'), rep = get('replaces'), grp = get('mode') === 'group';
      const kind = (NODE_KINDS.includes(get('kind') as NodeKind) ? get('kind') : 'service') as NodeKind;
      f.reset(); f.hidden = true;
      if (grp) { this.placing = { label: lbl, kind: 'service', group: true }; this.stage.viewport.focus({ preventScroll: true }); this.stage.redraw(); return; }
      if (rep) {
        // swap the card for the new node: it takes over every relationship of the card, which stays as a ghost
        this.stage.viewport.focus({ preventScroll: true });
        const op = spliceOp.replace(rep, lbl, { kind, ...(cat ? { category: cat } : {}), taken: this.sp.drawn });
        const at0 = this.sp.positions[this.posKey(rep)];
        if (at0) this.sp.positions[this.posKey((op.with as { id: string }).id)] = this.madeHere({ ...at0 });
        this.spliceOp(op);
        return;
      }
      this.placing = { label: lbl, kind, ...(cat ? { category: cat } : {}) };
      this.stage.viewport.focus({ preventScroll: true });
      this.stage.redraw();
    }
    private placeAt(where: SplicePlace | null, xy?: XY, into?: string) {
      const p = this.placing;
      if (!p || !this.sp) return;
      this.placing = null;
      // the groups view: a card dropped on empty space inside a group joins that group (on the overview, its own); inside
      // a group the splice proposes, every new card joins it
      const grp = into ?? (LV && at !== null && (!where || isPropGroup(at)) ? at : null);
      const op = spliceOp.add(p.label, where, { kind: p.kind, ...(p.category ? { category: p.category } : {}), ...(grp ? { group: grp } : {}), taken: this.sp.drawn });
      const id = op.node.id!;
      const b = kits.size(p.kind) ?? { w: CARD_W, h: CARD_H };
      const k = LV ? `@${at ?? ''}|${id}` : id;
      if (!where && xy) this.sp.positions[k] = this.madeHere(this.clampCard({ x: xy.x - b.w / 2, y: xy.y - b.h / 2 }, true, b));
      const r = this.spliceOp(op);
      if (!r.applied) delete this.sp.positions[k];
    }
    /** Place the proposed group being placed: on this level (dropped at `xy`), inside a group card (`into`), or as a
     *  card's outlet (`outletOf`: the card calls the new group). */
    private placeGroup(where: { into?: string; outletOf?: string }, xy?: XY) {
      const p = this.placing;
      if (!p?.group || !this.sp) return;
      this.placing = null;
      const parent = where.into ?? (LV ? at : null);
      const op = spliceOp.group(p.label, { ...(parent ? { parent } : {}), ...(where.outletOf ? { attach: { to: where.outletOf, dir: 'in' as const } } : {}), taken: this.sp.drawn });
      const k = `@${at ?? ''}|${GPRE}${op.group.id}`;
      if (xy && LV && !where.into) this.sp.positions[k] = this.madeHere(this.clampCard({ x: xy.x - GCARD.w / 2, y: xy.y - GCARD.h / 2 }, true, GCARD));
      const r = this.spliceOp(op);
      if (!r.applied) delete this.sp.positions[k];
    }
    private startLink(from: string, e: PointerEvent) {
      if (!this.sp || !this.stage.inBench || e.button !== 0 || !byId.has(from) || itemOf(from) || nodeMark(from) === 'removed') return;
      e.preventDefault(); e.stopPropagation();
      this.linking = { from, at: this.stage.toStage(e.clientX, e.clientY), over: null };
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId || !this.linking) return;
        this.linking.at = this.stage.toStage(ev.clientX, ev.clientY);
        const id = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('.bd-card')?.dataset.node ?? null;
        // a card, or a group card (a proposed group: the relationship goes to its entry card)
        this.linking.over = id && id !== from && byId.has(id) && (!itemOf(id) || itemOf(id)!.role === 'group') && nodeMark(id) !== 'removed' ? id : null;
        this.stage.redraw();
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
        const l = this.linking;
        this.linking = null;
        const g = l?.over ? itemOf(l.over) : null;
        if (l?.over && ev.type === 'pointerup' && g) {
          if (isPropGroup(g.ref)) this.spliceOp(spliceOp.connect(l.from, g.ref));
          else this.flash(`${hier.label(g.ref)} is a group in the code: go into it and drop on one of its cards`, true);
        } else if (l?.over && ev.type === 'pointerup') this.spliceOp(spliceOp.connect(l.from, l.over));
        else this.stage.redraw();
      };
      addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
      this.stage.redraw();
    }
    private startRename(id: string) {
      if (!this.sp || !byId.has(id) || itemOf(id) || nodeMark(id) === 'removed') return;
      this.renaming = id;
      const b = this.$(`#${cssId(id)}`).bounds(), inp = this.spEl.rename;
      Object.assign(inp.style, { left: `${Math.round(b.x + 8)}px`, top: `${Math.round(b.y + (byId.get(id)!.kind === 'actor' ? b.h / 2 - 13 : 20))}px`, width: `${Math.round(Math.max(120, b.w - 16))}px` });
      inp.value = label(id);
      inp.hidden = false;
      inp.focus({ preventScroll: true }); inp.select();
      this.stage.redraw();
    }
    private endRename(commit: boolean) {
      const id = this.renaming;
      if (!id) return;
      this.renaming = null;
      const inp = this.spEl.rename, v = inp.value.trim();
      inp.hidden = true;
      this.stage.viewport.focus({ preventScroll: true });
      if (commit && v && v !== label(id)) this.spliceOp(spliceOp.rename(id, v));
      else this.stage.redraw();
    }
    /** Delete / Backspace in a splice: disconnect the pinned wire, else remove the selected (or open) card. */
    private deleteSelected() {
      if (!this.sp) return;
      const wp = this.st.wirePin ? wireByKey.get(this.st.wirePin) : null;
      if (wp && wireMark(wp.key) !== 'removed' && wireMark(wp.key) !== 'rerouted') { this.st.wirePin = null; this.spliceOp(spliceOp.disconnect(wp.from, wp.to)); return; }
      const id = this.st.cursor ?? this.st.open;
      if (id && byId.has(id) && !itemOf(id) && nodeMark(id) !== 'removed') { this.spliceOp(spliceOp.remove(id)); return; }
      this.flash('select a card (click its name) or pin a wire (click it), then Delete', true);
    }
    // ---- a stack of splices (docs/ENGINE.md "Stack of splices"): compare many in a Stack view, edit one at a time here
    /** Where a session is kept while you step away from it: its file, or the open splice's id. */
    private spKey(sp: SpliceSession) { return sp.file ?? `open:${sp.splice.id}`; }
    /** Keep the open splice's unsaved changes before another one (or the real view) takes the board. */
    private keepOpenSplice() {
      const sp = this.sp;
      if (!sp) return;
      if (sp.dirty) this.stash.set(this.spKey(sp), sp); else this.stash.delete(this.spKey(sp));
    }
    /** A loose name match (a splice's title or id, "the X splice"). */
    private static fold(x: string) { return x.toLowerCase().replace(/^\s*the\s+/, '').replace(/\s+(splice|one)$/, '').replace(/[^a-z0-9]+/g, ''); }
    private static named<T extends { title: string; splice: Splice }>(xs: T[], ref: string): T | undefined {
      const f = BoardScene.fold, w = f(ref);
      if (!w) return undefined;
      return xs.find((x) => f(x.title) === w || f(x.splice.id) === w) ?? xs.find((x) => f(x.title).includes(w) || f(x.splice.id).includes(w) || (w.length > 3 && w.includes(f(x.title))));
    }
    async spliceStack(o: { names?: string[]; combine?: boolean | string[] } = {}): Promise<{ ok: boolean; view?: SpliceStackView; error?: string }> {
      const l = SPLICE_DIR_REL !== null ? await this.spliceList() : { ok: true, entries: [] as SpliceEntry[] };
      if (!l.ok) return { ok: false, error: l.error };
      this.savedCount = l.entries.length;
      type Layer = NonNullable<BoardScene['stk']>['layers'][number];
      // the saved splices (the open one and any stepped away from with unsaved changes as they are now), then unsaved ones never saved
      const live = (key: string) => (this.sp && this.spKey(this.sp) === key ? this.sp : this.stash.get(key) ?? null);
      const all: Layer[] = l.entries.filter((e) => e.splice).map((e) => {
        const ss = live(e.file);
        return { key: e.file, file: e.file, title: ss ? ss.title || e.title : e.title, splice: ss ? ss.splice : e.splice!, unsaved: !!ss?.dirty, session: ss };
      });
      for (const ss of [...(this.sp ? [this.sp] : []), ...this.stash.values()]) {
        if (ss.file || !ss.splice.ops.length || all.some((x) => x.key === this.spKey(ss))) continue;
        all.push({ key: this.spKey(ss), file: null, title: ss.title || 'untitled', splice: ss.splice, unsaved: true, session: ss });
      }
      if (!all.length) return { ok: false, error: `no splices to stack: none are saved${SPLICE_DIR_REL ? ` in ${SPLICE_DIR_REL}` : ''} and none is open with changes` };
      let layers = all;
      if (o.names?.length) {
        const picked: Layer[] = [], missing: string[] = [];
        for (const n of o.names) { const hit = BoardScene.named(all, n); if (hit && !picked.includes(hit)) picked.push(hit); else if (!hit) missing.push(n); }
        if (missing.length) return { ok: false, error: `no splice is called ${missing.map((x) => `"${x}"`).join(', ')}; splices: ${all.map((x) => x.title).join(', ')}` };
        layers = picked;
      }
      let combine: number[] = [];
      if (o.combine === true) combine = layers.map((_, i) => i);
      else if (Array.isArray(o.combine) && o.combine.length) {
        for (const n of o.combine) {
          let i = layers.indexOf(BoardScene.named(layers, n)!);
          // a splice named to combine that isn't in the stack yet joins it
          if (i < 0) { const hit = BoardScene.named(all, n); if (!hit) return { ok: false, error: `no splice is called "${n}" to combine; splices: ${all.map((x) => x.title).join(', ')}` }; layers = [...layers, hit]; i = layers.length - 1; }
          if (!combine.includes(i)) combine.push(i);
        }
      }
      if (o.combine && combine.length < 2) return { ok: false, error: `combining needs two splices or more (${combine.length ? `only ${layers[combine[0]!]!.title}` : 'none named'}); splices: ${all.map((x) => x.title).join(', ')}` };
      this.keepOpenSplice();
      // a combination was asked for: it is what to look at first (the real view is one tab away)
      this.openStack(layers, combine, combine.length >= 2 ? Infinity : 0);
      return { ok: true, view: this.spliceStackView()! };
    }
    /** Build the stack's slices and lift its plate over the board, on slice `cur`. */
    private openStack(layers: NonNullable<BoardScene['stk']>['layers'], combine: number[], cur: number, state?: Partial<StackState>, same: string[] = this.stk?.same ?? []) {
      const built = spliceStack(baseModel, layers, { combine, same });
      this.stk = { layers, combine: built.combine, built, cur: clamp(cur, 0, built.slices.length - 1), same: [...same] };
      this.showStack(state);
    }
    private showStack(state?: Partial<StackState>) {
      const plan = this.stk!;
      this.placing = null; this.linking = null; this.spAsk = null;
      if (this.renaming) this.endRename(false);
      void this.togglePop(false);
      const kinds = plan.built.kinds, n = plan.built.slices.length - 1;
      const Cls = stackView(plan.built.slices, {
        title: `${plan.built.combined ? 'Splices, side by side and combined' : 'Splices, side by side'}`,
        summary: `Stack of splices · the real view, then ${n - (plan.built.combined ? 1 : 0)} splice${n - (plan.built.combined ? 1 : 0) === 1 ? '' : 's'}${plan.built.combined ? ' and their combination' : ''} · proposals only`,
        noun: 'slice', rest: plan.cur, ...SPLICE_STACK_VIEW, kits,
        open: {
          label: (i) => (kinds[i]!.kind === 'real' ? 'Open the real view' : kinds[i]!.kind === 'combined' ? 'Open a part…' : 'Edit this splice'),
          hint: (i) => (kinds[i]!.kind === 'real' ? 'Back to the board without a splice' : kinds[i]!.kind === 'combined' ? 'The combined slice is read-only: open one of its splices to edit it' : 'Open this splice on the board, ready to edit (Esc comes back here)'),
          run: (i) => { this.spliceStackOpen(i + 1); },
        },
        buttons: [{ label: 'Leave', title: 'Back to the board (Esc)', run: () => { this.spliceStackLeave(); } }],
        // the combined slice's order, and the other order one click away
        headAction: (i) => (kinds[i]?.kind === 'combined' && plan.built.combined?.other ? { label: '⇄', title: `Swap the order: ${plan.built.combined.other.order.join(', then ')}${plan.built.combined.other.differs ? ' (it gives something else)' : ' (the same result)'}`, run: () => { this.spliceStackSwap(); } } : null),
        itemAction: (_i, k, id) => { if (id.startsWith('same:')) this.spliceStackSame(k + 1, !plan.built.combined?.conflicts[k]?.same?.unified); },
      });
      if (!this.host) {
        this.host = new StackHost(this.stage.dom, {
          preserve: this.stage.isExport,
          scale: () => this.stage.fitScale,
          onEscape: () => { this.spliceStackLeave(); },
          onChange: () => { const c = this.host?.scene?.getState().cur; if (this.stk && typeof c === 'number') this.stk.cur = c; this.stage.redraw(); },
          // the board's own keys while the stack covers it: the theater, `?` (the board's key help) and zoom
          onKey: (e) => { if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) { this.stage.theater(); return true; } return this.stage.keyHelp.key(e) || this.stage.view.key(e); },
        });
      }
      const host = this.host;
      void host.show(Cls, this.W, this.H, state).then(() => { if (this.host === host && !this.stage.isExport) host.focus(); });
      this.hostFade = 'in';
      this.stage.transition();
    }
    /** The stack's plate goes (it fades out over one transition, then is taken down); the plan stays for Esc to come back. */
    private hideStack() {
      if (!this.host) return;
      this.hostFade = 'out';
      this.stage.transition();
      this.stage.viewport.focus({ preventScroll: true });
    }
    private dropHost() { this.host?.dispose(); this.host = null; this.hostFade = null; }
    spliceStackOpen(ref: number | string): { ok: boolean; view?: SpliceView | null; error?: string } {
      const plan = this.stk;
      if (!plan) return { ok: false, error: 'there is no stack of splices: stack them first' };
      const sl = plan.built.slices, kinds = plan.built.kinds;
      let i = -1;
      if (typeof ref === 'number' || /^\s*#?\d+\s*$/.test(String(ref))) i = Math.round(Number(String(ref).replace('#', ''))) - 1;
      else {
        const w = BoardScene.fold(String(ref));
        if (/^(real|realview|thereal|original|nosplice|none)$/.test(w)) i = 0;
        else if (/^(combined|combination|together|both|all)$/.test(w)) i = kinds.findIndex((k) => k.kind === 'combined');
        else { const hit = BoardScene.named(plan.layers, String(ref)); i = hit ? kinds.findIndex((k) => k.layer === plan.layers.indexOf(hit)) : -1; }
      }
      if (i < 0 || i >= sl.length) return { ok: false, error: `no slice "${ref}" in the stack; slices: ${sl.map((x, j) => `${j + 1} ${x.title}`).join(', ')}` };
      const k = kinds[i]!;
      if (k.kind === 'combined') {
        const parts = plan.combine.map((j) => plan.layers[j]!);
        const why = `“${sl[i]!.title}” is read-only: it applies ${parts.map((p) => p.title).join(', then ')} in order, to compare them together. Open one of them to edit it.`;
        this.host?.ask({ text: why, buttons: [...parts.map((p, j) => ({ label: `Open ${p.title}`, primary: j === 0, run: () => { this.host?.ask(null); this.spliceStackOpen(p.title); } })), { label: 'Keep comparing', run: () => this.host?.ask(null) }] });
        this.stage.redraw();
        return { ok: false, error: `${why} Its splices: ${parts.map((p) => p.title).join(', ')}` };
      }
      plan.cur = i;
      this.keepOpenSplice();
      this.spAsk = null; this.placing = null; this.linking = null; this.renaming = null;
      if (k.kind === 'real') this.sp = null;
      else {
        const L = plan.layers[k.layer!]!;
        const ss = (this.sp && this.spKey(this.sp) === L.key ? this.sp : null) ?? this.stash.get(L.key) ?? L.session ?? new SpliceSession(baseModel, L.splice, { file: L.file, saved: !!L.file });
        this.stash.delete(L.key);
        L.session = ss;
        this.sp = ss;
        this.spNamed = true;
      }
      this.flash(null);
      // the board glides to the splice under the stack as it fades (its new cards grow in where they join)
      this.remodel();
      this.hideStack();
      return { ok: true, view: this.spliceView() };
    }
    spliceStackReturn(): boolean {
      const plan = this.stk;
      if (!plan || this.host) return false;
      // built again from the sessions as they are now: what you just changed shows, unsaved
      this.keepOpenSplice();
      for (const L of plan.layers) {
        const ss = (this.sp && this.spKey(this.sp) === L.key ? this.sp : null) ?? this.stash.get(L.key) ?? L.session;
        if (ss) { L.session = ss; L.splice = ss.splice; L.title = ss.title || L.title; L.unsaved = ss.dirty; if (!L.file && ss.file) { L.file = ss.file; } }
      }
      this.openStack(plan.layers, plan.combine, plan.cur);
      return true;
    }
    spliceStackLeave(): boolean {
      if (!this.stk) return false;
      this.stk = null;
      if (this.host) this.hideStack();
      this.stage.redraw();
      return true;
    }
    spliceStackView(): SpliceStackView | null {
      const plan = this.stk;
      if (!plan) return null;
      const st = this.host?.scene?.getState();
      return {
        shown: !!this.host && this.hostFade !== 'out', cur: (st?.cur ?? plan.cur) + 1,
        slices: plan.built.slices.map((x, i) => {
          const k = plan.built.kinds[i]!;
          return { index: i + 1, title: x.title, kind: k.kind, unsaved: x.badge === 'unsaved', changes: k.kind === 'real' ? 0 : k.kind === 'combined' ? plan.built.combined!.splice.ops.length : plan.layers[k.layer!]!.splice.ops.length, about: [...(x.about ?? [])], warning: x.warning?.text ?? null };
        }),
        conflicts: plan.built.combined?.conflicts.map((c) => c.message) ?? [],
        explained: (plan.built.slices.find((x) => x.id === 'combined')?.warning?.items ?? []).map((it, k) => ({
          n: k + 1, kind: it.name ?? 'conflict', what: it.title, splices: [...(it.who ?? [])], parts: (it.lines ?? []).map((l) => ({ splice: l.who, does: l.text })), result: it.result ?? '',
        })),
        order: (() => {
          const c = plan.built.combined;
          if (!c) return null;
          const o2 = c.conflicts.find((x) => x.kind === 'order');
          return { now: [...c.order], other: [...(c.other?.order ?? [])], matters: !!c.other?.differs, gives: o2 ? o2.parts[0]!.does.join(', ') : null, otherGives: o2 ? o2.parts[1]!.does.join(', ') : null };
        })(),
        lit: (() => {
          const shown = !!this.host && this.hostFade !== 'out', k = st ? (st.warn ?? st.warnPin ?? null) : null;
          return shown && k !== null && plan.built.kinds[st!.cur]?.kind === 'combined' ? { n: k + 1, pinned: st!.warnPin === k } : null;
        })(),
        asking: this.host?.question ?? null,
      };
    }
    spliceStackPlate(): unknown | null { return this.host && this.hostFade !== 'out' ? this.host.scene : null; }
    spliceStackSwap(): { ok: boolean; view?: SpliceStackView; error?: string } {
      const plan = this.stk;
      if (!plan) return { ok: false, error: 'there is no stack of splices: stack them first' };
      if (plan.combine.length < 2) return { ok: false, error: 'no splices are combined in this stack: combine two first' };
      const ci = plan.built.kinds.findIndex((k) => k.kind === 'combined');
      const st = this.host?.scene?.getState();
      this.openStack(plan.layers, [...plan.combine].reverse(), ci, { cur: ci, ...(st && st.cur !== ci ? { cur: st.cur } : {}) });
      return { ok: true, view: this.spliceStackView()! };
    }
    spliceStackSame(ref?: number | string, same = true): { ok: boolean; view?: SpliceStackView; error?: string } {
      const plan = this.stk, c = plan?.built.combined;
      if (!plan || !c) return { ok: false, error: 'no splices are combined: combine two first' };
      const qs = c.conflicts.map((x, k) => ({ x, k })).filter(({ x }) => x.same);
      if (!qs.length) return { ok: false, error: `${c.splice.title} has no two proposals with one name` };
      let hit = qs.find(({ x }) => x.same!.unified !== same) ?? qs[0]!;
      if (typeof ref === 'number' || /^\s*#?\d+\s*$/.test(String(ref ?? ''))) {
        const n = Math.round(Number(String(ref).replace('#', '')));
        const h = qs.find(({ k }) => k + 1 === n);
        if (!h) return { ok: false, error: `item ${n} isn't about two proposals with one name; those are ${qs.map(({ x, k }) => `${k + 1} ${x.subject}`).join(', ')}` };
        hit = h;
      } else if (typeof ref === 'string' && ref.trim()) {
        const w = BoardScene.fold(ref);
        hit = qs.find(({ x }) => BoardScene.fold(`${x.subject} ${x.message}`).includes(w) || w.includes(BoardScene.fold(x.subject.replace(/^(two different|one)\s+/i, '')).replace(/e?s$/, ''))) ?? hit;
      }
      const key = hit.x.same!.key;
      const next = same ? [...new Set([...plan.same, key])] : plan.same.filter((x) => x !== key);
      const ci = plan.built.kinds.findIndex((k) => k.kind === 'combined');
      this.openStack(plan.layers, plan.combine, ci, { cur: ci }, next);
      // pin the item it became (same key)
      const k2 = this.stk!.built.combined!.conflicts.findIndex((x) => x.same?.key === key);
      if (k2 >= 0) void this.host?.ready.then(() => (this.host?.scene as { showWarning?(k: number): boolean } | null)?.showWarning?.(k2));
      return { ok: true, view: this.spliceStackView()! };
    }
    settled() { return this.host ? this.host.ready : null; }
    // ---- the Splices list (page chrome in the actions row)
    private popEntries: SpliceEntry[] = [];
    private async togglePop(on?: boolean) {
      const pop = this.spEl.pop, btn = this.spEl.list;
      if (!pop || !btn) return;
      const show = on ?? pop.hidden;
      btn.setAttribute('aria-expanded', String(show));
      if (!show) { pop.hidden = true; return; }
      pop.hidden = false;
      pop.innerHTML = '<div class="pl-label">saved splices</div><div class="sp-none">reading…</div>';
      this.placePop();
      const l = await this.spliceList();
      if (pop.hidden) return;
      this.popEntries = l.entries;
      const row = (e: SpliceEntry) => `<button type="button" class="sp-e" data-file="${esc(e.file)}"><span class="t">${esc(e.title || e.id)}</span><span class="lb${e.landed ? '' : ' none'}">${e.landed ? `${e.landed} of ${e.ops} landed` : 'not landed'}</span><span class="m">${e.home ? `in ${esc(e.home)} · ` : ''}${e.ops} change${e.ops === 1 ? '' : 's'}${e.warnings ? ` · <span class="w">⚠ ${e.warnings} no longer appl${e.warnings === 1 ? 'ies' : 'y'}</span>` : ''}${e.updated ? ` · ${esc(e.updated.slice(0, 10))}` : ''}${e.error ? ` · <span class="w">${esc(e.error)}</span>` : ''}</span></button>`;
      this.savedCount = l.ok ? l.entries.length : this.savedCount;
      const n = l.entries.length;
      pop.innerHTML = `<div class="pl-label">saved splices · ${esc(SPLICE_DIR_REL ?? '')}</div>${l.ok ? l.entries.map(row).join('') || '<div class="sp-none">none yet: open a splice, propose changes, then Save</div>' : `<div class="sp-none">${esc(l.error ?? 'unavailable')}</div>`}<div class="sp-row2"><button type="button" class="plate-btn sp-new" data-new>New splice from this view</button><button type="button" class="plate-btn sp-new" data-stack${n ? '' : ' disabled'} title="${n ? `Compare ${n === 1 ? 'it' : `all ${n}`} with the real view in a Stack view (⇧S)` : 'Save a splice first'}">Stack ${n === 1 ? 'it' : `all ${n}`}</button></div>`;
      this.placePop();
      pop.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    }
    private placePop() {
      const pop = this.spEl.pop!, r = this.spEl.list!.getBoundingClientRect(), w = pop.offsetWidth || 380, h = pop.offsetHeight;
      pop.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, r.right - w)))}px`;
      pop.style.top = `${Math.round(r.top - h - 6 >= 8 ? r.top - h - 6 : Math.min(innerHeight - h - 8, r.bottom + 6))}px`;
    }
    private onPopClick(e: MouseEvent) {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-file],[data-new],[data-stack]');
      if (!t) return;
      void this.togglePop(false);
      if (t.dataset.stack !== undefined) { void this.spliceStack(); return; }
      if (this.sp?.dirty) { this.spAsk = 'leave'; this.flash('save or leave the open splice first', true); return; }
      if (t.dataset.new !== undefined) { this.spliceOpen(); return; }
      const hit = this.popEntries.find((x) => x.file === t.dataset.file);
      if (hit?.splice) this.spliceOpen({ splice: hit.splice, file: hit.file });
      else if (hit) this.flash(`${hit.file} can't be read: ${hit.error ?? 'unknown'}`, true);
    }
    /** The banner, the frame, the palette button, the Splice button: follow the splice (DOM written only on change). */
    private syncSplice() {
      const sp = this.sp, on = !!sp, E = this.spEl, dom = this.stage.dom;
      if (dom.classList.contains('sp-on') !== on) { dom.classList.toggle('sp-on', on); this.stage.root.classList.toggle('is-splice', on); }
      dom.classList.toggle('sp-placing', !!this.placing);
      dom.classList.toggle('sp-linking', !!this.linking);
      const set = (el: HTMLElement, t: string) => { if (el.textContent !== t) el.textContent = t; };
      if (E.btn && E.btn.getAttribute('aria-pressed') !== String(on)) {
        E.btn.setAttribute('aria-pressed', String(on));
        E.btn.textContent = on ? 'Leave splice' : 'Splice';
        E.btn.title = on ? 'Back to the real view (asks first when there are unsaved changes)' : 'Open this view in a new splice: a sandbox for proposed changes; the real diagram never changes (s in Bench)';
      }
      const add = on && this.stage.inBench;
      if (E.add.hidden === add) E.add.hidden = !add;
      if (E.gadd.hidden === (add && !!LV)) E.gadd.hidden = !(add && LV);
      if (!add && !E.pal.hidden) E.pal.hidden = true;
      if (!sp) return;
      const n = sp.splice.ops.length;
      set(E.title, this.spNamed ? sp.title : 'untitled');
      E.title.classList.toggle('is-untitled', !this.spNamed);
      const where = this.whereWords();
      set(E.sub, `— ${where ? `in ${where} · ` : ''}proposals only · ${n} change${n === 1 ? '' : 's'}${sp.note ? ` · ${sp.note}` : ''} · ${sp.dirty ? 'not saved' : sp.file ? 'saved' : 'nothing to save yet'}`);
      const ws = sp.result.warnings.length;
      if (E.warn.hidden === !!ws) E.warn.hidden = !ws;
      set(E.warn, ws ? `⚠ ${ws} change${ws === 1 ? '' : 's'} no longer appl${ws === 1 ? 'ies' : 'y'}` : '');
      const wt = sp.warnings().join('\n');
      if (E.warn.title !== wt) E.warn.title = wt;
      set(E.msg, this.spMsg?.text ?? '');
      E.msg.classList.toggle('is-bad', !!this.spMsg?.bad);
      const a = this.spAsk;
      if (E.name.hidden !== (a !== 'name')) E.name.hidden = a !== 'name';
      const asking = a === 'discard' || a === 'leave';
      if (E.ask.hidden === asking) E.ask.hidden = !asking;
      if (E.acts.hidden !== !!a) E.acts.hidden = !!a;
      if (a === 'discard') { set(E.q, sp.file ? `Discard this splice${sp.dirty ? ' and its unsaved changes' : ''}? This deletes ${sp.file.split('/').pop()}.` : `Discard ${n} unsaved change${n === 1 ? '' : 's'}?`); set(E.yes, 'Discard'); }
      else if (a === 'leave') { set(E.q, 'Leave without saving? The unsaved changes are lost.'); set(E.yes, 'Leave'); }
      const back = !!this.stk && !this.host, can = back || (this.savedCount ?? 0) > 0;
      set(E.stack, back ? 'Back to stack' : 'Stack');
      if (E.stack.disabled === can) E.stack.disabled = !can;
      const stt = back ? 'Back to the stack of splices you came from (Esc)' : can ? `Compare the saved splices (${this.savedCount}) and this one in a Stack view (⇧S)` : 'Save a splice first: the stack compares saved splices';
      if (E.stack.title !== stt) E.stack.title = stt;
      const st = SPLICE_DIR_REL !== null ? `Save into ${SPLICE_DIR_REL}/ (⌘S)` : 'This board has no model file to keep splices next to';
      if (E.save.title !== st) E.save.title = st;
      const dis = SPLICE_DIR_REL === null;
      if (E.save.disabled !== dis) E.save.disabled = dis;
    }

    // ------------------------------------------------------------------ keys
    /** Zoom and pan (docs/ENGINE.md "Zoom and pan"): a drag on blank space pans. Outside Bench a group frame's empty area
     *  is backdrop too; in Bench it is the group's handle. A wire under the pointer is never blank (hover, pin, insert). */
    isBlank(e: PointerEvent, byDefault: boolean) {
      const t = e.target as HTMLElement | null;
      const frame = !this.stage.inBench && !!t?.classList.contains('bd-group');
      return (byDefault || frame) && !this.wireAt(e).key;
    }
    onKey(e: KeyboardEvent) {
      const tg = e.target as HTMLElement;
      if (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA') return false;
      if (tg.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return false;
      const k = e.key;
      // a splice: ⌘Z / ⌘⇧Z (Ctrl on other systems) undo and redo its changes, ⌘S saves it
      if (this.sp && (e.metaKey || e.ctrlKey) && !e.altKey) {
        if (k === 'z' || k === 'Z') { if (e.shiftKey) this.spliceRedo(); else this.spliceUndo(); return true; }
        if (k === 'y') { this.spliceRedo(); return true; }
        if (k === 's') { void this.saveFromBanner(); return true; }
      }
      if (e.metaKey || e.ctrlKey) return false;
      if (this.sp && this.stage.inBench && (k === 'Delete' || k === 'Backspace')) { this.deleteSelected(); return true; }
      if (this.sp && k === 'n' && !e.altKey) { this.openPalette(); return true; }
      // r in a splice: replace the selected (or open) card with a new node, named in the palette
      if (this.sp && this.stage.inBench && k === 'r' && !e.altKey) {
        const id = this.st.cursor ?? this.st.open;
        if (id && byId.has(id) && nodeMark(id) !== 'removed') this.openPalette(id); else this.flash('select a card (click its name), then r to replace it', true);
        return true;
      }
      // ⇧S: stack the splices (back to the stack, when you came from one)
      if (k === 'S' && !e.altKey && !this.host && (SPLICE_DIR_REL !== null || this.sp || this.stk)) { void (this.stk ? this.spliceStackReturn() : this.spliceStack().then((r) => { if (!r.ok) this.flashAny(r.error ?? 'nothing to stack'); })); return true; }
      // s in Bench: fork this view into a splice
      if (!this.sp && this.stage.inBench && k === 's' && !e.altKey) { this.spliceOpen(); return true; }
      // inside the details' scrolling box, the scroll keys scroll it (the browser's own)
      if (tg.closest?.('.bd-body') && /^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(k)) return false;
      // with a card open, PgUp/PgDn/Home/End scroll its details from anywhere on the plate
      if (this.st.open && /^(PageUp|PageDown|Home|End)$/.test(k)) { this.scrollDetails(k === 'PageDown' ? 'down' : k === 'PageUp' ? 'up' : k === 'Home' ? 'top' : 'bottom'); return true; }
      if (k === 'Escape') return this.back();
      if (k === 'j' || k === 'ArrowDown' || k === 'ArrowRight') { this.moveCursor(1); return true; }
      if (k === 'k' || k === 'ArrowUp' || k === 'ArrowLeft') { this.moveCursor(-1); return true; }
      if (k === 'Enter' || k === ' ') { if (this.st.cursor) this.open(this.st.cursor); else this.moveCursor(1); return true; }
      if (k === 'x') { if (this.st.cursor && this.stage.inBench) this.togglePick(this.st.cursor); return this.stage.inBench; }
      // group navigation: g switches view; in the groups view l goes into the group at the cursor, h up a level
      if (k === 'g' && !e.altKey && hier.available) { this.groupView(view === 'groups' ? 'cards' : 'groups'); return true; }
      if (k === 'w' && !e.altKey && LV) { this.setLanes(); return true; }
      if (LV && k === 'l') { const c = this.st.cursor ? itemOf(this.st.cursor) : null; if (c) this.enterItem(c.id); return true; }
      if (LV && k === 'h') { this.up(); return true; }
      if (k === 'l') { const id = this.st.cursor ?? this.st.open; if (id && !this.folded(id)) this.drillTo(gOf.get(id)!); return true; }
      if (k === 'h') { if (this.st.drill) this.drillTo(null); return true; }
      if (/^[1-9]$/.test(k)) { const en = this.entries()[+k - 1]; if (en) this.togglePin(en.id); return true; }
      return false;
    }
    /** Key help (docs/ENGINE.md "Key help"): the keys `onKey` and `back` act on right now, in the same order of
     *  conditions; another mode's keys are listed `off` with where they work. */
    keys(): KeyHelpList {
      const N = 'Navigate', C = 'Card', LG = 'Legend', B = 'Bench', S = 'Splice';
      // the stack of splices covers the board: its keys (the Stack view's), Esc leaves it; the theater, zoom and `?` stay
      if (this.host && this.hostFade !== 'out') {
        const r = this.host.stage?.isReady ? this.host.stage.scene.keys?.() : undefined;
        const inner = (Array.isArray(r) ? r : r?.keys ?? []).map((h) => ({ ...h, group: h.group ?? 'Stack' }));
        const esc = inner.some((h) => !h.off && [h.keys].flat().includes('Esc'));
        // the hosted stack zooms on its own (the board forwards the zoom keys to it): its zoom lines, not the board's
        const zk = this.host.stage ? zoomKeys(this.host.stage.view) : [];
        return { keys: [...inner, ...(esc ? [] : [{ group: 'Stack', keys: 'Esc', does: 'leave the stack: back to the board' }]), ...zk], without: ['bench', 'inspector', 'theater-esc', ...(zk.length ? ['zoom-in', 'zoom-out', 'fit', 'zoom-pointer', 'pan'] : [])] };
      }
      const bench = this.stage.inBench, sp = this.sp, st = this.st, out: KeyHelp[] = [];
      const cur = st.cursor ? label(st.cursor) : null;
      out.push({ group: N, keys: ['j', '↓', '→'], does: cur ? 'next card' : 'step to the first card' });
      out.push({ group: N, keys: ['k', '↑', '←'], does: cur ? 'previous card' : 'step to the last card' });
      out.push({ group: N, keys: ['Enter', 'Space'], does: cur ? `open ${cur}` : 'step to the first card' });
      const curItem = st.cursor ? itemOf(st.cursor) : null;
      if (curItem) out[2] = { group: N, keys: ['Enter', 'Space'], does: curItem.role === 'group' ? `go into ${hier.label(curItem.ref)}` : `go across to ${cur}` };
      if (LV) {
        out.push(curItem ? { group: N, keys: 'l', does: curItem.role === 'group' ? `go into ${hier.label(curItem.ref)}` : `go across to ${cur}` } : { group: N, keys: 'l', does: 'go into the group at the cursor', off: true, when: 'with a group card or stub at the cursor' });
        out.push(at !== null ? { group: N, keys: 'h', does: `up to ${hier.parent(at) ? hier.label(hier.parent(at)!) : 'all groups'}` } : { group: N, keys: 'h', does: 'up a level', off: true, when: 'inside a group' });
      } else {
        const ca = st.cursor ?? st.open, into = ca && !this.folded(ca) ? gOf.get(ca)! : null;
        out.push(into && into !== st.drill ? { group: N, keys: 'l', does: `drill into ${gName(into)}` } : { group: N, keys: 'l', does: 'drill into the card\'s group', off: true, when: 'with a card at the cursor' });
        out.push(st.drill ? { group: N, keys: 'h', does: `step out of ${gName(st.drill)}` } : { group: N, keys: 'h', does: 'step out of the group', off: true, when: 'when drilled in' });
      }
      if (hier.available) out.push({ group: N, keys: 'g', does: view === 'groups' ? 'show every card' : 'show the groups (one card per group)' });
      if (hier.available) out.push(LV ? { group: N, keys: 'w', does: this.lanes === 'shared' ? 'separate lanes: each wire on its own track' : 'shared lanes: wires share runs' } : { group: N, keys: 'w', does: 'lanes: shared or separate', off: true, when: 'in the groups view' });
      const esc = this.escWords();
      if (esc) out.push({ group: N, keys: 'Esc', does: esc });
      out.push(st.open ? { group: C, keys: ['PgUp', 'PgDn'], does: `scroll ${label(st.open)}'s details` } : { group: C, keys: ['PgUp', 'PgDn'], does: 'scroll the details', off: true, when: 'with a card open' });
      out.push(st.open ? { group: C, keys: ['Home', 'End'], does: 'top / bottom of the details' } : { group: C, keys: ['Home', 'End'], does: 'top / bottom of the details', off: true, when: 'with a card open' });
      const n = Math.min(9, this.entries().length);
      if (n) out.push({ group: LG, keys: n === 1 ? '1' : `1–${n}`, does: `pin legend entry 1${n > 1 ? `–${n}` : ''} (again to unpin)` });
      out.push(bench && st.cursor ? { group: B, keys: 'x', does: `pick ${cur} (then + tag)` } : { group: B, keys: 'x', does: 'pick the card at the cursor', off: true, when: bench ? 'with a card at the cursor' : 'in Bench' });
      if (!sp) out.push(bench ? { group: S, keys: 's', does: 'open this view in a new splice' } : { group: S, keys: 's', does: 'open this view in a new splice', off: true, when: 'in Bench' });
      if (SPLICE_DIR_REL !== null || sp || this.stk) out.push({ group: S, keys: '⇧S', does: this.stk ? 'back to the stack of splices' : 'stack the saved splices' });
      if (sp) {
        const v = sp.view();
        out.push({ group: S, keys: 'n', does: bench ? '+ node: propose a new card' : '+ node: propose a new card (opens Bench)' });
        const wp = st.wirePin ? wireByKey.get(st.wirePin) : null, live = wp && wireMark(wp.key) !== 'removed' && wireMark(wp.key) !== 'rerouted';
        const sel = st.cursor ?? st.open, card = sel && byId.has(sel) && nodeMark(sel) !== 'removed' ? sel : null;
        out.push(bench && (live || card) ? { group: S, keys: ['Delete', 'Backspace'], does: live ? `disconnect ${label(wp!.from)} → ${label(wp!.to)}` : `remove ${label(card!)}` } : { group: S, keys: ['Delete', 'Backspace'], does: 'remove the selected card or pinned wire', off: true, when: bench ? 'with a card selected' : 'in Bench, with a card selected' });
        // r always answers in Bench (without a card it says to select one), so it is listed there either way
        out.push(bench ? { group: S, keys: 'r', does: card ? `replace ${label(card)} with a new card` : 'replace a card with a new one (select it first)' } : { group: S, keys: 'r', does: 'replace the selected card with a new card', off: true, when: 'in Bench' });
        out.push(v.canUndo ? { group: S, keys: '⌘Z', does: 'undo the last change' } : { group: S, keys: '⌘Z', does: 'undo', off: true, when: 'after a change' });
        out.push(v.canRedo ? { group: S, keys: ['⌘⇧Z', '⌘Y'], does: 'redo' } : { group: S, keys: ['⌘⇧Z', '⌘Y'], does: 'redo', off: true, when: 'after an undo' });
        out.push({ group: S, keys: '⌘S', does: this.spNamed ? 'save the splice' : 'name and save the splice' });
      }
      return out;
    }
    /** What Esc does now, in words (`back()`'s order), or null when it does nothing on the board. */
    private escWords(): string | null {
      if (this.linking) return 'cancel the new relationship';
      if (this.placing) return this.placing.group ? 'cancel placing the new group' : 'cancel placing the new card';
      if (this.sp && !this.spEl.pal.hidden) return this.spEl.pal.classList.contains('is-group') ? 'close the + group form' : 'close the + node form';
      if (this.spAsk) return 'cancel the question';
      if (this.st.wirePin) return 'close the pinned wire card';
      if (this.st.open) return `close ${label(this.st.open)}`;
      if (this.st.pins.length) return 'clear the pinned legend entries';
      if (LV && at !== null) return `up to ${hier.parent(at) ? hier.label(hier.parent(at)!) : 'all groups'}`;
      if (this.st.drill) return `step out of ${gName(this.st.drill)}`;
      if (this.st.picked.length) return 'drop the picked cards';
      if (this.stk && !this.host) return 'back to the stack of splices';
      return null;
    }
    /** Escape: the innermost thing first (panel, pins, drill, picked cards). */
    back(): boolean {
      // a splice's gestures in progress go first: a drag to connect, placing a node, the palette, a question in the banner
      if (this.linking) { this.linking = null; this.stage.redraw(); return true; }
      if (this.placing) { this.placing = null; this.stage.redraw(); return true; }
      if (this.sp && !this.spEl.pal.hidden) { this.closePalette(); return true; }
      if (this.spAsk) { this.spAsk = null; this.stage.redraw(); return true; }
      if (this.st.wirePin) { this.st.wirePin = null; this.stage.redraw(); return true; }
      if (this.st.open) { this.close(); return true; }
      if (this.st.pins.length) { this.st.pins = []; this.go(); return true; }
      if (LV && at !== null) { this.up(); return true; }
      if (this.st.drill) { this.drillTo(null); return true; }
      if (this.st.picked.length) { this.st.picked = []; this.stage.redraw(); return true; }
      // on a slice opened from a stack of splices: back to the stack
      if (this.stk && !this.host) return this.spliceStackReturn();
      return false;
    }

    // ------------------------------------------------------------------ frame
    private modeText(): string {
      const bench = this.stage.inBench, c = this.st.picked.length;
      const picked = c ? ` · ${c} picked` : '';
      if (this.legend.naming) return 'name the new tag · Enter to create it from the picked cards · Esc to cancel';
      if (this.note) return this.note;
      if (this.sp) {
        if (this.renaming) return `renaming ${label(this.renaming)} — type the new name · Enter proposes it · Esc cancels`;
        if (this.linking) return `proposing ${label(this.linking.from)} → ${this.linking.over ? label(this.linking.over) : '…'} — let go on a card${LV ? ' or a new group\'s card' : ''} · Esc cancels`;
        if (this.placing?.group) return `placing the group “${this.placing.label}”: click empty space to put it here · a group card: inside it · a card: an outlet of that card · Esc cancels`;
        if (this.placing) return `placing “${this.placing.label}”: click a wire to put it between its cards · ⇧-click a card: before it · ⌥-click: after it · click a card: it calls the new one · click empty space: drop it · Esc cancels`;
        if (this.spAsk === 'name') return 'name this splice, then Enter saves it · Esc cancels';
      }
      if (this.drag) return `moving ${label(this.drag.id)} — let go to place it · Reset layout puts every card back`;
      if (this.gdrag) return `moving the ${gName(this.gdrag.gid)} group (${this.gdrag.start.size} card${this.gdrag.start.size === 1 ? '' : 's'}) — let go to place it · Reset layout puts every card back`;
      const sw = this.shownWire();
      if (sw) return `${infoOf(sw).sentence}${wireMark(sw) ? ` (${wireMark(sw)} in this splice)` : ''} — ${this.st.wirePin === sw && !this.st.wire ? 'pinned · Esc closes it' : 'click the wire to pin its card'}`;
      const hv = this.entry(this.st.hover);
      if (hv) return `lighting “${hv.name}” (${hv.count ?? hv.members.length}) — click to ${this.st.pins.includes(hv.id) ? 'unpin' : 'pin'} it`;
      const sec = this.curSection();
      if (this.st.open && this.openInDock()) return `open: ${label(this.st.open)} · in the inspector${this.dockLock ? ' (locked)' : ''} — scroll it, or PgUp/PgDn · the tabs switch section · Esc to close · i unpins${picked}`;
      if (this.stage.dock?.shown && this.dockLock && !this.st.open) return `inspector locked on ${label(this.dockLock.id)} — open other cards to compare · its lock button follows again · i unpins${picked}`;
      if (this.st.open && sec) return `open: ${label(this.st.open)} · ${this.sectionsOf(this.st.open).find((x) => x.id === sec)!.title} — scroll, or PgUp/PgDn · the tabs switch section · Esc to close${picked}`;
      if (this.st.open) return `open: ${label(this.st.open)} — Esc to close · click another card to switch · PgUp/PgDn scroll it${LV ? '' : ` · l to drill into ${gName(gOf.get(this.st.open)!)}`}${picked}`;
      if (this.st.pins.length) {
        const es = this.st.pins.map((p) => this.entry(p)!).filter(Boolean), n = pinnedMembers(this.entries(), this.st.pins)?.size ?? 0;
        return `pinned: ${es.map((x) => x.name).join(' + ')} (${n}) — click an entry again to unpin · Esc clears${picked}`;
      }
      if (this.st.drill) return `inside ${gName(this.st.drill)} — h or Esc to step out · click a card or a rail head to open it${picked}`;
      if (LV && this.hover && itemOf(this.hover)) { const it = itemOf(this.hover)!; return it.role === 'group' ? `${hier.label(it.ref)} — click to go into it` : `${label(this.hover)} — ${it.side === 'in' ? 'calls in from outside' : 'called from inside'} · click to go across`; }
      if (c) return `picked ${c} — + tag makes a tag of ${c === 1 ? 'it' : 'them'} · ⌥/⇧-click to pick more · Esc drops them`;
      if (this.sp) {
        // honest about what the splice holds: its last change, in plain words
        const last = this.sp.note ?? 'no changes yet';
        return bench
          ? `${last} — proposals only · + node (n) adds · drag a card's ● onto another to connect · click a name, Delete removes it · double-click a name renames · ⌘Z / ⌘⇧Z`
          : `${last} — proposals only · b to edit in Bench · ⌘Z undo · ⌘⇧Z redo`;
      }
      if (LV && !bench) return at === null
        ? 'groups: click a group to go into it · hover a wire for what runs between them · hover the legend to light a set · g shows every card'
        : `inside ${hier.path(at).join(' › ')} — h or Esc goes up · stubs at the edges go across · click a card to open · g shows every card`;
      return bench
        ? 'bench: drag cards, or a group by its frame, to arrange · ⌥/⇧-click to pick, then + tag · hover the legend to light a set, click to pin · b leaves'
        : 'click a card to open · hover the legend to light a set, click to pin · j/k step · l drill in · b to arrange';
    }
    /** DOM that follows the state directly (text, attributes): written only when it changes. */
    private syncChrome() {
      this.syncSplice();
      // a slice opened from a stack of splices: Esc goes back to it (unless something here unwinds first)
      const mt = (this.stk && !this.host ? 'from the stack (Esc goes back) · ' : '') + this.modeText();
      if (this.el.mode.textContent !== mt) this.el.mode.textContent = mt;
      const bench = this.stage.inBench;
      if (this.el.reset.hidden === bench) this.el.reset.hidden = !bench;
      if (this.el.save && this.el.save.hidden === bench) this.el.save.hidden = !bench;
      this.legend.sync({ pins: this.st.pins, hover: this.st.hover ?? null, picked: this.st.picked.length, editable: bench });
      this.stage.dom.classList.toggle('wh-over', !!this.st.wire);
      this.stage.dom.classList.toggle('bd-moving', !!(this.drag || this.gdrag));
      for (const n of L.nodes) {
        const card = this.$(`#${cssId(n.id)}`).el, chip = this.$(`#h-${cssId(n.id)}`).el;
        const ex = String(this.st.open === n.id);
        if (card.getAttribute('aria-expanded') !== ex) { card.setAttribute('aria-expanded', ex); chip.setAttribute('aria-expanded', ex); }
        const f = this.folded(n.id);
        if (card.tabIndex !== (f ? -1 : 0)) card.tabIndex = f ? -1 : 0;
        if (chip.tabIndex !== (f ? 0 : -1)) chip.tabIndex = f ? 0 : -1;
      }
      this.syncLevel();
      for (const b of this.stage.dom.querySelectorAll<HTMLButtonElement>('.bd-drill')) {
        const inside = this.st.drill === b.dataset.drill, g = gName(b.dataset.drill!);
        const tx = inside ? '⤡' : '⤢';
        if (b.textContent !== tx) { b.textContent = tx; b.setAttribute('aria-label', inside ? `Step out of ${g}` : `Drill into ${g}`); b.title = inside ? `Step out of ${g} (h)` : `Drill into ${g} (l)`; }
      }
    }
    /** The breadcrumb ("All groups › App › Data"), the view toggle and the groups view's class (DOM written on change). */
    private syncLevel() {
      const dom = this.stage.dom;
      if (dom.classList.contains('bd-groups') !== !!LV) dom.classList.toggle('bd-groups', !!LV);
      const nav = dom.querySelector<HTMLElement>('.bd-crumbs');
      if (nav) {
        const sig = LV ? `${at ?? ''}` : '·cards';
        if (nav.dataset.sig !== sig) {
          nav.dataset.sig = sig;
          nav.hidden = !LV;
          if (LV) {
            const chain = at === null ? [] : [...hier.chain(at)].reverse();
            const crumb = (g: string | null, text: string, cur: boolean) => cur ? `<span aria-current="location">${esc(text)}</span>` : `<button type="button" data-level="${esc(g ?? '')}" title="Up to ${esc(text)} (h or Esc goes up one level)">${esc(text)}</button>`;
            nav.innerHTML = [crumb(null, 'All groups', at === null), ...chain.map((g, i) => crumb(g, hier.label(g), i === chain.length - 1))].join('<span class="sep" aria-hidden="true">›</span>');
          } else nav.innerHTML = '';
        }
      }
      const vb = this.viewBtns;
      if (vb) for (const [k, b] of Object.entries(vb)) { const on = String(view === k); if (b.getAttribute('aria-pressed') !== on) b.setAttribute('aria-pressed', on); }
      this.syncLaneBtn();
      this.syncLineKey();
    }
    /** The groups view's line key (docs/ENGINE.md "Group navigation"): a row for the counts on wires when the level has
     *  any, and one for wires that loop back to the left when it has any, in the lanes it rests in. */
    private syncLineKey() {
      const el = this.stage.dom.querySelector<HTMLElement>('.bd-foot .mm-legend');
      if (!el) return;
      const rowN = el.querySelector<HTMLElement>('[data-lk="n"]'), rowB = el.querySelector<HTMLElement>('[data-lk="back"]');
      if (!rowN || !rowB) return;
      const noun = this.countNoun();
      const counted = !!LV && [...LV.under.values()].some((u) => u.length > 1);
      const back = LV ? this.loopsBack() : null;
      const rows = lineKey({ counted, back: back?.to ?? null, lanes: this.lanes, noun });
      const rn = rows.find((r) => r.id === 'n'), rb = rows.find((r) => r.id === 'back');
      rowB.querySelector('i')?.classList.toggle('is-left', rb?.glyph === 'left');
      // six rows don't fit above the corner's key-help button: the legend packs tighter while the line key shows
      el.classList.toggle('has-lk', rows.length > 0);
      const set = (row: HTMLElement, r: LineKeyRow | undefined) => {
        if (row.hidden === !!r) row.hidden = !r;
        const sp = row.querySelector('.t')!;
        if (r && sp.textContent !== r.text) sp.textContent = r.text;
      };
      set(rowN, rn);
      set(rowB, rb);
    }
    /** What a count on a wire counts: the board's word, else calls when every relationship on the level is one. */
    private countNoun(): { one: string; many: string } {
      if (o.countNoun) return o.countNoun;
      const calls = wires.every((w) => (w.kinds.length ? w.kinds : [w.edge.kind]).every((k) => k === 'calls'));
      return calls ? { one: 'call', many: 'calls' } : { one: 'relationship', many: 'relationships' };
    }
    /** The level's wires drawn as going back to the left, in the current lanes: what they reach (groups, cards or
     *  both). Shared lanes curve a call back under its cards while both keep their arranged places (board-route.ts);
     *  separate lanes send one back when its callee lies left of its caller (lanes.ts). Null when none does. */
    private loopsBack(): { to: string } | null {
      if (!LV) return null;
      const targets: string[] = [];
      for (const w of wires) {
        const sa = slot(w.from), sb = slot(w.to), pa = this.placed(w.from), pb = this.placed(w.to);
        const back = this.lanes === 'separate'
          ? pb.x + this.box(w.to).w / 2 < pa.x
          : sb.layer <= sa.layer && Math.abs(pa.x - sa.x - (pb.x - sb.x)) < 0.5 && Math.abs(pa.y - sa.y - (pb.y - sb.y)) < 0.5;
        if (back) targets.push(w.to);
      }
      if (!targets.length) return null;
      const g = targets.map((id) => (isGroupItem(id) ? 'group' : 'card'));
      return { to: g.every((x) => x === 'group') ? 'group' : g.every((x) => x === 'card') ? 'card' : 'card or group' };
    }
    /** How low a wire may run: above the legend as drawn (the chrome floor draws it k times deeper from the bottom). */
    private floorY() { return Math.round(this.H - (LEG_H - 4) * this.stage.chrome.k - 20); }
    /** Every wire of the level on its own track (lanes.ts), memoised on exactly what it is routed from. */
    private sepMemos: { k: string; r: Map<string, LaneRoute> }[] = [];
    private sepRoutes(ends: Map<string, Rect>, obstacles: Rect[], floor: number): Map<string, LaneRoute> {
      const y0 = this.fitted.top + 2;
      let k = `sep|${floor}|${y0}|${this.W}|`;
      for (const w of wires) k += `${w.key};`;
      k += '|';
      for (const [id, r] of ends) k += `${id}:${rectKey(r)};`;
      for (const r of obstacles) k += `${rectKey(r)};`;
      const hit = this.sepMemos.find((m) => m.k === k);
      if (hit) return hit.r;
      const r = separateLanes(ends, wires.map((w) => ({ key: w.key, from: w.from, to: w.to })), { bounds: { x0: 8, x1: this.W - 8, y0, y1: floor }, obstacles });
      this.sepMemos = [{ k, r }, ...this.sepMemos].slice(0, 3);
      return r;
    }
    // ------------------------------------------------------------------ details: sections
    /** A card's details as named sections: the board's own (summary, calls, checks), then the scene's (`details`). */
    private sectionsOf(id: string): Sec[] {
      const n = realById.get(id)!;
      const ref = n.ref ? `${n.ref.file}${n.ref.line ? `:${n.ref.line}` : ''}` : '';
      const tag = (w: Wire) => {
        const glyph = `<i class="bd-glyph ${w.style === 'warn' ? 'warn' : w.style === 'dashed' ? 'dash' : w.style === 'idle' ? 'idle' : w.style === 'proposed' ? 'proposed' : ''}"></i>`;
        const n = w.count ? ` ×${w.count}` : '';
        const what = {
          undeclared: `<span class="bd-tag warn">seen${n}, not ${statics ? 'in the code' : 'declared'}</span>`,
          confirmed: `<span class="bd-tag">${w.decl ? 'declared' : 'in the code'} · seen${n}</span>`,
          entry: `<span class="bd-tag">entry · seen${n}</span>`,
          unseen: runs ? '<span class="bd-tag">declared, not seen</span>' : '<span class="bd-tag">declared</span>',
          extracted: runs ? '<span class="bd-tag">in the code, not seen</span>' : '<span class="bd-tag">in the code</span>',
          unexercised: '<span class="bd-tag">not exercised</span>',
          possible: '<span class="bd-tag">possible, not declared</span>',
          proposed: '<span class="bd-tag">proposed</span>',
        }[w.verdict];
        const kinds = w.kinds.filter((k) => k !== 'calls');
        const wm = wireMark(w.key), sp = wm && wm !== 'proposed' ? `<span class="bd-tag sp">${wm} in this splice</span>` : '';
        return [glyph, what + sp, kinds.length ? `<span class="bd-tag">${esc(kinds.join(', '))}</span>` : ''];
      };
      const row = (w: Wire, other: string) => { const [g, t, k] = tag(w); return `<div class="bd-edge" data-item="${esc(label(other))}">${g}<button type="button" class="bd-link" data-goto="${esc(other)}" title="Open ${esc(label(other))}">${esc(label(other))}</button>${t}${k}</div>`; };
      const outs = realWires.filter((w) => w.from === id), ins = realWires.filter((w) => w.to === id);
      const cs = nodeChecks.get(id)!;
      // its category and every tag it carries, each a chip that pins it
      const mine = this.entries().filter((e) => e.id !== HIGHLIGHT && e.members.includes(id));
      const chip = (e: LegendEntry) => `<button type="button" class="lg-e ${e.kind}" data-pin="${esc(e.id)}" title="${esc(e.hint ?? e.name)} · click to ${this.st.pins.includes(e.id) ? 'unpin' : 'pin'}">${e.kind === 'category' ? `<i class="lg-sw" data-cat="${e.slot ?? 0}"></i>` : ''}<span class="nm">${esc(e.name)}</span></button>`;
      const cat = mine.find((e) => e.kind === 'category'), tags = mine.filter((e) => e.kind !== 'category');
      const tagsHTML = `<h4 class="pl-label">category · ${cat ? esc(cat.name) : 'none'} · tags · ${tags.length}</h4><div class="bd-lgs">${cat ? chip(cat) : ''}${tags.map(chip).join('') || (cat ? '' : '<span class="bd-none">none</span>')}</div>`;
      const refHTML = ref ? `<div class="bd-ref"><code title="${esc(ref)}${n.ref?.symbol ? ` · ${esc(n.ref.symbol)}` : ''}">${esc(ref)}${n.ref?.symbol ? ` · ${esc(n.ref.symbol)}` : ''}</code><button type="button" class="bd-copy" data-copy="${esc(ref)}" aria-label="Copy file and line">copy</button></div>` : '';
      const out: Sec[] = [{
        id: 'summary', title: 'summary', noun: '', count: null, own: true,
        keywords: ['overview', 'about', 'description', 'category', 'tags', 'code', 'source', 'file', 'where', 'location', 'implementation'],
        html: `${spNote(id)}${n.summary ? `<p class="bd-sum">${esc(n.summary)}</p>` : ''}${refHTML}<section class="bd-sec">${tagsHTML}</section>`,
        compact: tagsHTML,
      }, {
        id: 'calls', title: 'calls', noun: 'relationships', count: outs.length + ins.length, own: true,
        keywords: ['called by', 'callers', 'callees', 'calls out', 'wires', 'connections', 'relationships', 'edges', 'talks to', 'depends on', 'dependencies', 'neighbours', 'neighbors'],
        html: `<h4 class="pl-label bd-sub">calls · ${outs.length}</h4>${outs.map((w) => row(w, w.to)).join('') || '<div class="bd-none">nothing</div>'}<h4 class="pl-label bd-sub">called by · ${ins.length}</h4>${ins.map((w) => row(w, w.from)).join('') || '<div class="bd-none">nothing (an entry point)</div>'}`,
      }];
      // what the card folds (a type's methods): each with where it is and whether it ran
      const ps = parts.get(id) ?? [];
      if (ps.length) out.push({
        id: 'parts', title: 'parts', noun: 'parts', count: ps.length, own: true,
        keywords: ['methods', 'members', 'folded', 'inside', 'contains', 'functions'],
        html: `<h4 class="pl-label">folded in · ${ps.length}</h4>${ps.map((p) => `<div class="bd-part" data-item="${esc(p.label ?? p.id)}"><code title="${esc(p.id)}">${esc(p.label ?? p.id)}</code>${p.exercised === false ? '<span class="bd-tag">not exercised</span>' : p.exercised ? '<span class="bd-tag">ran</span>' : ''}${p.ref ? `<span class="bd-none bd-part-at" title="${esc(p.ref.file)}">${esc(p.ref.file.split('/').pop()!)}${p.ref.line ? `:${p.ref.line}` : ''}</span>` : ''}</div>`).join('')}`,
      });
      if (cs.length) out.push({
        id: 'checks', title: 'checks', noun: 'checks', count: cs.length, own: true,
        keywords: ['warnings', 'notes', 'problems', 'issues', 'findings'],
        html: `<h4 class="pl-label">checks · ${cs.length}</h4>${cs.map((c) => `<div class="bd-check ${c.level}" data-item="${esc(c.code)}"><b>${c.level === 'warn' ? '⚠' : 'ⓘ'} ${esc(c.code)}</b>${esc(c.message)}</div>`).join('')}`,
      });
      const d = o.details?.(n);
      // a kit kind's own sections (docs/KITS.md), then the scene's
      const given: DetailSection[] = [...kits.sections(n, kx.stats?.get(id)), ...(!d ? [] : typeof d === 'string' ? [{ id: 'details', title: 'details', html: d }] : Array.isArray(d) ? d : [d])];
      for (const g of given) {
        if (!g || !g.id || out.some((x) => x.id === g.id)) continue;
        const items = itemsIn(g.html);
        out.push({ id: g.id, title: g.title || g.id, html: g.html, compact: g.compact, noun: g.noun ?? 'items', keywords: g.keywords ?? [], count: items.length || null, own: false });
      }
      return out;
    }
    sections(nodeId: string): SectionInfo[] {
      if (!realById.has(nodeId)) return [];
      return this.sectionsOf(nodeId).map((x) => ({ id: x.id, title: x.title, count: x.count, noun: x.noun, keywords: [...x.keywords], items: itemsIn(x.html) }));
    }
    /** The plate's 📌: pins the inspector beside the window (shown only where the dock can show). */
    private pinBtn() {
      return this.stage.dock?.available ? `<button type="button" class="bd-x bd-dockpin" data-dockpin aria-label="Pin the inspector to the side of the window" title="Pin the inspector to the side of the window (i)">${DOCK_ICON.pin}</button>` : '';
    }
    /** The ordinary panel: header, summary, then every section in a scrolling body. */
    private panelHTML(id: string) {
      const n = realById.get(id)!, secs = this.sectionsOf(id);
      const sum = secs.find((x) => x.id === 'summary')!;
      const head = `<div class="bd-ph"><span class="pl-label">${esc(n.kind)} · ${esc(gName(gOfAny(id)))}${n.lang ? ` · ${esc(n.lang)}` : ''}</span>${this.pinBtn()}<button type="button" class="bd-x" data-close aria-label="Close panel" title="Close (Esc)">×</button></div>
        <div class="bd-pt">${esc(label(id))}</div>`;
      const body = secs.map((x) => {
        if (x.id === 'summary') return `<section class="bd-sec" data-sec="summary">${x.compact}</section>`;
        const inner = x.compact ?? x.html;
        const h = x.own ? '' : `<h4 class="pl-label bd-sh"><span>${esc(x.title)}${x.count !== null ? ` · ${x.count}` : ''}</span><button type="button" class="bd-exp" data-section="${esc(x.id)}" title="Open ${esc(x.title)} large">expand ⤢</button></h4>`;
        return `<section class="bd-sec" data-sec="${esc(x.id)}">${h}${inner}</section>`;
      }).join('');
      const summary = sum.html.replace(/<section class="bd-sec">[\s\S]*<\/section>$/, '');
      return `${head}${summary}<div class="bd-body" data-pl-clip tabindex="0" role="region" aria-label="Details of ${esc(label(id))}">${body}</div>`;
    }
    /** The section view: that section large, the others behind a tab row. In the pinned inspector (`docked`) the dock's
     *  header carries pin, lock and side, so there is no "card ⤡"; × closes the card it follows (not a locked one). */
    private sectionHTML(id: string, sec: string, docked = false) {
      const n = realById.get(id)!, secs = this.sectionsOf(id), cur = secs.find((x) => x.id === sec) ?? secs[0]!;
      const items = itemsIn(cur.html);
      const x = docked ? (this.dockLock ? '' : `<button type="button" class="bd-x" data-close aria-label="Close the card" title="Close the card (Esc); the inspector stays pinned">×</button>`)
        : `${this.pinBtn()}<button type="button" class="bd-x" data-close aria-label="Close panel" title="Close (Esc)">×</button>`;
      return `<div class="bd-ph"><span class="pl-label">${esc(n.kind)} · ${esc(gName(gOfAny(id)))}${n.lang ? ` · ${esc(n.lang)}` : ''} · ${esc(cur.title)}</span>${x}</div>
        <div class="bd-pt">${esc(label(id))}</div>
        <div class="bd-tabs" role="tablist" aria-label="Sections">${secs.map((x) => `<button type="button" class="bd-tab" role="tab" data-section="${esc(x.id)}" aria-selected="${x.id === cur.id}">${esc(x.title)}${x.count !== null ? `<span class="c">${x.count}</span>` : ''}</button>`).join('')}${docked ? '' : '<button type="button" class="bd-exp" data-unsection title="Back to the small card panel">card ⤡</button>'}</div>
        ${items.length > 1 ? `<div class="bd-jump" aria-label="Jump to">${items.map((it) => `<button type="button" data-jump="${esc(it)}">${esc(it)}</button>`).join('')}</div>` : ''}
        <div class="bd-body" data-pl-clip tabindex="0" role="region" aria-label="${esc(cur.title)} of ${esc(label(id))}"><section class="bd-sec" data-sec="${esc(cur.id)}">${cur.html}</section></div>
        <div class="bd-more" aria-live="polite"></div>`;
    }
    /** The section the open card shows as a section view (a known id), or null. */
    private curSection(): string | null {
      const id = this.st.open, sec = this.st.section;
      return id && sec && this.sectionsOf(id).some((x) => x.id === sec) ? sec : null;
    }
    /** Where the section view docks: the side away from its card. */
    private secBox(id: string) {
      const w = Math.min(this.W - 2 * SEC_PAD, clamp(Math.round(this.W * 0.5), SEC_MIN_W, SEC_MAX_W));
      const p = this.placed(id), right = this.folded(id) || p.x + this.box(id).w / 2 < this.W / 2;
      // docked right in Bench, it starts under the toolbar (Reset layout, Save) so those stay reachable; it runs down over
      // the legend's side, which matters less than the details while you read them
      const y = right && this.stage.inBench ? SEC_TOP : SEC_PAD;
      return { x: right ? this.W - w - SEC_PAD : SEC_PAD, y, w, h: Math.max(240, this.H - y - SEC_PAD), right };
    }
    /** Build the panel's HTML (when the card or section changed) and size it; the panel stays where update() puts it. */
    private ensurePanel() {
      const pid = this.panelFor;
      if (!pid) return;
      const sec = this.st.open === pid ? this.curSection() : null;
      const key = `${pid}|${sec ?? ''}|${this.W}x${this.H}|${this.stage.inBench}|${!!this.stage.dock?.available}`;
      const el = this.el.panel;
      if (this.panelBuilt !== key) {
        const keep = this.panelBuilt?.startsWith(`${pid}|${sec ?? ''}|`) ? el.querySelector<HTMLElement>('.bd-body')?.scrollTop ?? 0 : 0;
        el.innerHTML = sec ? this.sectionHTML(pid, sec) : this.panelHTML(pid);
        el.classList.toggle('is-section', !!sec);
        el.setAttribute('aria-label', sec ? `Details of ${label(pid)}: ${sec}` : 'Details');
        if (sec) { const b = this.secBox(pid); el.style.width = `${b.w}px`; el.style.height = `${b.h}px`; }
        else { el.style.width = ''; el.style.height = ''; }
        this.panelBuilt = key;
        const body = el.querySelector<HTMLElement>('.bd-body');
        if (body) { body.scrollTop = keep; body.addEventListener('scroll', () => this.markShownAll()); }
        this.markShownAll();
      }
    }

    // ------------------------------------------------------------------ the pinned inspector (docs/ENGINE.md "Pinned inspector")
    /** What the pinned inspector shows: the card it is locked on, else the open card (following), with its section;
     *  null when it isn't on screen or shows its hint. */
    private dockView(): { id: string; sec: string } | null {
      const d = this.stage.dock;
      if (!d?.shown) return null;
      if (this.dockLock && realById.has(this.dockLock.id)) return this.dockLock;
      const id = this.st.open;
      return id ? { id, sec: this.dockSectionFor(id, this.st.section ?? null) } : null;
    }
    /** The section a card opens on in the inspector: the one asked for, else the one it showed last, else the scene's first, else the summary. */
    private dockSectionFor(id: string, want: string | null): string {
      const secs = this.sectionsOf(id), has = (x: string | null) => !!x && secs.some((y) => y.id === x);
      return has(want) ? want! : has(this.dockSec) ? this.dockSec! : (secs.find((x) => !x.own) ?? secs[0]!).id;
    }
    /** The open card is shown in the inspector (and so not on the plate). */
    private openInDock() { const v = this.dockView(); return !!v && v.id === this.st.open; }
    /** A card's panel may show on the plate: always, unless the inspector is pinned and follows the cards (or is locked on this one). */
    private inPlate(id: string) { return !(this.stage.dock?.shown && (!this.dockLock || this.dockLock.id === id)); }
    private dockBody() { return this.stage.dock?.body.querySelector<HTMLElement>('.bd-body') ?? null; }
    /** Build the inspector's HTML when what it shows changed (a hint when nothing is open). */
    private ensureDock() {
      const d = this.stage.dock;
      if (!d?.shown) { this.dockBuilt = null; return; }
      const v = this.dockView();
      const key = v ? `${v.id}|${v.sec}|${!!this.dockLock}` : '';
      if (this.dockBuilt === key) return;
      const keep = v && this.dockBuilt?.startsWith(`${v.id}|${v.sec}|`) ? this.dockBody()?.scrollTop ?? 0 : 0;
      this.dockBuilt = key;
      if (!v) { d.setSubject(null, 'open a card to inspect it'); return; }
      this.dockSec = v.sec;
      d.body.innerHTML = `<div class="bd-panel is-section is-docked" role="region" aria-label="Details of ${esc(label(v.id))}: ${esc(v.sec)}">${this.sectionHTML(v.id, v.sec, true)}</div>`;
      d.setSubject(label(v.id));
      const body = this.dockBody();
      if (body) { body.scrollTop = keep; body.addEventListener('scroll', () => this.markShownAll()); }
      this.markShownAll();
    }
    dockChanged(what: DockChange) {
      const d = this.stage.dock!;
      if (what === 'lock') {
        // lock on what it shows now; unlocking goes back to following the open card
        if (d.locked) { const v = this.dockView(); this.dockLock = v ? { ...v } : null; if (!v) d.lock(false); }
        else this.dockLock = null;
      }
      if (what === 'pin') {
        const wasIn = this.dockBuilt ? this.dockBuilt.split('|') : null;
        this.dockLock = null;
        if (!d.pinned && this.st.open) {
          // unpinned: the inspector goes back into the plate, as the section view it was showing
          if (wasIn && wasIn[0] === this.st.open) this.st.section = wasIn[1]!;
          this.panelFor = this.st.open;
          this.pm.snap(new Map([['p', { o: 0 }]]));
          this.go();
        }
      }
      this.panelBuilt = null;
    }
    inspector(): InspectorView {
      const d = this.stage.dock;
      if (!d) return inspectorOff({ pinned: false, shown: false, locked: false, side: 'right', px: () => 0 }, 'no inspector on this plate');
      if (!d.shown) return inspectorOff(d, d.pinned ? 'pinned, but not on screen (it shows while the plate fills the window)' : 'not pinned');
      this.ensureDock();
      const v = this.dockView();
      if (!v) return inspectorOff(d, 'nothing: no card is open, so it says "open a card to inspect it"');
      const m = this.measureIn(d.body, v.id, v.sec)!;
      return { pinned: d.pinned, shown: true, locked: d.locked, side: d.side, width: d.px(), node: v.id, label: label(v.id), section: v.sec, visible: m.visible, items: { shown: m.shown, partly: m.partly, hidden: m.hidden }, more: m.more };
    }

    // ------------------------------------------------------------------ measuring, scrolling
    /** Where the open card's details are on screen: the inspector (pinned, following it) or the plate's panel. */
    private openHost(): HTMLElement | null {
      const id = this.st.open;
      if (!id) return null;
      if (this.openInDock()) { this.ensureDock(); return this.stage.dock!.body; }
      this.panelFor = id;
      this.ensurePanel();
      return this.el.panel;
    }
    /** The index and the "more below" line follow the scroll, in the plate's panel and the inspector (DOM only). */
    private markShownAll() {
      const id = this.st.open;
      const plate = id && this.panelFor === id && !this.openInDock() ? this.measureIn(this.el.panel, id, this.curSection()) : null;
      if (plate) this.markIn(this.el.panel, plate);
      const dv = this.dockView(), dock = dv ? this.measureIn(this.stage.dock!.body, dv.id, dv.sec) : null;
      if (dock) this.markIn(this.stage.dock!.body, dock);
      // what is visible is part of what the page reports (Jarvis's view): a scroll that changes it redraws, so the page hears
      const sig = JSON.stringify([plate?.shown, plate?.partly, dock?.shown, dock?.partly]);
      if (sig !== this.shownSig) { const first = this.shownSig === null; this.shownSig = sig; if (!first) this.stage.redraw(); }
    }
    private markIn(host: HTMLElement, v: NonNullable<ReturnType<BoardScene['measureIn']>>) {
      const shown = new Set([...v.shown, ...v.partly]);
      for (const b of host.querySelectorAll<HTMLElement>('[data-jump]')) b.classList.toggle('is-shown', shown.has(b.dataset.jump!));
      const more = host.querySelector<HTMLElement>('.bd-more');
      if (more) {
        const t = v.more.below ? `more below · ${v.hidden.length ? `${v.hidden.length} not in view · ` : ''}scroll or PgDn` : v.more.above ? 'end · PgUp or Home to go back up' : '';
        if (more.textContent !== t) more.textContent = t;
      }
    }
    /** Which items of a card's details (in `host`: the plate's panel or the inspector) sit inside its scrolling box. */
    private measureIn(host: HTMLElement, id: string, sec: string | null): Omit<DetailsView, 'open' | 'label' | 'sections'> | null {
      const body = host.querySelector<HTMLElement>('.bd-body');
      if (!body) return null;
      const box = body.getBoundingClientRect();
      const shown: string[] = [], partly: string[] = [], hidden: string[] = [];
      const secs = this.sectionsOf(id);
      const parts: string[] = [];
      for (const x of sec ? secs.filter((y) => y.id === sec) : secs) {
        const hostSec = body.querySelector<HTMLElement>(`[data-sec="${cssAttr(x.id)}"]`);
        if (!hostSec) continue;
        const els = [...hostSec.querySelectorAll<HTMLElement>('[data-item]')];
        let full = 0; const part: string[] = [];
        for (const e of els) {
          const r = e.getBoundingClientRect(), name = e.dataset.item!;
          if (r.height === 0 && r.width === 0) { hidden.push(name); continue; }
          if (r.top >= box.top - 1 && r.bottom <= box.bottom + 1) { full++; shown.push(name); }
          else if (r.bottom > box.top + 1 && r.top < box.bottom - 1) { part.push(name); partly.push(name); }
          else hidden.push(name);
        }
        const hr = hostSec.getBoundingClientRect();
        const inView = hr.bottom > box.top + 1 && hr.top < box.bottom - 1;
        const noun = x.noun || 'items';
        let t: string;
        if (!els.length) t = !inView ? 'out of view (scroll to it)' : hr.top >= box.top - 1 && hr.bottom <= box.bottom + 1 ? 'all of it' : 'partly (scroll for the rest)';
        else if (full === els.length) t = `${full} of ${els.length} ${noun}`;
        else t = `${full} of ${els.length} ${noun} fully visible${part.length ? `, ${part.join(', ')} partly` : ''}; scroll for the rest`;
        parts.push(sec ? t : `${x.title}: ${t}`);
      }
      const more = { above: body.scrollTop > 1, below: body.scrollTop + body.clientHeight < body.scrollHeight - 1 };
      return { section: sec, visible: parts.join('; '), shown, partly, hidden, more };
    }
    detailsView(): DetailsView | null {
      const id = this.st.open;
      if (!id) return null;
      const host = this.openHost();
      const inDock = this.openInDock();
      const m = host ? this.measureIn(host, id, inDock ? this.dockView()!.sec : this.curSection()) : null;
      if (!m) return null;
      return { open: id, label: label(id), sections: this.sectionsOf(id).map((x) => ({ id: x.id, title: x.title, count: x.count })), ...m };
    }
    openDetails(nodeId: string, section: string | null = null) {
      if (itemOf(nodeId) && isGroupItem(nodeId)) { this.enterItem(nodeId); return; }
      if (!realById.has(nodeId)) return;
      if (LV && LV.items.get(nodeId)?.role !== 'node') this.navTo('groups', hier.levelOf(nodeId));
      const sec = section && this.sectionsOf(nodeId).some((x) => x.id === section) ? section : null;
      if (this.folded(nodeId)) this.st.drill = null;
      if (sec && this.stage.dock?.shown && !this.dockLock) this.dockSec = sec;
      if (this.st.open === nodeId && (this.st.section ?? null) === sec) { this.go(); return; }
      // switching tabs keeps the panel where it is; a new card, or card ↔ section view, folds and unfolds
      const tab = this.st.open === nodeId && !!sec && (!!this.curSection() || this.openInDock());
      if (this.st.open && !tab) this.pm.snap(new Map([['p', { o: 0 }]]));
      this.st.open = nodeId; this.st.section = sec; this.panelFor = nodeId; this.st.cursor = nodeId;
      if (tab) { this.ensurePanel(); this.stage.redraw(); return; }
      this.go();
    }
    scrollDetails(to: 'down' | 'up' | 'top' | 'bottom' | { item: string }): boolean {
      // the open card's details, wherever they are; with none open, what a locked inspector holds
      const host = this.st.open ? this.openHost() : this.dockView() ? (this.ensureDock(), this.stage.dock!.body) : null;
      const body = host?.querySelector<HTMLElement>('.bd-body');
      if (!body) return false;
      const moved = this.scrollBody(body, to);
      this.markShownAll();
      return moved;
    }
    /** Scroll one details box: a page, an end, or an item to the top. */
    private scrollBody(body: HTMLElement, to: 'down' | 'up' | 'top' | 'bottom' | { item: string }): boolean {
      const was = body.scrollTop, page = Math.max(40, body.clientHeight * 0.85);
      if (typeof to === 'object') {
        const it = [...body.querySelectorAll<HTMLElement>('[data-item]')].find((e) => e.dataset.item === to.item);
        if (!it) return false;
        // rects carry the plate's scale (and the panel's, mid-transition); scrollTop doesn't
        const k = body.getBoundingClientRect().height / (body.offsetHeight || 1) || 1;
        body.scrollTop = (it.getBoundingClientRect().top - body.getBoundingClientRect().top) / k + body.scrollTop - 6;
        return true;
      }
      body.scrollTop = to === 'down' ? was + page : to === 'up' ? was - page : to === 'top' ? 0 : body.scrollHeight;
      return body.scrollTop !== was;
    }

    update(f: Frame) {
      const k = ease.outCubic(clamp(f.t / f.duration));
      this.morph.progress(k); this.pm.progress(k);
      // the stack of splices over the board: it fades in as it opens and out as a slice comes back to the board; in stills
      // it is drawn frame by frame with the board (the same point of its own transition)
      const h = this.host;
      if (h) {
        const a = this.hostFade === 'in' ? k : this.hostFade === 'out' ? 1 - k : 1;
        h.el.style.opacity = a.toFixed(3);
        h.el.style.visibility = a < 0.02 && this.hostFade === 'out' ? 'hidden' : '';
        if (this.stage.isExport) h.still(clamp(f.t / f.duration));
        else if (f.t >= f.duration) {
          if (this.hostFade === 'out') { this.host = null; this.hostFade = null; queueMicrotask(() => h.dispose()); }
          else this.hostFade = null;
        }
      }
      if (f.t >= f.duration) { this.prevWires = []; this.laneFrom = null; }
      this.syncChrome();
      const hv = this.hover ? new Set([this.hover, ...nbrs.get(this.hover)!]) : null;
      // a hovered legend entry lights its cards at once, over whatever is pinned
      const lgHover = this.st.hover ? new Set(this.entry(this.st.hover)?.members ?? []) : null;
      const lit = litMembers(this.entries(), this.st.pins, this.st.hover ?? null);
      const sw = this.shownWire(), swEnds = sw ? new Set([wireByKey.get(sw)!.from, wireByKey.get(sw)!.to]) : null;
      const rects = new Map<string, { x: number; y: number; w: number; h: number; o: number; d: number }>();
      const picked = new Set(this.st.picked);
      for (const n of L.nodes) {
        const v = this.morph.value(`c:${n.id}`) as unknown as CardV;
        let { x, y, sx, sy, o: op } = v;
        const dragging = this.drag?.id === n.id, gp = this.gdrag?.start.get(n.id);
        if (dragging) { x = this.drag!.cur.x; y = this.drag!.cur.y; sx = sy = op = 1; }
        else if (gp) { x = gp.x + this.gdrag!.d.x; y = gp.y + this.gdrag!.d.y; sx = sy = op = 1; }
        const hd = (hv && !hv.has(n.id) ? DIM_HOVER : 1) * (swEnds && !swEnds.has(n.id) ? DIM_WIRE : 1);
        const d = dragging ? 1 : lgHover ? (lgHover.has(n.id) ? 1 : DIM_LEGEND) : v.d;
        const card = this.$(`#${cssId(n.id)}`);
        const litNow = this.st.open === n.id || this.hover === n.id || (!!lit && lit.has(n.id)) || !!swEnds?.has(n.id);
        // a splice's ghost (removed here, still in the code) stays where it was, faint
        const gh = nodeMark(n.id) === 'removed' ? (litNow ? 0.75 : 0.45) : 1;
        card.set({ x, y, sx, sy, opacity: op * d * hd * gh, hidden: op < 0.02 });
        card.classes['is-lit'] = litNow;
        card.classes['is-open'] = this.st.open === n.id;
        card.classes['is-drag'] = dragging || !!gp;
        card.classes['is-cursor'] = this.st.cursor === n.id && this.st.open !== n.id;
        card.classes['is-picked'] = picked.has(n.id);
        const b = this.box(n.id), w = b.w * sx, h = b.h * sy;
        rects.set(n.id, { x: x + b.w / 2 - w / 2, y: y + b.h / 2 - h / 2, w, h, o: op, d });
        const c = this.morph.value(`h:${n.id}`) as unknown as CardV;
        const chip = this.$(`#h-${cssId(n.id)}`);
        chip.set({ x: c.x, y: c.y, opacity: c.o * (lgHover ? d : c.d) * hd, hidden: c.o < 0.02 });
        chip.classes['is-lit'] = this.st.open === n.id || this.hover === n.id || (!!lit && lit.has(n.id)) || !!swEnds?.has(n.id);
        chip.classes['is-picked'] = picked.has(n.id);
      }
      // what a splice took away (a proposal undone, the splice left): fades where it is, then hides
      for (const id of this.cardDom) {
        if (byId.has(id)) continue;
        const v = this.morph.value(`c:${id}`) as unknown as CardV | undefined;
        // (squared: what leaves a level is gone well before it lands, so it never crowds the new scene)
        this.$(`#${cssId(id)}`).set(v ? { x: v.x, y: v.y, sx: v.sx, sy: v.sy, opacity: LV || this.levelGone.has(id) ? v.o * v.o : v.o, hidden: v.o < 0.02 } : { opacity: 0, hidden: true });
        this.$(`#h-${cssId(id)}`).set({ opacity: 0, hidden: true });
      }
      for (const gid of this.groupDom) if (!members.has(gid)) this.$(`#g-${cssId(gid)}`).set({ opacity: 0, hidden: true });
      // group frames follow their members' current boxes
      for (const g of groups) {
        // the overview's group cards have no frame around them
        if (LV?.bare.has(g.id)) { this.$(`#g-${cssId(g.id)}`).set({ opacity: 0, hidden: true }); continue; }
        const rs = members.get(g.id)!.map((id) => rects.get(id)!);
        const x0 = Math.min(...rs.map((r) => r.x)) - 14, y0 = Math.min(...rs.map((r) => r.y)) - 22;
        const x1 = Math.max(...rs.map((r) => r.x + r.w)) + 14, y1 = Math.max(...rs.map((r) => r.y + r.h)) + 14;
        const fr = this.$(`#g-${cssId(g.id)}`);
        fr.classes['is-gdrag'] = this.gdrag?.gid === g.id;
        const vis = Math.max(...rs.map((r) => r.o)), dim = Math.max(...rs.map((r) => r.d));
        fr.set({ x: x0, y: y0, opacity: vis * (0.35 + 0.65 * dim), hidden: vis < 0.02 });
        fr.vars['--w'] = `${Math.round(x1 - x0)}px`;
        fr.vars['--h'] = `${Math.round(y1 - y0)}px`;
      }
      // the panel unfolds from its card
      const po = this.pm.value('p')?.o ?? 0;
      const panel = this.$('#bd-panel');
      const pid = this.panelFor;
      this.ensureDock();
      const dk = this.stage.dock;
      if (dk?.shown) for (const b of dk.body.querySelectorAll<HTMLElement>('[data-pin]')) b.classList.toggle('is-pinned', this.st.pins.includes(b.dataset.pin!));
      if (!pid || po < 0.01 || !this.inPlate(pid)) { panel.set({ hidden: true, opacity: 0 }); delete this.el.panel.dataset.plChrome; }
      else {
        this.ensurePanel();
        for (const b of this.el.panel.querySelectorAll<HTMLElement>('[data-pin]')) b.classList.toggle('is-pinned', this.st.pins.includes(b.dataset.pin!));
        const r = rects.get(pid)!, ph = this.el.panel.offsetHeight;
        let px: number, py: number, dx = 0, dy = 0;
        const sec = this.st.open === pid && this.curSection();
        // the section view docks to the side away from its card and slides in from that edge
        // zoomed in (docs/ENGINE.md "Zoom and pan"): the section view is chrome, a side panel at its fit place; the small
        // panel stays beside its (zoomed) card, at its fit size, inside the visible part and clear of the chrome
        const view = this.stage.view, pw = this.el.panel.offsetWidth;
        if (sec) this.el.panel.dataset.plChrome = ''; else delete this.el.panel.dataset.plChrome;
        if (!sec && view.scaled) {
          const o = view.overlay({ x: r.x, y: r.y }, pw, ph, [r], (_at, w, h, W, H, av) => {
            const c = av[0]!, k = view.cardScale, g = PANEL_GAP * k, m = 8 * k;
            let x: number, y: number;
            if (c.x + c.w + g + w <= W - m) { x = c.x + c.w + g; y = c.y - m; dx = -1; }
            else if (c.x - g - w >= m) { x = c.x - g - w; y = c.y - m; dx = 1; }
            else { x = c.x; y = c.y + c.h + g; dy = -1; }
            return { x: clamp(x, m, W - w - m), y: clamp(y, m, H - h - m) };
          });
          const u = 1 - po;
          panel.set({ x: o.x + dx * u * 18 * o.scale, y: o.y + dy * u * 18 * o.scale, opacity: po, scale: o.scale * (0.94 + 0.06 * po) });
        } else {
          if (sec) { const b = this.secBox(pid); px = b.x; py = b.y; dx = b.right ? 1 : -1; }
          else if (r.x + r.w + PANEL_GAP + PANEL_W <= this.W - 8) { px = r.x + r.w + PANEL_GAP; py = r.y - 8; dx = -1; }
          else if (r.x - PANEL_GAP - PANEL_W >= 8) { px = r.x - PANEL_GAP - PANEL_W; py = r.y - 8; dx = 1; }
          else { px = r.x; py = r.y + r.h + PANEL_GAP; dy = -1; }
          px = clamp(px, 8, this.W - pw - 8); py = clamp(py, 8, this.H - ph - 8);
          const u = 1 - po;
          panel.set({ x: px + dx * u * 18, y: py + dy * u * 18, opacity: po, scale: 0.94 + 0.06 * po });
        }
      }
      // the wire's card: beside the pointer (a still: between the wire's two cards), inside the plate
      const wc = this.$('#wh-card'), wel = wc.el;
      if (!sw) { wc.hidden = true; this.wireCardFor = ''; }
      else {
        const pinned = this.st.wirePin === sw && !this.st.wire;
        const ck = `${sw}|${pinned}`;
        if (this.wireCardFor !== ck) {
          const ws = wireByKey.get(sw)!;
          wel.innerHTML = wireCardHTML(infoOf(sw), { pinned, calls: calls.get(sw) ?? [], callsTitle: 'recorded calls' });
          wel.classList.toggle('is-pinned', pinned);
          wel.setAttribute('aria-label', `${label(ws.from)} to ${label(ws.to)}`);
          this.wireCardFor = ck;
        }
        const ra = rects.get(wireByKey.get(sw)!.from)!, rb = rects.get(wireByKey.get(sw)!.to)!;
        const at = (this.st.wire === sw && this.st.wireAt) || { x: (ra.x + ra.w / 2 + rb.x + rb.w / 2) / 2, y: (ra.y + ra.h / 2 + rb.y + rb.h / 2) / 2 };
        // inside the visible part and at its fit size while zoomed (docs/ENGINE.md "Zoom and pan")
        wc.set(this.stage.view.overlay(at, WIRE_CARD_W, wel.offsetHeight, [ra, rb], placeCard));
      }
    }

    draw(f: Frame, fx: Fx) {
      const Ln = fx.under.lines;
      // the bench shows its grid; the read-only board its dots
      fx.under.bg.pattern = this.stage.inBench ? 'grid' : 'dots'; fx.under.bg.patternAlpha = this.stage.inBench ? 0.16 : 0.25;
      const lit = litMembers(this.entries(), this.st.pins, this.st.hover ?? null);
      const touches = (w: Wire, id: string | null | undefined) => !!id && (w.from === id || w.to === id);
      const lanes = new Map<string, number>();   // one bracket lane per caller, so a fan-out shares a trunk
      const drawnWn = new Set<string>();
      const sw = this.shownWire();
      this.wirePaths.clear();
      let top: (() => void) | null = null;
      // the cards on the board (not folded into the rail): free wires keep out from behind them
      const boxes = new Map<string, Rect>();
      for (const n of L.nodes) if (this.drag?.id === n.id || this.morph.value(`c:${n.id}`)!.o! >= 0.5) boxes.set(n.id, this.$(`#${cssId(n.id)}`).bounds());
      const others = (a: string, b: string) => [...boxes].filter(([id]) => id !== a && id !== b).map(([, r]) => r);
      // routes are reused while everything they were routed from is unchanged: free routing reads every card's box, so
      // those are one signature (exact: a number's string is that number), and the generation changes when it does
      let sig = '';
      for (const [id, r] of boxes) sig += `${id}:${rectKey(r)};`;
      if (sig !== this.obstacleSig) { this.obstacleSig = sig; this.obstacleGen++; }
      // how low a wire may run: above the legend as drawn (the chrome floor draws it k times deeper from the bottom)
      const floor = this.floorY();
      const memo = this.routeMemo, routes = new Map<string, { k: string; p: Path }>();
      const routed = (key: string, k: string, make: () => Path) => {
        const m = memo.get(key);
        const r = m && m.k === k ? m : { k, p: make() };
        routes.set(key, r);
        return r.p;
      };
      // a count badge keeps clear of every card, every group's label and the badges placed before it (badgeAt)
      const avoid: Rect[] = [...boxes.values()], placedWn: Rect[] = [];
      if (LV) for (const g of groups) {
        const fr = this.$(`#g-${cssId(g.id)}`), gl = fr.hidden || LV?.bare.has(g.id) ? null : fr.el.querySelector<HTMLElement>('.bd-gl');
        if (gl) avoid.push({ x: fr.x + gl.offsetLeft, y: fr.y + gl.offsetTop, w: gl.offsetWidth, h: gl.offsetHeight });
      }
      // a splice's legend entry lights exactly its wires (proposed; removed and rerouted), hovered or pinned
      const spHover = this.st.hover && ENTRY_MARKS[this.st.hover] ? ENTRY_MARKS[this.st.hover]! : null;
      const spPinned = this.st.pins.flatMap((p) => ENTRY_MARKS[p] ?? []);
      const markLit = (m: string | null) => !!m && (spHover ? spHover.includes(m) : spPinned.includes(m));
      // the groups view's lanes (docs/ENGINE.md "Group navigation"): separate puts every wire on its own track; a change
      // of lanes glides each wire from its old route to its new one over the transition
      const laneOn = !!LV && (this.lanes === 'separate' || !!this.laneFrom);
      const glide = LV && this.laneFrom ? ease.inOutCubic(clamp(f.t / f.duration)) : 1;
      let sep: Map<string, LaneRoute> | null = null;
      if (LV && (this.lanes === 'separate' || this.laneFrom?.mode === 'separate')) {
        const ends = new Map<string, Rect>();
        for (const w of wires) for (const id of [w.from, w.to]) if (!ends.has(id)) ends.set(id, this.$(`#${cssId(id)}`).bounds());
        for (const [id, r] of boxes) if (!ends.has(id)) ends.set(id, r);
        sep = this.sepRoutes(ends, avoid.slice(boxes.size), floor);
      }
      for (const w of wires) {
        const A = this.$(`#${cssId(w.from)}`), B = this.$(`#${cssId(w.to)}`);
        const va = this.morph.value(`c:${w.from}`)!, vb = this.morph.value(`c:${w.to}`)!;
        // a card folded into the rail (the cards view's drill); the groups view has no rail
        const fa = !LV && this.drag?.id !== w.from && va.o! < 0.5, fb = !LV && this.drag?.id !== w.to && vb.o! < 0.5;
        const ra = A.bounds(), rb = B.bounds(), ends = `${rectKey(ra)}|${rectKey(rb)}`;
        // free routing: around every other card on the board (the generation stands for their boxes)
        const free = () => routed(w.key, `shared|f|${this.obstacleGen}|${w.from}|${w.to}|${ends}|${floor}`, () => boardRoute(ra, rb, undefined, others(w.from, w.to), floor));
        let p: Path;
        if (fa && fb) { const lane = lanes.get(w.from) ?? lanes.set(w.from, lanes.size).get(w.from)!; p = routed(w.key, `shared|r|${lane}|${ends}`, () => railRoute(ra, rb, lane)); }
        else if (!this.drag || (this.drag.id !== w.from && this.drag.id !== w.to)) {
          // both cards keep their auto-layout arrangement relative to each other (moved by the same offset): the map's router
          const sa = slot(w.from), sb = slot(w.to);
          const same = Math.abs(A.x - sa.x - (B.x - sb.x)) < 0.5 && Math.abs(A.y - sa.y - (B.y - sb.y)) < 0.5 && A.sx === 1 && B.sx === 1 && A.sy === 1 && B.sy === 1;
          // the caller's column edge moves with it (a wider kit card in the column: the turn stays in the gutter)
          const right = sa.right !== undefined ? A.x + sa.right - sa.x : undefined;
          const grid = { a: { x: A.x, y: A.y, layer: sa.layer, right }, b: { x: B.x, y: B.y, layer: sb.layer } };
          p = same ? routed(w.key, `shared|g|${grid.a.x},${grid.a.y},${grid.a.layer},${grid.a.right}|${grid.b.x},${grid.b.y},${grid.b.layer}|${ends}|${floor}|${sb.layer <= sa.layer ? this.obstacleGen : ''}`, () => boardRoute(ra, rb, grid, sb.layer <= sa.layer ? others(w.from, w.to) : undefined, floor)) : free();
        } else p = free();
        if (laneOn) {
          const own = sep?.get(w.key)?.path ?? p;
          const to = this.lanes === 'separate' ? own : p;
          const from = this.laneFrom ? this.laneFrom.paths?.get(w.key) ?? (this.laneFrom.mode === 'separate' ? own : p) : to;
          p = glide < 1 ? lerpPath(from, to, glide) : to;
        }
        this.wirePaths.set(w.key, p);
      }
      // a count badge in separate lanes or with units keeps off the other wires where it can, and prefers a level run
      const soft = LV && (this.lanes === 'separate' || UNITS) ? { wires: [...this.wirePaths.values()] } : undefined;
      const noun = UNITS ? this.countNoun() : null;
      for (const w of wires) {
        const p = this.wirePaths.get(w.key)!;
        const A = this.$(`#${cssId(w.from)}`), B = this.$(`#${cssId(w.to)}`);
        const ca = this.$(`#h-${cssId(w.from)}`), cb = this.$(`#h-${cssId(w.to)}`);
        const mk = wireMark(w.key), ghost = mk === 'removed' || mk === 'rerouted', proposed = mk === 'proposed' || w.style === 'proposed';
        const lit2 = markLit(mk) || (!spHover && !!lit && lit.has(w.from) && lit.has(w.to));
        const shown = sw === w.key;
        const on = shown || touches(w, this.st.open) || touches(w, this.hover) || touches(w, this.drag?.id) || !!this.gdrag?.start.has(w.from) || !!this.gdrag?.start.has(w.to) || lit2;
        const vis = (n: typeof A, c: typeof A) => Math.max(n.opacity * (n.hidden ? 0 : 1), c.opacity * (c.hidden ? 0 : 1));
        const alpha = on ? 1 : Math.max(lit ? 0.1 : 0.18, Math.min(vis(A, ca), vis(B, cb))) * (sw ? DIM_WIRE : 1);
        // the verdict's style holds when lit: dashed stays dashed, the warning colour stays
        const color = w.style === 'warn' ? 'accent2' : on ? 'accent' : 'line';
        const stroke = { color, width: shown ? 2.8 : on ? 1.9 : 1.5, alpha, glow: shown ? 2.2 : on ? 1.5 : 0 } as const;
        const paint = () => {
          if (ghost) {
            // gone in the splice (removed, or rerouted through a proposal): a faint dotted ghost of the real wire
            const a = on ? 0.9 : 0.6 * (sw ? DIM_WIRE : 1) * (lit && !lit2 ? 0.5 : 1);
            const g = { color: 'muted', width: shown ? 2.2 : 1.6, alpha: a, glow: 0 } as const;
            Ln.dashes(p, { ...g, dash: 2.5, gap: 4.5 });
            const end = p.at(0.999);
            Ln.arrow(end, end.angle, 6, { color: 'muted', width: 1.2, alpha: a });
            return;
          }
          if (proposed) {
            // proposed: lit in the accent, long dashes (an intention, never mistaken for code)
            const a = on || !(lit || sw) ? 1 : 0.4;
            const g = { color: 'accent', width: shown ? 3.2 : 2.4, alpha: a, glow: shown ? 2.6 : 1.6 } as const;
            Ln.dashes(p, { ...g, dash: 9, gap: 5 });
            const end = p.at(0.999);
            Ln.arrow(end, end.angle, shown ? 9 : 8, { color: 'accent', width: shown ? 2 : 1.7, alpha: a });
            return;
          }
          if (w.style === 'dashed') Ln.dashes(p, { ...stroke, dash: 5, gap: 5 });
          else if (w.style === 'idle') Ln.dashes(p, { ...stroke, dash: 1.5, gap: 4, alpha: stroke.alpha * 0.85 });
          else Ln.path(p, stroke);
          const end = p.at(0.999);
          Ln.arrow(end, end.angle, shown ? 8.5 : 7, { color, width: shown ? 1.8 : 1.4, alpha });
        };
        // the hovered wire is drawn last, on top of the others
        if (shown) top = paint; else paint();
        // a wire that stands for several relationships (the groups view) says how many
        const wn = this.wnEl.get(w.key);
        if (wn) {
          // (one relationship under it, between a card and a group, needs no count)
          const n0 = LV?.under.get(w.key)?.length ?? 0, n = n0 > 1 ? n0 : 0, t = noun ? `${n} ${n === 1 ? noun.one : noun.many}` : String(n);
          const b = n ? badgeAt(p, t.length, avoid, placedWn, this.W, this.H, soft && { wires: soft.wires.filter((x) => x !== p) }) : { x: 0, y: 0, w: 0, h: 0 };
          if (n) placedWn.push(b);
          if (wn.textContent !== t) wn.textContent = t;
          wn.classList.toggle('is-on', on);
          wn.style.transform = `translate(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px)`;
          wn.style.opacity = (n ? Math.min(1, alpha * 1.6) : 0).toFixed(3);
          wn.style.visibility = n && alpha > 0.03 ? '' : 'hidden';
          drawnWn.add(w.key);
        }
      }
      top?.();
      this.routeMemo = routes;
      for (const [k, e] of this.wnEl) if (!drawnWn.has(k) && e.style.visibility !== 'hidden') e.style.visibility = 'hidden';
      // the last level's wires fade with their cards while the change of level runs
      for (const w of this.prevWires) {
        const ea = this.cardEl(w.from), eb = this.cardEl(w.to);
        if (!ea || !eb) continue;
        const A = this.$(ea), B = this.$(eb), a = Math.min(A.hidden ? 0 : A.opacity, B.hidden ? 0 : B.opacity) * 0.6;
        if (a < 0.02) continue;
        const p = boardRoute(A.bounds(), B.bounds(), undefined, []);
        Ln.path(p, { color: w.style === 'warn' ? 'accent2' : 'line', width: 1.4, alpha: a });
      }
      // dragging from a card's handle: the relationship it would propose, to the pointer (or the card under it)
      if (this.linking) {
        const A = this.$(`#${cssId(this.linking.from)}`), pa = A.at('right', 0.5, 3);
        const pb = this.linking.over ? this.$(`#${cssId(this.linking.over)}`).at('left', 0.5, 3) : this.linking.at;
        const p = wirePath(pa, pb, { kind: 'curve' });
        Ln.dashes(p, { color: 'accent', width: 2.4, alpha: 1, glow: 1.6, dash: 9, gap: 5 });
        const end = p.at(0.999);
        Ln.arrow(end, end.angle, 8, { color: 'accent', width: 1.7, alpha: 1 });
      }
    }
  };
}
