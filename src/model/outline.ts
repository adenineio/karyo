// What a mounted interactive plate says about itself, as plain data: its kind, the things on it
// (nodes, groups), its legend entries and its steps. A page that drives a plate from outside (voice
// control, deep links, tests) reads this to know what can be named; each plate returns it from
// `describe()`. Shape-neutral: labels come from the model or spec, never from here.
import type { LegendEntry } from './legend';

export type PlateKind = 'board' | 'trace' | 'tour' | 'stack' | 'explainer' | 'sequence';

export interface PlateOutline {
  kind: PlateKind;
  title: string;
  /** Everything on the plate that can be named (model nodes, explainer elements). */
  nodes: { id: string; label: string; group: string | null; category: string | null; tags: string[]; /** In a splice: proposed, removed, renamed or moved. */ mark?: string }[];
  groups: { id: string; label: string }[];
  /** The legend as it stands now: categories, tags, derived entries (each with its member count). */
  tags: { id: string; label: string; count: number }[];
  /** Step titles in order (requests on a trace board, slices on a Stack view); empty when the plate has none. */
  steps: string[];
  /** Per step, the node ids it shows or touches (a tour step's diagram, a request's calls, an explainer step's visible set). */
  stepMembers?: string[][];
}

/** The legend entries as outline tags (the ad-hoc highlight entry is not a tag). */
export const outlineTags = (entries: LegendEntry[]): PlateOutline['tags'] =>
  entries.filter((e) => e.id !== HIGHLIGHT).map((e) => ({ id: e.id, label: e.name, count: e.members.length }));

/** The id of the ad-hoc legend entry a plate's `highlight(ids)` pins: never rendered in the legend strip. */
export const HIGHLIGHT = 'highlight';
export const highlightEntry = (members: string[]): LegendEntry => ({ id: HIGHLIGHT, name: 'highlighted', kind: 'derived', hint: 'highlighted from outside the plate', members });

/** One named part of a card's details (docs/ENGINE.md "Card details: sections"): what a page or Jarvis can ask for. */
export interface SectionInfo {
  id: string;
  title: string;
  /** How many items it lists (its `[data-item]` elements); null when it isn't a list. */
  count: number | null;
  /** What its items are called ("tools", "relationships"). */
  noun: string;
  /** Other words that name it ("schemas", "inputs"): matched along with the title. */
  keywords: string[];
  /** The items' names, in order. */
  items: string[];
}
/** What an open card's details show right now, measured from the rendered DOM (items inside the visible box). */
export interface DetailsView {
  /** The open card (node id) and its label. */
  open: string;
  label: string;
  /** The section shown as a section view, or null for the ordinary panel. */
  section: string | null;
  sections: { id: string; title: string; count: number | null }[];
  /** In words: "7 of 7 fields", "2 of 7 fields fully visible, total partly; scroll for the rest". */
  visible: string;
  /** Item names wholly inside the visible box, partly inside, and out of view (scroll to reach them). */
  shown: string[];
  partly: string[];
  hidden: string[];
  /** Whether there is more to scroll to, above or below. */
  more: { above: boolean; below: boolean };
}
/** The pinned inspector (docs/ENGINE.md "Pinned inspector"), as a page or Jarvis reports it: whether it is pinned,
 *  on screen, locked, on which side, and what it shows, measured like DetailsView (only what is actually visible). */
export interface InspectorView {
  pinned: boolean;
  /** Pinned and on screen (it shows only while the plate fills the window, or where a host page places it). */
  shown: boolean;
  locked: boolean;
  side: 'left' | 'right';
  /** Its width (CSS px) in this window. */
  width: number;
  /** What it shows (a node id, or a step's own id such as "request 3") and its label; null while it shows its hint. */
  node: string | null;
  label: string | null;
  section: string | null;
  /** In words, as DetailsView's; or why it shows nothing. */
  visible: string;
  items: { shown: string[]; partly: string[]; hidden: string[] };
  more: { above: boolean; below: boolean };
}
/** An inspector that shows nothing: not pinned, not on screen, or its hint (`why`). */
export function inspectorOff(d: { pinned: boolean; shown: boolean; locked: boolean; side: 'left' | 'right'; px(): number }, why: string): InspectorView {
  return { pinned: d.pinned, shown: d.shown, locked: d.locked, side: d.side, width: d.px(), node: null, label: null, section: null, visible: why, items: { shown: [], partly: [], hidden: [] }, more: { above: false, below: false } };
}
/** Which `[data-item]` elements inside `root` sit inside the scrolling `box` (by their rects): wholly, partly, not. */
export function measureItems(box: HTMLElement, root: ParentNode, noun: string) {
  const b = box.getBoundingClientRect();
  const shown: string[] = [], partly: string[] = [], hidden: string[] = [];
  const els = [...root.querySelectorAll<HTMLElement>('[data-item]')];
  for (const e of els) {
    const r = e.getBoundingClientRect(), name = e.dataset.item!;
    if (r.height === 0 && r.width === 0) hidden.push(name);
    else if (r.top >= b.top - 1 && r.bottom <= b.bottom + 1) shown.push(name);
    else if (r.bottom > b.top + 1 && r.top < b.bottom - 1) partly.push(name);
    else hidden.push(name);
  }
  const n = els.length;
  const visible = !n ? 'nothing listed' : shown.length === n ? `${n} of ${n} ${noun}` : `${shown.length} of ${n} ${noun} fully visible${partly.length ? `, ${partly.join(', ')} partly` : ''}; scroll for the rest`;
  const more = { above: box.scrollTop > 1, below: box.scrollTop + box.clientHeight < box.scrollHeight - 1 };
  return { visible, shown, partly, hidden, more };
}
