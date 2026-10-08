// The legend strip: categories (a colour each) and tags (sets of cards) under a plate. Shared by
// the structure board (board.ts), the trace board (flowboard.ts) and the explainer plate
// (src/explainer/scene.ts). Hover an entry: its members light up at once, the wires between them
// light, everything else dims (state at rest + stage.redraw(), no transition). Click pins an entry
// (a transition); several pins show their union; click again unpins. The legend only renders and
// reports; the plate owns the state (pins, hover) and the picture.
import { esc } from './scenes';
import type { MNode, Verdict } from './model';
import './glass.css';   // the main themes' look of boards, tours, the Stack view, splices and the legend

/** `splice`: what an open splice proposes or removes (docs/ENGINE.md "Splice"). `kind`: the cards of a node kind a
 *  kit adds (docs/KITS.md). */
export type LegendKind = 'category' | 'tag' | 'derived' | 'team' | 'mine' | 'splice' | 'kind';
export interface LegendEntry {
  /** Unique across the legend: `cat:<id>`, `tag:<id>`, derived ids (`warnings`, `group:<g>` …), team and your tag ids. */
  id: string;
  name: string;
  kind: LegendKind;
  /** Member ids (node ids on model plates, element ids on explainers). */
  members: string[];
  /** What the chip counts when that isn't its members (a splice's entries count its cards and wires). */
  count?: number;
  /** Categories: palette slot 1..8 (`--pl-cat-n`), 0 = "other". */
  slot?: number;
  hint?: string;
  /** A key entry: the mark it stands for, drawn as a sample on the chip (`proposed` dashed line, `removed` ghost line,
   *  `changed` badge, `warn` ⚠ with the warning's dotted line), and what that mark means, in plain words after the name. */
  sample?: 'proposed' | 'removed' | 'changed' | 'warn' | 'ask' | 'note';
  meaning?: string;
  /** The symbol a `warn`, `ask` or `note` sample shows (default ⚠ for warn): e.g. ✓ for an agreement, ? for a question. */
  glyph?: string;
}

/** Categories past this many fold into "other". */
export const MAX_CATS = 8;

/** Palette slots for categories in a stable order: up to 8 get slots 1..8; with more, the first 7 keep
 *  theirs and the rest share "other" (slot 0), never a generated hue. */
export function categorySlots(cats: string[]): Map<string, number> {
  const out = new Map<string, number>();
  cats.forEach((c, i) => out.set(c, cats.length <= MAX_CATS ? i + 1 : i < MAX_CATS - 1 ? i + 1 : 0));
  return out;
}

/** A model node's category and tags (MNode.category, MNode.tags; both optional). */
export const nodeCategory = (n: MNode) => (typeof n.category === 'string' && n.category ? n.category : null);
export const nodeTags = (n: MNode) => (Array.isArray(n.tags) ? n.tags.filter((x): x is string => typeof x === 'string' && !!x) : []);

/** The line key's rows for a level of a board's groups view (docs/ENGINE.md "Group navigation", Lanes), after the wire
 *  styles' rows: what a count on a wire means when the level has counted wires, and what a call back to the left looks
 *  like when it has one, worded by how it's drawn (a curve under the cards in shared lanes, a track heading left in
 *  separate lanes). `noun`: what a count counts (the board's `countNoun`); `back`: what the calls back reach. */
export interface LineKeyRow { id: 'n' | 'back'; glyph: 'count' | 'curve' | 'left'; text: string }
export function lineKey(o: { counted: boolean; back: string | null; lanes: 'shared' | 'separate'; noun: { one: string; many: string } }): LineKeyRow[] {
  const out: LineKeyRow[] = [];
  if (o.counted) out.push({ id: 'n', glyph: 'count', text: `on a line = how many ${o.noun.many} it stands for` });
  if (o.back) {
    const sep = o.lanes === 'separate';
    out.push({ id: 'back', glyph: sep ? 'left' : 'curve', text: `${sep ? 'heading left' : 'curved'} = a ${o.noun.one} back to a ${o.back} on its left` });
  }
  return out;
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

export interface ModelLegendInput {
  nodes: MNode[];
  /** One per caller → callee pair, with its verdict (model.ts `wiresOf`): the legend says what the wires show. */
  wires: { from: string; to: string; verdict: Verdict }[];
  /** Nodes with a warning check. */
  warned: Set<string>;
  /** Group id of a node, its display name, and the groups in order. */
  groupOf: (id: string) => string;
  groupName: (g: string) => string;
  groups: string[];
  /** Static analysis contributed relationships (automatic mode): "in the code" rather than "declared". */
  statics?: boolean;
  /** The model holds a recorded run (model.ts `hasRuns`; default true). Without one there is no "declared, not seen". */
  runs?: boolean;
  /** Cards that ran but fold parts that never did (a type some of whose methods ran). */
  partly?: Set<string>;
  /** A kit's node kind (docs/KITS.md): its legend entry's name and glyph; null for kinds no kit adds. */
  kindEntry?: (kind: string) => { name: string; glyph?: string | null } | null;
}
/** What a Karyo model says about a set of nodes: categories, declared tags, and tags derived at view time. */
export function modelLegend(inp: ModelLegendInput): { categories: LegendEntry[]; kinds: LegendEntry[]; declared: LegendEntry[]; derived: LegendEntry[]; slotOf: Map<string, number> } {
  const ids = inp.nodes.map((n) => n.id);
  const has = new Set(ids);
  const cats = uniq(inp.nodes.map(nodeCategory).filter((c): c is string => !!c)).sort((a, b) => a.localeCompare(b));
  const slots = categorySlots(cats);
  const slotOf = new Map<string, number>();
  for (const n of inp.nodes) { const c = nodeCategory(n); if (c) slotOf.set(n.id, slots.get(c)!); }
  const categories: LegendEntry[] = cats.filter((c) => slots.get(c)! > 0).map((c) => ({ id: `cat:${c}`, name: c, kind: 'category', slot: slots.get(c)!, members: inp.nodes.filter((n) => nodeCategory(n) === c).map((n) => n.id), hint: `category ${c}` }));
  const other = cats.filter((c) => slots.get(c) === 0);
  if (other.length) categories.push({ id: 'cat:·other', name: 'other', kind: 'category', slot: 0, members: inp.nodes.filter((n) => other.includes(nodeCategory(n) ?? '')).map((n) => n.id), hint: `categories ${other.join(', ')}` });
  const tags = uniq(inp.nodes.flatMap(nodeTags)).sort((a, b) => a.localeCompare(b));
  const declared: LegendEntry[] = tags.map((t) => ({ id: `tag:${t}`, name: t, kind: 'tag', members: inp.nodes.filter((n) => nodeTags(n).includes(t)).map((n) => n.id), hint: `tag ${t} (declared in the code)` }));
  const ends = (pred: (w: ModelLegendInput['wires'][number]) => boolean) => uniq(inp.wires.filter(pred).flatMap((w) => [w.from, w.to])).filter((id) => has.has(id));
  const langs = uniq(inp.nodes.map((n) => n.lang).filter((l): l is string => !!l)).sort();
  const derived = ([
    { id: 'warnings', name: '⚠ warnings', kind: 'derived', hint: 'cards with a warning check', members: ids.filter((id) => inp.warned.has(id)) },
    { id: 'unseen', name: 'declared, not seen', kind: 'derived', hint: 'cards on a declared call no recorded run exercised', members: inp.runs === false ? [] : ends((w) => w.verdict === 'unseen') },
    { id: 'undeclared', name: inp.statics ? 'seen, not in the code' : 'seen, not declared', kind: 'derived', hint: inp.statics ? 'cards on a call a recorded run made that neither an annotation nor static analysis has' : 'cards on a call a recorded run made that no annotation declares', members: ends((w) => w.verdict === 'undeclared') },
    { id: 'unexercised', name: 'not exercised', kind: 'derived', hint: 'cards whose code never ran in recorded runs that watched it in full (a partial run is not a complete one)', members: inp.nodes.filter((n) => n.exercised === false).map((n) => n.id) },
    { id: 'partly-exercised', name: 'partly exercised', kind: 'derived', hint: 'cards that ran, but fold parts that never did in recorded runs that watched them', members: inp.nodes.filter((n) => inp.partly?.has(n.id)).map((n) => n.id) },
    ...inp.groups.map((g): LegendEntry => ({ id: `group:${g}`, name: `in ${inp.groupName(g)}`, kind: 'derived', hint: `the ${inp.groupName(g)} group`, members: ids.filter((id) => inp.groupOf(id) === g) })),
    ...(langs.length > 1 ? langs.map((l): LegendEntry => ({ id: `lang:${l}`, name: l, kind: 'derived', hint: `written in ${l}`, members: inp.nodes.filter((n) => n.lang === l).map((n) => n.id) })) : []),
  ] as LegendEntry[]).filter((e) => e.members.length > 0);
  // one entry per kit kind on the plate: its cards (docs/KITS.md)
  const kinds: LegendEntry[] = [];
  for (const k of uniq(inp.nodes.map((n) => n.kind as string)).sort((a, b) => a.localeCompare(b))) {
    const e = inp.kindEntry?.(k);
    if (e) kinds.push({ id: `kind:${k}`, name: e.glyph ? `${e.glyph} ${e.name}` : e.name, kind: 'kind', members: inp.nodes.filter((n) => n.kind === k).map((n) => n.id), hint: `kind ${k} (from a kit)` });
  }
  return { categories, kinds, declared, derived, slotOf };
}

/** The members to light: the hovered entry's, else the union of the pinned ones, else null (no highlight). */
export function litMembers(entries: LegendEntry[], pins: string[], hover: string | null): Set<string> | null {
  const by = new Map(entries.map((e) => [e.id, e]));
  if (hover && by.has(hover)) return new Set(by.get(hover)!.members);
  const ps = pins.filter((p) => by.has(p));
  return ps.length ? new Set(ps.flatMap((p) => by.get(p)!.members)) : null;
}
/** The union of the pinned entries' members (null when nothing is pinned). */
export function pinnedMembers(entries: LegendEntry[], pins: string[]): Set<string> | null { return litMembers(entries, pins, null); }

/** Resolve a public tag id (`hot-path`, `tag:hot-path`, `cat:store`, `store`, a derived id) to an entry id. */
export function resolveEntry(entries: LegendEntry[], id: string): string | null {
  for (const k of [id, `tag:${id}`, `cat:${id}`, `kind:${id}`, `group:${id}`, `lang:${id}`]) if (entries.some((e) => e.id === k)) return k;
  return null;
}

/** Card / element category edge (data-cat="n") and legend swatches. */
export const CATEGORY_CSS = /* css */ `
  ${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => `[data-cat="${n}"] { --lg-c: var(${n ? `--pl-cat-${n}` : '--pl-cat-other'}); --lg-f: ${n ? `var(--pl-cat-${n}-fill)` : 'none'}; }`).join('\n  ')}
  .mm-card[data-cat]::before { content: ''; position: absolute; left: -1px; top: -1px; bottom: -1px; width: 4px; border-radius: var(--pl-radius) 0 0 var(--pl-radius); background-color: var(--lg-c); background-image: var(--lg-f); pointer-events: none; }
  /* themes may carry the category further than the edge (adenine does, coloured-card style):
     --pl-cat-ring tints the card's border and --pl-cat-kind its kind label, as a share of the category
     colour (0% = off, the default). State rules that set border-color themselves still win. */
  .mm-card[data-cat] { --pl-card-border: color-mix(in oklab, var(--lg-c) var(--pl-cat-ring, 0%), var(--pl-card-border-base)); }
  .mm-card[data-cat] .mm-kind { color: color-mix(in oklab, var(--lg-c) var(--pl-cat-kind, 0%), var(--pl-muted)); }
  .mm-card.is-actor[data-cat]::before { left: 16px; top: 50%; bottom: auto; width: 8px; height: 8px; margin-top: -4px; border-radius: 50%; }
`;

export const LEGEND_CSS = /* css */ `
  ${CATEGORY_CSS}
  .lg { display: grid; gap: 6px; min-width: 0; }
  .lg-row { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
  .lg-row[hidden] { display: none; }
  .lg-h { flex: none; width: 84px; padding-top: 7px; }
  .lg-list { flex: 0 1 auto; display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; max-height: var(--lg-max-h, 62px); overflow: hidden; padding: 1px; align-content: flex-start; }
  .lg-w { display: inline-flex; flex: none; align-items: center; }
  .lg-e { display: inline-flex; align-items: center; gap: 6px; height: 26px; box-sizing: border-box; font: 12px/1 var(--pl-font-mono); padding: 0 9px; background: var(--pl-card); color: var(--pl-fg); border: 1px solid var(--pl-card-border); border-radius: min(var(--pl-radius), 999px); cursor: pointer; white-space: nowrap; }
  .lg-e b { font-weight: 600; color: var(--pl-muted); }
  .lg-e .lg-sw { flex: none; width: 10px; height: 10px; border-radius: min(var(--pl-radius), 2px); background-color: var(--lg-c); background-image: var(--lg-f); }
  .lg-e.derived { border-style: dashed; color: var(--pl-muted); }
  .lg-e.splice { border: 1.5px dashed var(--pl-accent); color: var(--pl-fg); background: color-mix(in srgb, var(--pl-accent) 8%, var(--pl-card)); }
  .lg-e.splice .lg-sw { width: 16px; height: 0; border-radius: 0; border-top: 2px dashed var(--pl-accent); background: none; }
  .lg-e.splice.removed-e .lg-sw { border-top: 2px dotted var(--pl-muted); }
  /* key entries (sample + meaning) */
  .lg-e .lg-mean { color: var(--pl-muted); }
  .lg-e .lg-sw.s-proposed, .lg-e .lg-sw.s-removed { width: 18px; height: 0; border-radius: 0; background: none; border-top: 2px dashed var(--pl-accent); }
  .lg-e .lg-sw.s-removed { border-top: 2px dotted var(--pl-muted); }
  .lg-e .lg-sw.s-changed { width: 14px; height: 8px; box-sizing: border-box; border: 1px solid var(--pl-accent); border-radius: 999px; background: none; }
  .lg-e .lg-sw.s-warn { width: auto; height: auto; border-radius: 0; background: none; display: inline-flex; align-items: center; gap: 3px; font: 700 12px/1 var(--pl-font-mono); color: var(--pl-accent-2); }
  .lg-e .lg-sw.s-warn::after { content: ''; width: 14px; border-top: 2.5px dotted var(--pl-accent-2); box-shadow: 0 0 0 2px color-mix(in srgb, var(--pl-accent-2) 16%, transparent); }
  .lg-e.warn-e { border: 1.5px dashed var(--pl-accent-2); color: var(--pl-fg); background: color-mix(in srgb, var(--pl-accent-2) 8%, var(--pl-card)); }
  .lg-e .lg-sw.s-ask, .lg-e .lg-sw.s-note { width: auto; height: auto; border: 0; border-radius: 0; background: none; font: 700 12px/1 var(--pl-font-mono); }
  .lg-e .lg-sw.s-ask { color: var(--pl-accent); }
  .lg-e .lg-sw.s-note { color: var(--pl-muted); }
  .lg-e.ask-e { border: 1.5px dashed var(--pl-accent); color: var(--pl-fg); }
  .lg-e.team::after, .lg-e.mine::after, .lg-e.kind::after { font-size: 9px; color: var(--pl-muted); letter-spacing: 0.06em; text-transform: uppercase; }
  .lg-e.kind::after { content: 'kind'; }
  .lg-e.team::after { content: 'team'; }
  .lg-e.mine::after { content: 'yours'; }
  .lg-e:hover, .lg-e.is-hover { border-color: var(--pl-fg); color: var(--pl-fg); }
  .lg-e.is-pinned { border: 1px solid var(--pl-accent); color: var(--pl-accent); background: color-mix(in srgb, var(--pl-accent) 10%, var(--pl-card)); }
  .lg-e.is-pinned b { color: var(--pl-accent); }
  .lg-sep { flex: none; align-self: center; width: 1px; height: 16px; margin: 0 3px; background: var(--pl-line); }
  .lg-del { font: 13px/1 var(--pl-font); background: transparent; color: var(--pl-muted); border: 0; padding: 0 4px 0 3px; cursor: pointer; }
  .lg-del:hover { color: var(--pl-accent-2); }
  .lg-new { flex: none; font: 12px/1 var(--pl-font-mono); height: 26px; padding: 0 9px; background: transparent; color: var(--pl-fg); border: 1px dashed var(--pl-line); border-radius: min(var(--pl-radius), 999px); cursor: pointer; white-space: nowrap; }
  .lg-new:hover:not(:disabled) { border-color: var(--pl-accent); color: var(--pl-accent); }
  .lg-new:disabled { opacity: 0.45; cursor: default; }
  .lg-name { flex: none; width: 170px; height: 26px; box-sizing: border-box; font: 12px/1 var(--pl-font-mono); padding: 0 8px; background: var(--pl-card); color: var(--pl-fg); border: 1px solid var(--pl-accent); border-radius: min(var(--pl-radius), 6px); }
  .lg button:focus-visible, .lg input:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: 2px; }
`;

export interface LegendOpts {
  /** Leave out a row with nothing in it (no "none declared", no empty Tags heading): explainers, whose legend is
   *  only what the spec declares. Boards keep both rows. */
  hideEmpty?: boolean;
  /** Section titles (default Categories / Tags). */
  titles?: { categories?: string; tags?: string };
  onHover(id: string | null): void;
  onToggle(id: string): void;
  /** Your tags get a labelled × that calls this. */
  onDelete?(id: string): void;
  /** A "+ tag" button and an inline name field: Enter calls this with the name. */
  onCreate?(name: string): void;
  /** Tooltips name keys 1–9 for the first nine entries (default true; off where those keys mean something else). */
  keyHints?: boolean;
}

/** The legend strip's DOM. `render()` when the entries change, `sync()` every frame (writes only what changed). */
export class LegendStrip {
  readonly el: HTMLElement;
  private cats: HTMLElement;
  private tags: HTMLElement;
  private newBtn: HTMLButtonElement | null = null;
  private name: HTMLInputElement | null = null;
  private hovered: string | null = null;
  /** The name field is open. */
  naming = false;

  constructor(host: HTMLElement, private o: LegendOpts) {
    const el = this.el = document.createElement('div');
    el.className = 'lg';
    el.innerHTML = `<div class="lg-row lg-cats"><span class="pl-label lg-h">${esc(o.titles?.categories ?? 'Categories')}</span><div class="lg-list" data-pl-clip></div></div>
      <div class="lg-row lg-tags"><span class="pl-label lg-h">${esc(o.titles?.tags ?? 'Tags')}</span><div class="lg-list" data-pl-clip></div>${o.onCreate ? '<button type="button" class="lg-new" data-lg-new title="Make a tag from the picked cards">+ tag</button><input class="lg-name" aria-label="Name for the new tag" placeholder="name, then Enter" hidden>' : ''}</div>`;
    host.append(el);
    this.cats = el.querySelector('.lg-cats .lg-list')!;
    this.tags = el.querySelector('.lg-tags .lg-list')!;
    this.newBtn = el.querySelector('.lg-new');
    this.name = el.querySelector('.lg-name');
    const entryOf = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.<HTMLElement>('[data-lg]')?.dataset.lg ?? null;
    const hover = (id: string | null) => { if (id !== this.hovered) { this.hovered = id; o.onHover(id); } };
    el.addEventListener('pointerover', (e) => hover(entryOf(e.target)));
    el.addEventListener('pointerleave', () => hover(null));
    el.addEventListener('focusin', (e) => hover(entryOf(e.target)));
    el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget as Node | null)) hover(null); });
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const del = t.closest<HTMLElement>('[data-lg-del]');
      if (del) { o.onDelete?.(del.dataset.lgDel!); return; }
      if (t.closest('[data-lg-new]')) { this.startNaming(); return; }
      const id = entryOf(t);
      if (id) o.onToggle(id);
    });
    this.name?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.endNaming(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.endNaming(false); }
    });
    this.name?.addEventListener('blur', () => { if (this.naming) this.endNaming(!!this.name!.value.trim()); });
  }

  render(categories: LegendEntry[], tags: LegendEntry[]) {
    const chip = (e: LegendEntry, i: number) => {
      const key = i < 9 && this.o.keyHints !== false ? ` (${i + 1})` : '';
      const sw = e.kind === 'category' ? `<i class="lg-sw" data-cat="${e.slot ?? 0}"></i>` : e.sample ? `<i class="lg-sw s-${e.sample}" aria-hidden="true">${esc(e.glyph ?? (e.sample === 'warn' ? '⚠' : ''))}</i>` : e.kind === 'splice' ? '<i class="lg-sw"></i>' : '';
      const mean = e.meaning ? ` <span class="lg-mean">${esc(e.meaning)}</span>` : '';
      const del = e.kind === 'mine' && this.o.onDelete ? `<button type="button" class="lg-del" data-lg-del="${esc(e.id)}" aria-label="Delete tag ${esc(e.name)}" title="Delete this tag">×</button>` : '';
      return `<span class="lg-w"><button type="button" class="lg-e ${e.kind}${e.sample === 'warn' ? ' warn-e' : e.sample === 'ask' ? ' ask-e' : e.sample === 'note' ? ' note-e' : e.kind === 'splice' ? ` ${e.id.replace(/^splice:/, '')}-e` : ''}" data-lg="${esc(e.id)}" aria-pressed="false" title="${esc(e.hint ?? e.name)} · ${e.count ?? e.members.length} · hover to light, click to pin${key}">${sw}<span class="nm">${esc(e.name)}</span>${mean} <b>${e.count ?? e.members.length}</b></button>${del}</span>`;
    };
    this.cats.innerHTML = categories.map((e, i) => chip(e, i)).join('') || '<span class="pl-muted lg-none">none declared</span>';
    // a splice's entries | declared | derived | the team's and yours, with a hairline between the kinds
    const band = (e: LegendEntry) => (e.kind === 'splice' ? -1 : e.kind === 'kind' ? -0.5 : e.kind === 'tag' ? 0 : e.kind === 'derived' ? 1 : 2);
    this.tags.innerHTML = tags.map((e, i) => (i && band(e) !== band(tags[i - 1]!) ? '<i class="lg-sep" aria-hidden="true"></i>' : '') + chip(e, categories.length + i)).join('');
    // "+ tag" and its name field follow the last tag
    if (this.newBtn && this.name) this.tags.append(this.newBtn, this.name);
    if (this.o.hideEmpty) {
      this.cats.parentElement!.hidden = !categories.length;
      this.tags.parentElement!.hidden = !tags.length && !this.newBtn;
    }
  }

  /** Classes and attributes from the plate's state. `picked`: how many cards "+ tag" would take; `editable`: Bench. */
  sync(s: { pins: string[]; hover: string | null; picked: number; editable: boolean }) {
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.lg-e')) {
      const id = b.dataset.lg!, pinned = s.pins.includes(id);
      b.classList.toggle('is-pinned', pinned);
      b.classList.toggle('is-hover', s.hover === id);
      const p = String(pinned);
      if (b.getAttribute('aria-pressed') !== p) b.setAttribute('aria-pressed', p);
    }
    for (const d of this.el.querySelectorAll<HTMLButtonElement>('.lg-del')) if (d.hidden === s.editable) d.hidden = !s.editable;
    if (this.newBtn) {
      const show = s.editable && !this.naming;
      if (this.newBtn.hidden === show) this.newBtn.hidden = !show;
      const dis = s.picked === 0;
      if (this.newBtn.disabled !== dis) this.newBtn.disabled = dis;
      const tt = dis ? 'Pick cards first (⌥/⇧-click), then make a tag from them' : `Make a tag from the ${s.picked} picked card${s.picked === 1 ? '' : 's'}`;
      if (this.newBtn.title !== tt) this.newBtn.title = tt;
    }
  }

  startNaming() {
    if (!this.name || !this.newBtn || this.newBtn.disabled) return;
    this.naming = true;
    this.name.hidden = false; this.newBtn.hidden = true;
    this.name.value = '';
    this.name.focus({ preventScroll: true });
    this.o.onHover(null);
  }
  private endNaming(create: boolean) {
    if (!this.name || !this.newBtn) return;
    const name = this.name.value.trim();
    this.naming = false;
    this.name.hidden = true; this.newBtn.hidden = false;
    if (create && name) this.o.onCreate?.(name);
    else this.o.onHover(null);
  }
}
