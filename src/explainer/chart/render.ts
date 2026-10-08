// A chart frame (data.ts, tween.ts) at a pixel size → one SVG string, plus the geometry hover needs. Pure:
// text is measured through the `measure` the caller passes (a canvas in the browser, an estimate in tests),
// so a frame always renders to the same string. Colours are classes over theme tokens (CHART_CSS): series
// take --pl-cat-<slot>, ink and grid take --pl-fg / --pl-muted / --pl-line, the ring and gap take --pl-card.
// Marks follow the usual quiet specs: hairline grid, 2px lines, bars capped in thickness with a rounded data
// end, a 2px surface gap between stacked segments, end dots with a surface ring, text never in series colour.
import { esc } from '../template';
import { bands, linear, points, timeTicks } from './scale';
import { decimalsOf, formatDate, formatNumber, formatValue, type FormatOpts } from './format';
import type { Annot, Frame, Item } from './data';

export type Measure = (text: string, size: number, weight?: number) => number;
/** A rough width (no DOM): what tests and tools use. */
export const estimate: Measure = (t, size, weight = 400) => [...t].reduce((a, c) => a + (/[\d]/.test(c) ? 0.56 : /[ il.,:;'|!]/.test(c) ? 0.28 : /[mwMW@%]/.test(c) ? 0.84 : /[A-Z]/.test(c) ? 0.66 : 0.52), 0) * size * (weight >= 600 ? 1.06 : 1);

/** What the pointer is over (interactive only): an x index, a bar (series and x) or a slice. */
export interface Hover { x?: number; s?: number }
/** Hover geometry of the last render (chart px). */
export interface Hit {
  kind: Frame['o']['kind'];
  /** line / sparkline: each x's position (horizontal), for the crosshair. */
  xs?: number[];
  /** bars: each bar's box, with its series and x index. */
  bars?: { x: number; y: number; w: number; h: number; s: number; i: number }[];
  /** donut: the centre, radii and each slice's angles (radians from 12 o'clock, clockwise). */
  arcs?: { cx: number; cy: number; r0: number; r1: number; a: [number, number, number][] };
  plot?: { x: number; y: number; w: number; h: number };
}
export interface Rendered { svg: string; hit: Hit }

const F = { tick: 12.5, legend: 13, value: 12.5, note: 12, big: 26 } as const;
const r1 = (v: number) => Math.round(v * 10) / 10;
const op = (a: number) => (a >= 0.999 ? '' : ` opacity="${Math.max(0, Math.round(a * 1000) / 1000)}"`);
const T = (x: number, y: number, s: string, cls: string, extra = '') => `<text x="${r1(x)}" y="${r1(y)}" class="${cls}"${extra}>${esc(s)}</text>`;
const cc = (slot: number) => `c${slot}`;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

/** A box with a rounded data end (radius up to rr) on one side: 't' top, 'b' bottom, 'r' right, 'l' left, '' none. */
function barPath(x: number, y: number, w: number, h: number, end: 't' | 'b' | 'r' | 'l' | '', rr = 4): string {
  if (w <= 0.05 || h <= 0.05) return '';
  const v = end === 't' || end === 'b', r = end ? r1(Math.min(rr, v ? w / 2 : h / 2, v ? h : w)) : 0;
  // corner radii clockwise from the top left
  const [a, b, c, d] = end === 't' ? [r, r, 0, 0] : end === 'b' ? [0, 0, r, r] : end === 'r' ? [0, r, r, 0] : end === 'l' ? [r, 0, 0, r] : [0, 0, 0, 0];
  const [X, Y, R, B] = [x, y, x + w, y + h].map(r1) as [number, number, number, number];
  const q = (k: number, cx: number, cy: number, ex: number, ey: number) => (k ? `Q${cx} ${cy} ${r1(ex)} ${r1(ey)}` : '');
  return `M${r1(X + a)} ${Y}H${r1(R - b)}${q(b, R, Y, R, Y + b)}V${r1(B - c)}${q(c, R, B, R - c, B)}H${r1(X + d)}${q(d, X, B, X, B - d)}V${r1(Y + a)}${q(a, X, Y, X + a, Y)}Z`;
}

/** Spread labels (centre y each) at least `gap` apart inside [lo, hi], each as near its own y as it can be:
 *  overlapping labels merge into runs centred on their members' mean. Returns the new centres, in input order. */
export function dodge(ys: number[], gap: number, lo: number, hi: number): number[] {
  const idx = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  type Run = { sum: number; n: number; top: number };
  const runs: Run[] = [];
  for (const o of idx) {
    runs.push({ sum: o.y, n: 1, top: o.y });
    // merge while the last run overlaps the one before it
    while (runs.length > 1) {
      const b = runs[runs.length - 1]!, a = runs[runs.length - 2]!;
      if (a.top + a.n * gap <= b.top + 1e-9) break;
      const m: Run = { sum: a.sum + b.sum, n: a.n + b.n, top: 0 };
      m.top = m.sum / m.n - ((m.n - 1) * gap) / 2;
      runs.splice(-2, 2, m);
    }
  }
  // keep every run inside the bounds (from the bottom, then the top wins)
  let floor = hi + gap;   // the last centre may sit at hi
  for (let r = runs.length - 1; r >= 0; r--) { const x = runs[r]!; x.top = Math.min(x.top, floor - x.n * gap); floor = x.top; }
  let ceil = lo;
  for (const x of runs) { x.top = Math.max(x.top, ceil); ceil = x.top + x.n * gap; }
  const res: number[] = [];
  let j = 0;
  for (const x of runs) for (let k = 0; k < x.n; k++, j++) res[idx[j]!.i] = x.top + k * gap;
  return res;
}

/** Tick format: the prefix and symbol units on the ticks, a word unit as the axis title. */
function tickFmt(fmt: FormatOpts, vals: number[]): { f: FormatOpts; title: string } {
  const word = !!fmt.unit && /^[A-Za-z]/.test(fmt.unit);
  const dec = fmt.format === 'percent' ? Math.max(0, ...vals.map((v) => decimalsOf(v * 100, 2))) : fmt.format === 'compact' ? undefined : Math.max(0, ...vals.map((v) => decimalsOf(v, 4)));
  return { f: { ...fmt, ...(dec === undefined ? {} : { decimals: dec }), unit: word ? '' : fmt.unit }, title: word ? fmt.unit! : '' };
}

/** Per mark: how far a highlight or an explicit dim fades it (1 = as is). */
function alphaOf(n: Frame['n'], any: number, s: string, x: string | null, line: boolean): number {
  const own = Math.max(n[`hs:${s}`] ?? 0, x === null || line ? 0 : Math.max(n[`hx:${x}`] ?? 0, n[`hp:${s}|${x}`] ?? 0));
  const dim = Math.max(n[`ds:${s}`] ?? 0, x === null ? 0 : Math.max(n[`dx:${x}`] ?? 0, n[`dp:${s}|${x}`] ?? 0));
  return (1 - 0.56 * clamp(any - own)) * (1 - 0.56 * dim);
}
/** Text beside a dimmed mark fades less than the mark, so it stays readable (AA on the card): ink text keeps at
 *  least ~70%, muted text ~88%. */
const ta = (a: number, muted = false) => 1 - (1 - a) * (muted ? 0.27 : 0.68);

export function renderChart(fr: Frame, W: number, H: number, measure: Measure = estimate, hover: Hover | null = null): Rendered {
  if (!(W > 4 && H > 4)) return { svg: '', hit: { kind: fr.o.kind } };
  const body = fr.o.kind === 'donut' ? donut(fr, W, H, measure, hover) : fr.o.kind === 'sparkline' ? spark(fr, W, H, hover) : cartesian(fr, W, H, measure, hover);
  return { svg: `<svg class="kch-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">${body.svg}</svg>`, hit: body.hit };
}

// ------------------------------------------------------------------ line and bars

function legendRow(items: { label: string; slot: number; a: number; p: number }[], line: boolean, x0: number, x1: number, y: number, measure: Measure): { svg: string; rows: number } {
  // right-aligned rows that wrap
  const w = items.map((it) => 16 + measure(it.label, F.legend)), rows: number[][] = [[]];
  let used = 0;
  items.forEach((_, i) => { const need = w[i]! + (rows[rows.length - 1]!.length ? 14 : 0); if (used + need > x1 - x0 && rows[rows.length - 1]!.length) { rows.push([]); used = 0; } rows[rows.length - 1]!.push(i); used += w[i]! + (rows[rows.length - 1]!.length > 1 ? 14 : 0); });
  let svg = '';
  rows.forEach((row, ri) => {
    const total = row.reduce((a, i, j) => a + w[i]! + (j ? 14 : 0), 0);
    let x = x1 - total;
    const cy = y + ri * 18 + 9;
    for (const i of row) {
      const it = items[i]!;
      svg += `<g class="${cc(it.slot)}">${line ? `<path class="kch-key" d="M${r1(x)} ${r1(cy)}h11"${op(it.a)}/>` : `<rect class="kch-sw" x="${r1(x)}" y="${r1(cy - 5)}" width="10" height="10" rx="2"${op(it.a)}/>`}${T(x + 16, cy + 4.2, it.label, 'kch-lg', op(it.p * ta(it.a / (it.p || 1))))}</g>`;
      x += w[i]! + 14;
    }
  });
  return { svg, rows: rows.length };
}

function cartesian(fr: Frame, W: number, H: number, measure: Measure, hover: Hover | null): Rendered {
  const { o, n } = fr, line = o.kind === 'line', hz = o.horizontal;
  const y0 = n.y0!, y1 = n.y1!;
  const series = fr.s, sp = series.map((s) => n[`p:${s.k}`] ?? 0);
  const xq = fr.x.map((x) => n[`q:${x.k}`] ?? 0);
  const any = Math.max(0, ...Object.keys(n).filter((k) => k.startsWith('hs:') || (!line && (k.startsWith('hx:') || k.startsWith('hp:')))).map((k) => n[k]!));
  const visTicks = fr.ty.filter((v) => (n[`ty:${v}`] ?? 0) > 0.01 && v >= Math.min(y0, y1) - 1e-9 && v <= Math.max(y0, y1) + 1e-9);
  const tf = tickFmt(o.fmt, fr.ty.filter((v) => (n[`ty:${v}`] ?? 0) > 0.5));
  const label = (v: number) => formatNumber(v, tf.f);
  let out = '';
  // header: the axis title (a word unit) on the left, the legend (two series or more) on the right
  const showLegend = series.filter((_, i) => sp[i]! > 0.01).length > 1 || (series.length > 1 && sp.some((p) => p > 0.01));
  const titleW = tf.title ? measure(tf.title, F.note) + 16 : 0;
  let headH = 0;
  if (showLegend) {
    const lg = legendRow(series.map((s, i) => ({ label: s.label, slot: s.slot, a: sp[i]! * alphaOf(n, any, s.k, null, true), p: sp[i]! })), line, titleW, W, 0, measure);
    out += lg.svg; headH = lg.rows * 18 + 8;
  }
  if (tf.title) { out += T(0, 13, tf.title, 'kch-ax'); headH = Math.max(headH, 22); }
  // value labels at bar tips / line ends
  const xs = fr.x;
  const single = series.length === 1 || n.stk! > 0.5;
  const tipOn = !line && (o.labels === 'tip' || (o.labels === 'auto' && single && fr.x.length <= 12));
  const endOn = line && (o.labels === 'end' || (o.labels === 'auto' && series.length <= 4));
  const valText = (v: number) => formatNumber(v, { ...o.fmt, unit: tf.f.unit });
  const lastIdx = (s: Item) => { for (let i = xs.length - 1; i >= 0; i--) if (Number.isFinite(n[`v:${s.k}|${xs[i]!.k}`]!)) return i; return -1; };
  const endW = endOn ? Math.max(0, ...series.map((s) => { const i = lastIdx(s); return i < 0 ? 0 : measure(valText(n[`v:${s.k}|${xs[i]!.k}`]!), F.value, 600); })) + 12 : 0;
  // the value axis and the category axis
  const tickW = Math.max(0, ...visTicks.map((v) => measure(label(v), F.tick)));
  const catW = hz ? Math.min(W * 0.38, Math.max(0, ...xs.map((x) => measure(x.label, F.tick))) + 10) : 0;
  const tipW = hz && tipOn ? Math.max(0, ...xs.map((x) => measure(valText(stackTotal(fr, x.k)), F.value, 600))) + 8 : 0;
  const P = hz
    ? { x: catW, y: headH + 2, w: W - catW - Math.max(tipW, measure(label(visTicks[visTicks.length - 1] ?? 0), F.tick) / 2 + 2), h: H - headH - 2 - 20 }
    : { x: tickW + 10, y: headH + (tipOn ? 18 : 8), w: W - tickW - 10 - Math.max(endW, 4), h: H - headH - (tipOn ? 18 : 8) - 22 };
  if (P.w < 20 || P.h < 20) return { svg: out, hit: { kind: o.kind } };
  const vS = hz ? linear(y0, y1, P.x, P.x + P.w) : linear(y0, y1, P.y + P.h, P.y);
  const base = vS(clamp(0, Math.min(y0, y1), Math.max(y0, y1)));
  // grid and value ticks (crossfading as the domain changes)
  let grid = '', tl = '';
  const lastLab: number[] = [];
  for (const v of visTicks) {
    const a = n[`ty:${v}`]!, p = vS(v);
    grid += hz ? `<path class="kch-g" d="M${r1(p)} ${P.y}v${r1(P.h)}"${op(a)}/>` : `<path class="kch-g" d="M${P.x} ${r1(p)}h${r1(P.w)}"${op(a)}/>`;
    if (!hz) { if (lastLab.some((q) => Math.abs(q - p) < 15)) continue; lastLab.push(p); tl += T(P.x - 8, p + 4, label(v), 'kch-tk kch-end', op(a)); }
    else { if (lastLab.some((q) => Math.abs(q - p) < measure(label(v), F.tick) + 8)) continue; lastLab.push(p); tl += T(p, P.y + P.h + 16, label(v), 'kch-tk kch-mid', op(a)); }
  }
  out += grid;
  // annotations behind the marks: bands and reference lines
  const cat = catPos(fr, P, hz, line);
  const posOfX = (k: string | undefined) => (k === undefined ? NaN : o.xType === 'band' ? cat.pos[fr.x.findIndex((x) => x.k === k)] ?? NaN : NaN);
  const xLin = o.xType === 'band' ? null : linear(n.x0!, n.x1!, P.x + 5, P.x + P.w - 5);
  let notes = '';
  // a band or a rule across the plot: `alongY` = its positions are y (a horizontal strip or line)
  const mark = (alongY: boolean, p0: number, p1: number, band: boolean, label: string, a: number) => {
    if (!Number.isFinite(p0) || !Number.isFinite(p1)) return;
    if (p0 > p1) [p0, p1] = [p1, p0];
    out += band ? `<rect class="kch-band" ${alongY ? `x="${P.x}" y="${r1(p0)}" width="${r1(P.w)}" height="${r1(p1 - p0)}"` : `x="${r1(p0)}" y="${P.y}" width="${r1(p1 - p0)}" height="${r1(P.h)}"`}${op(a)}/>`
      : `<path class="kch-ref" d="${alongY ? `M${P.x} ${r1(p0)}h${r1(P.w)}` : `M${r1(p0)} ${P.y}v${r1(P.h)}`}"${op(a)}/>`;
    if (label) notes += alongY ? T(P.x + P.w - 4, band ? p0 + 14 : p0 - 16 < P.y ? p0 + 15 : p0 - 6, label, 'kch-note kch-end kch-halo', op(a)) : T(p0 + 5, P.y + 12, label, 'kch-note kch-halo', op(a));
  };
  for (const an of fr.a) {
    const a = n[`a:${an.k}`] ?? 0, band = an.type === 'band';
    if (a < 0.01 || an.type === 'callout') continue;
    if (an.axis === 'y') mark(!hz, vS(n[`a0:${an.k}`]!), vS(n[`a1:${an.k}`]!), band, an.label, a);
    else {
      const half = o.xType === 'band' && band ? cat.step / 2 : 0;
      const p0 = xLin ? xLin(n[`a0:${an.k}`]!) : posOfX(an.x), p1 = xLin ? xLin(n[`a1:${an.k}`]!) : posOfX(an.x2);
      mark(hz, Math.min(p0, p1) - half, Math.max(p0, p1) + half, band, an.label, a);
    }
  }
  // a highlighted x on a line chart: a soft column behind the marks
  if (line) fr.x.forEach((x, i) => { const h = n[`hx:${x.k}`] ?? 0; if (h > 0.01) { const p = xLin ? xLin(x.t) : cat.pos[i]!, w = Math.max(14, Math.min(40, cat.step * 0.7)), x0 = Math.max(P.x, p - w / 2), x1 = Math.min(P.x + P.w, p + w / 2); out += `<rect class="kch-col" x="${r1(x0)}" y="${P.y}" width="${r1(x1 - x0)}" height="${r1(P.h)}" rx="3"${op(h * xq[i]!)}/>`; } });
  const hit: Hit = { kind: o.kind, plot: P };
  let marks = '', top = '';
  if (line) {
    const px = fr.x.map((x, i) => (xLin ? xLin(x.t) : cat.pos[i]!));
    hit.xs = px;
    const ends: { y: number; x: number; text: string; a: number; r: number }[] = [];
    series.forEach((s, si) => {
      const reveal = sp[si]!;
      if (reveal < 0.002) return;
      const a = alphaOf(n, any, s.k, null, true);
      const pts = fr.x.map((x, i) => ({ x: px[i]!, y: vS(n[`v:${s.k}|${x.k}`]!), ok: Number.isFinite(n[`v:${s.k}|${x.k}`]!) && xq[i]! > 0.001 }));
      const cut = P.x + reveal * P.w + 1;
      const runs: { x: number; y: number }[][] = [];
      let run: { x: number; y: number }[] | null = null;
      pts.forEach((p, i) => {
        if (!p.ok) { run = null; return; }
        if (p.x > cut) { const q = pts[i - 1]; if (run && q && q.ok && q.x < cut) run.push({ x: cut, y: q.y + ((p.y - q.y) * (cut - q.x)) / (p.x - q.x || 1) }); run = null; return; }
        if (!run) { run = []; runs.push(run); }
        run.push(p);
      });
      const d = runs.filter((r) => r.length).map((r) => 'M' + r.map((p) => `${r1(p.x)} ${r1(p.y)}`).join('L')).join('');
      if (!d) return;
      const ar = n.ar ?? 0;
      if (ar > 0.01) marks += `<path class="kch-area ${cc(s.slot)}" d="${runs.filter((r) => r.length > 1).map((r) => `M${r1(r[0]!.x)} ${r1(base)}L${r.map((p) => `${r1(p.x)} ${r1(p.y)}`).join('L')}L${r1(r[r.length - 1]!.x)} ${r1(base)}Z`).join('')}"${op(ar * a)}/>`;
      marks += `<path class="kch-line ${cc(s.slot)}" d="${d}"${op(a)}/>`;
      // the end dot, and the end value
      const li = lastIdx(s);
      const last = runs[runs.length - 1]?.[runs[runs.length - 1]!.length - 1];
      if (last) top += `<circle class="kch-dot ${cc(s.slot)}" cx="${r1(last.x)}" cy="${r1(last.y)}" r="4"${op(a)}/>`;
      if (endOn && li >= 0 && reveal > 0.98) ends.push({ x: px[li]!, y: vS(n[`v:${s.k}|${xs[li]!.k}`]!), text: valText(n[`v:${s.k}|${xs[li]!.k}`]!), a, r: clamp((reveal - 0.98) * 50) });
      // a point the step emphasizes: a ring and its value
      fr.x.forEach((x, i) => {
        const h = n[`hp:${s.k}|${x.k}`] ?? 0;
        if (h < 0.01 || !pts[i]!.ok || pts[i]!.x > cut) return;
        top += `<circle class="kch-ring" cx="${r1(pts[i]!.x)}" cy="${r1(pts[i]!.y)}" r="7"${op(h)}/>`;
        const v = n[`v:${s.k}|${x.k}`]!, above = pts[i]!.y - 14 > P.y + 4;
        top += T(clamp(pts[i]!.x, P.x + 20, P.x + P.w - 20), pts[i]!.y + (above ? -13 : 22), valText(v), 'kch-val kch-mid kch-halo', op(h));
      });
    });
    // end values, spread apart; a leader when a label had to move
    const ys = dodge(ends.map((e) => e.y), 15, P.y + 6, P.y + P.h);
    ends.forEach((e, i) => {
      const y = ys[i]!;
      if (Math.abs(y - e.y) > 3) top += `<path class="kch-lead" d="M${r1(e.x + 5)} ${r1(e.y)}L${r1(e.x + 9)} ${r1(y)}"${op(e.r * e.a)}/>`;
      top += T(e.x + 10, y + 4, e.text, 'kch-val', op(e.r * ta(e.a)));
    });
    // a highlighted x: dots and values on every series there
    fr.x.forEach((x, i) => {
      const h = n[`hx:${x.k}`] ?? 0;
      if (h < 0.01) return;
      const at = series.map((s, si) => ({ s, si, v: n[`v:${s.k}|${x.k}`]! })).filter((q) => Number.isFinite(q.v) && sp[q.si]! > 0.5 && !(endOn && lastIdx(q.s) === i));
      const ly = dodge(at.map((q) => vS(q.v)), 15, P.y + 6, P.y + P.h - 4);
      const right = px[i]! + 60 < P.x + P.w;
      at.forEach((q, j) => {
        top += `<circle class="kch-dot ${cc(q.s.slot)}" cx="${r1(px[i]!)}" cy="${r1(vS(q.v))}" r="4"${op(h)}/>`;
        top += T(px[i]! + (right ? 9 : -9), ly[j]! + 4, valText(q.v), `kch-val kch-halo${right ? '' : ' kch-end'}`, op(h));
      });
    });
    if (hover?.x !== undefined && px[hover.x] !== undefined) {
      const hx = px[hover.x]!;
      top += `<path class="kch-cross" d="M${r1(hx)} ${P.y}v${r1(P.h)}"/>`;
      series.forEach((s, si) => { const v = n[`v:${s.k}|${xs[hover.x!]!.k}`]!; if (Number.isFinite(v) && sp[si]! > 0.5) top += `<circle class="kch-dot ${cc(s.slot)}" cx="${r1(hx)}" cy="${r1(vS(v))}" r="4.5"/>`; });
    }
  } else {
    // bars: grouped and stacked geometry, blended by `stk` so a switch between them slides
    const stk = clamp(n.stk ?? 0), P2 = sp.reduce((a, p) => a + p, 0) || 1;
    hit.bars = [];
    fr.x.forEach((x, xi) => {
      const band = cat.band[xi]!;
      if (band.w < 0.3) return;
      const avail = band.w * 0.74, gw = Math.min(28, Math.max(1, (avail - 2 * (P2 - 1)) / P2));
      const sw = Math.min(40, avail);
      const groupW = gw * P2 + 2 * (P2 - 1);
      let off = band.x + (band.w - groupW) / 2, pos = 0, neg = 0;
      const tops: boolean[] = series.map(() => false);
      // which stacked segment is outermost (gets the rounded end)
      let lastPos = -1, lastNeg = -1;
      series.forEach((s, si) => { const v = (n[`v:${s.k}|${x.k}`] ?? 0) * sp[si]!; if (v > 0) lastPos = si; else if (v < 0) lastNeg = si; });
      if (lastPos >= 0) tops[lastPos] = true;
      if (lastNeg >= 0) tops[lastNeg] = true;
      series.forEach((s, si) => {
        const raw = n[`v:${s.k}|${x.k}`]!, v = Number.isFinite(raw) ? raw : 0, p = sp[si]!;
        const gx = off, gwi = gw * p;
        off += gwi + 2 * p;
        const sv = v * p, from = sv >= 0 ? pos : neg;
        if (sv >= 0) pos += sv; else neg += sv;
        // grouped: [gx, gwi] from 0 to v; stacked: centred [sw] from `from` to from + sv, minus a 2px gap at its base
        const u0 = gx + (band.x + (band.w - sw) / 2 - gx) * stk, uw = gwi + (sw - gwi) * stk;
        const a0 = base + (vS(from) - base) * stk, a1v = vS(from + sv) * stk + vS(v) * (1 - stk);
        const gap = from !== 0 ? 2 * stk : 0;
        let lo = Math.min(a0, a1v), len = Math.abs(a1v - a0);
        const outward = hz ? a1v > a0 : a1v < a0;
        // the gap sits at the end nearer the baseline
        if (outward === !hz) { len -= gap; } else { lo += gap; len -= gap; }
        if (len <= 0.05 || uw <= 0.05) return;
        const roundEnd = stk < 0.5 || tops[si] ? (hz ? (v >= 0 ? 'r' : 'l') : v >= 0 ? 't' : 'b') : '';
        const a = alphaOf(n, any, s.k, x.k, false) * Math.min(1, p * 4);
        const box = hz ? { x: lo, y: u0, w: len, h: uw } : { x: u0, y: lo, w: uw, h: len };
        const hov = hover?.s === si && hover?.x === xi;
        marks += `<path class="kch-bar ${cc(s.slot)}${hov ? ' is-hov' : ''}" d="${barPath(box.x, box.y, box.w, box.h, roundEnd as 't')}"${op(a * xq[xi]!)}/>`;
        hit.bars!.push({ ...box, s: si, i: xi });
        const h = n[`hp:${s.k}|${x.k}`] ?? 0;
        if (h > 0.01 && !tipOn) top += hz ? T(box.x + box.w + 6, box.y + box.h / 2 + 4, valText(v), 'kch-val kch-halo', op(h)) : T(box.x + box.w / 2, box.y - 6, valText(v), 'kch-val kch-mid kch-halo', op(h));
      });
      // the value at the bar's tip (the stack's total when stacked), when it fits the band
      if (tipOn && xq[xi]! > 0.5) {
        const tot = stackTotal(fr, x.k), txt = valText(tot), tw = measure(txt, F.value, 600);
        const a = ta(Math.max(...series.map((s) => alphaOf(n, any, s.k, x.k, false))));
        if (hz) { const e = vS(tot); if (band.w >= 14) top += T(e + (tot >= 0 ? 6 : -6), band.x + band.w / 2 + 4, txt, `kch-val${tot >= 0 ? '' : ' kch-end'}`, op(a)); }
        else if (tw <= band.w - 2) { const e = vS(tot); top += T(band.x + band.w / 2, tot >= 0 ? e - 6 : e + 15, txt, 'kch-val kch-mid', op(a)); }
      }
    });
    out += `<path class="kch-base" d="${hz ? `M${r1(base)} ${P.y}v${r1(P.h)}` : `M${P.x} ${r1(base)}h${r1(P.w)}`}"/>`;
  }
  // callouts: a ring on the point and a boxed note beside it
  for (const an of fr.a) {
    const a = n[`a:${an.k}`] ?? 0, s = series.find((q) => q.k === an.series), xi = fr.x.findIndex((x) => x.k === an.x);
    if (an.type !== 'callout' || a < 0.01 || !s || xi < 0) continue;
    const v = n[`v:${s.k}|${an.x}`]!;
    if (!Number.isFinite(v)) continue;
    let px: number, py: number;
    if (line) { px = xLin ? xLin(fr.x[xi]!.t) : cat.pos[xi]!; py = vS(v); }
    else { const b = hit.bars?.find((q) => series[q.s] === s && q.i === xi); if (!b) continue; px = hz ? b.x + b.w : b.x + b.w / 2; py = hz ? b.y + b.h / 2 : b.y; }
    if (line && sp[series.indexOf(s)]! * P.w + P.x < px - 1) continue;
    const text = an.label || valText(v), tw = measure(text, F.note, 600) + 14, th = 22;
    let bx = clamp(px - tw / 2, P.x, P.x + P.w - tw), by = py - 18 - th;
    if (by < P.y - (tipOn ? 14 : 4)) by = py + 18;
    if (hz) { bx = Math.min(px + 14, W - tw); by = clamp(py - th / 2, 0, H - th); }
    const ex = clamp(px, bx + 4, bx + tw - 4), ey = by > py ? by : by + th;
    top += `<g${op(a)}>${line ? `<circle class="kch-ring" cx="${r1(px)}" cy="${r1(py)}" r="7"/>` : ''}<path class="kch-lead" d="M${r1(ex)} ${r1(ey)}L${r1(px)} ${r1(py + (by > py ? 7 : -7) * (line ? 1 : 0.3))}"/><rect class="kch-box" x="${r1(bx)}" y="${r1(by)}" width="${r1(tw)}" height="${th}" rx="4"/>${T(bx + 7, by + 15, text, 'kch-cl')}</g>`;
  }
  // category / x labels
  let xl = '';
  if (o.xType === 'band') {
    const vis = fr.x.map((x, i) => ({ x, i })).filter((q) => xq[q.i]! > 0.5);
    const maxW = Math.max(0, ...vis.map((q) => measure(q.x.label, F.tick)));
    const spacing = vis.length > 1 ? cat.step : P.w;
    const stride = hz ? Math.max(1, Math.ceil(16 / Math.max(1, spacing))) : Math.max(1, Math.ceil((maxW + 10) / Math.max(1, spacing)));
    fr.x.forEach((x, i) => {
      const a = xq[i]!, j = vis.findIndex((q) => q.i === i);
      if (a < 0.01 || (j >= 0 && j % stride !== 0) || (j < 0 && a > 0.5)) return;
      const hl = (n[`hx:${x.k}`] ?? 0) > 0.5 ? ' kch-hx' : '';
      if (hz) { xl += T(P.x - 8, cat.pos[i]! + 4, fit(x.label, catW - 10, measure), `kch-tk kch-end${hl}`, op(a)); return; }
      const w = measure(x.label, F.tick), c = cat.pos[i]!;
      const anchor = c - w / 2 < 0 ? 'kch-start' : c + w / 2 > W ? 'kch-end' : 'kch-mid';
      xl += T(anchor === 'kch-start' ? 0 : anchor === 'kch-end' ? W : c, P.y + P.h + 17, x.label, `kch-tk ${anchor}${hl}`, op(a));
    });
  } else {
    const u = o.xType === 'time' ? timeTicks(n.x0!, n.x1!, 6) : null;
    const placed: [number, number][] = [];
    fr.tx.forEach((t, j) => {
      const a = n[`tx:${t}`] ?? 0, p = xLin!(t);
      if (a < 0.01 || p < P.x - 1 || p > P.x + P.w + 1) return;
      const s = u ? formatDate(t, u.unit, j === 0 && u.unit !== 'year') : formatValue(t, { grouping: !o.xPlain });
      const w = measure(s, F.tick), x0 = clamp(p - w / 2, 0, W - w);
      if (placed.some(([l, r]) => x0 < r + 8 && x0 + w > l - 8)) return;
      placed.push([x0, x0 + w]);
      xl += T(x0, P.y + P.h + 17, s, 'kch-tk', op(a));
    });
  }
  return { svg: out + marks + notes + tl + xl + top, hit };
}

/** A label cut to a width, with an ellipsis. */
function fit(s: string, w: number, measure: Measure, size: number = F.tick): string {
  if (measure(s, size) <= w) return s;
  let t = s;
  while (t.length > 1 && measure(t + '…', size) > w) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

function stackTotal(fr: Frame, xk: string): number {
  const vals = fr.s.map((s) => (fr.n[`v:${s.k}|${xk}`] ?? 0) * (fr.n[`p:${s.k}`] ?? 0)).filter(Number.isFinite);
  if ((fr.n.stk ?? 0) > 0.5) return vals.reduce((a, v) => a + v, 0);
  return vals.length ? vals.reduce((a, v) => (Math.abs(v) > Math.abs(a) ? v : a), 0) : 0;
}

/** Category positions: weighted bands (bars) or points edge to edge (lines). */
function catPos(fr: Frame, P: { x: number; y: number; w: number; h: number }, hz: boolean, line: boolean) {
  const w = fr.x.map((x) => fr.n[`q:${x.k}`] ?? 0);
  const total = w.reduce((a, b) => a + b, 0) || 1;
  if (line) { const pos = points(w, P.x + 5, P.x + P.w - 5); return { pos, band: [], step: (P.w - 10) / Math.max(1, total - 1) }; }
  const band = hz ? bands(w, P.y, P.y + P.h) : bands(w, P.x, P.x + P.w);
  return { pos: band.map((b) => b.x + b.w / 2), band, step: (hz ? P.h : P.w) / total };
}

// ------------------------------------------------------------------ donut

function arcPath(cx: number, cy: number, r0: number, r1_: number, a0: number, a1: number): string {
  if (a1 - a0 < 1e-4) return '';
  if (a1 - a0 > Math.PI * 2 - 1e-4) a1 = a0 + Math.PI * 2 - 1e-4;
  const p = (r: number, a: number) => `${r1(cx + r * Math.sin(a))} ${r1(cy - r * Math.cos(a))}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1_, a0)}A${r1(r1_)} ${r1(r1_)} 0 ${large} 1 ${p(r1_, a1)}L${p(r0, a1)}A${r1(r0)} ${r1(r0)} 0 ${large} 0 ${p(r0, a0)}Z`;
}

function donut(fr: Frame, W: number, H: number, measure: Measure, hover: Hover | null): Rendered {
  const { n, o } = fr;
  const vals = fr.s.map((s) => Math.max(0, n[`v:${s.k}|`] ?? 0) * (n[`p:${s.k}`] ?? 0));
  const total = vals.reduce((a, v) => a + v, 0);
  const any = Math.max(0, ...fr.s.map((s) => n[`hs:${s.k}`] ?? 0));
  // the legend beside the ring (below it when the box is tall)
  const pct = (v: number) => (total > 0 ? formatValue(v / total, { format: 'percent', decimals: 0 }) : '0%');
  const rows = fr.s.map((s, i) => ({ s, i, v: n[`v:${s.k}|`] ?? 0, a: Math.min(1, (n[`p:${s.k}`] ?? 0) * 3) * alphaOf(n, any, s.k, null, true) }));
  const valW = Math.max(0, ...rows.map((r) => measure(formatNumber(r.v, o.fmt), F.legend, 600)));
  const pctW = Math.max(0, ...rows.map((r) => measure(pct(r.v), F.legend)));
  let labW = Math.max(0, ...rows.map((r) => measure(r.s.label, F.legend)));
  // the layout that gives the ring the most room: legend beside it (with values, then without), or below it
  const full = 18 + labW + 14 + valW + 10 + pctW, lean = 18 + labW + 12 + pctW;
  const opts = [
    { side: true, vals: true, legW: full, D: Math.min(H - 8, W - full - 26) },
    { side: true, vals: false, legW: lean, D: Math.min(H - 8, W - lean - 26) },
    { side: false, vals: true, legW: Math.min(W, full), D: Math.min(W - 8, H - rows.length * 22 - 16) },
  ];
  const want = Math.min(H - 8, 150);
  const pick = opts.find((x) => x.D >= want) ?? opts.reduce((a, b) => (b.D > a.D + 8 ? b : a));
  const { side, vals: showVals } = pick;
  let legW = pick.legW;
  if (legW > W) { labW = Math.max(30, labW - (legW - W)); legW = W; }
  const D = Math.max(24, pick.D);
  const gx = side ? Math.max(0, (W - (D + 24 + legW)) / 2) : 0;
  const R = D / 2, R0 = R * 0.62, cx = side ? gx + R + 1 : W / 2, cy = side ? H / 2 : R + 4;
  const sweep = clamp(n.sw ?? 1);
  let out = '', a0 = 0;
  const arcs: [number, number, number][] = [];
  fr.s.forEach((s, i) => {
    const span = total > 0 ? (vals[i]! / total) * Math.PI * 2 * sweep : 0;
    const h = n[`hs:${s.k}`] ?? 0, mid = a0 + span / 2, push = 6 * h;
    const dx = push * Math.sin(mid), dy = -push * Math.cos(mid);
    const d = arcPath(cx + dx, cy + dy, R0, R, a0, a0 + span);
    if (d) out += `<path class="kch-arc ${cc(s.slot)}${hover?.s === i ? ' is-hov' : ''}" d="${d}"${op(rows[i]!.a)}/>`;
    arcs.push([a0, a0 + span, i]);
    a0 += span;
  });
  // the centre: the total, or the one slice the step emphasizes
  const lit = fr.s.findIndex((s) => (n[`hs:${s.k}`] ?? 0) > 0.5);
  const cv = lit >= 0 ? (n[`v:${fr.s[lit]!.k}|`] ?? 0) : fr.s.reduce((a, s) => a + (n[`v:${s.k}|`] ?? 0) * (n[`p:${s.k}`] ?? 0), 0);
  const cl = lit >= 0 ? `${fr.s[lit]!.label} · ${pct(n[`v:${fr.s[lit]!.k}|`] ?? 0)}` : o.total;
  const big = formatNumber(cv, o.fmt), bs = Math.min(F.big, (R0 * 1.7) / Math.max(1, measure(big, 1, 700)));
  if (bs >= 11) out += T(cx, cy + (R0 > 34 ? bs * 0.18 : bs * 0.35), big, 'kch-big kch-mid', ` style="font-size:${r1(bs)}px"`) + (R0 > 34 ? T(cx, cy + bs * 0.18 + 17, fit(cl, R0 * 1.8, measure), 'kch-ax kch-mid') : '');
  // legend rows: swatch, label, value, share
  const lx = side ? cx + R + 24 : Math.max(0, (W - legW) / 2), ly = side ? cy - (rows.length * 22) / 2 + 11 : cy + R + 18;
  rows.forEach((r, j) => {
    const y = ly + j * 22;
    const p = Math.min(1, (n[`p:${r.s.k}`] ?? 0) * 3), a = r.a / (p || 1);
    out += `<g class="${cc(r.s.slot)}"${op(p)}><rect class="kch-sw" x="${r1(lx)}" y="${r1(y - 5)}" width="10" height="10" rx="2"${op(a)}/>${T(lx + 18, y + 4.2, fit(r.s.label, labW, measure, F.legend), 'kch-lg', op(ta(a)))}${showVals ? T(lx + 18 + labW + 14 + valW, y + 4.2, formatNumber(r.v, o.fmt), 'kch-val kch-end', op(ta(a))) : ''}${T(lx + legW, y + 4.2, pct(r.v), 'kch-tk kch-end', op(ta(a, true)))}</g>`;
  });
  return { svg: out, hit: { kind: 'donut', arcs: { cx, cy, r0: R0, r1: R, a: arcs } } };
}

// ------------------------------------------------------------------ sparkline

function spark(fr: Frame, W: number, H: number, hover: Hover | null): Rendered {
  const { n } = fr, s = fr.s[0];
  if (!s) return { svg: '', hit: { kind: 'sparkline' } };
  const pad = 5, xs = points(fr.x.map((x) => n[`q:${x.k}`] ?? 0), pad, W - pad), vS = linear(n.y0!, n.y1!, H - pad, pad);
  const reveal = n[`p:${s.k}`] ?? 0, cut = pad + reveal * (W - 2 * pad) + 0.5;
  const pts = fr.x.map((x, i) => ({ x: xs[i]!, y: vS(n[`v:${s.k}|${x.k}`]!), ok: Number.isFinite(n[`v:${s.k}|${x.k}`]!) })).filter((p) => p.ok && p.x <= cut);
  if (!pts.length) return { svg: '', hit: { kind: 'sparkline', xs } };
  const a = alphaOf(n, Math.max(0, n[`hs:${s.k}`] ?? 0), s.k, null, true);
  const d = 'M' + pts.map((p) => `${r1(p.x)} ${r1(p.y)}`).join('L');
  const base = vS(clamp(0, Math.min(n.y0!, n.y1!), Math.max(n.y0!, n.y1!)));
  const ar = n.ar ?? 0;
  let out = ar > 0.01 && pts.length > 1 ? `<path class="kch-area ${cc(s.slot)}" d="M${r1(pts[0]!.x)} ${r1(base)}L${d.slice(1)}L${r1(pts[pts.length - 1]!.x)} ${r1(base)}Z"${op(ar * a)}/>` : '';
  out += `<path class="kch-line kch-thin ${cc(s.slot)}" d="${d}"${op(a)}/>`;
  const last = pts[pts.length - 1]!;
  out += `<circle class="kch-dot ${cc(s.slot)}" cx="${r1(last.x)}" cy="${r1(last.y)}" r="3"${op(a)}/>`;
  fr.x.forEach((x, i) => { const h = n[`hp:${s.k}|${x.k}`] ?? n[`hx:${x.k}`] ?? 0; const v = n[`v:${s.k}|${x.k}`]!; if (h > 0.01 && Number.isFinite(v) && xs[i]! <= cut) out += `<circle class="kch-ring" cx="${r1(xs[i]!)}" cy="${r1(vS(v))}" r="5"${op(h)}/>`; });
  if (hover?.x !== undefined && Number.isFinite(n[`v:${s.k}|${fr.x[hover.x]?.k}`]!)) out += `<path class="kch-cross" d="M${r1(xs[hover.x]!)} 0v${H}"/><circle class="kch-dot ${cc(s.slot)}" cx="${r1(xs[hover.x]!)}" cy="${r1(vS(n[`v:${s.k}|${fr.x[hover.x]!.k}`]!))}" r="3.5"/>`;
  return { svg: out, hit: { kind: 'sparkline', xs } };
}

/** The chart layer's styles (theme tokens only): series colours, grid, ink, halos, the hover tooltip and the
 *  screen-reader twin. Scoped under `.kch` (the element hosting `data-k-chart`). */
export const CHART_CSS = /* css */ `
.kch{position:relative;min-width:0;min-height:0}
.kch-svg{display:block;overflow:visible;font-family:var(--pl-font);font-variant-numeric:tabular-nums}
.kch .c0 { --c: var(--pl-cat-other); } ${[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `.kch .c${i} { --c: var(--pl-cat-${i}); }`).join(' ')}
.kch-g{stroke:var(--pl-line);stroke-opacity:0.45;stroke-width:1;fill:none;shape-rendering:crispEdges}
.kch-base{stroke:var(--pl-muted);stroke-opacity:0.7;stroke-width:1;fill:none;shape-rendering:crispEdges}
.kch-tk{fill:var(--pl-muted);font-size:12.5px}
.kch-ax{fill:var(--pl-muted);font-size:12px}
.kch-lg{fill:var(--pl-fg);font-size:13px}
.kch-val{fill:var(--pl-fg);font-size:12.5px;font-weight:600}
.kch-note{fill:var(--pl-muted);font-size:12px;font-weight:500}
.kch-cl{fill:var(--pl-fg);font-size:12px;font-weight:600}
.kch-big{fill:var(--pl-fg);font-weight:700;letter-spacing:-0.01em}
.kch-hx{fill:var(--pl-fg);font-weight:600}
.kch-mid{text-anchor:middle}.kch-end{text-anchor:end}.kch-start{text-anchor:start}
.kch-halo{paint-order:stroke;stroke:var(--pl-card);stroke-width:4px;stroke-linejoin:round}
.kch-line{fill:none;stroke:var(--c);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.kch-thin{stroke-width:1.75}
.kch-key{fill:none;stroke:var(--c);stroke-width:2.5;stroke-linecap:round}
.kch-area{fill:var(--c);fill-opacity:0.13;stroke:none}
.kch-bar,.kch-sw{fill:var(--c)}
.kch-arc{fill:var(--c);stroke:var(--pl-card);stroke-width:2;stroke-linejoin:round}
.kch-dot{fill:var(--c);stroke:var(--pl-card);stroke-width:2}
.kch-ring{fill:none;stroke:var(--pl-accent);stroke-width:1.75}
.kch-ref{fill:none;stroke:var(--pl-fg);stroke-opacity:0.55;stroke-width:1.25;stroke-dasharray:5 4}
.kch-band{fill:var(--pl-fg);fill-opacity:0.06}
.kch-col{fill:var(--pl-accent);fill-opacity:0.12}
.kch-lead{fill:none;stroke:var(--pl-muted);stroke-width:1}
.kch-box{fill:var(--pl-card);stroke:var(--pl-accent);stroke-width:1.25}
.kch-cross{stroke:var(--pl-muted);stroke-width:1;fill:none}
.kch .is-hov{filter:brightness(1.18) saturate(1.05)}
.kch-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.kch-tip{position:absolute;z-index:4;left:0;top:0;pointer-events:none;min-width:96px;padding:7px 9px;border-radius:min(var(--pl-radius),6px);background:var(--pl-card);border:1px solid var(--pl-card-border);box-shadow:0 6px 18px color-mix(in srgb,var(--pl-bg) 55%,transparent);font:12px/1.35 var(--pl-font);color:var(--pl-fg);white-space:nowrap}
.kch-tip[hidden]{display:none}
.kch-tip b{display:block;margin-bottom:3px;font:600 11px/1.3 var(--pl-font-mono);letter-spacing:0.04em;color:var(--pl-muted)}
.kch-tip div{display:flex;align-items:center;gap:7px}
.kch-tip i{width:10px;height:2.5px;border-radius:2px;background:var(--c)}
.kch-tip strong{font-weight:650;font-variant-numeric:tabular-nums}
.kch-tip span{color:var(--pl-muted)}
`;
