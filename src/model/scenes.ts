// Generic Karyo scenes drawn from a Karyo model (docs/MODEL.md): no hand layout, no hand
// timing. `mapScene(model)` builds the structure; `flowScene(model, id)` replays a recorded
// flow hop by hop with its real durations. Both return Scene classes for mount() or the gallery.
import { Scene, type Frame, type Fx, type SceneClass, wire, prog, ease, stagger, springStep, clamp, comet, pulseRing, lightUnder, outline, Path, roundCorners, type P } from '../engine';
import { groupLabel } from './curation';
import { attributeCall, wiresOf, wireWords, type Model, type MNode, type MSpan, type MFlow, type Wire, type Hop } from './model';
import { kitsFor, modelStats, whereOf, type KitSet, type NodeStats } from '../kits/registry';
import './glass.css';   // the main themes' look of boards, tours, the Stack view, splices and the legend

// ------------------------------------------------------------------ layout

export const CARD_W = 188, CARD_H = 72, COL_GAP = 72, ROW_GAP = 16, BAND_GAP = 40, TOP = 112, SIDE = 48;

export interface CardBox { w: number; h: number }
/** A card's slot: where it rests, its column (`layer`) and that column's right edge (wires turn in the gutter past it). */
export interface CardSlot { x: number; y: number; layer: number; right?: number }

export interface Layout {
  nodes: MNode[];
  /** One per ordered pair among `nodes` (model.ts `wiresOf`): what every view draws, never raw edges. */
  wires: Wire[];
  /** A wire by its key (`pairKey`). */
  wire: Map<string, Wire>;
  pos: Map<string, CardSlot>;
  /** Every card's size: a kit kind's declared size (docs/KITS.md), else CARD_W × CARD_H. */
  size: Map<string, CardBox>;
  /** Each column's left edge and width (as wide as its widest card). */
  colX: number[];
  colW: number[];
  groups: { id: string; label: string; x: number; y: number; w: number; h: number }[];
  layers: number;
  W: number;
  H: number;
}

/** A laid-out card's size (the default card's for an id the layout doesn't have). */
export const boxOf = (L: Pick<Layout, 'size'>, id: string): CardBox => L.size.get(id) ?? { w: CARD_W, h: CARD_H };

/** Layered left-to-right layout: callers left of callees, each group in its own horizontal band. Cards are the size
 *  their kind gives them (`kits`: a kit kind's declared size, default the model's kits); a column is as wide as its
 *  widest card, and a column's cards stack at their own heights. */
export function layout(model: Model, keep?: Set<string>, extraRight = 0, minH = 480, kits: KitSet = kitsFor(model)): Layout {
  const nodes = model.nodes.filter((n) => n.kind !== 'module' && (!keep || keep.has(n.id)));
  const size = new Map(nodes.map((n) => [n.id, kits.size(n.kind) ?? { w: CARD_W, h: CARD_H }]));
  const ids = new Set(nodes.map((n) => n.id));
  const wires = wiresOf(model, (id) => ids.has(id));
  const out = new Map<string, string[]>(), inn = new Map<string, string[]>();
  for (const e of wires) { (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to); (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)!).push(e.from); }
  // longest path from the sources (cycle-safe: a node's depth never exceeds the node count)
  const layer = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(0, ...(inn.get(id) ?? []).map((p) => depth(p, seen) + 1));
    seen.delete(id);
    layer.set(id, d);
    return d;
  };
  nodes.forEach((n) => depth(n.id, new Set()));
  const groupOf = (n: MNode) => (n.kind === 'actor' ? '·outside' : n.group ?? 'other');
  const groupIds = [...new Set(nodes.map(groupOf))].sort((a, b) => {
    const la = Math.min(...nodes.filter((n) => groupOf(n) === a).map((n) => layer.get(n.id)!)), lb = Math.min(...nodes.filter((n) => groupOf(n) === b).map((n) => layer.get(n.id)!));
    return la - lb || a.localeCompare(b);
  });
  const layers = Math.max(0, ...layer.values()) + 1;
  const colW = Array.from({ length: layers }, (_, l) => Math.max(0, ...nodes.filter((n) => layer.get(n.id) === l).map((n) => size.get(n.id)!.w)) || CARD_W);
  const colX: number[] = [];
  colW.forEach((w, l) => colX.push(l ? colX[l - 1]! + colW[l - 1]! + COL_GAP : SIDE));
  const pos = new Map<string, CardSlot>();
  const rowOf = new Map<string, number>();
  const groups: Layout['groups'] = [];
  // pack group bands: a band sits beside earlier bands whose columns it doesn't share
  const placed: { lo: number; hi: number; bottom: number }[] = [];
  let bottomMost = TOP;
  for (const g of groupIds) {
    const members = nodes.filter((n) => groupOf(n) === g);
    const ls = members.map((n) => layer.get(n.id)!);
    const lo = Math.min(...ls), hi = Math.max(...ls);
    const y = Math.max(TOP, ...placed.filter((b) => b.lo <= hi && lo <= b.hi).map((b) => b.bottom + BAND_GAP));
    let colH = CARD_H;
    for (let l = lo; l <= hi; l++) {
      const col = members.filter((n) => layer.get(n.id) === l);
      // order by the average row of their callers (keeps wires short), then id
      col.sort((a, b) => bary(a.id) - bary(b.id) || declOrder(a.id) - declOrder(b.id) || a.id.localeCompare(b.id));
      let yy = y + 22;
      col.forEach((n, i) => { rowOf.set(n.id, i); pos.set(n.id, { x: colX[l]!, y: yy, layer: l, right: colX[l]! + colW[l]! }); yy += size.get(n.id)!.h + ROW_GAP; });
      colH = Math.max(colH, yy - ROW_GAP - (y + 22));
    }
    const h = 22 + colH + 14;
    const label = g === '·outside' ? 'outside' : `${groupLabel(model, g)}${langsOf(members)}`;
    groups.push({ id: g, label, x: colX[lo]! - 14, y, w: colX[hi]! + colW[hi]! - colX[lo]! + 28, h });
    placed.push({ lo, hi, bottom: y + h });
    bottomMost = Math.max(bottomMost, y + h);
  }
  const y = bottomMost + BAND_GAP;
  // siblings keep the order their caller lists them in (`calls=[…]` is usually pipeline order)
  function declOrder(id: string) { return Math.min(...(inn.get(id) ?? []).map((p) => out.get(p)!.indexOf(id)), 1e9); }
  function bary(id: string) { const ps = inn.get(id) ?? []; const rs = ps.map((p) => rowOf.get(p)).filter((r): r is number => r !== undefined); return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0; }
  // the frame follows the content (no forced 16:9): wide graphs get a wide, short plate
  const W = Math.max(960, colX[layers - 1]! + colW[layers - 1]! + SIDE + extraRight);
  const H = Math.max(minH, y - BAND_GAP + 64);
  return { nodes, wires, wire: new Map(wires.map((w) => [w.key, w])), pos, size, colX, colW, groups, layers, W, H };
}

const langsOf = (ns: MNode[]) => { const l = [...new Set(ns.map((n) => n.lang).filter(Boolean))]; return l.length ? ` · ${l.join(' + ')}` : ''; };
/** The wire legend's entries (model.ts `wireWords`): what solid, dashed, the warning colour and (after a recording that
 *  watched whole packages) dotted mean. */
export function legendHTML(m: Model): string {
  const w = wireWords(m);
  return `<span><i></i>${w.solid}</span>${w.dashed ? `<span><i class="dash"></i>${w.dashed}</span>` : ''}${w.warn ? `<span><i class="warn"></i>${w.warn}</span>` : ''}${w.idle ? `<span><i class="idle"></i>${w.idle}</span>` : ''}`;
}
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const cssId = (id: string) => 'n-' + id.replace(/[^A-Za-z0-9_-]/g, '_');

export const MAP_CSS = /* css */ `
  .mm-head { position: absolute; left: ${SIDE}px; top: 34px; display: grid; gap: 6px; }
  .mm-group { position: absolute; box-sizing: border-box; border: 1px dashed var(--pl-line); border-radius: calc(var(--pl-radius) + 6px); }
  .mm-group > .pl-label { position: absolute; left: 12px; top: 6px; }
  .mm-card { position: absolute; width: ${CARD_W}px; height: ${CARD_H}px; padding: 9px 12px; display: grid; align-content: start; gap: 3px; }
  .mm-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .mm-kind { font: 500 10px/1 var(--pl-font-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--pl-muted); }
  .mm-lang { font: 500 10px/1 var(--pl-font-mono); color: var(--pl-muted); }
  .mm-name { font: 600 15px/1.2 var(--pl-font-display); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mm-ref { font: 11px/1.2 var(--pl-font-mono); color: var(--pl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mm-card.is-ext { border-style: dashed; box-shadow: none; }
  .mm-card.is-actor { border-radius: 999px; text-align: center; align-content: center; }
  .mm-card.is-lit { border-color: var(--pl-accent); }
  .mm-warn { position: absolute; left: 0; top: 0; font: 600 10px/1 var(--pl-font-mono); padding: 4px 6px; border-radius: 999px; background: var(--pl-accent-2); color: var(--pl-card); white-space: nowrap; margin: -26px 0 0 -40px; z-index: 3; }
  .mm-foot { position: absolute; left: ${SIDE}px; bottom: 24px; display: grid; gap: 4px; max-width: 70%; }
  .mm-foot .row { font: 12px/1.35 var(--pl-font-mono); color: var(--pl-muted); }
  .mm-foot .row b { color: var(--pl-accent-2); font-weight: 600; }
  .mm-legend { position: absolute; right: ${SIDE}px; top: 40px; display: grid; gap: 5px; font: 11px/1.2 var(--pl-font-mono); color: var(--pl-muted); }
  .mm-legend i { display: inline-block; width: 26px; height: 0; margin-right: 8px; vertical-align: middle; border-top: 2px solid var(--pl-line); }
  .mm-legend i.dash { border-top-style: dashed; }
  .mm-legend i.idle { border-top-style: dotted; opacity: 0.75; }
  .mm-card.is-idle { border-style: dotted; }
  .mm-card.is-idle .mm-name { opacity: 0.72; }
  .mm-legend i.warn { border-color: var(--pl-accent-2); }
`;

/** What a view draws kit cards with (docs/KITS.md): the kits, and the model's node stats their templates may read. */
export interface CardKits { kits: KitSet; stats?: Map<string, NodeStats> }
/** The kits a view built on `model` draws with: its bound kits (or the page's), and its stats. */
export const cardKits = (model: Model, kits: KitSet = kitsFor(model)): CardKits => ({ kits, stats: modelStats(model) });

/** A node's card. A node whose kind a kit adds is drawn with that kind's template, in the same frame (the category
 *  edge and ring, the badges, a splice's marks); every other node gets the default card. */
export function cardHTML(n: MNode, kx?: CardKits) {
  const { short: ref, full } = whereOf(n);   // long paths keep their last two segments; the full path is in the tooltip
  const kit = kx?.kits.cardInner(n, kx.stats?.get(n.id));
  if (kit != null) {
    const ext = n.kind === 'external' || (!n.ref && n.kind !== 'actor') ? ' is-ext' : '';
    return `<div class="pl-card mm-card is-kit kc-${esc(n.kind)}${ext}" id="${cssId(n.id)}" data-kind="${esc(n.kind)}" title="${esc(n.id)}${n.summary ? ' — ' + esc(n.summary) : ''}">${kit.trim()}</div>`;
  }
  const cls = n.kind === 'external' || !n.ref && n.kind !== 'actor' ? 'is-ext' : n.kind === 'actor' ? 'is-actor' : '';
  if (n.kind === 'actor') return `<div class="pl-card mm-card ${cls}" id="${cssId(n.id)}"><div class="mm-name">${esc(n.label ?? n.id)}</div></div>`;
  return `<div class="pl-card mm-card ${cls}" id="${cssId(n.id)}" title="${esc(n.id)}${n.summary ? ' — ' + esc(n.summary) : ''}">
    <div class="mm-top"><span class="mm-kind">${n.kind}</span><span class="mm-lang">${n.lang ?? ''}</span></div>
    <div class="mm-name">${esc(n.label ?? n.id)}</div>
    <div class="mm-ref" title="${esc(full)}">${esc(ref)}</div></div>`;
}

/** Route between two laid-out cards. Forward edges are elbows that turn in the gutter right after
 *  the caller, so a caller's edges share one trunk and branch off to each callee (a fan-out of ten
 *  reads as a bus, not a sheaf of curves). Other edges loop underneath. */
export function route(a: CardSlot, b: CardSlot, pa: P, pb: P): Path {
  if (b.layer <= a.layer) return wire(pa, pb, { kind: 'curve', from: 'bottom', to: 'bottom', tension: 0.8 });
  // the turn sits in the gutter past the caller's column (past a wider card in it too)
  const x1 = (a.right !== undefined ? Math.max(pa.x, a.right + 3) : pa.x) + COL_GAP / 2 - 3;
  if (b.layer === a.layer + 1) {
    if (Math.abs(pb.y - pa.y) < 2) return wire(pa, pb, { kind: 'straight' });
    return new Path(roundCorners([pa, { x: x1, y: pa.y }, { x: x1, y: pb.y }, pb], 10));
  }
  // skipping columns: run along the gap above the callee's row, never behind a card in between
  const x2 = pb.x - COL_GAP / 2 + 3, lane = b.y - ROW_GAP / 2 - 1;
  return new Path(roundCorners([pa, { x: x1, y: pa.y }, { x: x1, y: lane }, { x: x2, y: lane }, { x: x2, y: pb.y }, pb], 10));
}

abstract class ModelScene extends Scene {
  abstract readonly model: Model;
  abstract readonly L: Layout;
  abstract readonly kx: CardKits;
  protected ends(e: { from: string; to: string }): [P, P] {
    const a = this.L.pos.get(e.from)!, b = this.L.pos.get(e.to)!;
    const A = this.$(`#${cssId(e.from)}`), B = this.$(`#${cssId(e.to)}`);
    return b.layer > a.layer ? [A.at('right', 0.5, 3), B.at('left', 0.5, 3)] : [A.at('bottom', 0.5, 3), B.at('bottom', 0.5, 3)];
  }
  protected path(e: { from: string; to: string }) { const [pa, pb] = this.ends(e); return route(this.L.pos.get(e.from)!, this.L.pos.get(e.to)!, pa, pb); }
  protected baseHTML(title: string, sub: string, extra = '') {
    const L = this.L;
    return `<style>${MAP_CSS}${this.kx.kits.css()}</style>
      <header class="mm-head"><div class="pl-label">${esc(sub)}</div><h1 class="pl-title">${esc(title)}</h1></header>
      ${L.groups.map((g) => `<div class="mm-group" id="g-${cssId(g.id)}" style="left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px"><span class="pl-label">${esc(g.label)}</span></div>`).join('')}
      ${L.nodes.map((n) => { const p = L.pos.get(n.id)!; return cardHTML(n, this.kx).replace('class="pl-card', `style="left:${p.x}px;top:${p.y}px" class="pl-card`); }).join('')}
      ${extra}`;
  }
}

// ------------------------------------------------------------------ structure map

/** The whole model: groups, nodes, edges styled by where they came from, warnings. */
export function mapScene(model: Model, o: { title?: string } = {}): SceneClass {
  const kx = cardKits(model);
  const L = layout(model);
  const warned = L.wires.filter((w) => w.style === 'warn');
  const warns = (model.checks ?? []).filter((c) => c.level === 'warn');
  const tNodes = (l: number) => 0.6 + l * 0.35;
  const tEdges = tNodes(L.layers) + 0.2;
  const tWarn = tEdges + 0.9;
  return class MapScene extends ModelScene {
    static title = o.title ?? `${model.project ?? 'Project'}: structure`;
    static width = L.W;
    static height = L.H;
    static duration = tWarn + 3;
    static poster = tWarn + 2.5;
    static fx = 'under' as const;
    readonly model = model;
    readonly L = L;
    readonly kx = kx;
    build(dom: HTMLElement) {
      const warnChips = warned.map((_, i) => `<span class="mm-warn" id="w${i}">⚠ undeclared</span>`).join('');
      const langs = [...new Set((model.producers ?? []).map((p) => p.lang))].join(' + ');
      dom.innerHTML = this.baseHTML(o.title ?? `How ${model.project ?? 'the project'} fits together`, `Structure · from ${langs} code`, `
        ${warnChips}
        <div class="mm-legend" id="legend">${legendHTML(model)}</div>
        <div class="mm-foot" id="foot">${warns.slice(0, 3).map((c) => `<div class="row"><b>⚠ ${c.code}</b> ${esc(c.message)}</div>`).join('') || '<div class="row">Annotations, imports and recorded runs agree.</div>'}</div>`);
    }
    update(f: Frame) {
      const t = f.t;
      const h = prog(t, 0, 0.6, ease.outExpo);
      this.$('.mm-head').set({ opacity: h, y: 12 * (1 - h) });
      this.$('#legend').opacity = prog(t, 0.3, 0.9);
      L.groups.forEach((g, i) => { const k = stagger(t, i, 0.2, 0.12, 0.5); this.$(`#g-${cssId(g.id)}`).set({ opacity: k, scale: 0.98 + 0.02 * k }); });
      for (const n of L.nodes) {
        const t0 = tNodes(L.pos.get(n.id)!.layer), s = springStep(t - t0, 2.4, 0.5);
        this.$(`#${cssId(n.id)}`).set({ opacity: clamp((t - t0) / 0.2), scale: 0.88 + 0.12 * s, y: 8 * (1 - s) });
      }
      warned.forEach((e, i) => {
        const m = this.path(e).at(0.5), k = prog(t, tWarn, tWarn + 0.4, ease.outBack);
        this.$(`#w${i}`).set({ x: m.x, y: m.y, scale: 0.6 + 0.4 * k, opacity: k });
      });
      this.$('#foot').opacity = prog(t, tWarn + 0.3, tWarn + 0.9);
    }
    draw(f: Frame, fx: Fx) {
      const t = f.t, Ln = fx.under.lines;
      fx.under.bg.pattern = 'dots'; fx.under.bg.patternAlpha = 0.25;
      for (const e of L.wires) {
        const k = prog(t, tEdges, tEdges + 0.7, ease.inOutCubic);
        const p = this.path(e);
        const warn = e.style === 'warn';
        if (warn) { Ln.path(p, { to: k, color: 'accent2', width: 1.8, glow: 1.5 * prog(t, tWarn, tWarn + 0.5) }); pulseRing(Ln, p.at(0.5), t, tWarn, { color: 'accent2', r1: 30 }); }
        else if (e.style === 'dashed') Ln.dashes(p, { to: k, dash: 5, gap: 5, color: 'line', width: 1.4 });
        else if (e.style === 'idle') Ln.dashes(p, { to: k, dash: 1.5, gap: 4, color: 'line', width: 1.4, alpha: 0.7 });
        else Ln.path(p, { to: k, color: 'line', width: 1.5 });
        // a tiny arrowhead at the callee end
        if (k >= 1) { const end = p.at(0.999); Ln.arrow(end, end.angle, 7, { color: warn ? 'accent2' : 'line', width: 1.4 }); }
      }
    }
  };
}

// ------------------------------------------------------------------ flow replay

const spansCount = (m: Model, id: string) => m.flows.find((f) => f.id === id)?.spans.length ?? 0;

const HOP = 0.5;       // seconds a call takes to travel along its wire
const STEP = 0.8;      // playback seconds between consecutive call starts

/** Replay one recorded flow: each call travels its wire in order; cards stay lit while their call runs. */
export function flowScene(model: Model, flowId: string, o: { title?: string } = {}): SceneClass {
  const found = model.flows.find((f) => f.id === flowId);
  if (!found) throw new Error(`karyo: model has no flow "${flowId}" (have: ${model.flows.map((f) => f.id).join(', ')})`);
  const flow: MFlow = found;
  const spans = [...flow.spans].sort((a, b) => a.start - b.start);
  const byId = new Map(spans.map((s) => [s.id, s]));
  const caller = (s: MSpan) => (s.parent && byId.has(s.parent) ? byId.get(s.parent)!.node : flow.entry);
  const keep = new Set<string>(spans.map((s) => s.node));
  if (flow.entry) keep.add(flow.entry);
  const PANEL = 340, ROW_H = 34;       // rows have a fixed pitch so scrolling the list is exact
  const multiLang = new Set(spans.map((s) => s.lang)).size > 1;
  // the step list scrolls, so long flows don't stretch the plate past ~16 rows
  const L = layout(model, keep, PANEL + 24, TOP + 66 + Math.min(16, spansCount(model, flowId)) * ROW_H);
  const kx = cardKits(model);
  // playback clock: call starts are evenly spaced; everything else interpolates real time between them
  const t0 = spans[0]?.start ?? 0;
  const starts = spans.map((s) => s.start);
  const avgGap = starts.length > 1 ? (starts[starts.length - 1]! - starts[0]!) / (starts.length - 1) || 1e6 : 1e6;
  const V = (ts: number) => {
    let i = 0;
    while (i < starts.length - 1 && starts[i + 1]! <= ts) i++;
    const a = starts[i]!, b = starts[i + 1];
    const base = 0.9 + i * STEP;
    return b !== undefined && b > a ? base + ((ts - a) / (b - a)) * STEP : base + Math.min(1.6, ((ts - a) / avgGap) * STEP);
  };
  const arrive = (s: MSpan) => V(s.start) + HOP;
  const endV = (s: MSpan) => Math.max(arrive(s) + 0.35, V(s.end ?? s.start) + HOP);
  const total = Math.max(...spans.map(endV)) + 1.8;
  const ms = (ns: number) => (ns / 1e6 < 10 ? (ns / 1e6).toFixed(1) : Math.round(ns / 1e6).toString());
  const depthOf = (s: MSpan): number => { let d = 0; for (let p = s.parent && byId.get(s.parent); p; p = p.parent ? byId.get(p.parent) : undefined) d++; return d; };
  // "Orders store · save_order": the node, plus what the span says it did (skip `fn()` labels, the node says that)
  const what = (s: MSpan, node?: MNode) => { const l = s.label && s.label !== s.node && !s.label.endsWith('()') && s.label !== node?.label ? s.label : ''; return l ? `${esc(node?.label ?? s.node)} <span class="op">· ${esc(l)}</span>` : esc(node?.label ?? s.node); };
  // the wire a call travels: the relationship the merge counted it on (model.ts attributeCall)
  const hopOf = (s: MSpan): Hop | undefined => { const c = caller(s); if (!c || c === s.node) return undefined; const h = attributeCall((k) => L.wire.get(k)?.edge, c, s.node); return L.wire.has(h.key) ? h : undefined; };

  return class FlowScene extends ModelScene {
    static title = o.title ?? flow.title ?? `Flow: ${flow.id}`;
    static width = L.W;
    static height = L.H;
    static duration = total;
    static poster = total - 0.5;
    static fx = 'under' as const;
    readonly model = model;
    readonly L = L;
    readonly kx = kx;
    build(dom: HTMLElement) {
      const span0 = spans[0], dur = span0 ? (Math.max(...spans.map((s) => s.end ?? s.start)) - span0.start) : 0;
      const langs = [...new Set(spans.map((s) => s.lang).filter(Boolean))].join(' → ');
      dom.innerHTML = this.baseHTML(o.title ?? flow.title ?? flow.id, `Recorded run · ${langs} · ${ms(dur)} ms · trace ${flow.trace.slice(0, 8)}`, `
        <style>
          .mf-panel { position: absolute; right: ${SIDE}px; top: ${TOP}px; width: ${PANEL}px; bottom: 40px; display: grid; grid-template-rows: auto 1fr; gap: 6px; }
          .mf-clip { overflow: hidden; min-height: 0; }
          .mf-list { display: grid; gap: 2px; }
          .mf-row { box-sizing: border-box; height: ${ROW_H - 2}px; display: grid; grid-template-columns: 22px 1fr auto; column-gap: 6px; row-gap: 4px; align-items: baseline; padding: 4px 8px; border-radius: min(var(--pl-radius), 6px); font: 12px/1.3 var(--pl-font-mono); color: var(--pl-muted); }
          .mf-row .n { color: var(--pl-muted); }
          .mf-row .who { color: var(--pl-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .mf-row .lang { font-size: 10px; opacity: 0.8; }
          .mf-row .who .op { color: var(--pl-muted); }
          .mf-row.is-now { background: color-mix(in srgb, var(--pl-accent) 14%, transparent); }
          .mf-row.is-now .who { color: var(--pl-accent); }
          .mf-row.is-err .who { color: var(--pl-accent-2); }
          .mf-bar { grid-column: 2 / span 2; height: 3px; border-radius: 2px; background: var(--pl-card-border); overflow: hidden; }
          .mf-bar i { display: block; height: 100%; background: var(--pl-accent); opacity: 0.8; transform-origin: 0 50%; transform: translateX(var(--x, 0)) scaleX(var(--k, 0)); width: var(--w, 0); }
          .mf-x { position: absolute; left: 0; top: 0; z-index: 3; font: 600 10px/1 var(--pl-font-mono); padding: 4px 6px; border-radius: 999px; background: var(--pl-card); border: 1px solid var(--pl-accent); color: var(--pl-accent); white-space: nowrap; transform: translate(-50%, -140%); }
        </style>
        <aside class="mf-panel"><div class="pl-label">Calls, in order</div><div class="mf-clip" data-pl-clip><div class="mf-list" id="list">
          ${spans.map((s, i) => { const node = model.nodes.find((n) => n.id === s.node); const w = ((s.end ?? s.start) - s.start) / Math.max(1, dur); const x = (s.start - t0) / Math.max(1, dur);
            return `<div class="mf-row ${s.status === 'error' ? 'is-err' : ''}" id="r${i}"><span class="n">${i + 1}</span><span class="who" title="${esc(node?.label ?? s.node)}${s.label ? ` · ${esc(s.label)}` : ''}" style="padding-left:${Math.min(4, depthOf(s)) * 10}px">${what(s, node)}</span><span>${ms((s.end ?? s.start) - s.start)} ms${multiLang ? ` <span class="lang">${s.lang ?? ''}</span>` : ''}</span><span class="mf-bar"><i style="--w:${(w * 100).toFixed(2)}%; --x:${(x / Math.max(w, 1e-3) * 100).toFixed(2)}%"></i></span></div>`; }).join('')}
        </div></div></aside>
        ${spans.map((s, i) => { const p = byId.get(s.parent ?? ''); return p && p.lang && s.lang && p.lang !== s.lang ? `<span class="mf-x" id="x${i}">${p.lang} → ${s.lang}</span>` : ''; }).join('')}`);
    }
    update(f: Frame) {
      const t = f.t;
      const h = prog(t, 0, 0.6, ease.outExpo);
      this.$('.mm-head').set({ opacity: h, y: 12 * (1 - h) });
      L.groups.forEach((g, i) => this.$(`#g-${cssId(g.id)}`).opacity = stagger(t, i, 0.1, 0.1, 0.5));
      for (const n of L.nodes) {
        const k = stagger(t, L.pos.get(n.id)!.layer, 0.2, 0.08, 0.45, ease.outExpo);
        const card = this.$(`#${cssId(n.id)}`);
        card.set({ opacity: 0.35 + 0.65 * k, y: 6 * (1 - k) });
        const active = spans.some((s) => s.node === n.id && t >= arrive(s) && t < endV(s)) || (n.id === flow.entry && t > 0.9 && t < total - 1.6);
        card.classes['is-lit'] = active;
        // how lit: a short rise as a span arrives and fall as it ends (a theme may ramp its light with it)
        const ramp = Math.max(0, ...spans.filter((s) => s.node === n.id).map((s) => Math.min(clamp((t - arrive(s) + 0.15) / 0.3), clamp((endV(s) - t + 0.15) / 0.3))), n.id === flow.entry ? Math.min(clamp((t - 0.9 + 0.15) / 0.3), clamp((total - 1.6 - t + 0.15) / 0.3)) : 0);
        card.vars['--kx-lit'] = String(Math.round(ramp * 100) / 100);
        if (active || spans.some((s) => s.node === n.id && t >= arrive(s))) card.opacity = 1;
      }
      let now = -1;
      spans.forEach((s, i) => {
        const row = this.$(`#r${i}`);
        const shown = prog(t, V(s.start), V(s.start) + 0.3);
        row.opacity = 0.25 + 0.75 * shown;
        if (t >= V(s.start)) now = i;
        this.$(`#r${i} .mf-bar i`).vars['--k'] = prog(t, arrive(s), endV(s)).toFixed(4);
        const x = this.$opt(`#x${i}`);
        if (x) {
          const e = hopOf(s);
          if (e) { const m = this.path(e).at(0.5); x.set({ x: m.x, y: m.y, opacity: prog(t, V(s.start), V(s.start) + 0.3) * (1 - prog(t, endV(s), endV(s) + 0.5) * 0.6) }); }
        }
      });
      spans.forEach((_, i) => { this.$(`#r${i}`).classes['is-now'] = i === now && t < total - 1.6; });
      // keep the current row in view
      const visible = Math.floor((L.H - 40 - TOP - 26) / ROW_H);
      this.$('#list').y = -Math.max(0, now - visible + 2) * ROW_H;
    }
    draw(f: Frame, fx: Fx) {
      const t = f.t, Ln = fx.under.lines, bg = fx.under.bg;
      bg.pattern = 'dots'; bg.patternAlpha = 0.22;
      for (const e of L.wires) Ln.path(this.path(e), { color: 'line', width: 1.3, alpha: 0.7 });
      for (const s of spans) {
        const e = hopOf(s);
        const card = this.$(`#${cssId(s.node)}`);
        if (e) {
          // a call against its wire's direction (a queue delivering to its subscriber) travels it backwards
          const p = this.path(e), a = V(s.start), u = (x: number) => (e.reversed ? 1 - x : x);
          const k = prog(t, a, a + HOP, ease.inOutCubic);
          if (k > 0) Ln.path(p, { ...(e.reversed ? { from: 1 - k, to: 1 } : { to: k }), color: s.status === 'error' ? 'accent2' : 'accent', width: 1.9, alpha: 1 - 0.6 * prog(t, endV(s), endV(s) + 0.6), glow: 1.5 });
          comet(Ln, t, (tb) => (tb >= a && tb <= a + HOP ? p.at(u(prog(tb, a, a + HOP, ease.inOutCubic))) : null), { scale: 0.75, embers: 30, seed: s.start % 997 });
          // the return: a small dot runs back when the call finishes
          const r = prog(t, V(s.end ?? s.start) + HOP * 0.4, V(s.end ?? s.start) + HOP * 1.2, ease.inOutCubic);
          if (r > 0 && r < 1) { const q = p.at(u(1 - r)); Ln.dot(q.x, q.y, 5, { color: 'accent', alpha: 0.8, glow: 2 }); }
        }
        pulseRing(Ln, card.center, t, arrive(s), { r1: 70, dur: 0.7, color: s.status === 'error' ? 'accent2' : 'accent' });
        const act = prog(t, arrive(s), arrive(s) + 0.2) * (1 - prog(t, endV(s), endV(s) + 0.3));
        if (act > 0) { lightUnder(bg, card, 0.28 * act, f.theme.accent, 0.5); outline(Ln, card, { pad: 5, radius: 12, width: 1.2, alpha: act * 0.8, glow: 1.2 }); }
      }
    }
  };
}
