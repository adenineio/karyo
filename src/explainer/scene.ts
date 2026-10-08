// The explainer plate: an explainer spec (docs/EXPLAINERS.md) as an interactive plate you step
// through (docs/ENGINE.md, "Interactive plates"). A board of real HTML elements (instances of
// components) sits inside a camera; across the top an optional timeline of stations; beside or
// under the board the narration (step n of N, title, prose). A step is the only thing that moves:
// leaving elements fade where they are, the layout and the camera glide, arriving elements fade in
// with a slight rise, links draw on, numbers count, SVG paths draw, emphasized elements get an
// outline and light under them, the rest can dim. The rest state is the settled step. Under the
// board, an optional legend (the spec's categories and tags): hover an entry to light its elements
// at once, click to pin it. In Bench (`b`) elements drag; a moved element keeps its place across
// steps (a viewer override, localStorage) until "Reset layout".
import { Scene, Morph, Path, wire, rrectPath, ease, clamp, mix, draggable, type Frame, type Fx, type SceneClass, type Vals, type P, type KeyHelp } from '../engine';
import { highlight } from '../model/tour';
import { outlineTags, highlightEntry, HIGHLIGHT, type PlateOutline } from '../model/outline';
import { categorySlots, resolveEntry, LegendStrip, LEGEND_CSS, CATEGORY_CSS, type LegendEntry } from '../model/legend';
import { MAP_CSS } from '../model/scenes';
import { renderTemplate, scopeCss, esc, mdLite, mdInline, tweenProps } from './template';
import { resolveSteps, withDefaults } from './resolve';
import { layoutBoard, type Placed, type Sized } from './layout';
import type { ExplainerBundle, Rect } from './types';
import { ChartView } from './chart/dom';
import { chartKindOf, frameOf, seriesOf, seriesKey, type Frame as ChartFrame } from './chart/data';
import { CHART_CSS } from './chart/render';
import './glass.css';   // the glass themes' look of the chrome, the built-in components and the charts

/** What a page can call on a mounted explainer (`stage.scene as unknown as ExplainerApi`). */
export interface ExplainerApi {
  /** Go to step i (0-based); stops play. */
  go(i: number): void;
  next(): void;
  prev(): void;
  /** Step through the remaining steps (from the first when on the last); again: stop. */
  play(): void;
  readonly step: number;
  readonly stepCount: number;
  /** Layout problems of the current step at rest (camera cut-offs, overlaps, narration overflow). */
  lint(): string[];
  /** Pin exactly this legend entry (a tag id, or `cat:<id>` for a category); null clears every pin. */
  focusTag(tagId: string | null): void;
  /** Light exactly these elements (an ad-hoc pin, replacing the others); null or [] removes it. */
  highlight?(ids: string[] | null): void;
  /** What is on the plate, as plain data (src/model/outline.ts). */
  describe?(): PlateOutline;
}

const D = 0.7;                    // one transition (s)
const RISE = 14;                  // arriving elements rise this far (px)
const GPAD = 18, GTOP = 34;       // group frame padding (sides/bottom, top with the label)
const DIM_PIN = 0.72, DIM_LEGEND = 0.75;   // how far a legend highlight fades the rest (of 1)
type XY = { x: number; y: number };

// ------------------------------------------------------------------ geometry helpers

function clipSeg(a: P, b: P, r: Rect): [P, P] | null {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const ps = [-dx, dx, -dy, dy], qs = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];
  for (let i = 0; i < 4; i++) {
    const p = ps[i]!, q = qs[i]!;
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [{ x: a.x + t0 * dx, y: a.y + t0 * dy }, { x: a.x + t1 * dx, y: a.y + t1 * dy }];
}
/** The parts of a polyline inside a rect. */
function clipRuns(pts: P[], r: Rect): P[][] {
  const runs: P[][] = [];
  let cur: P[] | null = null;
  for (let i = 1; i < pts.length; i++) {
    const c = clipSeg(pts[i - 1]!, pts[i]!, r);
    if (!c) { cur = null; continue; }
    const last = cur?.[cur.length - 1];
    if (cur && last && Math.abs(last.x - c[0].x) < 0.01 && Math.abs(last.y - c[0].y) < 0.01) cur.push(c[1]);
    else { cur = [c[0], c[1]]; runs.push(cur); }
  }
  return runs;
}
const inside = (p: P, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const union = (rs: Rect[]): Rect | null => {
  if (!rs.length) return null;
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
const pad = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });

/** A link between two element rects (board px): side to side, curved. */
function route(a: Rect, b: Rect): Path {
  const G = 6;
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  if (gapX >= gapY) {
    const fwd = bcx >= acx;
    const pa = { x: fwd ? a.x + a.w + G : a.x - G, y: acy }, pb = { x: fwd ? b.x - G : b.x + b.w + G, y: bcy };
    if (Math.abs(pa.y - pb.y) < 1) return new Path([pa, pb]);
    return wire(pa, pb, { kind: 'curve', from: fwd ? 'right' : 'left', to: fwd ? 'left' : 'right', tension: 0.45 });
  }
  const down = bcy >= acy;
  const pa = { x: acx, y: down ? a.y + a.h + G : a.y - G }, pb = { x: bcx, y: down ? b.y - G : b.y + b.h + G };
  if (Math.abs(pa.x - pb.x) < 1) return new Path([pa, pb]);
  return wire(pa, pb, { kind: 'curve', from: down ? 'bottom' : 'top', to: down ? 'top' : 'bottom', tension: 0.45 });
}

// ------------------------------------------------------------------ element hooks (data-k-*)

const decimalsOf = (v: unknown) => { const m = typeof v === 'number' && Number.isFinite(v) ? String(v).match(/\.(\d+)$/) : null; return m ? Math.min(6, m[1]!.length) : 0; };
function fmtNum(v: number, dec: number, group: boolean) {
  const neg = v < 0 && Math.abs(v).toFixed(dec) !== (0).toFixed(dec);
  let [i, f] = Math.abs(v).toFixed(dec).split('.') as [string, string | undefined];
  if (group && Math.abs(v) >= 1000) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '−' : '') + i + (f ? '.' + f : '');
}

/** `<pre data-k-code data-lang data-focus data-start>` → numbered, tinted lines (focus lines lit). */
function applyCode(root: HTMLElement) {
  for (const pre of root.querySelectorAll<HTMLElement>('pre[data-k-code]')) {
    const lang = pre.dataset.lang || 'ts', start = parseInt(pre.dataset.start || '1', 10) || 1;
    const focus = new Set((pre.dataset.focus || '').split(/[\s,]+/).filter(Boolean).map(Number));
    const src = (pre.textContent ?? '').replace(/^\n/, '').replace(/\n$/, '').split('\n');
    pre.innerHTML = highlight(src, lang).map((h, j) => `<span class="ln${focus.has(start + j) ? ' is-lit' : ''}"><span class="no">${start + j}</span>${h || ' '}</span>`).join('');
  }
}

interface Hooks {
  nums: { el: HTMLElement; prop: string; dec: number | null; group: boolean }[];
  scales: { el: HTMLElement; a: string; b: string }[];
  draws: SVGGeometryElement[];
}
function collectHooks(root: HTMLElement): Hooks {
  const nums = [...root.querySelectorAll<HTMLElement>('[data-k-num]')].map((el) => {
    const d = el.getAttribute('data-k-decimals');
    const g = el.getAttribute('data-k-group');
    return { el, prop: el.getAttribute('data-k-num')!.trim(), dec: d && /^\d+$/.test(d.trim()) ? +d : null, group: g !== null && g !== 'false' };
  });
  const scales = [...root.querySelectorAll<HTMLElement>('[data-k-scale]')].map((el) => {
    const [a = '1', b = '1'] = el.getAttribute('data-k-scale')!.split('/').map((s) => s.trim());
    return { el, a, b };
  });
  const draws = [...root.querySelectorAll<SVGGeometryElement>('[data-k-draw]')];
  for (const d of draws) { d.setAttribute('pathLength', '1'); d.style.strokeDasharray = '1 1'; }
  return { nums, scales, draws };
}

// ------------------------------------------------------------------ the plate

export function explainerScene(bundle: ExplainerBundle, o: { title?: string } = {}): SceneClass {
  const spec = bundle.spec;
  const W = spec.size?.w ?? 1600, H = spec.size?.h ?? 900;
  const R = resolveSteps(spec);
  const steps = R.steps, N = steps.length;
  const els = spec.elements;
  const EI = new Map(els.map((e, i) => [e.id, i]));
  const links = R.links.filter((l) => EI.has(l.from) && EI.has(l.to) && l.from !== l.to);
  const groups = (spec.groups ?? []).filter((g) => els.some((e) => e.group === g.id));
  const narration = spec.narration ?? 'side';
  const hasTimeline = spec.timeline ?? N > 1;
  const title = o.title ?? spec.title;
  const defaultGap = groups.length ? 56 : 32;
  const metaOf = (ei: number) => bundle.components[els[ei]!.type]?.meta;
  const propsAt = (ei: number, si: number) => withDefaults(metaOf(ei)?.props, steps[si]!.props[els[ei]!.id]);

  // ---- the legend: categories (colour = order) and tags, members are element ids
  const catSpecs = (spec.categories ?? []).filter((c) => c && typeof c.id === 'string');
  const tagSpecs = (spec.tags ?? []).filter((t) => t && typeof t.id === 'string');
  const slots = categorySlots(catSpecs.map((c) => c.id));
  // a category's members: the elements in it, and the charts with a series or slice in it
  const chartCatsOf = (e: (typeof els)[number]) => {
    const kind = chartKindOf(bundle.components[e.type]?.template);
    if (!kind) return new Set<string>();
    return new Set([e.props, ...(spec.steps ?? []).map((st) => st.set?.[e.id])].flatMap((p) => (p ? seriesOf(kind, p).map((x) => x.category ?? '') : [])));
  };
  const inCat = (e: (typeof els)[number], id: string) => e.category === id || chartCatsOf(e).has(id);
  const lgCats: LegendEntry[] = catSpecs.filter((c) => slots.get(c.id)! > 0).map((c) => ({ id: `cat:${c.id}`, name: c.label ?? c.id, kind: 'category', slot: slots.get(c.id)!, members: els.filter((e) => inCat(e, c.id)).map((e) => e.id), hint: `category ${c.label ?? c.id}` }));
  const otherCats = catSpecs.filter((c) => slots.get(c.id) === 0).map((c) => c.id);
  if (otherCats.length) lgCats.push({ id: 'cat:·other', name: 'other', kind: 'category', slot: 0, members: els.filter((e) => otherCats.some((c) => inCat(e, c))).map((e) => e.id), hint: `categories ${otherCats.join(', ')}` });
  const lgTags: LegendEntry[] = tagSpecs.map((t) => ({ id: `tag:${t.id}`, name: t.label ?? t.id, kind: 'tag', members: els.filter((e) => Array.isArray(e.tags) && e.tags.includes(t.id)).map((e) => e.id), hint: t.description ?? `tag ${t.label ?? t.id}` }));
  const lgAll = [...lgCats, ...lgTags];
  const lgEntry = (id: string | null | undefined) => (id ? lgAll.find((e) => e.id === id) : undefined);
  const hasLegend = spec.legend ?? lgAll.length > 0;
  const LEG_ROWS = hasLegend ? (lgCats.length ? 1 : 0) + (lgTags.length ? 1 : 0) || 1 : 0;
  const LEG_SPACE = hasLegend ? LEG_ROWS * 32 + 22 : 0;   // the strip plus the gap above it
  const slotOfEl = new Map(els.filter((e) => e.category && slots.has(e.category)).map((e) => [e.id, slots.get(e.category!)!]));

  // ---- chrome geometry
  const SIDE = W >= 1200 ? 48 : 28;
  const HEAD_H = spec.summary ? 104 : 80;
  const TY = HEAD_H + 22;                             // timeline track
  const BODY_Y = hasTimeline ? TY + 76 : HEAD_H + 20;
  const BODY_B = H - 44;
  let view: Rect, narr: Rect | null;
  if (narration === 'side') {
    const NW = clamp(Math.round(W * 0.25), 300, 420);
    view = { x: SIDE, y: BODY_Y, w: W - 2 * SIDE - NW - 40, h: BODY_B - BODY_Y - LEG_SPACE };
    narr = { x: view.x + view.w + 40, y: BODY_Y, w: NW, h: BODY_B - BODY_Y };
  } else if (narration === 'bottom') {
    const NH = clamp(Math.round(H * 0.17), 120, 190);
    view = { x: SIDE, y: BODY_Y, w: W - 2 * SIDE, h: BODY_B - BODY_Y - NH - 20 - LEG_SPACE };
    narr = { x: SIDE, y: view.y + view.h + LEG_SPACE + 20, w: W - 2 * SIDE, h: NH };
  } else { view = { x: SIDE, y: BODY_Y, w: W - 2 * SIDE, h: BODY_B - BODY_Y - LEG_SPACE }; narr = null; }
  const LEG_Y = view.y + view.h + 14;
  const X0 = N === 1 ? W / 2 : SIDE + 70, X1 = N === 1 ? W / 2 : W - SIDE - 70;
  const sp = N === 1 ? 0 : (X1 - X0) / (N - 1);
  const sx = (i: number) => X0 + i * sp;
  const STW = N === 1 ? 220 : Math.min(200, sp - 12);

  // ---- per element: tweened props (counted from 0 when it appears) and their decimals
  const tween = els.map((e) => {
    const c = bundle.components[e.type];
    const all = new Set(c ? tweenProps(c.template) : []);
    const count = new Set<string>();
    if (c) {
      for (const m of c.template.matchAll(/data-k-num\s*=\s*"([^"]+)"/g)) count.add(m[1]!.trim());
      for (const m of c.template.matchAll(/data-k-scale\s*=\s*"([^"/]+)\//g)) if (!/^[\d.]+$/.test(m[1]!.trim())) count.add(m[1]!.trim());
    }
    return { all, count };
  });
  const decs = els.map((_, ei) => Object.fromEntries([...tween[ei]!.all].map((p) => [p, Math.max(0, ...steps.map((_, si) => decimalsOf(propsAt(ei, si)[p])))])));

  // ---- per element and step: the HTML (tweened props pinned to step 1's values, so a step that only
  //      changes numbers keeps the same DOM and the numbers count)
  // kit node kinds (docs/KITS.md) are components with a `node` block: the element is the card's frame
  const kindMeta = (t: string) => (bundle.components[t]?.meta as { node?: { label?: string } } | undefined)?.node;
  const isKind = (t: string) => !!kindMeta(t);
  const kindLabel = (t: string) => kindMeta(t)?.label ?? t;
  const variants = els.map((e, ei) => steps.map((_, si) => {
    const c = bundle.components[e.type];
    if (!c) return `<div class="kx-missing">unknown component “${esc(e.type)}”</div>`;
    const p = propsAt(ei, si), p0 = propsAt(ei, 0);
    for (const k of tween[ei]!.all) if (typeof p0[k] === 'number' && typeof p[k] === 'number') p[k] = p0[k];
    // a kit's node kind (docs/KITS.md) reads its fields as props, plus node.* (the element as the node) and stats.*
    if (isKind(e.type)) Object.assign(p, { node: { id: e.id, kind: e.type, kindLabel: kindLabel(e.type), label: labelOf(ei), summary: '', category: e.category ?? '', tags: e.tags ?? [], lang: '', group: e.group ?? '', where: '', proposed: false }, stats: { in: 0, out: 0, calls: 0, ops: [], opsCount: 0, callers: [], callees: [] } });
    try { return renderTemplate(c.template, p); }
    catch (err) { return `<div class="kx-missing">component “${esc(e.type)}”: ${esc(err instanceof Error ? err.message : String(err))}</div>`; }
  }));

  // ---- charts (data-k-chart): colour slots follow the series (its category, else its first place across the
  //      steps), never their rank in one step; one frame per element and step
  const chartKind = els.map((e) => chartKindOf(bundle.components[e.type]?.template));
  const chartSlots = els.map((e, ei) => {
    const kind = chartKind[ei];
    if (!kind) return null;
    const order: string[] = [];
    steps.forEach((_, si) => seriesOf(kind, propsAt(ei, si)).forEach((x, i) => { const k = seriesKey(x, i); if (!order.includes(k)) order.push(k); }));
    return (k: string, cat?: string) => (cat && slots.has(cat) ? slots.get(cat)! : order.indexOf(k) < 8 ? order.indexOf(k) + 1 : 0);
  });
  // a chart with no category of its own leaks its first series' colour (the first series shown, by its slot)
  const chartLeak = els.map((e, ei) => {
    const kind = chartKind[ei];
    if (!kind || (e.category && slots.has(e.category))) return null;
    for (let si = 0; si < steps.length; si++) { const s = seriesOf(kind, propsAt(ei, si)); if (s.length) return chartSlots[ei]!(seriesKey(s[0]!, 0), s[0]!.category); }
    return null;
  });
  const catLabel = (id: string) => catSpecs.find((c) => c.id === id)?.label;
  // the legend's categories light parts of charts: a category entry's ids, and the series (or slices) of a chart
  // that a step shows in those categories (null when it shows none)
  const catIdsOf = (entry: string) => (entry === 'cat:·other' ? otherCats : entry.startsWith('cat:') ? [entry.slice(4)] : []);
  const legendParts = (ei: number, si: number, cats: string[]): string[] | null => {
    if (!cats.length || !chartKind[ei]) return null;
    const keys = seriesOf(chartKind[ei]!, propsAt(ei, si)).flatMap((x, i) => (x.category && cats.includes(x.category) ? [seriesKey(x, i)] : []));
    return keys.length ? keys : null;
  };
  const frames = new Map<string, ChartFrame>();
  /** A chart's frame at step si; with legend categories active, their series are its emphasis (instead of the step's). */
  const frameAt = (ei: number, si: number, cats: string[] = []) => {
    const lit = legendParts(ei, si, cats);
    const key = `${ei}|${si}|${lit ? lit.join('\u0001') : ''}`;
    let f = frames.get(key);
    if (!f) { f = frameOf(chartKind[ei]!, propsAt(ei, si), { slot: chartSlots[ei]!, catLabel, parts: lit ? { emph: lit, dim: [] } : steps[si]!.parts[els[ei]!.id] }); frames.set(key, f); }
    return f;
  };
  const hasCharts = chartKind.some(Boolean);

  function labelOf(ei: number) { const e = els[ei]!, p = e.props ?? {}; return e.label ?? (typeof p.title === 'string' ? p.title : typeof p.label === 'string' ? p.label : e.id); };
  const compCss = [...new Set(els.map((e) => e.type))].map((t) => bundle.components[t] ? `/* ${t} */\n${scopeCss(bundle.components[t]!.css, t)}` : '').join('\n');

  const CSS = /* css */ `
    /* the header, tools and step rail: one chrome band (docs/ENGINE.md "Zoom and pan"); it lays nothing out itself */
    .kx-top { position: absolute; left: 0; top: 0; width: ${W}px; height: ${BODY_Y - 12}px; pointer-events: none; }
    .kx-top > * { pointer-events: auto; }
    .kx-top > .kx-marker { pointer-events: none; }
    .kx-head { position: absolute; left: ${SIDE}px; top: 24px; width: ${W - 2 * SIDE - (N > 1 ? 280 : 120)}px; display: grid; gap: 6px; }
    .kx-head .pl-title { font-size: 28px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .kx-sum { margin: 0; font-size: 14.5px; line-height: 19px; color: var(--pl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .kx-sum code { font: 13px/1 var(--pl-font-mono); }
    .kx-tools { position: absolute; right: ${SIDE}px; top: 34px; display: flex; gap: 8px; }
    .kx-btn { font: 500 11px/1 var(--pl-font-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--pl-fg); background: var(--pl-card); border: 1px solid var(--pl-line); border-radius: min(var(--pl-radius), 6px); padding: 8px 12px; min-width: 40px; cursor: pointer; }
    .kx-btn:hover { border-color: var(--pl-fg); }
    .kx-btn:focus-visible, .kx-st:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: 2px; }
    .kx-btn.is-on { border-color: var(--pl-accent); color: var(--pl-accent); }
    #kx-play { min-width: 76px; }

    .kx-st { position: absolute; top: ${TY - 8}px; height: 58px; margin: 0; padding: 0; border: 0; background: none; color: var(--pl-fg); font: inherit; cursor: pointer; display: flex; flex-direction: column; align-items: center; border-radius: min(var(--pl-radius), 6px); }
    .kx-dot { flex: none; box-sizing: border-box; width: 12px; height: 12px; margin-top: 2px; border-radius: 50%; border: 2px solid var(--pl-line); background: var(--pl-bg); }
    .kx-st.is-past .kx-dot { border-color: var(--pl-muted); background: var(--pl-muted); }
    .kx-st.is-cur .kx-dot { border-color: var(--pl-accent); background: var(--pl-accent); }
    .kx-stt { flex: none; margin-top: 8px; width: 100%; height: 32px; font: 600 13px/16px var(--pl-font-display); text-align: center; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
    .kx-st.is-cur .kx-stt { color: var(--pl-accent); }
    .kx-st:hover .kx-stt { text-decoration: underline; text-underline-offset: 3px; }
    .kx-marker { position: absolute; left: -12px; top: ${TY - 12}px; width: 24px; height: 24px; box-sizing: border-box; border-radius: 50%; border: 2px solid var(--pl-accent); pointer-events: none; }

    .kx-view { position: absolute; left: ${view.x}px; top: ${view.y}px; width: ${view.w}px; height: ${view.h}px; overflow: hidden;
      /* a soft edge: what the camera crops fades out instead of being sliced */
      -webkit-mask-image: linear-gradient(to right, transparent, #000 20px, #000 calc(100% - 20px), transparent), linear-gradient(to bottom, transparent, #000 20px, #000 calc(100% - 20px), transparent);
      -webkit-mask-composite: source-in; mask-image: linear-gradient(to right, transparent, #000 20px, #000 calc(100% - 20px), transparent), linear-gradient(to bottom, transparent, #000 20px, #000 calc(100% - 20px), transparent); mask-composite: intersect; }
    .kx-cam { position: absolute; left: 0; top: 0; width: ${view.w}px; height: ${view.h}px; }
    .kx-el { position: absolute; left: 0; top: 0; z-index: 1; box-sizing: border-box; outline: none; }
    .kx-el:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: 5px; border-radius: var(--pl-radius); }
    .kx-el :where(p code, li code, td code, dd code, .md code, .body code) { font: 0.88em/1 var(--pl-font-mono); color: var(--pl-accent); }
    .kx-el :where(a) { color: var(--pl-accent); }
    .kx-el :where(mark) { background: color-mix(in srgb, var(--pl-accent) 20%, transparent); color: inherit; padding: 0 2px; border-radius: 3px; }
    .kx-el :where(ul, ol) { margin: 0 0 6px; padding-left: 1.25em; }
    .kx-missing { box-sizing: border-box; padding: 12px 14px; border: 1.5px dashed var(--pl-accent-2); border-radius: var(--pl-radius); color: var(--pl-accent-2); font: 13px/1.4 var(--pl-font-mono); }
    .kx-group { position: absolute; left: 0; top: 0; z-index: 0; width: calc(var(--gw, 0) * 1px); height: calc(var(--gh, 0) * 1px); box-sizing: border-box; border: 1.5px dashed var(--pl-line); border-radius: calc(var(--pl-radius) + 8px); pointer-events: none; }
    .kx-glabel { position: absolute; left: 14px; top: 10px; font: 500 11px/14px var(--pl-font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--pl-muted); white-space: nowrap; }
    .kx-llabel { position: absolute; left: 0; top: 0; z-index: 3; font: 500 11.5px/1 var(--pl-font-mono); padding: 4px 7px; background: var(--pl-bg); color: var(--pl-muted); border: 1px solid var(--pl-card-border); border-radius: min(var(--pl-radius), 999px); white-space: nowrap; }
    .kx-llabel.is-lit { color: var(--pl-accent); border-color: var(--pl-accent); }
    .kx-llabel.is-warn { color: var(--pl-accent-2); }

    .kx-narr { position: absolute; ${narr ? `left: ${narr.x}px; top: ${narr.y}px; width: ${narr.w}px; height: ${narr.h}px;` : 'display: none;'} overflow: hidden; }
    .kx-tx { position: absolute; left: 0; right: 0; top: 0; display: grid; gap: 10px; align-content: start; }
    .kx-h { margin: 0; font: 700 26px/1.15 var(--pl-font-display); letter-spacing: -0.01em; }
    .kx-prose p { margin: 0 0 10px; font-size: 16px; line-height: 1.55; color: var(--pl-fg); max-width: 62ch; }
    .kx-prose p:last-child { margin-bottom: 0; }
    .kx-prose ul, .kx-prose ol { margin: 0 0 10px; padding-left: 1.3em; font-size: 16px; line-height: 1.5; }
    .kx-prose code { font: 14px/1 var(--pl-font-mono); color: var(--pl-accent); }
    .kx-prose a { color: var(--pl-accent); }
    .kx-prose mark { background: color-mix(in srgb, var(--pl-accent) 20%, transparent); color: inherit; padding: 0 2px; }
    .kx-narr.is-bottom .kx-tx { grid-template-columns: minmax(0, 380px) minmax(0, 1fr); column-gap: 40px; align-items: start; }
    .kx-narr.is-bottom .kx-tx > .kx-left { display: grid; gap: 8px; }
    .kx-narr.is-bottom .kx-prose p { font-size: 15.5px; }
    .kx-legend { position: absolute; left: ${view.x}px; top: ${LEG_Y}px; width: ${view.w}px; }
    .kx-legend .lg-list { --lg-max-h: 28px; }
    .kx-legend .lg-h { width: 92px; }
    .kx-el[data-cat]::before { content: ''; position: absolute; left: -9px; top: 4px; bottom: 4px; width: 3px; border-radius: 2px; background-color: var(--lg-c); background-image: var(--lg-f); pointer-events: none; }
    .plate.is-bench .kx-el { cursor: grab; user-select: none; touch-action: none; }
    .kx-el.is-drag { z-index: 5; cursor: grabbing; }
    .kx-tools [hidden] { display: none; }
    ${hasLegend ? LEGEND_CSS : catSpecs.length ? CATEGORY_CSS : ''}
    .kx-mode { position: absolute; left: ${SIDE}px; bottom: 16px; font: 12px/1.2 var(--pl-font-mono); color: var(--pl-muted); white-space: nowrap; }
    .kx-note { position: absolute; right: ${SIDE + 76}px; bottom: 15px; max-width: 44%; font-size: 12.5px; line-height: 1.2; color: var(--pl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }
    .kx-note code { font: 11.5px/1 var(--pl-font-mono); }
    ${spec.note ? '.kx-mode { max-width: calc(56% - ' + (SIDE + 92) + 'px); overflow: hidden; text-overflow: ellipsis; }' : ''}
    ${els.some((e) => isKind(e.type)) ? `${MAP_CSS.replace(/^\s*\.mm-(head|group|foot|legend|warn|card)[^\n]*\n/gm, '')}
    .kx-el.kx-kind { box-sizing: border-box; padding: 9px 12px; display: grid; align-content: start; gap: 3px; overflow: hidden; }` : ''}
    ${hasCharts ? CHART_CSS : ''}
    ${compCss}
  `;

  const stationHTML = (i: number) => `<button type="button" class="kx-st" id="st${i}" style="left:${sx(i) - STW / 2}px;width:${STW}px" title="${esc(steps[i]!.title)}${i < 9 ? ` (${i + 1})` : ''}" aria-label="Step ${i + 1}: ${esc(steps[i]!.title)}"><span class="kx-dot"></span><span class="kx-stt">${esc(steps[i]!.title)}</span></button>`;
  const paneHTML = (i: number) => {
    const s = steps[i]!;
    const head = `<div class="pl-label">Step ${i + 1} of ${N}</div><h2 class="kx-h">${esc(s.title)}</h2>`;
    const prose = s.text ? `<div class="kx-prose">${mdLite(s.text)}</div>` : '';
    return `<div class="kx-tx" id="t${i}">${narration === 'bottom' ? `<div class="kx-left">${head}</div>${prose}` : head + prose}</div>`;
  };

  const SK = `karyo:explainer:${spec.id}`;
  const loadMoved = (): Record<string, XY> => { try { const v = JSON.parse(localStorage.getItem(SK) ?? 'null'); return v && typeof v === 'object' && v.positions && typeof v.positions === 'object' ? v.positions : {}; } catch { return {}; } };
  const saveMoved = (m: Record<string, XY>) => { try { localStorage.setItem(SK, JSON.stringify({ positions: m })); } catch { /* not persisted */ } };

  return class ExplainerPlate extends Scene implements ExplainerApi {
    static title = title;
    static width = W;
    static height = H;
    static duration = D;
    static fx = 'under' as const;
    static interactive = true;
    static bench = true;

    private cur = 0;
    /** Legend: pinned entries (a transition) and the hovered one (at once). */
    private pins: string[] = [];
    private lgHover: string | null = null;
    private legend: LegendStrip | null = null;
    /** Bench: the viewer's element positions (board px, every step) and the element being dragged. */
    private moved: Record<string, XY> = loadMoved();
    private drag: { ei: number; start: XY; cur: XY } | null = null;
    private playing = false;
    private timer: ReturnType<typeof setTimeout> | 0 = 0;
    private morph = new Morph();
    private kk = { main: 1, out: 1, in: 1, draw: 1, count: 1 };
    private size: { w: number; h: number }[] = [];
    private labelSize: { w: number; h: number }[] = [];
    private pos: Placed[] = [];
    private cams: { cx: number; cy: number; s: number }[] = [];
    /** Per step: elements a camera focus would cut at the edge of the view. They fade right back
     *  instead of showing a clipped sliver of text; the whole element returns when the camera does. */
    private cut: Set<string>[] = [];
    private cutGroups: Set<number>[] = [];
    private grects: { r: Rect; on: boolean }[][] = [];
    private shown: string[] = [];
    private hooks: Hooks[] = [];
    private charts: (ChartView | null)[] = [];
    private routes: (Path | null)[] = [];
    private camNow = { s: 1, tx: 0, ty: 0 };
    private radius = { theme: '', r: 10 };

    get step() { return this.cur; }
    get stepCount() { return N; }

    async build(dom: HTMLElement) {
      const sub = `Explainer${N > 1 ? ` · ${N} steps` : ''}`;
      dom.innerHTML = `<style>${CSS}</style>
        <div class="kx-top" data-pl-chrome><header class="kx-head"><div class="pl-label">${esc(sub)}</div><h1 class="pl-title" title="${esc(title)}">${esc(title)}</h1>${spec.summary ? `<p class="kx-sum" title="${esc(spec.summary)}">${mdInline(spec.summary)}</p>` : ''}</header>
        <div class="kx-tools"><button type="button" class="kx-btn" id="kx-reset" title="Put every element back where the explainer lays it out" hidden>Reset layout</button>${N > 1 ? '<button type="button" class="kx-btn" id="kx-prev" title="Previous step (← or k)" aria-label="Previous step">‹</button><button type="button" class="kx-btn" id="kx-play" title="Play the steps (p; any key stops)">Play</button><button type="button" class="kx-btn" id="kx-next" title="Next step (→, j or Enter)" aria-label="Next step">›</button>' : ''}</div>
        ${hasTimeline ? steps.map((_, i) => stationHTML(i)).join('') + '<div class="kx-marker" id="kx-marker"></div>' : ''}</div>
        <div class="kx-view" data-pl-clip><div class="kx-cam" id="kx-cam">
          ${groups.map((g, gi) => `<div class="kx-group" id="g${gi}" aria-hidden="true">${g.label ? `<span class="kx-glabel">${esc(g.label)}</span>` : ''}</div>`).join('')}
          ${els.map((e, ei) => `<div class="kx-el kc-${esc(e.type)}${isKind(e.type) ? ' pl-card kx-kind' : ''}" id="e${ei}" data-id="${esc(e.id)}"${slotOfEl.has(e.id) ? ` data-cat="${slotOfEl.get(e.id)}"` : chartLeak[ei] != null ? ` data-leak="${chartLeak[ei]}"` : ''} tabindex="0" role="group" aria-label="${esc(labelOf(ei))}"></div>`).join('')}
          ${links.map((l, li) => (l.label ? `<span class="kx-llabel" id="l${li}">${esc(l.label)}</span>` : '')).join('')}
        </div></div>
        <div class="kx-narr${narration === 'bottom' ? ' is-bottom' : ''}" data-pl-clip data-pl-chrome aria-live="polite">${narr ? steps.map((_, i) => paneHTML(i)).join('') : ''}</div>
        ${hasLegend ? '<div class="kx-legend" id="kx-legend" data-pl-chrome></div>' : ''}
        <div class="kx-mode" id="kx-mode" data-pl-chrome></div>${spec.note ? `<div class="kx-note" data-pl-chrome title="${esc(spec.note)}">${mdInline(spec.note)}</div>` : ''}`;
      if (hasLegend) {
        this.legend = new LegendStrip(dom.querySelector('#kx-legend')!, {
          onHover: (id) => { if (id !== this.lgHover) { this.lgHover = id; this.stage.redraw(); } },
          onToggle: (id) => this.togglePin(id),
          keyHints: false,   // 1–9 go to a step here
          hideEmpty: true,   // only the rows the spec declares
        });
        this.legend.render(lgCats, lgTags);
      }
      dom.querySelector('#kx-reset')!.addEventListener('click', () => this.resetLayout());
      els.forEach((e, ei) => {
        draggable(dom.querySelector<HTMLElement>(`#e${ei}`)!, this.stage, {
          // Bench only, and only what the current step shows
          onStart: () => {
            if (!this.stage.inBench || !steps[this.cur]!.visible.has(e.id)) return;
            const p = this.pos[this.cur]!.get(e.id) ?? { x: 0, y: 0 };
            this.drag = { ei, start: { x: p.x, y: p.y }, cur: { x: p.x, y: p.y } };
            this.stop();
          },
          onMove: ({ dx, dy }) => {
            if (!this.drag) return;
            const s = this.camNow.s || 1;   // stage px → board px
            this.drag.cur = { x: this.drag.start.x + dx / s, y: this.drag.start.y + dy / s };
            this.stage.redraw();
          },
          onEnd: () => {
            const d = this.drag;
            if (!d) return;
            this.drag = null;
            this.moved[els[d.ei]!.id] = { x: Math.round(d.cur.x), y: Math.round(d.cur.y) };
            saveMoved(this.moved);
            // re-plan with the override (frames, camera): glide from where it was let go
            const m = this.targets(); this.plan();
            m.set(`e${d.ei}`, { ...m.get(`e${d.ei}`)!, x: d.cur.x, y: d.cur.y });
            this.morph.snap(m);
            this.retarget();
            this.stage.transition();
          },
        });
      });

      if (hasTimeline) steps.forEach((_, i) => dom.querySelector(`#st${i}`)!.addEventListener('click', () => this.go(i)));
      dom.querySelector('#kx-prev')?.addEventListener('click', () => this.prev());
      dom.querySelector('#kx-next')?.addEventListener('click', () => this.next());
      dom.querySelector('#kx-play')?.addEventListener('click', () => this.play());
      dom.addEventListener('pointerdown', (e) => { if (this.playing && !(e.target as HTMLElement).closest('#kx-play')) this.stop(); }, true);
      this.stage.onFrame((t) => {
        if (this.playing && !this.timer && t >= this.stage.duration && !this.stage.playing) {
          const words = steps[this.cur]!.text.split(/\s+/).filter(Boolean).length;
          this.timer = setTimeout(() => this.playNext(), clamp(1400 + words * 60, 1800, 8000));
        }
      });
      new MutationObserver(() => this.stage.redraw()).observe(this.stage.root, { attributes: true, attributeFilter: ['class'] });
      // a theme picked while the plate is open may change type and padding (the glass themes do): measure again
      const themeMo = new MutationObserver(() => this.themeChanged());
      for (const el of [document.documentElement, this.stage.root]) themeMo.observe(el, { attributes: true, attributeFilter: ['data-plate-theme', 'data-theme'] });
      document.fonts?.addEventListener?.('loadingdone', () => { if (performance.now() < this.fontsUntil) this.themeChanged(); });

      await this.measure(dom);
      this.plan();
      this.cur = 0;
      this.morph.snap(this.targets());
      this.charts.forEach((c, ei) => c?.snap(frameAt(ei, 0)));
      this.syncA11y();
    }

    /** Every element's size: its at.w / component size.w (or its natural width), and the tallest of its
     *  step variants (or at.h / size.h). Runs once fonts and images are in. */
    private async measure(dom: HTMLElement) {
      const nodes = els.map((_, ei) => dom.querySelector<HTMLElement>(`#e${ei}`)!);
      nodes.forEach((n, ei) => { n.innerHTML = variants[ei]![0]!; });
      void dom.offsetHeight;                                  // style everything so fonts start loading
      await document.fonts?.ready;
      for (let ei = 0; ei < els.length; ei++) {
        const e = els[ei]!, n = nodes[ei]!, meta = metaOf(ei);
        const fixedW = e.at?.w ?? meta?.size?.w, fixedH = e.at?.h ?? meta?.size?.h;
        let w = 0, h = 0;
        for (const html of [...new Set(variants[ei]!)]) {
          n.innerHTML = html;
          applyCode(n);
          await Promise.all([...n.querySelectorAll('img')].map((img) => img.decode().catch(() => undefined)));
          n.style.height = 'auto';
          if (fixedW) n.style.width = `${fixedW}px`;
          else { n.style.width = 'max-content'; n.style.maxWidth = '560px'; }
          w = Math.max(w, fixedW ?? n.offsetWidth);
          if (!fixedW) n.style.width = `${Math.ceil(w)}px`;
          h = Math.max(h, fixedH ?? n.offsetHeight);
        }
        n.style.maxWidth = '';
        this.size[ei] = { w: Math.ceil(w), h: Math.ceil(h) };
        n.style.width = `${this.size[ei]!.w}px`;
        n.style.height = `${this.size[ei]!.h}px`;
        n.innerHTML = variants[ei]![0]!;
        applyCode(n);
        this.shown[ei] = variants[ei]![0]!;
        this.hooks[ei] = collectHooks(n);
        if (chartKind[ei]) {
          const v = new ChartView(() => this.stage.redraw(), !this.stage.isExport, () => { const sm = propsAt(ei, this.cur).summary; return typeof sm === 'string' ? sm : undefined; });
          this.charts[ei] = v;
          this.attachChart(ei, n);
        }
      }
      links.forEach((l, li) => {
        const n = l.label ? dom.querySelector<HTMLElement>(`#l${li}`) : null;
        this.labelSize[li] = n ? { w: n.offsetWidth, h: n.offsetHeight } : { w: 0, h: 0 };
      });
    }

    /** After a theme change (and its web fonts arriving), every element's size again, then the layout and camera,
     *  landing at once on the current step. Sizes only change when the new theme's type or padding differ. */
    private remeasuring = 0;
    private fontsUntil = 0;
    private themeChanged() {
      this.fontsUntil = performance.now() + 12000;
      const run = ++this.remeasuring;
      requestAnimationFrame(async () => {
        if (run !== this.remeasuring || !this.stage.isReady) return;
        const before = JSON.stringify(this.size);
        await this.measure(this.stage.dom);
        if (run !== this.remeasuring || JSON.stringify(this.size) === before) { this.syncVariantsNow(); this.stage.redraw(); return; }
        this.plan();
        this.morph = new Morph();
        this.morph.snap(this.targets());
        this.charts.forEach((c, ei) => c?.snap(frameAt(ei, this.cur, this.legendCats())));
        this.syncVariantsNow();
        this.stage.redraw();
      });
    }
    /** measure() leaves step 1's HTML in every element: put the current step's back (and its hooks). */
    private syncVariantsNow() {
      els.forEach((_, ei) => { if (this.shown[ei] !== variants[ei]![this.cur]) this.shown[ei] = ''; });
      this.syncVariants();
    }

    private attachChart(ei: number, n: HTMLElement) {
      const host = n.querySelector<HTMLElement>('[data-k-chart]');
      if (host) this.charts[ei]?.attach(host);
    }

    /** Each step's resting layout, group frames and camera. */
    private plan() {
      const cache = new Map<string, Placed>();
      // graph layers leave room for the widest link label
      const labelGap = Math.max(0, ...this.labelSize.map((z) => z.w + 56));
      const sized = (ids: Set<string> | null): Sized[] => els.filter((e) => !ids || ids.has(e.id)).map((e) => ({ id: e.id, w: this.size[EI.get(e.id)!]!.w, h: this.size[EI.get(e.id)!]!.h, at: e.at }));
      const get = (li: number, ids: Set<string> | null) => {
        const key = `${li}|${ids ? [...ids].sort().join(',') : '*'}`;
        let p = cache.get(key);
        if (!p) { p = layoutBoard(sized(ids), R.layouts[li]!, links, view, { gap: defaultGap, layerGap: labelGap }); cache.set(key, p); }
        return p;
      };
      steps.forEach((st, si) => {
        const all = get(st.layoutIndex, null);
        const p = st.layout.scope === 'visible' ? new Map([...all, ...get(st.layoutIndex, st.visible)]) : new Map(all);
        // the viewer's Bench positions hold on every step
        for (const [id, xy] of Object.entries(this.moved)) if (EI.has(id)) p.set(id, { ...(p.get(id) ?? { x: 0, y: 0 }), x: xy.x, y: xy.y });
        this.pos[si] = p;
        const rect = (id: string): Rect => { const q = p.get(id)!, s = this.size[EI.get(id)!]!; return { x: q.x, y: q.y, w: s.w, h: s.h }; };
        this.grects[si] = groups.map((g) => {
          const members = els.filter((e) => e.group === g.id);
          const vis = members.filter((e) => st.visible.has(e.id));
          const u = union((vis.length ? vis : members).map((e) => rect(e.id)))!;
          return { r: { x: u.x - GPAD, y: u.y - GTOP, w: u.w + 2 * GPAD, h: u.h + GTOP + GPAD }, on: vis.length > 0 };
        });
        let F: Rect, maxS: number;
        if (st.focus && typeof st.focus === 'object') { F = st.focus; maxS = 4; }
        else if (typeof st.focus === 'string') {
          const gi = groups.findIndex((g) => g.id === st.focus);
          F = gi >= 0 ? pad(this.grects[si]![gi]!.r, 24) : pad(rect(st.focus), 40);
          maxS = 1.5;
        }
        else {
          const vis = [...st.visible].map(rect).concat(this.grects[si]!.filter((g) => g.on).map((g) => g.r));
          F = pad(union(vis) ?? union(els.map((e) => rect(e.id)))!, 28);
          maxS = 1;
        }
        const s = clamp(Math.min(view.w / F.w, view.h / F.h), 0.1, maxS);
        this.cams[si] = { cx: F.x + F.w / 2, cy: F.y + F.h / 2, s };
        const cut = new Set<string>();
        if (st.focus) {
          const vw = view.w / s, vh = view.h / s, wx = F.x + F.w / 2 - vw / 2, wy = F.y + F.h / 2 - vh / 2, tol = 4;
          for (const id of st.visible) {
            const r = rect(id);
            if (r.x < wx - tol || r.y < wy - tol || r.x + r.w > wx + vw + tol || r.y + r.h > wy + vh + tol) cut.add(id);
          }
        }
        this.cut[si] = cut;
        const cg = new Set<number>();
        if (st.focus) {
          const vw = view.w / s, vh = view.h / s, wx = F.x + F.w / 2 - vw / 2, wy = F.y + F.h / 2 - vh / 2, tol = 4;
          this.grects[si]!.forEach((g, gi) => { const r = g.r; if (r.x < wx - tol || r.y < wy - tol || r.x + r.w > wx + vw + tol || r.y + r.h > wy + vh + tol) cg.add(gi); });
        }
        this.cutGroups[si] = cg;
      });
    }

    // ------------------------------------------------------------ public API
    go(i: number) { this.stop(); this.to(i); }
    next() { this.go(this.cur + 1); }
    prev() { this.go(this.cur - 1); }
    play() {
      if (this.playing) { this.stop(); return; }
      this.playing = true;
      if (this.cur >= N - 1) this.to(0);
      else this.stage.redraw();
    }
    focusTag(tagId: string | null) {
      const id = tagId === null ? null : resolveEntry(lgAll, tagId);
      if (tagId !== null && !id) return;
      const pins = id ? [id] : [];
      if (JSON.stringify(pins) === JSON.stringify(this.pins)) return;
      this.pins = pins;
      this.retarget(); this.stage.transition();
    }
    highlight(ids: string[] | null) {
      const keep = [...new Set((ids ?? []).filter((id) => EI.has(id)))];
      const had = this.pins.includes(HIGHLIGHT);
      // the ad-hoc entry lives in the entry list (pins and lighting treat it like any entry) but is never drawn in the strip
      const i = lgAll.findIndex((e) => e.id === HIGHLIGHT);
      if (i >= 0) lgAll.splice(i, 1);
      if (keep.length) lgAll.push(highlightEntry(keep));
      if (!keep.length && !had) return;
      this.stop();
      this.pins = keep.length ? [HIGHLIGHT] : this.pins.filter((p) => p !== HIGHLIGHT);
      this.retarget(); this.stage.transition();
    }
    describe(): PlateOutline {
      return {
        kind: 'explainer', title,
        nodes: els.map((e) => ({ id: e.id, label: e.label ?? e.id, group: e.group ?? null, category: e.category ?? null, tags: [...(e.tags ?? [])] })),
        groups: groups.map((g) => ({ id: g.id, label: g.label ?? g.id })),
        tags: outlineTags(lgAll),
        steps: steps.map((s) => s.title),
        stepMembers: steps.map((s) => [...s.visible]),
      };
    }
    private togglePin(id: string) {
      if (!lgEntry(id)) return;
      this.stop();
      this.pins = this.pins.includes(id) ? this.pins.filter((p) => p !== id) : [...this.pins, id];
      this.retarget(); this.stage.transition();
    }
    private resetLayout() {
      if (!Object.keys(this.moved).length) return;
      this.moved = {}; saveMoved(this.moved);
      this.stage.viewport.focus({ preventScroll: true });   // the button hides itself: keep the keys on the plate
      this.plan(); this.retarget(); this.stage.transition();
    }
    setBench(on: boolean) { if (!on && this.drag) { this.drag = null; } }
    lint(): string[] {
      const out: string[] = [];
      const st = steps[this.cur]!, where = `step ${this.cur + 1}`;
      const vr = { x: view.x - 2, y: view.y - 2, w: view.w + 4, h: view.h + 4 };
      const boxes: { id: string; b: Rect }[] = [];
      els.forEach((e, ei) => {
        if (!st.visible.has(e.id)) return;
        const b = this.$(`#e${ei}`).bounds();
        boxes.push({ id: e.id, b });
        const n = this.stage.dom.querySelector<HTMLElement>(`#e${ei}`)!;
        const inner = [...n.children].reduce((m, c) => Math.max(m, (c as HTMLElement).offsetTop + (c as HTMLElement).offsetHeight, (c as HTMLElement).scrollHeight ?? 0), 0);
        if (inner > n.clientHeight + 2 || n.scrollWidth > n.clientWidth + 2) out.push(`${where}: "${e.id}" content is bigger than its box (${this.size[ei]!.w}×${this.size[ei]!.h}); raise at.w / at.h or shorten it`);
        if (this.charts[ei]) out.push(...this.charts[ei]!.lint(e.id).map((m) => `${where}: ${m}`));
        if (!st.focus && (b.x < vr.x || b.y < vr.y || b.x + b.w > vr.x + vr.w || b.y + b.h > vr.y + vr.h)) out.push(`${where}: "${e.id}" is cut off by the edge of the board`);
      });
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!.b, b = boxes[j]!.b;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 6 && oy > 6) out.push(`${where}: "${boxes[i]!.id}" and "${boxes[j]!.id}" overlap`);
      }
      const pane = this.stage.dom.querySelector<HTMLElement>(`#t${this.cur}`);
      if (pane && narr && pane.offsetHeight > narr.h + 1) out.push(`${where}: the narration is taller than its panel (${pane.offsetHeight} > ${narr.h} px); shorten the text`);
      return out;
    }

    // ------------------------------------------------------------ state
    private to(i: number) {
      i = clamp(Math.round(i), 0, N - 1);
      if (i === this.cur) return;
      this.cur = i;
      this.retarget();
      this.syncA11y();
      this.stage.transition();
    }
    private stop() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = 0;
      if (this.playing) { this.playing = false; this.stage.redraw(); }
    }
    private playNext() {
      this.timer = 0;
      if (!this.playing) return;
      if (this.cur >= N - 1) { this.stop(); return; }
      this.to(this.cur + 1);
    }
    /** Hidden elements leave the tab order and the accessibility tree. */
    private syncA11y() {
      const st = steps[this.cur]!;
      els.forEach((e, ei) => {
        const n = this.stage.dom.querySelector<HTMLElement>(`#e${ei}`);
        if (!n) return;
        const on = st.visible.has(e.id);
        n.tabIndex = on ? 0 : -1;
        if (on) n.removeAttribute('aria-hidden'); else n.setAttribute('aria-hidden', 'true');
      });
    }

    /** The legend entries lighting the plate now (the hovered one wins over the pins), and their categories. */
    private legendOn(): string[] { return this.lgHover ? [this.lgHover] : this.pins; }
    private legendCats(): string[] { return [...new Set(this.legendOn().flatMap(catIdsOf))]; }
    /** The elements the given legend entries light at step si: their members, except that a chart in a category
     *  only through its series counts when the step shows one of them (its series light; the chart isn't outlined). */
    private legendSet(entries: string[], si: number): Set<string> | null {
      if (!entries.length) return null;
      const set = new Set(entries.flatMap((id) => lgEntry(id)?.members ?? []));
      const cats = [...new Set(entries.flatMap(catIdsOf))];
      if (cats.length) els.forEach((e, ei) => {
        if (!chartKind[ei] || !set.has(e.id) || (e.category && cats.includes(e.category))) return;
        const other = entries.some((id) => !id.startsWith('cat:') && lgEntry(id)?.members.includes(e.id));
        if (!other && !legendParts(ei, si, cats)) set.delete(e.id);
      });
      return set;
    }
    /** Is this chart lit by the legend through its own series (so its parts carry the highlight, not an outline)? */
    private litByParts(ei: number): boolean {
      const e = els[ei]!, cats = this.legendCats();
      return !!legendParts(ei, this.cur, cats) && !(e.category && cats.includes(e.category));
    }

    /** The resting layout of the current step. */
    private targets() {
      const m = new Map<string, Vals>(), c = this.cur, st = steps[c]!;
      const pinned = this.legendSet(this.pins, this.cur);
      m.set('cam', { ...this.cams[c]! });
      m.set('mk', { x: sx(c) });
      steps.forEach((_, i) => {
        m.set(`s${i}`, { o: i <= c ? 1 : 0.55, lit: i === c ? 1 : 0 });
        m.set(`t${i}`, { x: i === c ? 0 : Math.sign(i - c) * 28, o: i === c ? 1 : 0 });
      });
      els.forEach((e, ei) => {
        const p = this.pos[c]!.get(e.id) ?? { x: 0, y: 0 };
        const shown = st.visible.has(e.id) ? (this.cut[c]!.has(e.id) ? 0.12 : 1) : 0;
        m.set(`e${ei}`, { x: p.x, y: p.y, o: shown, dim: st.dim.has(e.id) ? 1 : 0, lit: st.emph.has(e.id) ? 1 : 0, pin: pinned ? (pinned.has(e.id) ? 0 : 1) : 0, hl: pinned?.has(e.id) ? 1 : 0 });
        const props = propsAt(ei, c);
        for (const k of tween[ei]!.all) { const v = props[k]; if (typeof v === 'number' && Number.isFinite(v)) m.set(`n${ei}:${k}`, { v }); }
        m.set(`w${ei}`, { k: 1 });
      });
      groups.forEach((_, gi) => { const g = this.grects[c]![gi]!; m.set(`g${gi}`, { ...g.r, o: g.on ? (this.cutGroups[c]!.has(gi) ? 0.12 : 1) : 0 }); });
      links.forEach((l, li) => m.set(`l${li}`, { o: st.links.includes(l.id) ? (this.cut[c]!.has(l.from) || this.cut[c]!.has(l.to) ? 0.12 : 1) : 0, d: 1, pk: pinned && pinned.has(l.from) && pinned.has(l.to) ? 1 : 0 }));
      return m;
    }
    /** From what is on screen now to the current step: arriving elements rise and fade in where they
     *  land (their numbers count from 0, their paths draw), leaving ones fade where they are, new links
     *  draw on, everything else glides. */
    private retarget() {
      const to = this.targets(), from = new Map<string, Vals>();
      const arriving = new Set<number>();
      els.forEach((_, ei) => { const cur = this.val(`e${ei}`), tv = to.get(`e${ei}`)!; if (tv.o! > 0 && (!cur || cur.o! < 0.02)) arriving.add(ei); });
      for (const [key, tv] of to) {
        const cur = this.val(key);
        if (!cur) { from.set(key, tv); continue; }
        const k0 = key[0];
        if (k0 === 'e') {
          if (arriving.has(+key.slice(1))) { from.set(key, { ...tv, y: tv.y! + RISE, o: 0, lit: 0 }); continue; }
          if (tv.o === 0) to.set(key, { ...tv, x: cur.x!, y: cur.y! });
        } else if (k0 === 'g') {
          if (tv.o! > 0 && cur.o! < 0.02) { from.set(key, { ...tv, o: 0 }); continue; }
          if (tv.o === 0) to.set(key, { ...cur, o: 0 });
        } else if (k0 === 'l') {
          if (tv.o! > 0 && cur.o! < 0.02) { from.set(key, { o: 1, d: 0, pk: tv.pk! }); continue; }
          if (tv.o === 0) to.set(key, { o: 0, d: cur.d!, pk: cur.pk ?? 0 });
        } else if (k0 === 'n') {
          const [eis, prop] = key.slice(1).split(':') as [string, string];
          if (arriving.has(+eis) && tween[+eis]!.count.has(prop)) { from.set(key, { v: 0 }); continue; }
        } else if (k0 === 'w') {
          if (arriving.has(+key.slice(1))) { from.set(key, { k: 0 }); continue; }
        }
        from.set(key, cur);
      }
      const m = new Morph();
      m.snap(from); m.retarget(to);
      this.morph = m;
      const cats = this.legendCats();
      this.charts.forEach((c, ei) => c?.retarget(frameAt(ei, this.cur, cats), arriving.has(ei)));
    }

    getState() { return { step: this.cur, pins: [...this.pins], hover: this.lgHover }; }
    setState(st: unknown) {
      const v = (st ?? {}) as { step?: number; pins?: string[]; hover?: string | null };
      this.stop();
      // as if navigated from step 1: start there, then transition into the state
      this.cur = 0; this.pins = []; this.lgHover = null;
      this.morph = new Morph();
      this.morph.snap(this.targets());
      this.charts.forEach((c, ei) => c?.snap(frameAt(ei, 0)));
      this.cur = clamp(Math.round(v.step ?? 0), 0, N - 1);
      this.pins = (Array.isArray(v.pins) ? v.pins : []).map((p) => resolveEntry(lgAll, String(p))).filter((p): p is string => !!p);
      this.lgHover = v.hover ? resolveEntry(lgAll, v.hover) : null;
      this.retarget();
      this.syncA11y();
    }
    states() {
      const out: { name: string; state: unknown }[] = steps.map((_, i) => ({ name: `step-${i + 1}`, state: { step: i } }));
      // each tag pinned on the step that shows most of its elements (stills of the legend)
      const best = (e: LegendEntry) => steps.map((s, i) => ({ i, n: e.members.filter((m) => s.visible.has(m)).length })).sort((a, b) => b.n - a.n || b.i - a.i)[0]!.i;
      for (const e of lgTags.filter((x) => x.members.length)) out.push({ name: `legend-pin-${e.id.slice(4)}`, state: { step: best(e), pins: [e.id] } });
      const cat = lgCats.find((x) => x.members.length);
      if (cat) out.push({ name: `legend-hover-${cat.id.slice(4)}`, state: { step: best(cat), hover: cat.id } });
      return out;
    }

    /** Key help (docs/ENGINE.md "Key help"): what `onKey` does right now. */
    keys(): KeyHelp[] {
      const S = 'Steps';
      if (this.playing) return [{ group: S, keys: 'any key', gesture: true, does: 'stop playing' }];
      const first = this.cur === 0, last = this.cur === N - 1, n = Math.min(9, N), out: KeyHelp[] = [];
      if (N > 1) {
        out.push({ group: S, keys: ['→', 'j', 'Enter'], does: 'next step', ...(last ? { off: true, when: 'before the last step' } : {}) });
        out.push({ group: S, keys: ['←', 'k'], does: 'previous step', ...(first ? { off: true, when: 'after the first step' } : {}) });
        out.push({ group: S, keys: 'Home', does: 'the first step', ...(first ? { off: true, when: 'after the first step' } : {}) });
        out.push({ group: S, keys: 'End', does: 'the last step', ...(last ? { off: true, when: 'before the last step' } : {}) });
        out.push({ group: S, keys: `1–${n}`, does: `go to step 1–${n}` });
        out.push({ group: S, keys: 'p', does: last ? 'play from the start' : 'play from here' });
      }
      if (this.pins.length) out.push({ group: 'Legend', keys: 'Esc', does: 'clear the pinned legend entries' });
      return out;
    }
    onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      const k = e.key;
      if (this.playing) {
        this.stop();
        return k !== 'f' && k !== 'Escape';   // any key stops play; f and Esc still reach the theater
      }
      if ((k === 'Enter' || k === ' ') && (e.target as HTMLElement).closest?.('button')) return false;
      if (k === 'Escape' && this.pins.length) { this.pins = []; this.retarget(); this.stage.transition(); return true; }
      if (k === 'ArrowRight' || k === 'j' || k === 'Enter') this.to(this.cur + 1);
      else if (k === 'ArrowLeft' || k === 'k') this.to(this.cur - 1);
      else if (k === 'Home') this.to(0);
      else if (k === 'End') this.to(N - 1);
      else if (/^[1-9]$/.test(k)) { if (+k <= N) this.to(+k - 1); }
      else if (k === 'p' && N > 1) this.play();
      else return false;                      // Esc included: falls through to the theater
      return true;
    }

    // ------------------------------------------------------------ frame
    /** A key's value at the current progress: positions and the camera on the main curve; leaving
     *  things fade early, arriving ones late; links draw and numbers count in the second half. */
    private val(key: string): Vals | undefined {
      const k0 = key[0], tgt = this.morph.target(key);
      if (!tgt) return undefined;
      const at = (k: number) => { this.morph.progress(k); return this.morph.value(key)!; };
      let v: Vals;
      if (k0 === 'e' || k0 === 'g') v = { ...at(this.kk.main), o: at(tgt.o === 0 ? this.kk.out : this.kk.in).o! };
      else if (k0 === 't') v = at(tgt.o === 0 ? this.kk.out : this.kk.in);
      else if (k0 === 'l') v = tgt.o === 0 ? at(this.kk.out) : at(this.kk.draw);
      else if (k0 === 'w') v = at(this.kk.draw);
      else if (k0 === 'n') v = at(this.kk.count);
      else v = at(this.kk.main);
      this.morph.progress(this.kk.main);
      return v;
    }

    /** Swap in the current step's HTML for elements whose (non-numeric) props changed. */
    private syncVariants() {
      els.forEach((_, ei) => {
        const want = variants[ei]![this.cur]!;
        if (this.shown[ei] === want) return;
        const n = this.stage.dom.querySelector<HTMLElement>(`#e${ei}`)!;
        n.innerHTML = want;
        applyCode(n);
        this.hooks[ei] = collectHooks(n);
        this.shown[ei] = want;
        if (this.charts[ei]) this.attachChart(ei, n);
      });
    }

    update(f: Frame) {
      const p = clamp(f.t / f.duration);
      this.kk = { main: ease.outCubic(p), out: ease.inOutCubic(clamp(p / 0.45)), in: ease.outCubic(clamp((p - 0.3) / 0.7)), draw: ease.inOutCubic(clamp((p - 0.4) / 0.6)), count: ease.inOutCubic(clamp((p - 0.25) / 0.75)) };
      this.morph.progress(this.kk.main);
      this.syncVariants();

      const cam = this.val('cam')!;
      const s = cam.s!, tx = s * (view.w / 2 - cam.cx!), ty = s * (view.h / 2 - cam.cy!);
      this.camNow = { s, tx, ty };
      this.$('#kx-cam').set({ x: tx, y: ty, scale: s });

      const rects: Rect[] = [];
      const lgh = this.lgHover ? this.legendSet([this.lgHover], this.cur) : null;
      const lgCats = this.legendCats();
      els.forEach((e, ei) => {
        const v = { ...this.val(`e${ei}`)! }, n = this.$(`#e${ei}`);
        const dragging = this.drag?.ei === ei;
        if (dragging) { v.x = this.drag!.cur.x; v.y = this.drag!.cur.y; }
        // a legend highlight: its members as they are, the rest faded (hover at once, pins through the transition)
        const hlk = lgh ? (lgh.has(e.id) ? 1 : 1 - DIM_LEGEND) : 1 - DIM_PIN * (v.pin ?? 0);
        n.set({ x: v.x!, y: v.y!, opacity: v.o! * (1 - 0.68 * v.dim!) * (dragging ? 1 : hlk) });
        n.classes['is-drag'] = dragging;
        n.hidden = v.o! < 0.004;
        n.classes['is-lit'] = v.lit! > 0.5;
        // how lit, through the transition: a theme may ramp its light with it (unused by the rest)
        n.vars['--kx-lit'] = String(Math.round(v.lit! * 100) / 100);
        n.classes['is-dim'] = v.dim! > 0.5;
        rects[ei] = { x: v.x!, y: v.y!, w: this.size[ei]!.w, h: this.size[ei]!.h };
        const hk = this.hooks[ei]!;
        const num = (x: string) => (/^-?[\d.]+$/.test(x) ? +x : this.val(`n${ei}:${x}`)?.v ?? (typeof propsAt(ei, this.cur)[x] === 'number' ? propsAt(ei, this.cur)[x] as number : NaN));
        for (const h of hk.nums) {
          const nv = this.val(`n${ei}:${h.prop}`);
          if (!nv) continue;
          const txt = fmtNum(nv.v!, h.dec ?? decs[ei]![h.prop] ?? 0, h.group);
          if (h.el.textContent !== txt) h.el.textContent = txt;
        }
        for (const h of hk.scales) {
          const a = num(h.a), b = num(h.b), k = String(Math.round(clamp(b ? a / b : 0) * 10000) / 10000);
          if (h.el.style.getPropertyValue('--k') !== k) h.el.style.setProperty('--k', k);
        }
        if (hk.draws.length) {
          const off = String(Math.round((1 - (this.val(`w${ei}`)?.k ?? 1)) * 10000) / 10000);
          for (const d of hk.draws) if (d.style.strokeDashoffset !== off) d.style.strokeDashoffset = off;
        }
        if (this.charts[ei] && v.o! >= 0.004) {
          // a hovered legend category lights its series at once (a pin retargets, so it tweens)
          const want = frameAt(ei, this.cur, lgCats);
          if (this.charts[ei]!.target !== want) this.charts[ei]!.snap(want);
          this.charts[ei]!.render(this.kk.count);
        }
      });

      groups.forEach((_, gi) => {
        const v = this.val(`g${gi}`)!, n = this.$(`#g${gi}`);
        n.set({ x: v.x!, y: v.y!, opacity: v.o! });
        n.hidden = v.o! < 0.004;
        n.vars['--gw'] = v.w!.toFixed(1);
        n.vars['--gh'] = v.h!.toFixed(1);
      });

      const st = steps[this.cur]!;
      links.forEach((l, li) => {
        const v = this.val(`l${li}`)!;
        const a = rects[EI.get(l.from)!]!, b = rects[EI.get(l.to)!]!;
        this.routes[li] = v.o! > 0.004 ? route(a, b) : null;
        if (!l.label) return;
        const n = this.$(`#l${li}`), r = this.routes[li];
        if (!r) { n.hidden = true; return; }
        const mid = r.at(0.5), sz = this.labelSize[li]!;
        n.set({ x: mid.x - sz.w / 2, y: mid.y - sz.h / 2, opacity: v.o! * clamp((v.d! - 0.55) / 0.45) });
        n.hidden = v.o! * v.d! < 0.3;
        n.classes['is-lit'] = l.style === 'accent' || st.emph.has(l.from) || st.emph.has(l.to);
        n.classes['is-warn'] = l.style === 'warn';
      });

      if (hasTimeline) {
        const mk = this.val('mk')!.x!;
        this.$('#kx-marker').x = mk;
        steps.forEach((_, i) => {
          const v = this.val(`s${i}`)!, n = this.$(`#st${i}`);
          n.opacity = v.o!;
          n.classes['is-cur'] = v.lit! > 0.5;
          n.classes['is-past'] = mk > sx(i) + 1 && v.lit! <= 0.5;
        });
      }
      if (narr) steps.forEach((_, i) => {
        const w = this.val(`t${i}`)!, n = this.$(`#t${i}`);
        n.set({ x: w.x!, opacity: w.o! });
        n.hidden = w.o! < 0.004;
      });
      const rb = this.stage.dom.querySelector<HTMLButtonElement>('#kx-reset')!;
      const showReset = this.stage.inBench && Object.keys(this.moved).length > 0;
      if (rb.hidden === showReset) rb.hidden = !showReset;
      this.legend?.sync({ pins: this.pins, hover: this.lgHover, picked: 0, editable: false });
      if (N > 1) {
        this.$('#kx-play').text = this.playing ? 'Stop' : 'Play';
        this.$('#kx-play').classes['is-on'] = this.playing;
        this.$('#kx-prev').opacity = this.cur === 0 ? 0.4 : 1;
        this.$('#kx-next').opacity = this.cur === N - 1 ? 0.4 : 1;
      }
      const where = N > 1 ? `step ${this.cur + 1} of ${N}` : '';
      const theater = this.stage.inTheater ? 'Esc leave theater' : 'f theater';
      const hv = lgEntry(this.lgHover);
      const pinTxt = this.pins.length ? `pinned ${this.pins.map((p) => lgEntry(p)?.name).join(' + ')} · Esc clears · ` : '';
      this.$('#kx-mode').text = this.drag ? `moving ${labelOf(this.drag.ei)} — it keeps this place on every step until Reset layout`
        : hv ? `lighting “${hv.name}” (${hv.members.length}) — click to ${this.pins.includes(hv.id) ? 'unpin' : 'pin'} it`
        : this.playing ? `playing · ${where} · any key or click stops`
        : `${pinTxt}${N > 1 ? `${where} · ←/→ step · p play · ` : ''}${this.stage.inBench ? 'bench: drag elements · b leaves · ' : ''}${theater}`;
    }

    draw(f: Frame, fx: Fx) {
      const Ln = fx.under.lines, bg = fx.under.bg, th = f.theme;
      bg.pattern = 'dots'; bg.patternAlpha = 0.18;
      if (this.radius.theme !== th.name) this.radius = { theme: th.name, r: parseFloat(getComputedStyle(this.stage.root).getPropertyValue('--pl-radius')) || 0 };

      if (hasTimeline && N > 1) {
        // the step rail is chrome: its fx go on the chrome's layer (docs/ENGINE.md "Zoom and pan")
        const mk = this.val('mk')!.x!, Lr = fx.front.lines;
        Lr.seg(X0, TY, X1, TY, { color: 'line', width: 2 });
        if (mk > X0) Lr.seg(X0, TY, mk, TY, { color: 'accent', width: 2.4, glow: 1.2 });
        fx.front.bg.light(mk, TY, 46, 0.3, th.accent);
      }

      const { s, tx, ty } = this.camNow;
      const map = (q: P): P => ({ x: view.x + view.w / 2 + s * (q.x - view.w / 2) + tx, y: view.y + view.h / 2 + s * (q.y - view.h / 2) + ty });
      const st = steps[this.cur]!;
      const lgh = this.lgHover ? this.legendSet([this.lgHover], this.cur) : null;

      links.forEach((l, li) => {
        const r = this.routes[li];
        if (!r) return;
        const v = this.val(`l${li}`)!;
        if (v.o! < 0.01 || v.d! < 0.002) return;
        const ea = this.val(`e${EI.get(l.from)}`)!, eb = this.val(`e${EI.get(l.to)}`)!;
        // legend highlight: links between two lit members light; the others fade with their ends
        const hlk = lgh ? (lgh.has(l.from) && lgh.has(l.to) ? 1 : 0) : v.pk ?? 0;
        const fade = lgh ? (hlk ? 1 : 1 - DIM_LEGEND) : 1 - DIM_PIN * Math.max(ea.pin ?? 0, eb.pin ?? 0) * (1 - hlk);
        const lit = Math.max(ea.lit!, eb.lit!, hlk);
        const dimk = (1 - 0.6 * Math.max(ea.dim!, eb.dim!) * (1 - lit)) * fade;
        const style = l.style ?? 'solid', strong = style === 'accent' || style === 'warn';
        const base = style === 'accent' ? th.accent : style === 'warn' ? th.accent2 : th.muted;
        const col = strong ? base : mix(base, th.accent, lit * 0.9);
        const width = strong ? 2.2 : 1.6 + 0.4 * lit, alpha = v.o! * dimk * (strong ? 1 : 0.85 + 0.15 * lit);
        const pts = (v.d! >= 1 ? r : r.slice(0, v.d!)).pts.map(map);
        if (pts.length < 2) return;
        for (const run of clipRuns(pts, view)) {
          const path = new Path(run);
          if (style === 'dashed') Ln.dashes(path, { dash: 7, gap: 6, color: col, width, alpha });
          else Ln.path(path, { color: col, width, alpha, glow: strong ? 1.3 : lit });
        }
        const end = new Path(pts).at(0.999);
        const ak = clamp((v.d! - 0.82) / 0.18);
        if (ak > 0 && inside(end, view)) Ln.arrow(end, end.angle, 7 + 1.5 * Math.min(1, s), { color: col, width: Math.min(width, 1.8), alpha: alpha * ak });
      });

      els.forEach((e, ei) => {
        const v = this.val(`e${ei}`)!;
        const o = v.o!;
        // a legend highlight draws a quiet outline (no light) around each member
        const hl = (lgh ? (lgh.has(e.id) ? 1 : 0) : v.hl ?? 0) * (this.litByParts(ei) ? 0 : 1);
        if (hl * o > 0.01 && v.lit! < 0.5) {
          const b = this.$(`#e${ei}`).bounds(5);
          const path = this.radius.r ? rrectPath(b.x, b.y, b.w, b.h, this.radius.r + 3) : new Path([{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }, { x: b.x, y: b.y }]);
          for (const run of clipRuns(path.pts, view)) Ln.polyline(run, { color: 'accent', width: 1.2, alpha: o * hl * 0.75 });
        }
        // a legend highlight fades the step's own emphasis on the elements it leaves out
        const fadeK = lgh ? (lgh.has(e.id) ? 1 : 1 - DIM_LEGEND) : 1 - DIM_PIN * (v.pin ?? 0);
        const lit = v.lit!;
        if (lit * o * fadeK < 0.01) return;
        const b = this.$(`#e${ei}`).bounds(6);
        const path = this.radius.r ? rrectPath(b.x, b.y, b.w, b.h, this.radius.r + 4)
          : new Path([{ x: b.x + b.w / 2, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }, { x: b.x, y: b.y }, { x: b.x + b.w / 2, y: b.y }]);
        const part = lit >= 1 ? path : path.slice(0, lit);
        for (const run of clipRuns(part.pts, view)) Ln.polyline(run, { color: 'accent', width: 1.5, alpha: o * 0.9 * fadeK, glow: 1.2 * fadeK });
        const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        if (inside(c, view) && st.visible.has(e.id)) bg.light(c.x, c.y, Math.max(b.w, b.h) * 0.55, 0.26 * lit * o * fadeK, th.accent);
      });
    }
  };
}
