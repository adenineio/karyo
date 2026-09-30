// The trace board: a recorded flow as an interactive plate you step through, not a movie
// (docs/ENGINE.md, "Interactive plates"). Left, the flow's root calls (requests, runs, jobs) as cards; right, the map of
// the nodes the flow touched. At rest with nothing selected it shows the WHOLE trace (every wire the
// flow used lit, with use counts). Selecting request #n shows the system as it was at request #n:
// its card unfolds into its nested calls, its path lights, earlier paths ghost, later ones dim, and
// the transition itself carries a comet along the request's hops in order. Under the map, the
// legend of the flow's nodes (categories, tags; hover lights, click pins). In Bench (`b`) the map
// cards (and whole groups, by their frame) drag and their wires follow; positions persist per plate in localStorage.
import { Scene, type Frame, type Fx, type SceneClass, type Vals, type Path, type DockChange, type KeyHelp, Morph, prog, ease, clamp, comet, pulseRing, lightUnder, outline, mix, motion, draggable, pickPath } from '../engine';
import { attributeCall, checksFor, wiresOf, type Model, type MNode, type MSpan, type MFlow } from './model';
import { layout, cardHTML, cardKits, boxOf, route, cssId, esc, MAP_CSS, TOP, SIDE } from './scenes';
import { kitsFor, type KitSet } from '../kits/registry';
import { boardRoute } from './board-route';
import { modelLegend, litMembers, pinnedMembers, resolveEntry, LegendStrip, LEGEND_CSS, type LegendEntry } from './legend';
import { outlineTags, highlightEntry, HIGHLIGHT, inspectorOff, measureItems, type PlateOutline, type DetailsView, type InspectorView } from './outline';
import { callsByPair, wireInfo, wireCardHTML, placeCard, listing, WIRE_CSS, WIRE_CARD_W, NOT_A_WIRE, type WireInfo, type RecordedCall } from './wire-info';

/** What a trace board exposes to a page (buttons outside the plate, deep links). */
export interface TraceBoardApi {
  select(i: number | null): void;
  replay(): void;
  focusTag(tagId: string | null): void;
  /** Light exactly these map cards (an ad-hoc pin, replacing the others); null or [] removes it. */
  highlight?(nodeIds: string[] | null): void;
  /** Escape: unwind the innermost thing (a pinned wire card, the pins, the selection). False when there was nothing. */
  back?(): boolean;
  /** What is on the plate, as plain data (src/model/outline.ts). */
  describe?(): PlateOutline;
  /** The card that opens here is a request's: open the next request (after the selected one) that touches the node,
   *  with its calls unfolded. One section, "calls". False when no request touches it. */
  openDetails?(nodeId: string, section?: string | null): boolean;
  /** The open request's calls as details (docs/ENGINE.md "Card details: sections"); null when none is open. */
  detailsView?(): DetailsView | null;
  /** The pinned inspector (docs/ENGINE.md "Pinned inspector"): the selected request's calls beside the window. */
  inspector?(): InspectorView;
}

const D = 0.9;                       // one transition (s)
const HOPS: [number, number] = [0.02, 0.62]; // the comet's window inside a transition
const COLW = 300, GAP = 10, BASE_H = 64, ERR_H = 18, ROW = 20, ROWS_PAD = 17;
const COL_TOP = TOP + 28;
const OFF = COLW + 48;               // the map starts right of the request column
const DWELL = 450;                   // replay: ms a landed request stays before the next one
const LEG = 100;                     // the legend under the map
const DIM_PIN = 0.3, DIM_LEGEND = 0.22, DIM_WIRE = 0.55;
type XY = { x: number; y: number };

/** One recorded call: caller → callee, drawn on the wire `key` (backwards when `reversed`: see model.ts attributeCall). */
interface Hop { key: string; from: string; to: string; reversed: boolean; err: boolean }
interface Req {
  root: MSpan;
  rows: { s: MSpan; depth: number }[];   // nested calls, tree order
  dur: number;                           // ns
  err: boolean;
  errText: string;
  hops: Hop[];                           // in start order: entry → root node, then every nested call
  nodes: Set<string>;
  pairs: Map<string, number>;            // wire → uses in this request
}

const fmtMs = (ns: number) => {
  const v = ns / 1e6;
  return v < 0.1 ? `${Math.max(1, Math.round(v * 1000))} µs` : v < 1 ? `${v.toFixed(2)} ms` : v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`;
};
const midTrunc = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.ceil((n - 1) / 2))}…${s.slice(s.length - Math.floor((n - 1) / 2))}`);

/** A recorded flow as the trace board sees it: its requests (one per root span) with their hops, each hop
 *  on the wire its call was counted on (model.ts attributeCall), and the flow's wires, one per pair.
 *  Pure, so tests can check that every hop lands on exactly one drawn wire. */
export function traceRequests(model: Model, flow: MFlow) {
  const spans = [...flow.spans].sort((a, b) => a.start - b.start);
  const byId = new Map(spans.map((s) => [s.id, s]));
  const kids = new Map<string, MSpan[]>();
  for (const s of spans) if (s.parent && byId.has(s.parent)) (kids.get(s.parent) ?? kids.set(s.parent, []).get(s.parent)!).push(s);
  const caller = (s: MSpan) => (s.parent && byId.has(s.parent) ? byId.get(s.parent)!.node : flow.entry);
  const end = (s: MSpan) => s.end ?? s.start;

  // ---- layout: the flow's map (its wires, one per pair, are what hops travel)
  const keep = new Set(spans.map((s) => s.node));
  if (flow.entry) keep.add(flow.entry);
  const kindOf = new Map(model.nodes.map((n) => [n.id, n.kind]));
  const wireOf = new Map(wiresOf(model, (id) => keep.has(id) && kindOf.get(id) !== 'module').map((w) => [w.key, w]));

  // ---- requests: one per root span
  const reqs: Req[] = spans.filter((s) => !s.parent || !byId.has(s.parent)).map((root) => {
    const rows: Req['rows'] = [];
    const walk = (s: MSpan, d: number) => { for (const c of kids.get(s.id) ?? []) { rows.push({ s: c, depth: d }); walk(c, d + 1); } };
    walk(root, 1);
    const all = [root, ...rows.map((r) => r.s)];
    const bad = all.find((s) => s.status === 'error');
    const hops: Hop[] = [];
    for (const s of [...all].sort((a, b) => a.start - b.start)) {
      const c = caller(s);
      if (!c || c === s.node) continue;
      const h = attributeCall((k) => wireOf.get(k)?.edge, c, s.node);
      hops.push({ key: h.key, from: c, to: s.node, reversed: h.reversed, err: s.status === 'error' });
    }
    const pairs = new Map<string, number>();
    for (const h of hops) pairs.set(h.key, (pairs.get(h.key) ?? 0) + 1);
    const nodes = new Set(all.map((s) => s.node));
    if (flow.entry) nodes.add(flow.entry);
    return { root, rows, dur: end(root) - root.start, err: !!bad, errText: bad ? String(bad.attrs?.error ?? 'error') : '', hops, nodes, pairs };
  });
  // where each hop's wire runs (a hop always has a wire in a merged model: see model.ts invariants)
  const hopEnds = new Map(reqs.flatMap((r) => r.hops.map((h) => [h.key, h.reversed ? { from: h.to, to: h.from } : { from: h.from, to: h.to }] as const)));

  return { spans, byId, keep, wireOf, reqs, hopEnds };
}

export function traceBoard(model0: Model, flowId: string, o: { title?: string; kits?: KitSet } = {}): SceneClass {
  // kit kinds (docs/KITS.md): their cards, sizes and legend entries
  const kits = o.kits ?? kitsFor(model0);
  const model = kits.decorate(model0);
  const found = model.flows.find((f) => f.id === flowId);
  if (!found) throw new Error(`karyo: model has no flow "${flowId}" (have: ${model.flows.map((f) => f.id).join(', ')})`);
  const flow: MFlow = found;
  const { spans, byId, keep, reqs, hopEnds } = traceRequests(model, flow);
  const nodeOf = new Map(model.nodes.map((n) => [n.id, n]));
  const end = (s: MSpan) => s.end ?? s.start;
  const N = reqs.length;

  // ---- layout: request column on the left, the flow's map on the right
  const baseH = (r: Req) => BASE_H + (r.err ? ERR_H : 0);
  const openH = (r: Req) => baseH(r) + (r.rows.length ? ROWS_PAD + r.rows.length * ROW : 0);
  const colH = (open: number | null) => reqs.reduce((a, r, i) => a + (i === open ? openH(r) : baseH(r)), 0) + GAP * Math.max(0, N - 1);
  const maxCol = Math.max(colH(null), ...reqs.map((_, i) => colH(i)));
  const L0 = layout(model, keep, OFF, COL_TOP + maxCol + 64, kits);
  const pos = new Map([...L0.pos].map(([k, v]) => [k, { ...v, x: v.x + OFF, ...(v.right !== undefined ? { right: v.right + OFF } : {}) }]));
  const box = (id: string) => boxOf(L0, id);
  const kx = cardKits(model, kits);
  const groups = L0.groups.map((g) => ({ ...g, x: g.x + OFF }));
  // the legend sits under the map
  const mapBottom = Math.max(TOP, ...groups.map((g) => g.y + g.h));
  const LEG_X = OFF + SIDE - 14, LEG_Y = mapBottom + 26;
  const W = L0.W, H = Math.max(L0.H, LEG_Y + LEG + 44);
  const gOf = new Map(L0.nodes.map((n) => [n.id, n.kind === 'actor' ? '·outside' : n.group ?? 'other']));
  const gMembers = new Map(groups.map((g) => [g.id, L0.nodes.filter((n) => gOf.get(n.id) === g.id).map((n) => n.id)]));
  const ML = modelLegend({
    nodes: L0.nodes, wires: L0.wires, groups: groups.map((g) => g.id), groupOf: (id) => gOf.get(id)!, groupName: (g) => (g === '·outside' ? 'outside' : g),
    kindEntry: (k) => (kits.kind(k) ? { name: kits.plural(k), glyph: kits.glyph(k) } : null),
    warned: new Set(L0.nodes.filter((n) => checksFor(model, n.id).some((c) => c.level === 'warn')).map((n) => n.id)),
  });
  const entries: LegendEntry[] = [...ML.categories, ...ML.kinds, ...ML.declared, ...ML.derived];
  /** The legend's entries in the order it draws them (its tooltips name keys 1–9 for the first nine). */
  const shownEntries: LegendEntry[] = [...ML.categories, ...ML.declared, ...ML.derived];
  const entry = (id: string | null | undefined) => (id ? entries.find((e) => e.id === id) : undefined);
  const SK = `karyo:trace:${flowId}`;
  const loadMoved = (): Record<string, XY> => { try { const v = JSON.parse(localStorage.getItem(SK) ?? 'null'); return v && typeof v === 'object' && v.positions && typeof v.positions === 'object' ? v.positions : {}; } catch { return {}; } };
  const saveMoved = (m: Record<string, XY>) => { try { localStorage.setItem(SK, JSON.stringify({ positions: m })); } catch { /* not persisted */ } };
  const clampCard = (p: XY, id: string): XY => { const b = box(id); return { x: clamp(p.x, OFF, W - b.w - 8), y: clamp(p.y, TOP, LEG_Y - b.h - 12) }; };
  // one wire per caller → callee pair (model.ts wiresOf)
  const pairs = L0.wires;
  const total = new Map<string, number>();
  for (const r of reqs) for (const [k, c] of r.pairs) total.set(k, (total.get(k) ?? 0) + c);
  const badges = pairs.filter((p) => (total.get(p.key) ?? 0) > 1);
  // what each wire means (wire-info.ts): this flow's calls along it, and the requests it carried
  const pairOf = new Map(pairs.map((p) => [p.key, p]));
  const flowCalls = callsByPair(model, [flow]);
  const infoMemo = new Map<string, WireInfo>();
  const infoOf = (key: string) => infoMemo.get(key) ?? infoMemo.set(key, wireInfo(pairOf.get(key)!, flowCalls.get(key) ?? [], {
    label: (id) => nodeOf.get(id)?.label ?? id, node: (id) => nodeOf.get(id),
    where: (() => { const rs = reqs.map((r, i) => (r.pairs.has(key) ? String(i + 1) : '')).filter(Boolean); return rs.length ? `in request${rs.length === 1 ? '' : 's'} ${listing(rs, 12)} of ${N}` : null; })(),
  })).get(key)!;
  const reqSpans = reqs.map((r) => new Set([r.root.id, ...r.rows.map((x) => x.s.id)]));
  // per-node totals (hover chip)
  const nodeStat = new Map<string, { calls: number; ns: number }>();
  for (const s of spans) { const v = nodeStat.get(s.node) ?? { calls: 0, ns: 0 }; v.calls++; v.ns += end(s) - s.start; nodeStat.set(s.node, v); }

  const langs = [...new Set(spans.map((s) => s.lang).filter(Boolean))].join(' + ');
  const sumNs = reqs.reduce((a, r) => a + r.dur, 0);
  const summary = `${N} request${N === 1 ? '' : 's'} · ${spans.length} calls · ${fmtMs(sumNs)}${langs ? ` · ${langs}` : ''}`;
  const title = o.title ?? flow.title ?? flow.id;
  const errIdx = reqs.findIndex((r) => r.err);

  // "Orders store · save order": the node, plus what the span says it did (skip `fn()` labels)
  const what = (s: MSpan) => {
    const n = nodeOf.get(s.node);
    const l = s.label && s.label !== s.node && !s.label.endsWith('()') && s.label !== n?.label ? s.label : '';
    return { html: l ? `${esc(n?.label ?? s.node)} <span class="op">· ${esc(l)}</span>` : esc(n?.label ?? s.node), text: `${n?.label ?? s.node}${l ? ` · ${l}` : ''}` };
  };
  const hopWin = (r: Req, h: number): [number, number] => { const w = (HOPS[1] - HOPS[0]) / Math.max(1, r.hops.length); return [HOPS[0] + h * w, HOPS[0] + (h + 1) * w]; };

  const reqHTML = (r: Req, i: number) => {
    const label = r.root.label ?? r.root.node;
    const method = String(r.root.attrs?.method ?? '');
    const n = r.rows.length;
    return `<div class="pl-card tb-req" id="q${i}" data-pl-clip data-pl-chrome="bare">
      <div class="tb-l1"><span class="tb-n">${i + 1}</span><span class="tb-name" title="${esc(label)}">${esc(midTrunc(label, 22))}</span><span class="tb-dur">${fmtMs(r.dur)}</span></div>
      <div class="tb-l2"><span>${esc(method || r.root.node)} · ${n} call${n === 1 ? '' : 's'}</span><span class="tb-st ${r.err ? 'is-err' : ''}">${r.err ? 'error' : 'ok'}</span></div>
      ${r.err ? `<div class="tb-err" title="${esc(r.errText)}">${esc(r.errText)}</div>` : ''}
      <div class="tb-rows">${r.rows.map(({ s, depth }) => { const w = what(s); return `<div class="tb-row ${s.status === 'error' ? 'is-err' : ''}"><span class="w" style="padding-left:${Math.min(4, depth - 1) * 12}px" title="${esc(w.text)}${s.status === 'error' && s.attrs?.error ? ` — ${esc(String(s.attrs.error))}` : ''}">${w.html}</span><span class="d">${fmtMs(end(s) - s.start)}</span></div>`; }).join('')}</div>
    </div>`;
  };

  // scene CSS is page-wide (two trace boards can share a page): nothing per-plate goes in it; that's inline
  const CSS = /* css */ `
    .tb-bar { position: absolute; right: ${SIDE}px; top: 40px; display: flex; gap: 8px; }
    .tb-btn { font: 500 11px/1 var(--pl-font-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--pl-fg); background: var(--pl-card); border: 1px solid var(--pl-line); border-radius: min(var(--pl-radius), 6px); padding: 8px 12px; min-width: 76px; cursor: pointer; }
    .tb-btn:hover { border-color: var(--pl-fg); }
    .tb-btn:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: 2px; }
    .tb-btn.is-on { border-color: var(--pl-accent); color: var(--pl-accent); }
    .tb-colhead { position: absolute; left: ${SIDE}px; top: ${TOP + 6}px; }
    /* the request list's chrome band (docs/ENGINE.md "Zoom and pan"): its backdrop while zoomed; the requests sit on it */
    .tb-colband { position: absolute; left: ${SIDE}px; top: ${TOP}px; width: ${COLW}px; bottom: 48px; pointer-events: none; }
    .tb-req { position: absolute; left: ${SIDE}px; top: ${COL_TOP}px; width: ${COLW}px; height: calc(var(--h, ${BASE_H}) * 1px); padding: 10px 12px; overflow: hidden; cursor: pointer; }
    .tb-l1 { display: grid; grid-template-columns: 18px 1fr auto; column-gap: 8px; align-items: baseline; height: 20px; }
    .tb-n { font: 500 11px/20px var(--pl-font-mono); color: var(--pl-muted); }
    .tb-name { font: 600 13.5px/20px var(--pl-font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tb-req.is-lit .tb-name { color: var(--pl-accent); }
    .tb-dur { font: 12px/20px var(--pl-font-mono); color: var(--pl-fg); font-variant-numeric: tabular-nums; }
    .tb-l2 { display: flex; justify-content: space-between; margin: 6px 0 0 26px; font: 11px/16px var(--pl-font-mono); color: var(--pl-muted); height: 16px; }
    .tb-st.is-err { color: var(--pl-accent-2); font-weight: 600; }
    .tb-err { margin: 2px 0 0 26px; height: 16px; font: 11px/16px var(--pl-font-mono); color: var(--pl-accent-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tb-rows { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--pl-card-border); }
    .tb-row { display: grid; grid-template-columns: 1fr auto; column-gap: 10px; height: ${ROW}px; font: 11.5px/${ROW}px var(--pl-font-mono); }
    .tb-row .w { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tb-row .op, .tb-row .d { color: var(--pl-muted); }
    .tb-row .d { font-variant-numeric: tabular-nums; }
    .tb-row.is-err .w, .tb-row.is-err .d, .tb-row.is-err .op { color: var(--pl-accent-2); }
    .tb-badge { position: absolute; left: 0; top: 0; z-index: 3; pointer-events: none; }
    .tb-badge > span { display: block; transform: translate(-50%, -50%); font: 600 10px/1 var(--pl-font-mono); padding: 3px 5px; border-radius: 999px; background: var(--pl-card); border: 1px solid var(--pl-accent); color: var(--pl-accent); white-space: nowrap; }
    .mm-card { cursor: pointer; }
    .mm-card.is-lit.is-err { border-color: var(--pl-accent-2); }
    .tb-chip { position: absolute; right: 8px; top: -12px; z-index: 4; font: 600 10px/1 var(--pl-font-mono); padding: 4px 7px; border-radius: 999px; background: var(--pl-fg); color: var(--pl-bg); white-space: nowrap; pointer-events: none; }
    .tb-mode { position: absolute; left: ${SIDE}px; bottom: 20px; font: 12px/1.2 var(--pl-font-mono); color: var(--pl-muted); white-space: nowrap; }
    .tb-legend { position: absolute; right: ${SIDE}px; padding-top: 10px; border-top: 1px dashed var(--pl-line); }
    .tb-legend .lg-cats .lg-list { --lg-max-h: 28px; }
    .tb-bar [hidden] { display: none; }
    .mm-group.tb-group { width: var(--w); height: var(--h); }
    .tb-insp { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 14px 18px 12px; }
    .tb-ih { display: flex; align-items: center; gap: 8px; }
    .tb-ih > .pl-label { flex: 1; min-width: 0; }
    .tb-it { font: 700 22px/1.2 var(--pl-font-display); overflow-wrap: anywhere; }
    .tb-im { font: 13px/1.4 var(--pl-font-mono); color: var(--pl-muted); }
    .tb-im .is-err { color: var(--pl-accent-2); font-weight: 600; }
    .tb-ie { font: 13px/1.4 var(--pl-font-mono); color: var(--pl-accent-2); overflow-wrap: anywhere; }
    .tb-ibody { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; outline: none; border-top: 1px solid var(--pl-card-border); padding-top: 6px; }
    .tb-icall { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 12px; padding: 5px 0; border-bottom: 1px solid var(--pl-card-border); font: 14px/1.4 var(--pl-font-mono); }
    .tb-icall:last-child { border-bottom: 0; }
    .tb-icall .w { overflow-wrap: anywhere; }
    .tb-icall .op, .tb-icall .d { color: var(--pl-muted); }
    .tb-icall .d { font-variant-numeric: tabular-nums; }
    .tb-icall .e { grid-column: 1 / -1; font-size: 12.5px; color: var(--pl-accent-2); overflow-wrap: anywhere; }
    .tb-icall.is-err .w, .tb-icall.is-err .op { color: var(--pl-accent-2); }
    .tb-imore { font: 12px/1.3 var(--pl-font-mono); color: var(--pl-muted); text-align: right; min-height: 14px; }
    .mm-card.is-hl { border-color: var(--pl-accent); }
    .plate.is-bench .mm-card { cursor: grab; user-select: none; touch-action: none; }
    .mm-card.is-drag { z-index: 9; cursor: grabbing; }
    /* Bench: a group frame (its border, empty area or label) drags the whole group; a wire under the pointer still wins */
    .plate.is-bench .mm-group.tb-group { cursor: grab; transition: border-color 120ms, background-color 120ms; }
    .plate.is-bench .plate-dom:not(.wh-over):not(.tb-moving) .tb-group:hover, .plate.is-bench .tb-group.is-gdrag { border-color: color-mix(in srgb, var(--pl-accent) 60%, var(--pl-line)); background-color: color-mix(in srgb, var(--pl-accent) 4%, transparent); }
    .plate.is-bench .tb-group.is-gdrag { cursor: grabbing; }
    .plate-dom.wh-over .tb-group { cursor: pointer; }
    ${LEGEND_CSS}
    ${WIRE_CSS}
  `;

  return class TraceBoard extends Scene implements TraceBoardApi {
    static title = title;
    static width = W;
    static height = H;
    static duration = D;
    static fx = 'under' as const;
    static interactive = true;
    static inspector = true;

    private sel: number | null = null;
    /** The pinned inspector (docs/ENGINE.md "Pinned inspector"): the request it is locked on, and what its DOM shows. */
    private dockLock: number | null = null;
    private dockBuilt: string | null = null;
    private open = true;
    /** The selection on screen when the current transition began (its path un-lights as the new one lights). */
    private fromSel: number | null = null;
    /** The transition re-lights the same path (a fold, or replay starting on the current request): no comet. */
    private quiet = false;
    private hover: string | null = null;
    private replaying = false;
    private timer: ReturnType<typeof setTimeout> | 0 = 0;
    private morph = new Morph();
    private paths = new Map<string, Path>();
    static bench = true;
    /** Legend: pinned entries (a transition) and the hovered one (at once). */
    private pins: string[] = [];
    private lgHover: string | null = null;
    private legend!: LegendStrip;
    /** Bench: the viewer's positions for map cards (localStorage), and the card being dragged. */
    private moved: Record<string, XY> = loadMoved();
    private drag: { id: string; start: XY; cur: XY } | null = null;
    /** Bench: a group dragged by its frame: where each member started, and the delta so far (the same for all). */
    private gdrag: { gid: string; start: Map<string, XY>; d: XY } | null = null;
    /** The click that ends a group drag lands on the plate: it is not a click on a wire or on empty space. */
    private eatClick = false;
    /** Wire hover (docs/ENGINE.md "Wire hover"): the wire under the pointer and where it is (state at rest), the pinned one. */
    private wire: string | null = null;
    private wireAt: XY | null = null;
    private wirePin: string | null = null;
    private wireCardFor = '';

    build(dom: HTMLElement) {
      dom.innerHTML = `<style>${MAP_CSS}${CSS}${kits.css()}</style>
        <header class="mm-head" data-pl-chrome><div class="pl-label">${esc(summary)}</div><h1 class="pl-title">${esc(title)}</h1></header>
        <div class="tb-bar" data-pl-chrome><button type="button" class="tb-btn" id="tb-reset" title="Put every map card back where the layout has it" hidden>Reset layout</button><button type="button" class="tb-btn" id="tb-replay" title="Replay the requests one by one (p; any key stops)">Replay</button><button type="button" class="tb-btn" id="tb-whole" title="Back to the whole trace (Esc)">Whole trace</button></div>
        <div class="pl-label tb-colhead" data-pl-chrome="bare">Requests, in order</div>
        <div class="tb-colband" data-pl-chrome aria-hidden="true"></div>
        ${groups.map((g) => `<div class="mm-group tb-group" id="g-${cssId(g.id)}" style="left:${g.x}px;top:${g.y}px;--w:${g.w}px;--h:${g.h}px"><span class="pl-label">${esc(g.label)}</span></div>`).join('')}
        ${L0.nodes.map((n) => { const p = pos.get(n.id)!; return cardHTML(n, kx).replace('class="pl-card', `style="left:${p.x}px;top:${p.y}px" class="pl-card`).replace(/<\/div>\s*$/, `${this.chipHTML(n)}</div>`); }).join('')}
        ${badges.map((b, j) => `<div class="tb-badge" id="b${j}"><span>×${total.get(b.key)}</span></div>`).join('')}
        ${reqs.map(reqHTML).join('')}
        <div class="tb-legend" id="tb-legend" data-pl-chrome style="left:${LEG_X}px;top:${LEG_Y}px"></div>
        <div class="pl-card wh-card" id="wh-card" role="status" aria-live="polite"></div>
        <div class="tb-mode" id="tb-mode" data-pl-chrome></div>`;

      reqs.forEach((_, i) => dom.querySelector(`#q${i}`)!.addEventListener('click', () => this.clickReq(i)));
      for (const n of L0.nodes) {
        const el = dom.querySelector<HTMLElement>(`#${cssId(n.id)}`)!;
        const slot = ML.slotOf.get(n.id);
        if (slot !== undefined) el.dataset.cat = String(slot);
        draggable(el, this.stage, {
          onClick: () => this.clickNode(n.id),
          // only in Bench: elsewhere the map is read-only
          onStart: () => { if (!this.stage.inBench) return; const p = this.at(n.id); this.drag = { id: n.id, start: p, cur: p }; },
          onMove: ({ dx, dy }) => { if (!this.drag) return; this.drag.cur = clampCard({ x: this.drag.start.x + dx, y: this.drag.start.y + dy }, n.id); this.paths.clear(); this.stage.redraw(); },
          onEnd: () => {
            const d = this.drag;
            if (!d) return;
            this.drag = null;
            this.moved[d.id] = d.cur;
            saveMoved(this.moved);
            this.paths.clear();
            this.stage.redraw();
          },
        });
        el.addEventListener('mouseenter', () => { if (this.gdrag) return; this.hover = n.id; this.stage.redraw(); });
        el.addEventListener('mouseleave', () => { if (this.hover === n.id) { this.hover = null; this.stage.redraw(); } });
      }
      // Bench: a group frame drags every card of its group together (not from a wire under the pointer: a click pins it)
      for (const g of groups) {
        draggable(dom.querySelector<HTMLElement>(`#g-${cssId(g.id)}`)!, this.stage, {
          handle: (e) => this.stage.inBench && !this.wireUnder(e).key,
          onStart: () => {
            if (!this.stage.inBench || this.drag) return;
            const ids = gMembers.get(g.id)!;
            if (ids.length) { this.gdrag = { gid: g.id, start: new Map(ids.map((id) => [id, this.at(id)])), d: { x: 0, y: 0 } }; this.hover = null; this.wire = null; this.wireAt = null; }
          },
          onMove: ({ dx, dy }) => {
            const gd = this.gdrag;
            if (!gd) return;
            // as a unit: the delta is clamped so every member stays where one card's drag may go
            const ps = [...gd.start].map(([id, p]) => ({ ...p, ...box(id) }));
            const lo = { x: OFF - Math.min(...ps.map((p) => p.x)), y: TOP - Math.min(...ps.map((p) => p.y)) };
            const hi = { x: W - 8 - Math.max(...ps.map((p) => p.x + p.w)), y: LEG_Y - 12 - Math.max(...ps.map((p) => p.y + p.h)) };
            gd.d = { x: clamp(dx, Math.min(0, lo.x), Math.max(0, hi.x)), y: clamp(dy, Math.min(0, lo.y), Math.max(0, hi.y)) };
            this.paths.clear(); this.stage.redraw();
          },
          onEnd: () => {
            const gd = this.gdrag;
            if (!gd) return;
            this.gdrag = null;
            this.eatClick = true;
            setTimeout(() => { this.eatClick = false; }, 0);
            if (gd.d.x || gd.d.y) {
              for (const [id, p] of gd.start) this.moved[id] = { x: p.x + gd.d.x, y: p.y + gd.d.y };
              saveMoved(this.moved);
            }
            this.paths.clear(); this.stage.redraw();
          },
        });
      }
      this.legend = new LegendStrip(dom.querySelector('#tb-legend')!, {
        onHover: (id) => { if (id !== this.lgHover) { this.lgHover = id; this.stage.redraw(); } },
        onToggle: (id) => this.togglePin(id),
      });
      this.legend.render(shownEntries.slice(0, ML.categories.length), shownEntries.slice(ML.categories.length));
      dom.querySelector('#tb-reset')!.addEventListener('click', () => this.resetLayout());
      dom.querySelector('#tb-replay')!.addEventListener('click', () => this.replay());
      dom.querySelector('#tb-whole')!.addEventListener('click', () => this.select(null));
      // wires: hover shows what one means, a click pins its card
      dom.addEventListener('pointermove', (e) => this.wireMove(e));
      this.stage.viewport.addEventListener('pointerleave', () => { if (this.wire) { this.wire = null; this.wireAt = null; this.stage.redraw(); } });
      dom.addEventListener('click', (e) => this.wireClick(e));
      // any press stops a replay (the press then does what it does)
      dom.addEventListener('pointerdown', (e) => { if (this.replaying && !(e.target as HTMLElement).closest('#tb-replay')) this.stopReplay(); }, true);
      // replay: when a transition has landed, wait a beat, then step on
      this.stage.onFrame((t) => {
        if (this.replaying && !this.timer && t >= this.stage.duration && !this.stage.playing)
          this.timer = setTimeout(() => this.replayNext(), motion() === 0 ? DWELL * 2 : DWELL);
      });
      this.morph.snap(this.targets());
    }

    private chipHTML(n: MNode) {
      const st = nodeStat.get(n.id);
      const txt = st ? `${st.calls} call${st.calls === 1 ? '' : 's'} · ${fmtMs(st.ns)}` : n.id === flow.entry ? `${N} request${N === 1 ? '' : 's'} sent` : 'not called';
      return `<span class="tb-chip" id="c-${cssId(n.id)}">${esc(txt)}</span>`;
    }

    // ------------------------------------------------------------ public API
    /** Select request i (0-based), or null for the whole trace. */
    select(i: number | null) {
      this.stopReplay();
      if (i !== null) i = clamp(Math.round(i), 0, N - 1);
      if (i === this.sel && (i === null || this.open)) return;
      this.go(i, true);
    }
    /** Step through every request from the current one (or the first) to the last, then back to the whole trace. Again: stop. */
    replay() {
      if (this.replaying) { this.stopReplay(); return; }
      if (!N) return;
      this.replaying = true;
      this.go(this.sel ?? 0, true, true);
    }

    /** Pin exactly this legend entry (a tag id, `cat:<c>`, a derived id); null clears every pin. */
    focusTag(tagId: string | null) {
      const id = tagId === null ? null : resolveEntry(entries, tagId);
      if (tagId !== null && !id) return;
      const pins = id ? [id] : [];
      if (JSON.stringify(pins) === JSON.stringify(this.pins)) return;
      this.pins = pins;
      this.repin();
    }
    highlight(nodeIds: string[] | null) {
      const ids = [...new Set((nodeIds ?? []).filter((id) => gOf.has(id)))];
      const had = this.pins.includes(HIGHLIGHT);
      // the ad-hoc entry lives in the entry list (so pins, lighting and the mode line treat it like any entry) but is never drawn in the strip
      const i = entries.findIndex((e) => e.id === HIGHLIGHT);
      if (i >= 0) entries.splice(i, 1);
      if (ids.length) entries.push(highlightEntry(ids));
      if (!ids.length && !had) return;
      this.stopReplay();
      this.pins = ids.length ? [HIGHLIGHT] : this.pins.filter((p) => p !== HIGHLIGHT);
      this.repin();
    }
    back(): boolean {
      this.stopReplay();
      if (this.wirePin) { this.wirePin = null; this.stage.redraw(); }
      else if (this.pins.length) { this.pins = []; this.repin(); }
      else if (this.sel === null) return false;
      else this.select(null);
      return true;
    }
    openDetails(nodeId: string, _section: string | null = null): boolean {
      const hits = reqs.map((r, i) => (r.nodes.has(nodeId) ? i : -1)).filter((i) => i >= 0);
      if (!hits.length) return false;
      const next = hits.find((i) => this.sel === null || i > this.sel) ?? hits[0]!;
      this.stopReplay();
      this.go(next, true);
      return true;
    }
    /** The column is laid out so an open request always shows every call (maxCol), so what is listed is what is visible. */
    detailsView(): DetailsView | null {
      if (this.sel === null) return null;
      const r = reqs[this.sel]!, names = r.rows.map(({ s }) => s.label ?? nodeOf.get(s.node)?.label ?? s.node), n = names.length;
      return {
        open: `request ${this.sel + 1}`, label: r.root.label ?? r.root.node, section: this.open ? 'calls' : null,
        sections: [{ id: 'calls', title: 'calls', count: n }],
        visible: this.open ? `${n} of ${n} calls` : `collapsed: its ${n} calls are folded away`,
        shown: this.open ? names : [], partly: [], hidden: this.open ? [] : names, more: { above: false, below: false },
      };
    }
    // ------------------------------------------------------------ the pinned inspector
    /** The request the inspector shows: the one it is locked on, else the selected one; null when not on screen or none. */
    private dockView(): number | null {
      if (!this.stage.dock?.shown) return null;
      return this.dockLock ?? this.sel;
    }
    private ensureDock() {
      const d = this.stage.dock;
      if (!d?.shown) { this.dockBuilt = null; return; }
      const i = this.dockView();
      const key = i === null ? '' : `${i}|${this.dockLock !== null}`;
      if (this.dockBuilt === key) return;
      this.dockBuilt = key;
      if (i === null) { d.setSubject(null, 'select a request to inspect its calls'); return; }
      const r = reqs[i]!, name = r.root.label ?? r.root.node, n = r.rows.length, method = String(r.root.attrs?.method ?? '');
      d.body.innerHTML = `<div class="tb-insp" role="region" aria-label="Request ${i + 1}: its calls">
        <div class="tb-ih"><span class="pl-label">request ${i + 1} of ${N}${method ? ` · ${esc(method)}` : ''}</span></div>
        <div class="tb-it">${esc(name)}</div>
        <div class="tb-im">${n} call${n === 1 ? '' : 's'} · ${fmtMs(r.dur)} · <span class="${r.err ? 'is-err' : ''}">${r.err ? 'error' : 'ok'}</span></div>
        ${r.err ? `<div class="tb-ie">${esc(r.errText)}</div>` : ''}
        <div class="tb-ibody" data-pl-clip tabindex="0" role="region" aria-label="Calls of request ${i + 1}">${r.rows.map(({ s, depth }) => {
          const w = what(s), bad = s.status === 'error';
          return `<div class="tb-icall ${bad ? 'is-err' : ''}" data-item="${esc(w.text)}"><span class="w" style="padding-left:${Math.min(6, depth - 1) * 14}px">${w.html}</span><span class="d">${fmtMs(end(s) - s.start)}</span>${bad && s.attrs?.error ? `<span class="e" style="padding-left:${Math.min(6, depth - 1) * 14}px">${esc(String(s.attrs.error))}</span>` : ''}</div>`;
        }).join('') || '<div class="tb-im">no nested calls</div>'}</div>
        <div class="tb-imore" aria-live="polite"></div></div>`;
      d.setSubject(`request ${i + 1}`);
      const body = d.body.querySelector<HTMLElement>('.tb-ibody')!;
      body.addEventListener('scroll', () => this.markDock());
      this.markDock();
    }
    private dockSig = '';
    /** The "more below" line follows the scroll; a scroll that changes what is visible redraws (Jarvis hears it). */
    private markDock() {
      const body = this.stage.dock?.body.querySelector<HTMLElement>('.tb-ibody');
      if (!body) return;
      const m = measureItems(body, body, 'calls');
      const more = this.stage.dock!.body.querySelector<HTMLElement>('.tb-imore')!;
      const t = m.more.below ? `more below · ${m.hidden.length ? `${m.hidden.length} not in view · ` : ''}scroll` : m.more.above ? 'end' : '';
      if (more.textContent !== t) more.textContent = t;
      const sig = `${m.shown.length}|${m.partly.join(',')}`;
      if (sig !== this.dockSig) { const first = !this.dockSig; this.dockSig = sig; if (!first) this.stage.redraw(); }
    }
    dockChanged(what: DockChange) {
      const d = this.stage.dock!;
      if (what === 'lock') { this.dockLock = d.locked ? this.dockView() : null; if (d.locked && this.dockLock === null) d.lock(false); }
      if (what === 'pin') this.dockLock = null;
    }
    inspector(): InspectorView {
      const d = this.stage.dock;
      if (!d) return inspectorOff({ pinned: false, shown: false, locked: false, side: 'right', px: () => 0 }, 'no inspector on this plate');
      if (!d.shown) return inspectorOff(d, d.pinned ? 'pinned, but not on screen (it shows while the plate fills the window)' : 'not pinned');
      this.ensureDock();
      const i = this.dockView();
      if (i === null) return inspectorOff(d, 'nothing: no request is selected, so it says "select a request to inspect its calls"');
      const body = d.body.querySelector<HTMLElement>('.tb-ibody')!;
      const m = measureItems(body, body, 'calls');
      return { pinned: true, shown: true, locked: d.locked, side: d.side, width: d.px(), node: `request ${i + 1}`, label: reqs[i]!.root.label ?? reqs[i]!.root.node, section: 'calls', visible: m.visible, items: { shown: m.shown, partly: m.partly, hidden: m.hidden }, more: m.more };
    }
    describe(): PlateOutline {
      return {
        kind: 'trace', title,
        nodes: L0.nodes.map((n) => ({ id: n.id, label: n.label ?? n.id, group: gOf.get(n.id) ?? null, category: n.category ?? null, tags: [...(n.tags ?? [])] })),
        groups: groups.map((g) => ({ id: g.id, label: g.id === '·outside' ? 'outside' : g.id })),
        tags: outlineTags(entries),
        steps: reqs.map((r) => r.root.label ?? r.root.node),
        stepMembers: reqs.map((r) => [...r.nodes]),
      };
    }
    private togglePin(id: string) {
      if (!entry(id)) return;
      this.stopReplay();
      this.pins = this.pins.includes(id) ? this.pins.filter((p) => p !== id) : [...this.pins, id];
      this.repin();
    }
    /** Pins changed: glide the dims, no comet (the selected path doesn't change). */
    private repin() { this.quiet = true; this.fromSel = this.sel; this.morph.retarget(this.targets()); this.stage.transition(); }
    private resetLayout() { this.moved = {}; saveMoved(this.moved); this.paths.clear(); this.stage.redraw(); }
    setBench(on: boolean) { if (!on && (this.drag || this.gdrag)) { this.drag = null; this.gdrag = null; this.paths.clear(); } }
    /** Where a map card rests: the viewer's position in Bench, else the layout's. */
    private at(id: string): XY {
      if (this.drag?.id === id) return this.drag.cur;
      const gp = this.gdrag?.start.get(id);
      if (gp) return { x: gp.x + this.gdrag!.d.x, y: gp.y + this.gdrag!.d.y };
      const m = this.moved[id]; const p = pos.get(id)!; return m ? clampCard(m, id) : { x: p.x, y: p.y }; }

    // ------------------------------------------------------------ wires
    private wireUnder(e: MouseEvent): { key: string | null; at: XY } {
      const at = this.stage.toStage(e.clientX, e.clientY);
      const t = e.target as HTMLElement | null;
      if (!t || t.closest(NOT_A_WIRE)) return { key: null, at };
      return { key: pickPath(pairs.map((p) => [p.key, this.path(p.key)] as const), at, Math.max(4, 6 / this.stage.zoom)), at };
    }
    private wireMove(e: PointerEvent) {
      if (this.drag || this.gdrag) return;
      const { key, at } = this.wireUnder(e);
      if (!key && !this.wire) return;
      this.wire = key; this.wireAt = key ? at : null;
      this.stage.redraw();
    }
    private wireClick(e: MouseEvent) {
      if (this.eatClick) { this.eatClick = false; return; }
      if ((e.target as HTMLElement).closest('.wh-card')) return;
      const { key } = this.wireUnder(e);
      if (key) this.wirePin = this.wirePin === key ? null : key;
      else if (this.wirePin) this.wirePin = null;
      else return;
      this.stage.redraw();
    }
    private shownWire(): string | null { const k = this.wire ?? this.wirePin; return k && pairOf.has(k) ? k : null; }
    /** The recorded calls a pinned card lists: the selected request's along that wire, else the whole flow's. */
    private wireCalls(key: string): { calls: RecordedCall[]; title: string } {
      const all = flowCalls.get(key) ?? [];
      if (this.sel === null) return { calls: all, title: 'calls in this flow' };
      return { calls: all.filter((c) => reqSpans[this.sel!]!.has(c.span.id)), title: `calls in request ${this.sel + 1}` };
    }

    // ------------------------------------------------------------ state
    private go(sel: number | null, open: boolean, force = false) {
      this.quiet = !force && sel === this.sel && sel !== null;
      this.fromSel = force && sel === this.sel ? null : this.sel;
      this.sel = sel; this.open = open;
      this.morph.retarget(this.targets());
      this.stage.transition();
    }
    private stopReplay() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = 0;
      if (this.replaying) { this.replaying = false; this.stage.redraw(); }
    }
    private replayNext() {
      this.timer = 0;
      if (!this.replaying) return;
      if (this.sel === null || this.sel >= N - 1) { this.replaying = false; this.go(null, true); }
      else this.go(this.sel + 1, true);
    }
    private clickReq(i: number) {
      if (i === this.sel) { this.stopReplay(); this.go(i, !this.open); } else this.select(i);
    }
    private clickNode(id: string) {
      const hits = reqs.map((r, i) => (r.nodes.has(id) ? i : -1)).filter((i) => i >= 0);
      if (!hits.length) return;
      const cur = this.sel === null ? -1 : hits.indexOf(this.sel);
      this.select(hits[(cur + 1) % hits.length]!);
    }
    private step(d: number) {
      const to = this.sel === null ? (d > 0 ? 0 : N - 1) : clamp(this.sel + d, 0, N - 1);
      if (to !== this.sel) this.select(to);
    }

    /** The resting layout of the current state. */
    private targets() {
      const m = new Map<string, Vals>(), s = this.sel;
      let y = 0;
      reqs.forEach((r, i) => {
        const opened = s === i && this.open;
        const h = opened ? openH(r) : baseH(r);
        m.set(`q${i}`, { y, h, open: opened ? 1 : 0, o: s === null || i === s ? 1 : i < s ? 0.85 : 0.6, lit: s === i ? 1 : 0 });
        y += h + GAP;
      });
      const earlier = (pred: (r: Req) => boolean) => s !== null && reqs.slice(0, s).some(pred);
      const pinned = pinnedMembers(entries, this.pins);
      for (const n of L0.nodes) {
        const o = s === null ? 1 : reqs[s]!.nodes.has(n.id) ? 1 : earlier((r) => r.nodes.has(n.id)) ? 0.72 : 0.42;
        m.set(`n:${n.id}`, { o, pin: pinned && !pinned.has(n.id) ? DIM_PIN : 1 });
      }
      for (const p of pairs) m.set(`pl:${p.key}`, { k: pinned && pinned.has(p.from) && pinned.has(p.to) ? 1 : 0 });
      for (const p of pairs) {
        const used = total.has(p.key);
        let v: Vals;
        if (s === null) v = used ? { on: 1, a: 0.8, w: 1.5 } : { on: 0, a: 0.5, w: 1.2 };
        else if (reqs[s]!.pairs.has(p.key) || earlier((r) => r.pairs.has(p.key))) v = { on: 1, a: 0.3, w: 1.4 };
        else v = { on: 0, a: used ? 0.32 : 0.4, w: 1.2 };
        m.set(`e:${p.key}`, v);
      }
      badges.forEach((b, j) => m.set(`b${j}`, { o: s === null || (reqs[s]!.pairs.get(b.key) ?? 0) > 1 ? 1 : 0 }));
      return m;
    }

    getState() { return { sel: this.sel, open: this.open, pins: [...this.pins], hover: this.lgHover, wire: this.wire, wireAt: this.wireAt, wirePin: this.wirePin }; }
    setState(st: unknown) {
      const v = (st ?? {}) as { sel?: number | null; open?: boolean; pins?: string[]; hover?: string | null; wire?: string | null; wireAt?: XY | null; wirePin?: string | null };
      this.wire = v.wire && pairOf.has(v.wire) ? v.wire : null;
      this.wireAt = this.wire && v.wireAt && typeof v.wireAt.x === 'number' ? { x: v.wireAt.x, y: v.wireAt.y } : null;
      this.wirePin = v.wirePin && pairOf.has(v.wirePin) ? v.wirePin : null;
      this.stopReplay();
      // as if navigated from the whole trace: start there, then transition into the state
      this.sel = null; this.fromSel = null; this.open = true; this.quiet = false; this.pins = []; this.lgHover = null;
      this.morph.snap(this.targets());
      this.sel = v.sel == null ? null : clamp(v.sel, 0, N - 1);
      this.open = v.open ?? true;
      this.pins = (Array.isArray(v.pins) ? v.pins : []).map((p) => resolveEntry(entries, String(p))).filter((p): p is string => !!p);
      this.lgHover = v.hover ? resolveEntry(entries, v.hover) : null;
      this.morph.retarget(this.targets());
    }
    states() {
      const out = [
        { name: 'whole', state: { sel: null, open: true } },
        { name: 'select-1', state: { sel: 0, open: true } },
        { name: 'select-last', state: { sel: N - 1, open: true } },
        { name: 'select-2-collapsed', state: { sel: Math.min(1, N - 1), open: false } },
      ];
      if (errIdx >= 0) out.push({ name: 'select-error', state: { sel: errIdx, open: true } });
      const tag = ML.declared[0] ?? ML.categories[0] ?? ML.derived[0];
      const slug = (e: LegendEntry) => e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (tag) out.push({ name: `legend-pin-${slug(tag)}`, state: { sel: null, open: true, pins: [tag.id] } as never });
      if (tag && N > 1) out.push({ name: `select-2-pin-${slug(tag)}`, state: { sel: 1, open: true, pins: [tag.id] } as never });
      const cat = ML.categories[0];
      if (cat) out.push({ name: `legend-hover-${slug(cat)}`, state: { sel: null, open: true, hover: cat.id } as never });
      // a wire hovered (the most used one), and pinned with a request selected (its card lists that request's calls)
      const wk = [...pairs].sort((a, b) => (total.get(b.key) ?? 0) - (total.get(a.key) ?? 0) || a.key.localeCompare(b.key))[0]?.key;
      if (wk) {
        out.push({ name: `wire-hover-${wk}`, state: { sel: null, open: true, wire: wk } as never });
        const ri = reqs.findIndex((r) => r.pairs.has(wk));
        out.push({ name: `wire-pin-${wk}`, state: { sel: ri >= 0 ? ri : null, open: true, wirePin: wk } as never });
      }
      return out;
    }

    /** Zoom and pan (docs/ENGINE.md "Zoom and pan"): a drag on blank space pans. Outside Bench a group frame's empty area
     *  is backdrop too; in Bench it is the group's handle. A wire under the pointer is never blank (hover, pin, insert). */
    isBlank(e: PointerEvent, byDefault: boolean) {
      const t = e.target as HTMLElement | null;
      const frame = !this.stage.inBench && !!t?.classList.contains('tb-group');
      return (byDefault || frame) && !this.wireUnder(e).key;
    }
    /** Key help (docs/ENGINE.md "Key help"): what `onKey` does right now. */
    keys(): KeyHelp[] {
      const R = 'Requests', sel = this.sel;
      if (this.replaying) return [{ group: R, keys: 'any key', gesture: true, does: 'stop the replay' }];
      const out: KeyHelp[] = [
        { group: R, keys: ['j', '↓', '→'], does: sel === null ? 'select the first request' : 'next request', ...(sel === N - 1 ? { off: true, when: 'before the last request' } : {}) },
        { group: R, keys: ['k', '↑', '←'], does: sel === null ? 'select the last request' : 'previous request', ...(sel === 0 ? { off: true, when: 'after the first request' } : {}) },
        { group: R, keys: 'Home', does: 'the first request', ...(sel === 0 ? { off: true, when: 'after the first request' } : {}) },
        { group: R, keys: 'End', does: 'the last request', ...(sel === N - 1 ? { off: true, when: 'before the last request' } : {}) },
        { group: R, keys: ['Enter', 'Space'], does: sel === null ? 'select the first request' : this.open ? `fold request ${sel + 1}'s calls` : `unfold request ${sel + 1}'s calls` },
        { group: R, keys: 'p', does: 'replay the requests one by one' },
      ];
      const n = Math.min(9, shownEntries.length);
      if (n) out.push({ group: 'Legend', keys: n === 1 ? '1' : `1–${n}`, does: `pin legend entry 1${n > 1 ? `–${n}` : ''} (again to unpin)` });
      const esc = this.wirePin ? 'close the pinned wire card' : this.pins.length ? 'clear the pinned legend entries' : sel !== null ? 'back to the whole trace' : null;
      if (esc) out.push({ group: R, keys: 'Esc', does: esc });
      return out;
    }
    onKey(e: KeyboardEvent) {
      if (this.replaying) { this.stopReplay(); return true; }
      const k = e.key;
      // inside the inspector's list of calls, the scroll keys scroll it (the browser's own)
      if ((e.target as HTMLElement).closest?.('.tb-ibody') && /^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(k)) return false;
      if ((k === 'Enter' || k === ' ') && (e.target as HTMLElement).closest?.('button')) return false; // the button's own click
      if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'j') this.step(1);
      else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'k') this.step(-1);
      else if (k === 'Home') { if (this.sel !== 0) this.select(0); }
      else if (k === 'End') { if (this.sel !== N - 1) this.select(N - 1); }
      else if (k === 'Enter' || k === ' ') { if (this.sel === null) this.select(0); else this.go(this.sel, !this.open); }
      else if (k === 'p') this.replay();
      else if (/^[1-9]$/.test(k) && shownEntries[+k - 1]) this.togglePin(shownEntries[+k - 1]!.id);
      else if (k === 'Escape') {
        // innermost first: a pinned wire card, the pins, then the selection
        if (!this.back()) return false;
      }
      else return false;
      return true;
    }

    // ------------------------------------------------------------ frame
    private path(key: string): Path {
      // map cards never move, so a wire's route is fixed once the cards are measured
      let p = this.paths.get(key);
      if (!p) {
        const { from, to } = L0.wire.get(key) ?? hopEnds.get(key)!;
        const a = pos.get(from)!, b = pos.get(to)!;
        const A = this.$(`#${cssId(from)}`), B = this.$(`#${cssId(to)}`);
        const ma = this.at(from), mb = this.at(to);
        const da = { x: ma.x - a.x, y: ma.y - a.y }, db = { x: mb.x - b.x, y: mb.y - b.y };
        if (Math.abs(da.x - db.x) < 0.5 && Math.abs(da.y - db.y) < 0.5) {
          // both cards keep their arrangement (untouched, or moved together): the map's own router
          const [pa, pb] = b.layer > a.layer ? [A.at('right', 0.5, 3), B.at('left', 0.5, 3)] : [A.at('bottom', 0.5, 3), B.at('bottom', 0.5, 3)];
          p = route({ ...a, x: a.x + da.x, y: a.y + da.y, ...(a.right !== undefined ? { right: a.right + da.x } : {}) }, { ...b, x: b.x + db.x, y: b.y + db.y }, pa, pb);
        } else p = boardRoute(A.bounds(), B.bounds());
        if (A.box.w && B.box.w && !this.drag && !this.gdrag) this.paths.set(key, p);
      }
      return p;
    }
    /** How lit a map node is at time t: lights when the comet arrives, un-lights as the old path fades. */
    private nodeLit(id: string, t: number, k: number) {
      const inS = this.sel !== null && reqs[this.sel]!.nodes.has(id);
      const inF = this.fromSel !== null && reqs[this.fromSel]!.nodes.has(id);
      if (inS && (inF || this.quiet)) return 1;
      if (inS) {
        const r = reqs[this.sel!]!;
        const h = r.hops.findIndex((x) => x.to === id);
        const at = h >= 0 ? hopWin(r, h)[1] : hopWin(r, 0)[0];
        return prog(t, at, at + 0.12);
      }
      return inF ? 1 - k : 0;
    }

    update(f: Frame) {
      const t = f.t, k = ease.outCubic(clamp(t / f.duration));
      this.morph.progress(k);
      this.ensureDock();
      reqs.forEach((_, i) => {
        const v = this.morph.value(`q${i}`)!;
        const card = this.$(`#q${i}`);
        card.set({ y: v.y!, opacity: v.o! });
        card.vars['--h'] = v.h!.toFixed(2);
        card.classes['is-lit'] = v.lit! > 0.5;
        this.$(`#q${i} .tb-rows`).opacity = v.open!;
      });
      const lgh = this.lgHover ? new Set(entry(this.lgHover)?.members ?? []) : null;
      const lit = litMembers(entries, this.pins, this.lgHover);
      const sw = this.shownWire(), swEnds = sw ? new Set([pairOf.get(sw)!.from, pairOf.get(sw)!.to]) : null;
      const rects = new Map<string, { x: number; y: number; w: number; h: number; o: number }>();
      for (const n of L0.nodes) {
        const card = this.$(`#${cssId(n.id)}`);
        const v = this.morph.value(`n:${n.id}`)!, home = pos.get(n.id)!, here = this.at(n.id);
        const op0 = v.o! * (lgh ? (lgh.has(n.id) ? 1 : DIM_LEGEND) : v.pin ?? 1);
        // a hovered wire: its two cards in full, the rest a little dimmer
        const op = swEnds ? (swEnds.has(n.id) ? 1 : op0 * DIM_WIRE) : op0;
        const moving = this.drag?.id === n.id || !!this.gdrag?.start.has(n.id);
        card.set({ x: here.x - home.x, y: here.y - home.y, opacity: moving ? 1 : op });
        rects.set(n.id, { x: here.x, y: here.y, ...box(n.id), o: op });
        card.classes['is-drag'] = moving;
        card.classes['is-hl'] = (!!lit && lit.has(n.id)) || !!swEnds?.has(n.id);
        card.classes['is-lit'] = this.sel !== null && this.nodeLit(n.id, t, k) > 0.5;
        card.classes['is-err'] = this.sel !== null && reqs[this.sel]!.hops.some((h) => h.to === n.id && h.err);
        this.$(`#c-${cssId(n.id)}`).hidden = this.hover !== n.id;
      }
      // group frames follow their members (a card dragged out in Bench stretches its frame)
      for (const g of groups) {
        const rs = gMembers.get(g.id)!.map((id) => rects.get(id)!);
        if (!rs.length) continue;
        const x0 = Math.min(...rs.map((r) => r.x)) - 14, y0 = Math.min(...rs.map((r) => r.y)) - 22;
        const x1 = Math.max(...rs.map((r) => r.x + r.w)) + 14, y1 = Math.max(...rs.map((r) => r.y + r.h)) + 14;
        const fr = this.$(`#g-${cssId(g.id)}`);
        fr.classes['is-gdrag'] = this.gdrag?.gid === g.id;
        fr.set({ x: x0 - g.x, y: y0 - g.y, opacity: lgh || this.pins.length ? 0.35 + 0.65 * Math.max(...rs.map((r) => r.o)) : 1 });
        fr.vars['--w'] = `${Math.round(x1 - x0)}px`;
        fr.vars['--h'] = `${Math.round(y1 - y0)}px`;
      }
      badges.forEach((b, j) => {
        const node = this.$(`#b${j}`), p = this.path(b.key);
        const at = p.atLength(Math.max(0, p.length - 22));
        const inSel = this.sel !== null ? reqs[this.sel]!.pairs.get(b.key) ?? 0 : 0;
        const dimB = lgh ? (lgh.has(b.from) && lgh.has(b.to) ? 1 : DIM_LEGEND) : this.pins.length && !(lit?.has(b.from) && lit?.has(b.to)) ? DIM_PIN : 1;
        node.set({ x: at.x, y: at.y, opacity: this.morph.value(`b${j}`)!.o! * dimB });
        this.$(`#b${j} > span`).text = `×${inSel > 1 ? inSel : total.get(b.key)}`;
      });
      this.$('#tb-replay').text = this.replaying ? 'Stop' : 'Replay';
      this.$('#tb-replay').classes['is-on'] = this.replaying;
      this.$('#tb-whole').opacity = this.sel === null ? 0.45 : 1;
      const rb = this.stage.dom.querySelector<HTMLButtonElement>('#tb-reset')!;
      if (rb.hidden === this.stage.inBench) rb.hidden = !this.stage.inBench;
      this.legend.sync({ pins: this.pins, hover: this.lgHover, picked: 0, editable: false });
      this.stage.dom.classList.toggle('wh-over', !!this.wire);
      this.stage.dom.classList.toggle('tb-moving', !!(this.drag || this.gdrag));
      // the wire's card: beside the pointer (a still: the wire's midpoint), inside the plate, off its two cards
      const wc = this.$('#wh-card'), wel = wc.el;
      if (!sw) { wc.hidden = true; this.wireCardFor = ''; }
      else {
        const pinned = this.wirePin === sw && !this.wire;
        const ck = `${sw}|${pinned}|${this.sel}`;
        if (this.wireCardFor !== ck) {
          const c = this.wireCalls(sw);
          wel.innerHTML = wireCardHTML(infoOf(sw), { pinned, calls: c.calls, callsTitle: c.title });
          wel.classList.toggle('is-pinned', pinned);
          this.wireCardFor = ck;
        }
        const ra = rects.get(pairOf.get(sw)!.from)!, rb = rects.get(pairOf.get(sw)!.to)!;
        const mid = this.path(sw).at(0.5);
        const at = (this.wire === sw && this.wireAt) || { x: mid.x, y: mid.y };
        // inside the visible part and at its fit size while zoomed (docs/ENGINE.md "Zoom and pan")
        wc.set(this.stage.view.overlay(at, WIRE_CARD_W, wel.offsetHeight, [ra, rb], placeCard));
      }
      const hv = entry(this.lgHover);
      const pinTxt = this.pins.length ? ` · pinned ${this.pins.map((p) => entry(p)?.name).join(' + ')}` : '';
      this.$('#tb-mode').text = sw ? `${infoOf(sw).sentence} — ${this.wirePin === sw && !this.wire ? 'pinned · Esc closes it' : 'click the wire to pin its card'}`
        : this.drag ? `moving ${nodeOf.get(this.drag.id)?.label ?? this.drag.id} — let go to place it · Reset layout puts it back`
        : this.gdrag ? `moving the ${this.gdrag.gid === '·outside' ? 'outside' : this.gdrag.gid} group — let go to place it · Reset layout puts it back`
        : hv ? `lighting “${hv.name}” (${hv.members.length}) — click to ${this.pins.includes(hv.id) ? 'unpin' : 'pin'} it`
        : this.replaying && this.sel !== null ? `replaying ${this.sel + 1} of ${N} — any key stops`
        : this.sel === null ? `click a request to step into it · ←/→ step · p replay${pinTxt ? `${pinTxt} (Esc clears)` : this.stage.inBench ? ' · bench: drag map cards, or a group by its frame' : ''}`
        : `request ${this.sel + 1} of ${N} · ←/→ step · Esc ${this.pins.length ? 'clears the pins' : 'whole trace'}${pinTxt}`;
    }

    draw(f: Frame, fx: Fx) {
      const t = f.t, k = ease.outCubic(clamp(t / f.duration)), moving = t < f.duration;
      const Ln = fx.under.lines, bg = fx.under.bg, th = f.theme;
      bg.pattern = this.stage.inBench ? 'grid' : 'dots'; bg.patternAlpha = this.stage.inBench ? 0.14 : 0.22;
      const lit = litMembers(entries, this.pins, this.lgHover);
      const dimOf = (id: string) => (lit ? (lit.has(id) ? 1 : this.lgHover ? DIM_LEGEND : DIM_PIN) : 1);

      // base wires: the whole trace, ghosts and dims
      const sw = this.shownWire();
      for (const p of pairs) {
        const v = this.morph.value(`e:${p.key}`)!;
        const path = this.path(p.key), col = mix(th.line, th.accent, v.on!);
        // a legend highlight: its wires lit (hover at once, pins through the transition), the rest dimmed
        const pk = this.lgHover ? (lit!.has(p.from) && lit!.has(p.to) ? 1 : 0) : this.morph.value(`pl:${p.key}`)!.k!;
        const a = v.a! * Math.min(dimOf(p.from), dimOf(p.to)) * (sw && sw !== p.key ? DIM_WIRE : 1);
        Ln.path(path, { color: col, alpha: a, width: v.w! });
        const e = path.at(0.999);
        Ln.arrow(e, e.angle, 7, { color: col, width: 1.3, alpha: a });
        if (pk > 0.01) { Ln.path(path, { color: 'accent', alpha: pk, width: 1.9, glow: 1.2 }); Ln.arrow(e, e.angle, 7, { color: 'accent', width: 1.4, alpha: pk }); }
      }

      // the selected request's path, drawn on hop by hop; the previous one fading out
      const S = this.sel !== null ? reqs[this.sel]! : null, F = this.fromSel !== null ? reqs[this.fromSel]! : null;
      if (F && F !== S) for (const key of F.pairs.keys()) {
        if (S?.pairs.has(key)) continue;
        Ln.path(this.path(key), { color: F.hops.find((h) => h.key === key)?.err ? 'accent2' : 'accent', width: 2.2, alpha: 1 - k, glow: 1.5 });
      }
      if (S) {
        S.hops.forEach((h, i) => {
          if (S.hops.findIndex((x) => x.key === h.key) !== i) return; // first use of a wire draws it
          const [a, b] = hopWin(S, i);
          const shared = this.quiet || !!F?.pairs.has(h.key);
          const to = shared ? 1 : prog(t, a, b, ease.inOutCubic);
          if (to > 0) Ln.path(this.path(h.key), { ...(h.reversed ? { from: 1 - to, to: 1 } : { to }), color: h.err ? 'accent2' : 'accent', width: 2.2, alpha: 1, glow: 1.5 });
        });
        // the comet and arrivals exist only while the transition runs: at rest the path is still
        if (moving && !this.quiet) S.hops.forEach((h, i) => {
          const [a, b] = hopWin(S, i), path = this.path(h.key);
          const col = h.err ? 'accent2' : 'accent';
          comet(Ln, t, (tb) => (tb >= a && tb <= b ? path.at(h.reversed ? 1 - prog(tb, a, b, ease.inOutCubic) : prog(tb, a, b, ease.inOutCubic)) : null), { scale: 0.7, tail: Math.min(0.12, b - a), embers: 22, seed: 11 + i * 7, color: col });
          const dur = Math.min(0.32, f.duration - b - 0.01);
          if (dur > 0.05) pulseRing(Ln, this.$(`#${cssId(h.to)}`).center, t, b, { r1: 54, dur, color: col });
        });
      }

      // the hovered (or pinned) wire on top: thicker, lit, in its verdict's style (dashed: declared, not seen; warning: not declared)
      if (sw) {
        const w = pairOf.get(sw)!, path = this.path(sw), e = path.at(0.999);
        const col = w.style === 'warn' ? 'accent2' : 'accent';
        if (w.style === 'dashed') Ln.dashes(path, { color: col, width: 2.8, alpha: 1, glow: 2.2, dash: 5, gap: 5 });
        else if (w.style === 'idle') Ln.dashes(path, { color: col, width: 2.8, alpha: 1, glow: 2.2, dash: 1.5, gap: 4 });
        else Ln.path(path, { color: col, width: 2.8, alpha: 1, glow: 2.2 });
        Ln.arrow(e, e.angle, 8.5, { color: col, width: 1.8, alpha: 1 });
      }

      // lit cards: the selected request, then the path's nodes in hop order (the bg holds 8 lights)
      reqs.forEach((_, i) => {
        const lit = this.morph.value(`q${i}`)!.lit!;
        if (lit <= 0.01) return;
        // the request list is chrome: its fx go on the chrome's layer (docs/ENGINE.md "Zoom and pan")
        const card = this.$(`#q${i}`);
        outline(fx.front.lines, card, { pad: 5, radius: 12, width: 1.3, alpha: lit * 0.9, glow: 1.2 });
        lightUnder(fx.front.bg, card, 0.26 * lit, th.accent, 0.45);
      });
      const order = S ? [...new Set([flow.entry, ...S.hops.map((h) => h.to)].filter((x): x is string => !!x))] : [];
      const rest = F ? [...F.nodes].filter((id) => !order.includes(id)) : [];
      for (const id of [...order, ...rest]) {
        const lit = this.nodeLit(id, t, k);
        if (lit <= 0.01) continue;
        const card = this.$(`#${cssId(id)}`);
        const err = !!S?.hops.some((h) => h.to === id && h.err);
        outline(Ln, card, { pad: 3, radius: 11, width: 1.2, alpha: lit * 0.85, glow: 1.2, color: err ? 'accent2' : 'accent' });
        lightUnder(bg, card, 0.22 * lit, err ? th.accent2 : th.accent, 0.5);
      }
    }
  };
}

