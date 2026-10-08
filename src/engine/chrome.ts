// Chrome vs content: under the viewer's zoom, and at small fits (docs/ENGINE.md "Zoom and pan" and "Chrome floor").
//
// A scene marks the parts of its plate that frame the picture rather than belong to it (a header, a legend, a mode line,
// a toolbar, a side panel) with `data-pl-chrome`. The content (cards, wires) is laid out in stage px and scales with the
// plate's fit; chrome is drawn by its own rule:
//   - while the viewer is zoomed in, each marked element stays exactly where and how it is at fit: the frame scales and
//     pans the whole stage, and this counter-transforms every chrome root with the CSS `translate` and `scale`
//     properties, which compose outside the `transform` a Node writes, so scenes animate chrome as usual;
//   - the chrome floor: chrome is never drawn smaller than CHROME_FLOOR CSS px per stage px (its designed size), times
//     the interface size (uisize.ts: S, M, L). When the fit would draw it smaller, each chrome root is drawn `k` times
//     its fit size, scaled about the stage edge it sits at (a header from the top-left corner, a toolbar from the
//     top-right, a legend from the bottom), so chrome along one edge keeps its order. A root spanning half the stage (or
//     a large panel) keeps its span instead: it is laid out narrower (`max-width` / `max-height`) and drawn larger, so
//     its text reflows. Roots that belong together (one class, e.g. a row of tabs; or inside one band) share a scale,
//     never boosted past the stage, and are clamped inside it as a group.
// At fit with no boost nothing is written (stills and lint stay byte-identical: export mode never boosts).
//
//   data-pl-chrome           a band: while zoomed or boosted it gets an opaque backdrop (the theme's background, reaching
//                            the stage edge when it sits near one), so the content passes under it and never shows
//                            through; the backdrop takes the pointer (a card under it is not clickable through it), and
//                            the fx layer over the HTML is masked there
//   data-pl-chrome="bare"    kept at fit (and boosted) too, without a backdrop (it has its own: a tab, a card of its
//                            own); the fx layer over the HTML is still masked there and hover cards keep clear of it
//   data-pl-chrome="overlay" kept at fit, and nothing else: a click-through outline around the whole plate (never boosted)
//   data-pl-floor="own"      (with any of the above) kept at fit while zoomed, never boosted by the floor: the scene draws
//                            it at the floor's size itself (it rides the content, e.g. a tab on a sheet, placed in stage px
//                            from `fit`'s `o.chrome`), so scaling it about a stage edge would move it off what it labels
//
// Bands along an edge (spanning at least half of it) also widen the pan limits, so every edge of the content can be
// brought out from under them. Chrome lives in the plate's fit coordinates: its Nodes measure and map as at fit, fx drawn
// for it go on `fx.front` (the under layer at fit; while zoomed or boosted a canvas between the backdrops and the chrome,
// drawn with the transform of the chrome it belongs to), and `pt()` / `box()` say where a fit point or box of chrome is
// drawn now.
import { layoutBox, type Node, type Box } from './node';
import type { Stage } from './stage';
import { uiSize } from './uisize';

export const CHROME = '[data-pl-chrome]';
/** Stage px the backdrop reaches past its element … */
const PAD = 10;
/** … and past which it reaches the stage edge it sits near. */
const SNAP = 72;
/** z-index while zoomed or boosted: backdrops at Z0, `fx.front` at Z0 + 1, chrome above (keeping its own order). */
export const Z0 = 100;
/** The chrome floor: chrome is never drawn smaller than this many CSS px per stage px, times the interface size. Chrome
 *  is designed at a readable size in stage px (labels 11–12 px, body 13–14 px), so 1 keeps that size on screen. */
export const CHROME_FLOOR = 1;
/** A root covering this much of the stage is a surface (a plate hosted inside this one), not chrome text: never boosted. */
const SURFACE = 0.6;
/** A root at least this share of the stage's width (height) keeps its span on that axis; so does a large panel (this
 *  share of the stage's area, and a quarter of the axis). */
const SPAN = 0.5, BIG = 0.15;
/** The axes a chrome root laid out at `b` keeps its span on, in a W × H stage (the floor lays it out narrower there). */
export const chromeSpans = (b: Box, W: number, H: number) => ({ x: b.w >= SPAN * W || (b.w * b.h >= BIG * W * H && b.w >= W / 4), y: b.h >= SPAN * H || (b.w * b.h >= BIG * W * H && b.h >= H / 4) });
/** Where to lay out a lone chrome root (no other root of its class, not inside a band) so that the floor, boosting it
 *  `k` times, draws it at `d` (stage px at fit, inside the stage): along an axis it spans, its margins to the stage edges
 *  are drawn k times larger; along any other it is scaled about the stage edge it sits at. A plate that relays out for
 *  its chrome (`fit`'s `o.chrome`) places its panels with it, so the boosted chrome lands where it left room. */
export function chromeBoxFor(d: Box, W: number, H: number, k: number): Box {
  if (Math.abs(k - 1) < 0.005) return { ...d };
  const spanned = (lo: number, len: number, ext: number) => { const a = lo / k, b = ext - (ext - lo - len) / k; return [a, b - a] as const; };
  const anchored = (lo: number, len: number, ext: number) => { const A = len >= ext / 2 || lo + len / 2 < ext / 2 ? 0 : ext; return [A + (lo - A) / k, len / k] as const; };
  let [x, w] = spanned(d.x, d.w, W), [y, h] = spanned(d.y, d.h, H);
  const sp = chromeSpans({ x, y, w, h }, W, H);
  if (!sp.x) [x, w] = anchored(d.x, d.w, W);
  if (!sp.y) [y, h] = anchored(d.y, d.h, H);
  return { x, y, w, h };
}

export interface Insets { l: number; t: number; r: number; b: number }
/** Where a root is drawn at fit along one axis: drawn = P + (p - a) × k (fit coordinates). */
interface Ax { a: number; P: number }
interface Place { k: number; x: Ax; y: Ax }
interface Root {
  el: HTMLElement; node: Node | null; anc: Node | null; cs: CSSStyleDeclaration; kind: string; band: boolean; shown: boolean;
  /** Its layout box; its rect at fit as laid out now; and as laid out without the floor's max-width / max-height. */
  box: Box; cur: Box; nat: Box;
  span: { x: boolean; y: boolean }; place: Place; fixed: boolean;
}
/** A root the floor lays out narrower (or shorter): its natural size at fit, and the inline styles it had. */
interface Comp { key: string; natW: number; natH: number; mw: string; mh: string; set: string }

const ident = (): Place => ({ k: 1, x: { a: 0, P: 0 }, y: { a: 0, P: 0 } });
const drawnOf = (pl: Place, r: Box): Box => ({ x: pl.x.P + (r.x - pl.x.a) * pl.k, y: pl.y.P + (r.y - pl.y.a) * pl.k, w: r.w * pl.k, h: r.h * pl.k });
const inside = (a: Box, b: Box) => a.x >= b.x - 2 && a.y >= b.y - 2 && a.x + a.w <= b.x + b.w + 2 && a.y + a.h <= b.y + b.h + 2;

export class ChromeLayer {
  /** Chrome as drawn at fit (stage px, the floor included): each band's backdrop, and each bare element's box. */
  rects: Box[] = [];
  /** How deep bands reach in from each edge as drawn (stage px at fit, the floor included): the view may pan that much
   *  past the edge, scaled so the stage's edge never goes beyond the band's inner edge. */
  insets: Insets = { l: 0, t: 0, r: 0, b: 0 };
  /** The same at the chrome's own size (no floor): what covers the content at fit without the floor. */
  insets0: Insets = { l: 0, t: 0, r: 0, b: 0 };
  /** The chrome floor's boost now: chrome is drawn `k` times its fit size (1: at fit size; docs/ENGINE.md "Chrome floor"). */
  k = 1;
  private styled = new Map<HTMLElement, { z: string; base: number }>();
  private backdrops = new Map<HTMLElement, HTMLElement>();
  private comp = new Map<HTMLElement, Comp>();
  /** Roots whose content didn't reflow when laid out narrower (it is placed in stage px: a step rail), per stage size:
   *  they are scaled whole instead, as far as the stage allows. */
  private rigid = new Map<HTMLElement, { key: string; x: boolean; y: boolean }>();
  private placed: { nat: Box; place: Place }[] = [];
  private maskKey = '';

  constructor(private readonly stage: Stage, private readonly nodeOf: (el: HTMLElement) => Node | undefined, private readonly ancestor: (el: HTMLElement) => Node | null) {
    // a backdrop is chrome: a click on it never reaches the content under it
    const eat = (e: Event) => { if ((e.target as HTMLElement | null)?.dataset?.plChrome === 'backdrop') e.stopPropagation(); };
    stage.viewport.addEventListener('click', eat, true);
    stage.viewport.addEventListener('dblclick', eat, true);
  }

  /** Is chrome drawn other than at its fit place and size (zoomed in, or boosted by the floor)? */
  get active() { return this.stage.view.zoomed || this.k !== 1; }
  /** Where the chrome is drawn now (stage px, the view included): at fit with no boost, `rects` itself. */
  shown(): Box[] {
    return this.rects.map((r) => this.viewed(r));
  }
  /** Where a point of chrome (fit coordinates) is drawn now: the floor's placement of the chrome there, and the view. */
  pt(p: { x: number; y: number }) {
    const pl = this.placeAt(p);
    const d = pl ? { x: pl.x.P + (p.x - pl.x.a) * pl.k, y: pl.y.P + (p.y - pl.y.a) * pl.k } : p;
    const v = this.stage.view;
    return v.zoomed ? { x: v.x + d.x / v.zoom, y: v.y + d.y / v.zoom } : { x: d.x, y: d.y };
  }
  /** Where a box of chrome (fit coordinates) is drawn now. At fit with no boost, the box itself. */
  box(b: Box): Box {
    const pl = this.placeAt({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    return this.viewed(pl ? drawnOf(pl, b) : b);
  }
  /** Where `fx.front` is shown (stage px) when what it draws covers `bounds` (fit coordinates): the whole fit-space
   *  canvas, under the transform of the chrome there (none: the view's rect). */
  frontBox(bounds: Box | null): Box {
    const pl = bounds ? this.placeAt({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }) : null;
    const st = this.stage;
    return this.viewed(pl ? { x: pl.x.P - pl.x.a * pl.k, y: pl.y.P - pl.y.a * pl.k, w: st.W * pl.k, h: st.H * pl.k } : { x: 0, y: 0, w: st.W, h: st.H });
  }
  /** Is this element chrome (inside a marked element of this plate)? */
  contains(el: Element | null): boolean {
    const r = el?.closest(CHROME);
    return !!r && r.closest('.plate-dom') === this.stage.dom;
  }

  /** A fit-coordinates box as drawn in the (zoomed) stage. */
  private viewed(b: Box): Box {
    const v = this.stage.view, k = 1 / v.zoom;
    return v.zoomed ? { x: v.x + b.x * k, y: v.y + b.y * k, w: b.w * k, h: b.h * k } : { ...b };
  }
  /** The floor's placement of the smallest chrome root at a fit point (null with no boost, or no chrome there). */
  private placeAt(p: { x: number; y: number }): Place | null {
    if (this.k === 1) return null;
    let best: Place | null = null, area = Infinity;
    for (const r of this.placed) {
      const a = r.nat.w * r.nat.h;
      if (p.x >= r.nat.x && p.x <= r.nat.x + r.nat.w && p.y >= r.nat.y && p.y <= r.nat.y + r.nat.h && a < area) { best = r.place; area = a; }
    }
    return best;
  }

  /** The outermost marked elements of this plate (not a plate hosted inside it). */
  private roots(): HTMLElement[] {
    const dom = this.stage.dom;
    const outer = (e: HTMLElement) => { const a = e.parentElement?.closest(CHROME); return !a || !dom.contains(a); };
    return [...dom.querySelectorAll<HTMLElement>(CHROME)].filter((e) => e.dataset.plChrome !== 'backdrop' && e.closest('.plate-dom') === dom && outer(e));
  }

  /** The floor's boost for the plate's size on screen now (a host plate's scale included): 1 off zoomable plates. */
  private boost(): number {
    const st = this.stage;
    return this.boostAt(st.viewport.getBoundingClientRect().width / st.W);
  }
  /** The floor's boost for a plate drawn at `scale` CSS px per stage px (1 where the floor is off: export mode, clips,
   *  a plate in a page's column rather than filling a space of its own). */
  boostAt(scale: number): number {
    const st = this.stage;
    if (!st.view.enabled || st.isExport || !(scale > 0) || !st.fills) return 1;
    const k = Math.round(((Math.max(scale, CHROME_FLOOR) * uiSize().k) / scale) * 1000) / 1000;
    return Math.abs(k - 1) < 0.005 ? 1 : k;
  }

  /** Every frame, after layout is measured and before the fx are drawn. */
  update() {
    const st = this.stage, v = st.view;
    // off for plates that can't be zoomed (a clip, a hosted plate), unless a still sets a zoomed view
    if (!v.enabled && !v.zoomed && !this.styled.size && !this.comp.size) return;
    const zoomed = v.zoomed, W = st.W, H = st.H, z = v.zoom;
    const K = this.k = this.boost();
    const key = `${W}x${H}`;
    const list: Root[] = [];
    for (const el of this.roots()) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || !el.isConnected) continue;
      const node = this.nodeOf(el) ?? null, anc = node ? node.parent : this.ancestor(el);
      let c = this.comp.get(el);
      // laid out for another stage size (or no boost now): back to its own layout, measured again
      if (c && (c.key !== key || K === 1)) { this.uncomp(el, c); c = undefined; node?.measure(); }
      const box = node ? node.box : layoutBox(el, st.frame);
      const cur = this.fitRect(node, anc, box);
      const nat = c ? { x: cur.x, y: cur.y, w: c.natW, h: c.natH } : cur;
      const kind = el.dataset.plChrome ?? '';
      const shown = cs.visibility !== 'hidden' && +cs.opacity > 0.01 && cur.w > 0 && cur.h > 0;
      // an overlay (an outline around the plate), a surface (a plate hosted inside this one) and chrome the scene sizes for
      // the floor itself keep their fit size
      const fixed = kind === 'overlay' || el.dataset.plFloor === 'own' || nat.w * nat.h >= SURFACE * W * H;
      list.push({ el, node, anc, cs, kind, band: kind === '' || kind === 'band', shown, box, cur, nat, span: { x: false, y: false }, place: ident(), fixed });
    }
    if (K !== 1) this.layoutFloor(list, K, W, H, key);
    // laid out narrower for the floor, and no longer: back to its own layout
    for (const R of list) { const c = this.comp.get(R.el); if (c && !R.span.x && !R.span.y) { this.uncomp(R.el, c); this.remeasure(R); } }

    const rects: Box[] = [], ins: Insets = { l: 0, t: 0, r: 0, b: 0 }, ins0: Insets = { l: 0, t: 0, r: 0, b: 0 };
    const live = new Set<HTMLElement>();
    const placed: { nat: Box; place: Place }[] = [];
    const deep = (bg: Box, into: Insets) => {
      const wide = bg.w >= W / 2, tall = bg.h >= H / 2;
      if (bg.x <= 0 && tall) into.l = Math.max(into.l, bg.x + bg.w);
      if (bg.x + bg.w >= W && tall) into.r = Math.max(into.r, W - bg.x);
      if (bg.y <= 0 && wide) into.t = Math.max(into.t, bg.y + bg.h);
      if (bg.y + bg.h >= H && wide) into.b = Math.max(into.b, H - bg.y);
    };
    const backdrop = (r: Box): Box => {
      let x0 = r.x - PAD, y0 = r.y - PAD, x1 = r.x + r.w + PAD, y1 = r.y + r.h + PAD;
      if (r.x < SNAP) x0 = 0;
      if (r.y < SNAP) y0 = 0;
      if (W - (r.x + r.w) < SNAP) x1 = W;
      if (H - (r.y + r.h) < SNAP) y1 = H;
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    for (const R of list) {
      const { el, cs, place: pl } = R;
      const d = drawnOf(pl, R.cur);
      placed.push({ nat: R.nat, place: pl });
      let bg: Box | null = null;
      if (R.shown) {
        if (R.band) {
          bg = backdrop(d);
          rects.push(bg);
          deep(bg, ins);
          deep(backdrop(R.nat), ins0);
        } else if (R.kind !== 'overlay') rects.push(d);
      }
      const moved = pl.k !== 1 || pl.x.P !== pl.x.a || pl.y.P !== pl.y.a;
      // boosted, every root is lifted over the backdrops (in its own order), moved or not
      if (!zoomed && !moved && K === 1) continue;
      live.add(el);
      // the counter-transform: a point p the Node transforms put at M(p) is drawn at (P + (M(p) - a) × k) / zoom + view
      let s = this.styled.get(el);
      if (!s) { s = { z: el.style.zIndex, base: parseInt(cs.zIndex, 10) || 0 }; this.styled.set(el, s); }
      const [ox, oy] = cs.transformOrigin.split(' ').map((q) => parseFloat(q) || 0);
      const O = R.anc ? R.anc.map({ x: R.box.x + ox!, y: R.box.y + oy! }) : { x: R.box.x + ox!, y: R.box.y + oy! };
      const sc = pl.k / z;
      const tx = v.x + (pl.x.P - pl.x.a * pl.k) / z - O.x * (1 - sc), ty = v.y + (pl.y.P - pl.y.a * pl.k) / z - O.y * (1 - sc);
      el.style.translate = `${r3(tx)}px ${r3(ty)}px`;
      el.style.scale = String(r4(sc));
      el.style.zIndex = String(Z0 + 2 + Math.max(0, s.base));
      // the band's backdrop: covers the content passing under it, and takes the pointer there
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
        const k = 1 / z;
        Object.assign(b.style, { left: `${r3(v.x + bg.x * k)}px`, top: `${r3(v.y + bg.y * k)}px`, width: `${r3(bg.w * k)}px`, height: `${r3(bg.h * k)}px`, zIndex: String(Z0), opacity: cs.opacity === '1' ? '' : cs.opacity, display: '' });
      } else if (b) b.style.display = 'none';
    }
    this.rects = rects;
    this.placed = placed;
    const cap = (i: Insets): Insets => ({ l: Math.min(i.l, W / 2), r: Math.min(i.r, W / 2), t: Math.min(i.t, H / 2), b: Math.min(i.b, H / 2) });
    this.insets = cap(ins);
    this.insets0 = cap(ins0);
    // chrome that stopped being chrome (or went back to its fit place and size): back as it was
    for (const [el, s] of this.styled) if (!live.has(el)) { el.style.translate = ''; el.style.scale = ''; el.style.zIndex = s.z; this.styled.delete(el); }
    for (const [el, b] of this.backdrops) if (!live.has(el)) { b.remove(); this.backdrops.delete(el); }
    const seen = new Set(list.map((R) => R.el));
    for (const [el, c] of this.comp) if (!seen.has(el)) this.uncomp(el, c);
    this.mask(this.active);
  }

  /** The rect a root covers at fit (stage px): its layout box through its own and its ancestors' Node transforms. */
  private fitRect(node: Node | null, anc: Node | null, box: Box): Box {
    const fitMap = (x: number, y: number) => node ? node.map({ x, y }) : anc ? anc.map({ x, y }) : { x, y };
    const cs4 = [fitMap(box.x, box.y), fitMap(box.x + box.w, box.y), fitMap(box.x, box.y + box.h), fitMap(box.x + box.w, box.y + box.h)];
    const x = Math.min(...cs4.map((c) => c.x)), y = Math.min(...cs4.map((c) => c.y));
    return { x, y, w: Math.max(...cs4.map((c) => c.x)) - x, h: Math.max(...cs4.map((c) => c.y)) - y };
  }

  /** The chrome floor (K above 1; below 1 for a small interface): group the roots, scale each group about the stage edge
   *  it sits at (never past the stage, clamped inside it), and lay roots that span the stage out narrower to keep it. */
  private layoutFloor(list: Root[], K: number, W: number, H: number, key: string) {
    const live = list.filter((R) => !R.fixed);
    // groups: roots of one class (a row of tabs, a list of requests), and roots inside a band (the list on its backdrop)
    const par = live.map((_, i) => i);
    const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i]!)));
    const sig = new Map<string, number>();
    live.forEach((R, i) => {
      const c = R.el.classList[0];
      if (c) { const s = `${R.el.tagName}.${c}`, j = sig.get(s); if (j === undefined) sig.set(s, i); else par[find(i)] = find(j); }
      live.forEach((B, j) => { if (j !== i && B.band && B.nat.w * B.nat.h > R.nat.w * R.nat.h && inside(R.nat, B.nat)) par[find(i)] = find(j); });
    });
    const groups = new Map<number, Root[]>();
    live.forEach((R, i) => { const g = find(i); groups.set(g, [...(groups.get(g) ?? []), R]); });
    const spans = (b: Box) => chromeSpans(b, W, H);
    for (const M of groups.values()) {
      const one = M.length === 1 ? M[0]! : null;
      // a band holding the others (a list's backdrop) doesn't limit the group: it keeps its span around it
      const container = M.length > 1 ? M.find((R) => M.every((o) => o === R || inside(o.nat, R.nat))) ?? null : null;
      if (one) {
        one.span = spans(one.nat);
        const rg = this.rigid.get(one.el);
        if (rg && rg.key === key) one.span = { x: one.span.x && !rg.x, y: one.span.y && !rg.y };
      }
      if (container) { const s = spans(container.nat); container.span = { x: s.x && container.nat.w >= SPAN * W, y: s.y && container.nat.h >= SPAN * H }; }
      const bodies = M.filter((R) => R !== container);
      let k = K;
      const axis = (ext: number, lo: (b: Box) => number, len: (b: Box) => number, spanned: boolean): number | null => {
        if (spanned) return null;
        const s = Math.min(...bodies.map((R) => lo(R.nat))), e = Math.max(...bodies.map((R) => lo(R.nat) + len(R.nat)));
        // the edge it sits at: the start for a group spanning half the stage, else the nearer one
        const A = e - s >= ext / 2 || (s + e) / 2 < ext / 2 ? 0 : ext;
        if (K > 1) k = Math.min(k, Math.max(1, A === 0 ? ext / Math.max(1, e) : ext / Math.max(1, ext - s)));
        return A;
      };
      const Ax = axis(W, (b) => b.x, (b) => b.w, !!one?.span.x), Ay = axis(H, (b) => b.y, (b) => b.h, !!one?.span.y);
      for (const R of M) {
        R.place = { k, x: { a: Ax ?? 0, P: Ax ?? 0 }, y: { a: Ay ?? 0, P: Ay ?? 0 } };
        if (R.span.x || R.span.y) this.spanLayout(R, k, W, H, key);
      }
      // clamp the group inside the stage (along the axes it doesn't span)
      const ds = bodies.map((R) => drawnOf(R.place, R.cur));
      const shift = (lo: number, hi: number, ext: number) => (hi - lo > ext || lo < 0 ? -lo : hi > ext ? ext - hi : 0);
      const dx = Ax === null ? 0 : shift(Math.min(...ds.map((d) => d.x)), Math.max(...ds.map((d) => d.x + d.w)), W);
      const dy = Ay === null ? 0 : shift(Math.min(...ds.map((d) => d.y)), Math.max(...ds.map((d) => d.y + d.h)), H);
      for (const R of M) { if (Ax !== null && !R.span.x) R.place.x.P += dx; if (Ay !== null && !R.span.y) R.place.y.P += dy; }
    }
  }

  /** A root that spans the stage along an axis keeps that span: its margins to the stage edges scale with the boost, and
   *  it is laid out (max-width / max-height) so that, drawn k times larger, it fills what is left. */
  private spanLayout(R: Root, k: number, W: number, H: number, key: string) {
    const n = R.nat, cs = R.cs;
    const target = (s: number, len: number, ext: number) => {
      let a = s * k, b = ext - (ext - s - len) * k;
      if (b - a < len * 0.4) { a = s; b = s + len; }
      return { a, len: (b - a) / k };
    };
    const tx = R.span.x ? target(n.x, n.w, W) : null, ty = R.span.y ? target(n.y, n.h, H) : null;
    // as CSS max sizes, in the element's own box (fit px → layout px; less padding and border for a content box)
    const content = cs.boxSizing !== 'border-box';
    const px = (q: string) => parseFloat(q) || 0;
    const exX = content ? px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth) : 0;
    const exY = content ? px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth) : 0;
    const mw = tx ? `${r3(Math.max(0, (tx.len * R.box.w) / Math.max(1, R.cur.w) - exX))}px` : '';
    const mh = ty ? `${r3(Math.max(0, (ty.len * R.box.h) / Math.max(1, R.cur.h) - exY))}px` : '';
    let c = this.comp.get(R.el);
    const el = R.el, over = () => ({ x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight });
    const fresh = !c, ov0 = fresh ? over() : null;
    if (!c) { c = { key, natW: n.w, natH: n.h, mw: el.style.maxWidth, mh: el.style.maxHeight, set: '' }; this.comp.set(el, c); }
    const set = `${mw}|${mh}`;
    if (c.set !== set) {
      c.set = set;
      el.style.maxWidth = mw || c.mw;
      el.style.maxHeight = mh || c.mh;
      this.remeasure(R);
    }
    // content that doesn't reflow (placed in stage px) would spill out: scale this root whole instead (next frame)
    if (ov0) {
      const ov = over(), rx = !!tx && ov.x - ov0.x > Math.max(4, 0.1 * el.clientWidth), ry = !!ty && ov.y - ov0.y > Math.max(4, 0.1 * el.clientHeight);
      if (rx || ry) {
        this.rigid.set(el, { key, x: rx, y: ry });
        this.uncomp(el, c);
        this.remeasure(R);
        queueMicrotask(() => this.stage.redraw());
      }
    }
    if (tx) R.place.x = { a: R.cur.x, P: tx.a };
    if (ty) R.place.y = { a: R.cur.y, P: ty.a };
  }
  private remeasure(R: Root) {
    R.node?.measure();
    R.box = R.node ? R.node.box : layoutBox(R.el, this.stage.frame);
    R.cur = this.fitRect(R.node, R.anc, R.box);
  }
  private uncomp(el: HTMLElement, c: Comp) {
    el.style.maxWidth = c.mw;
    el.style.maxHeight = c.mh;
    this.comp.delete(el);
  }

  /** The fx layer over the HTML draws above every element: mask it where chrome is drawn. */
  private mask(active: boolean) {
    const c = this.stage.fx.over?.canvas;
    if (!c) return;
    const v = this.stage.view, k = 1 / v.zoom;
    const key = active ? this.rects.map((r) => [r.x, r.y, r.w, r.h].map((q) => r3(q * k)).join(',')).join(';') + `|${r3(this.stage.W * k)},${r3(this.stage.H * k)}` : '';
    if (key === this.maskKey) return;
    this.maskKey = key;
    if (!active) { c.style.removeProperty('mask'); c.style.removeProperty('-webkit-mask'); return; }
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
