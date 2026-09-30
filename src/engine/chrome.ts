// Chrome vs content under the viewer's zoom (docs/ENGINE.md "Zoom and pan").
//
// A scene marks the parts of its plate that frame the picture rather than belong to it (a header, a legend, a mode line,
// a toolbar, a side panel) with `data-pl-chrome`. While the viewer is zoomed in, the Stage keeps each marked element
// exactly where and how it is at fit: the frame scales and pans the whole stage, and this counter-transforms every
// chrome root with the CSS `translate` and `scale` properties, which compose outside the `transform` a Node writes, so
// scenes animate chrome as usual. At fit nothing is written (stills and lint stay byte-identical).
//
//   data-pl-chrome           a band: while zoomed it gets an opaque backdrop (the theme's background, reaching the
//                            stage edge when it sits near one), so the content pans under it and never shows through;
//                            the backdrop takes the pointer (a card under it is not clickable through it), and the fx
//                            layer over the HTML is masked there
//   data-pl-chrome="bare"    kept at fit too, without a backdrop (it has its own: a tab, a card of its own); the fx
//                            layer over the HTML is still masked there and hover cards keep clear of it
//   data-pl-chrome="overlay" kept at fit, and nothing else: a click-through outline around the whole plate
//
// Bands along an edge (spanning at least half of it) also widen the pan limits, so every edge of the content can be
// brought out from under them. Chrome lives in the plate's fit coordinates: its Nodes measure and map as at fit, fx drawn
// for it go on `fx.front` (the under layer at fit; while zoomed a fit-space canvas between the backdrops and the chrome),
// and `pt()` / `box()` say where a fit point or box of chrome is drawn in the zoomed stage.
import { layoutBox, type Node, type Box } from './node';
import type { Stage } from './stage';

export const CHROME = '[data-pl-chrome]';
/** Stage px the backdrop reaches past its element … */
const PAD = 10;
/** … and past which it reaches the stage edge it sits near. */
const SNAP = 72;
/** z-index while zoomed: backdrops at Z0, `fx.front` at Z0 + 1, chrome above (keeping its own order among itself). */
export const Z0 = 100;

export interface Insets { l: number; t: number; r: number; b: number }

export class ChromeLayer {
  /** Chrome as laid out at fit (stage px): each band's backdrop, and each bare element's box. */
  rects: Box[] = [];
  /** How deep bands reach in from each edge (stage px at fit): the view may pan that much past the edge, scaled so the
   *  stage's edge never goes beyond the band's inner edge. */
  insets: Insets = { l: 0, t: 0, r: 0, b: 0 };
  private styled = new Map<HTMLElement, { z: string; base: number }>();
  private backdrops = new Map<HTMLElement, HTMLElement>();
  private maskKey = '';

  constructor(private readonly stage: Stage, private readonly nodeOf: (el: HTMLElement) => Node | undefined, private readonly ancestor: (el: HTMLElement) => Node | null) {
    // a backdrop is chrome: a click on it never reaches the content under it
    const eat = (e: Event) => { if ((e.target as HTMLElement | null)?.dataset?.plChrome === 'backdrop') e.stopPropagation(); };
    stage.viewport.addEventListener('click', eat, true);
    stage.viewport.addEventListener('dblclick', eat, true);
  }

  /** Where the chrome is drawn now (stage px, the view included): at fit, `rects` itself. */
  shown(): Box[] {
    return this.rects.map((r) => this.box(r));
  }
  /** Where a point of chrome (fit coordinates) is drawn in the zoomed stage. At fit, the point itself. */
  pt(p: { x: number; y: number }) {
    const v = this.stage.view;
    return v.zoomed ? { x: v.x + p.x / v.zoom, y: v.y + p.y / v.zoom } : { x: p.x, y: p.y };
  }
  /** Where a box of chrome (fit coordinates) is drawn in the zoomed stage. At fit, the box itself. */
  box(b: Box): Box {
    const v = this.stage.view, k = 1 / v.zoom;
    return v.zoomed ? { x: v.x + b.x * k, y: v.y + b.y * k, w: b.w * k, h: b.h * k } : { ...b };
  }
  /** Is this element chrome (inside a marked element of this plate)? */
  contains(el: Element | null): boolean {
    const r = el?.closest(CHROME);
    return !!r && r.closest('.plate-dom') === this.stage.dom;
  }

  /** The outermost marked elements of this plate (not a plate hosted inside it). */
  private roots(): HTMLElement[] {
    const dom = this.stage.dom;
    const outer = (e: HTMLElement) => { const a = e.parentElement?.closest(CHROME); return !a || !dom.contains(a); };
    return [...dom.querySelectorAll<HTMLElement>(CHROME)].filter((e) => e.dataset.plChrome !== 'backdrop' && e.closest('.plate-dom') === dom && outer(e));
  }

  /** Every frame, after layout is measured and before the fx are drawn. */
  update() {
    const st = this.stage, v = st.view;
    // off for plates that can't be zoomed (a clip, a hosted plate), unless a still sets a zoomed view
    if (!v.enabled && !v.zoomed && !this.styled.size) return;
    const zoomed = v.zoomed, W = st.W, H = st.H, k = 1 / v.zoom;
    const roots = this.roots(), rects: Box[] = [], ins: Insets = { l: 0, t: 0, r: 0, b: 0 };
    const live = new Set<HTMLElement>();
    for (const el of roots) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || !el.isConnected) continue;
      const node = this.nodeOf(el) ?? null, anc = node ? node.parent : this.ancestor(el);
      const box = node ? node.box : layoutBox(el, st.frame);
      // at fit: the element as its own and its ancestors' Node transforms place it
      const fitMap = (x: number, y: number) => node ? node.map({ x, y }) : anc ? anc.map({ x, y }) : { x, y };
      const cs4 = [fitMap(box.x, box.y), fitMap(box.x + box.w, box.y), fitMap(box.x, box.y + box.h), fitMap(box.x + box.w, box.y + box.h)];
      const r = { x: Math.min(...cs4.map((c) => c.x)), y: Math.min(...cs4.map((c) => c.y)), w: 0, h: 0 };
      r.w = Math.max(...cs4.map((c) => c.x)) - r.x; r.h = Math.max(...cs4.map((c) => c.y)) - r.y;
      const shown = cs.visibility !== 'hidden' && +cs.opacity > 0.01 && r.w > 0 && r.h > 0;
      const kind = el.dataset.plChrome ?? '', band = kind === '' || kind === 'band';
      let bg: Box | null = null;
      if (shown) {
        if (band) {
          let x0 = r.x - PAD, y0 = r.y - PAD, x1 = r.x + r.w + PAD, y1 = r.y + r.h + PAD;
          if (r.x < SNAP) x0 = 0;
          if (r.y < SNAP) y0 = 0;
          if (W - (r.x + r.w) < SNAP) x1 = W;
          if (H - (r.y + r.h) < SNAP) y1 = H;
          bg = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          rects.push(bg);
          const wide = bg.w >= W / 2, tall = bg.h >= H / 2;
          if (x0 <= 0 && tall) ins.l = Math.max(ins.l, x1);
          if (x1 >= W && tall) ins.r = Math.max(ins.r, W - x0);
          if (y0 <= 0 && wide) ins.t = Math.max(ins.t, y1);
          if (y1 >= H && wide) ins.b = Math.max(ins.b, H - y0);
        } else if (kind !== 'overlay') rects.push(r);
      }
      if (!zoomed) continue;
      live.add(el);
      // the counter-transform: a point p the Node transforms put at M(p) is drawn at M(p) / zoom + (view x, y)
      let s = this.styled.get(el);
      if (!s) { s = { z: el.style.zIndex, base: parseInt(cs.zIndex, 10) || 0 }; this.styled.set(el, s); }
      const [ox, oy] = cs.transformOrigin.split(' ').map((q) => parseFloat(q) || 0);
      const O = anc ? anc.map({ x: box.x + ox!, y: box.y + oy! }) : { x: box.x + ox!, y: box.y + oy! };
      el.style.translate = `${r3(v.x - O.x * (1 - k))}px ${r3(v.y - O.y * (1 - k))}px`;
      el.style.scale = String(r4(k));
      el.style.zIndex = String(Z0 + 2 + Math.max(0, s.base));
      // the band's backdrop: covers the content panning under it, and takes the pointer there
      let b = this.backdrops.get(el);
      if (bg) {
        if (!b || !b.isConnected) {
          b = document.createElement('div');
          b.className = 'plate-chrome-bg';
          b.dataset.plChrome = 'backdrop';
          b.setAttribute('aria-hidden', 'true');
          st.dom.append(b);
          this.backdrops.set(el, b);
        }
        Object.assign(b.style, { left: `${r3(v.x + bg.x * k)}px`, top: `${r3(v.y + bg.y * k)}px`, width: `${r3(bg.w * k)}px`, height: `${r3(bg.h * k)}px`, zIndex: String(Z0), opacity: cs.opacity === '1' ? '' : cs.opacity, display: '' });
      } else if (b) b.style.display = 'none';
    }
    this.rects = rects;
    const cap = (x: number, m: number) => Math.min(x, m / 2);
    this.insets = { l: cap(ins.l, W), r: cap(ins.r, W), t: cap(ins.t, H), b: cap(ins.b, H) };
    // chrome that stopped being chrome (or the view went back to fit): back as it was
    for (const [el, s] of this.styled) if (!live.has(el)) { el.style.translate = ''; el.style.scale = ''; el.style.zIndex = s.z; this.styled.delete(el); }
    for (const [el, b] of this.backdrops) if (!live.has(el)) { b.remove(); this.backdrops.delete(el); }
    this.mask(zoomed);
  }

  /** The fx layer over the HTML draws above every element: mask it where chrome is drawn. */
  private mask(zoomed: boolean) {
    const c = this.stage.fx.over?.canvas;
    if (!c) return;
    const v = this.stage.view, k = 1 / v.zoom;
    const key = zoomed ? this.rects.map((r) => [r.x, r.y, r.w, r.h].map((q) => r3(q * k)).join(',')).join(';') + `|${r3(this.stage.W * k)},${r3(this.stage.H * k)}` : '';
    if (key === this.maskKey) return;
    this.maskKey = key;
    if (!zoomed) { c.style.removeProperty('mask'); c.style.removeProperty('-webkit-mask'); return; }
    const w = r3(this.stage.W * k), h = r3(this.stage.H * k);
    const holes = this.rects.map((r) => `<rect x="${r3(r.x * k)}" y="${r3(r.y * k)}" width="${r3(r.w * k)}" height="${r3(r.h * k)}" fill="black"/>`).join('');
    // transparent where chrome is (an SVG mask inside the image, so overlapping holes stay holes)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><mask id="m"><rect width="${w}" height="${h}" fill="white"/>${holes}</mask></defs><rect width="${w}" height="${h}" fill="white" mask="url(#m)"/></svg>`;
    const m = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0 / 100% 100% no-repeat`;
    c.style.setProperty('-webkit-mask', m);
    c.style.setProperty('mask', m);
  }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 100000) / 100000;
