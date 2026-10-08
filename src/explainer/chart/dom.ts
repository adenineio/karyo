// The browser side of a chart (`data-k-chart="<kind>"` in a component template): holds the frames a step
// tweens between, renders the frame at the transition's progress into the hook element, keeps the
// screen-reader twin current, and (interactive pages only, never in export) shows a tooltip on hover.
// Hover is state at rest: it sets a field and asks the stage to redraw; nothing animates on its own.
import { birthFrame, lerpFrame } from './tween';
import { renderChart, type Hit, type Hover, type Measure } from './render';
import { chartSummary, chartTable } from './a11y';
import { formatNumber } from './format';
import type { Frame } from './data';

const widths = new Map<string, number>();
let ctx: CanvasRenderingContext2D | null | undefined;
/** Text width in the chart's font (a canvas, cached); falls back to the estimate without one. */
function canvasMeasure(family: string): Measure {
  return (t, size, weight = 400) => {
    const key = `${family}|${size}|${weight}|${t}`;
    let w = widths.get(key);
    if (w === undefined) {
      if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) return t.length * size * 0.56;
      ctx.font = `${weight} ${size}px ${family}`;
      w = Math.ceil(ctx.measureText(t).width * 10) / 10;
      widths.set(key, w);
    }
    return w;
  };
}

export class ChartView {
  el: HTMLElement | null = null;
  private svgBox: HTMLElement | null = null;
  private sr: HTMLElement | null = null;
  private tip: HTMLElement | null = null;
  private from: Frame | null = null;
  private to: Frame | null = null;
  private k = 1;
  private shown = '';
  private srShown = '';
  private hit: Hit = { kind: 'line' };
  private hover: Hover | null = null;
  w = 0;
  h = 0;

  constructor(private redraw: () => void, private interactive: boolean, private summary: () => string | undefined) {}

  /** Bind to the hook element (again after the element's HTML was swapped). */
  attach(el: HTMLElement) {
    if (this.el === el) return;
    this.el = el;
    el.classList.add('kch');
    el.innerHTML = '<div class="kch-box-svg"></div><div class="kch-sr" data-pl-clip></div>' + (this.interactive ? '<div class="kch-tip" hidden aria-hidden="true"></div>' : '');
    this.svgBox = el.firstElementChild as HTMLElement;
    this.sr = el.children[1] as HTMLElement;
    this.tip = this.interactive ? (el.children[2] as HTMLElement) : null;
    this.shown = ''; this.srShown = '';
    this.measure();
    if (this.interactive) {
      el.addEventListener('pointermove', (e) => this.onMove(e));
      el.addEventListener('pointerleave', () => this.setHover(null, null));
    }
  }
  /** The hook's size (layout px, unaffected by the camera's scale). */
  measure() { if (this.el && this.el.clientWidth > 0) { this.w = this.el.clientWidth; this.h = this.el.clientHeight; } }

  /** Rest on a frame at once. */
  snap(to: Frame) { this.from = this.to = to; this.k = 1; this.hover = null; if (this.tip) this.tip.hidden = true; this.syncSr(); }
  /** Start a tween to `to`: from what is on screen now (the running tween at its last drawn progress), or from
   *  nothing when the chart arrives. */
  retarget(to: Frame, arriving: boolean) {
    // the same target (a legend pin restarted the transition): carry on from what is on screen
    if (to === this.to && !arriving) { this.from = this.current() ?? to; this.k = 0; return; }
    this.from = arriving || !this.to ? birthFrame(to) : lerpFrame(this.from ?? this.to, this.to, this.k);
    this.to = to; this.k = 0;
    this.hover = null; if (this.tip) this.tip.hidden = true;
    this.syncSr();
  }
  /** The frame being tweened to (or resting on). */
  get target(): Frame | null { return this.to; }
  current(k = this.k): Frame | null { return this.to && this.from ? lerpFrame(this.from, this.to, k) : this.to; }

  /** Draw the frame at progress k (0..1 of the step's count curve). */
  render(k: number) {
    this.k = k;
    const fr = this.current(k);
    if (!fr || !this.svgBox || !this.el) return;
    if (!this.w) this.measure();
    const family = getComputedStyle(this.el).fontFamily || 'sans-serif';
    const r = renderChart(fr, this.w, this.h, canvasMeasure(family), k >= 1 ? this.hover : null);
    this.hit = r.hit;
    if (r.svg !== this.shown) { this.svgBox.innerHTML = r.svg; this.shown = r.svg; }
  }

  private syncSr() {
    if (!this.sr || !this.to) return;
    const html = `<p>${chartSummaryHtml(this.to, this.summary())}</p>${chartTable(this.to)}`;
    if (html !== this.srShown) { this.sr.innerHTML = html; this.srShown = html; }
  }

  // ------------------------------------------------------------ hover (interactive only)
  private onMove(e: PointerEvent) {
    if (!this.el || !this.to || this.k < 1) return;
    const b = this.el.getBoundingClientRect(), sx = this.el.clientWidth / (b.width || 1);
    const x = (e.clientX - b.left) * sx, y = (e.clientY - b.top) * sx;
    this.setHover(pick(this.hit, x, y), { x, y });
  }
  private setHover(h: Hover | null, at: { x: number; y: number } | null) {
    const same = JSON.stringify(h) === JSON.stringify(this.hover);
    this.hover = h;
    if (this.tip) {
      const fr = this.to;
      if (!h || !fr || !at) this.tip.hidden = true;
      else {
        if (!same) fillTip(this.tip, fr, h);
        this.tip.hidden = false;
        const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
        const left = at.x + 14 + tw > this.w ? at.x - 14 - tw : at.x + 14;
        this.tip.style.left = `${Math.round(Math.max(-8, left))}px`;
        this.tip.style.top = `${Math.round(Math.min(Math.max(-8, at.y - th / 2), this.h - th + 8))}px`;
      }
    }
    if (!same) this.redraw();
  }

  /** Layout problems at rest: a label outside the chart, or two labels on top of each other. */
  lint(name: string): string[] {
    const out: string[] = [];
    if (!this.el || !this.svgBox) return out;
    const svg = this.svgBox.querySelector('svg');
    if (!svg) return out;
    const box = svg.getBoundingClientRect(), s = (box.width / (this.w || 1)) || 1;
    const texts = [...svg.querySelectorAll('text')].filter((t) => +(t.getAttribute('opacity') ?? (t.parentElement?.getAttribute('opacity') ?? 1)) > 0.05 && t.textContent);
    const rs = texts.map((t) => ({ t: t.textContent!, r: t.getBoundingClientRect() }));
    for (const { t, r } of rs) if (r.left < box.left - 2 * s || r.right > box.right + 2 * s || r.top < box.top - 2 * s || r.bottom > box.bottom + 2 * s) out.push(`chart "${name}": the label "${t}" sits outside the chart`);
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i]!.r, b = rs[j]!.r;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 2 * s && oy > 3 * s) out.push(`chart "${name}": the labels "${rs[i]!.t}" and "${rs[j]!.t}" overlap`);
    }
    return out;
  }
}

const chartSummaryHtml = (fr: Frame, own?: string) => chartSummary(fr, own).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** What sits under (x, y): the nearest x on a line, the bar under the pointer, the slice at that angle. */
export function pick(hit: Hit, x: number, y: number): Hover | null {
  if (hit.xs && hit.xs.length) {
    const p = hit.plot;
    if (p && (x < p.x - 12 || x > p.x + p.w + 12 || y < p.y - 12 || y > p.y + p.h + 12)) return null;
    let best = 0;
    hit.xs.forEach((v, i) => { if (Math.abs(v - x) < Math.abs(hit.xs![best]! - x)) best = i; });
    return { x: best };
  }
  if (hit.bars) {
    // the box grown to a comfortable target (at least 24 px across)
    const b = hit.bars.find((q) => { const gx = Math.max(0, (24 - q.w) / 2), gy = Math.max(0, (24 - q.h) / 2); return x >= q.x - gx && x <= q.x + q.w + gx && y >= q.y - gy && y <= q.y + q.h + gy; });
    return b ? { s: b.s, x: b.i } : null;
  }
  if (hit.arcs) {
    const { cx, cy, r0, r1, a } = hit.arcs, d = Math.hypot(x - cx, y - cy);
    if (d < r0 - 6 || d > r1 + 8) return null;
    let ang = Math.atan2(x - cx, cy - y);
    if (ang < 0) ang += Math.PI * 2;
    const s = a.find(([a0, a1]) => ang >= a0 && ang < a1);
    return s ? { s: s[2] } : null;
  }
  return null;
}

/** The tooltip: the x (or slice) as a heading, then each series' value (strong) and name; text only. */
function fillTip(tip: HTMLElement, fr: Frame, h: Hover) {
  tip.textContent = '';
  const f = (v: number) => formatNumber(v, fr.o.fmt);
  const head = document.createElement('b');
  const row = (slot: number, v: number, label: string) => {
    const d = document.createElement('div'), i = document.createElement('i'), s = document.createElement('strong'), l = document.createElement('span');
    d.className = `c${slot}`; s.textContent = f(v); l.textContent = label;
    d.append(i, s, l); tip.append(d);
  };
  if (fr.o.kind === 'donut') {
    const it = fr.s[h.s!];
    if (!it) return;
    const total = fr.s.reduce((a, s) => a + (fr.n[`v:${s.k}|`] ?? 0), 0), v = fr.n[`v:${it.k}|`] ?? 0;
    head.textContent = `${it.label} · ${total ? Math.round((v / total) * 100) : 0}%`; tip.append(head);
    row(it.slot, v, 'of ' + f(total));
    return;
  }
  const x = fr.x[h.x!];
  if (!x) return;
  head.textContent = fr.o.kind === 'sparkline' ? `${fr.s[0]?.label ?? ''} · ${h.x! + 1} of ${fr.x.length}` : x.label;
  tip.append(head);
  const list = h.s !== undefined ? [fr.s[h.s]!] : fr.s;
  for (const s of list) { const v = fr.n[`v:${s.k}|${x.k}`]!; if (s && Number.isFinite(v) && (fr.n[`p:${s.k}`] ?? 0) > 0.5) row(s.slot, v, fr.o.kind === 'sparkline' ? '' : s.label); }
}
