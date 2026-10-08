// A Node wraps one real HTML element in the stage. Scenes animate it by setting plain
// properties every frame (x, y, scale, rotate, opacity, CSS variables, classes, text); the
// stage resets them to rest before each frame and writes only what changed, so the element's
// look is always a pure function of time. The node also knows where the element is on screen
// (its layout box plus its own and its ancestors' animated transforms), which is what lets the
// fx layer wire, outline or light real elements.
import type { P, Side } from './geom';

export interface Box { x: number; y: number; w: number; h: number }

export class Node {
  // ---- animated properties (reset to these rest values before every frame)
  x = 0; y = 0;
  scale = 1; sx = 1; sy = 1;
  /** Degrees. */
  rotate = 0;
  opacity = 1;
  /** px of CSS blur (0 = none). */
  blur = 0;
  /** Hide completely (visibility: hidden) — cheaper than opacity 0 and removes it from hit tests. */
  hidden = false;
  /** CSS custom properties to set this frame, e.g. { '--k': 0.5 }. */
  vars: Record<string, string | number> = {};
  /** Classes to toggle on this frame (true = add). Classes not listed are left as authored. */
  classes: Record<string, boolean> = {};
  /** Replace the text content this frame (null = leave the authored text). */
  text: string | null = null;

  /** Layout box in stage px, ignoring all transforms (measured by the stage every frame). */
  box: Box = { x: 0, y: 0, w: 0, h: 0 };
  /** Nearest ancestor Node (its transform also moves this element). */
  parent: Node | null = null;

  private written = { transform: '', opacity: '', filter: '', visibility: '', text: null as string | null };
  private writtenVars: Record<string, string> = {};
  private writtenClasses: Record<string, boolean> = {};
  private authoredText: string;

  constructor(readonly el: HTMLElement, readonly frame: HTMLElement) {
    this.authoredText = el.textContent ?? '';
    // every node is its children's offsetParent and containing block, so offsets add up exactly
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  }

  /** Back to rest (the engine calls this before each frame). */
  reset() {
    this.x = this.y = this.rotate = this.blur = 0;
    this.scale = this.sx = this.sy = this.opacity = 1;
    this.hidden = false;
    this.vars = {}; this.classes = {}; this.text = null;
  }

  /** Set several properties at once; returns this. */
  set(p: Partial<Pick<Node, 'x' | 'y' | 'scale' | 'sx' | 'sy' | 'rotate' | 'opacity' | 'blur' | 'hidden' | 'text'>>) { Object.assign(this, p); return this; }

  /** Write changed properties to the element (engine, after the scene's update). */
  flush() {
    const s = this.el.style;
    const tf = this.x || this.y || this.rotate || this.scale !== 1 || this.sx !== 1 || this.sy !== 1
      ? `translate(${r3(this.x)}px, ${r3(this.y)}px) rotate(${r3(this.rotate)}deg) scale(${r4(this.scale * this.sx)}, ${r4(this.scale * this.sy)})` : '';
    if (tf !== this.written.transform) { s.transform = tf; this.written.transform = tf; }
    const op = this.opacity >= 1 ? '' : String(r4(Math.max(0, this.opacity)));
    if (op !== this.written.opacity) { s.opacity = op; this.written.opacity = op; }
    const fl = this.blur > 0.01 ? `blur(${r3(this.blur)}px)` : '';
    if (fl !== this.written.filter) { s.filter = fl; this.written.filter = fl; }
    const vis = this.hidden ? 'hidden' : '';
    if (vis !== this.written.visibility) { s.visibility = vis; this.written.visibility = vis; }
    const tx = this.text ?? this.authoredText;
    if (tx !== (this.written.text ?? this.authoredText)) { this.el.textContent = tx; this.written.text = tx; }
    // vars: set listed ones, clear ones set last frame but not this one
    for (const k in this.writtenVars) if (!(k in this.vars)) { s.removeProperty(k); delete this.writtenVars[k]; }
    for (const k in this.vars) {
      const v = String(this.vars[k]);
      if (this.writtenVars[k] !== v) { s.setProperty(k, v); this.writtenVars[k] = v; }
    }
    for (const k in this.writtenClasses) if (!(k in this.classes)) { this.el.classList.toggle(k, false); delete this.writtenClasses[k]; }
    for (const k in this.classes) {
      const v = !!this.classes[k];
      if (this.writtenClasses[k] !== v) { this.el.classList.toggle(k, v); this.writtenClasses[k] = v; }
    }
  }

  /** Measure the layout box (stage px, transforms ignored): offsets up to the stage frame. */
  measure() { this.box = layoutBox(this.el, this.frame); }

  /** Map a point in layout space (stage px) through this node's transform and its ancestors'. (Chrome is in the plate's
   *  fit coordinates whatever the viewer's zoom: `stage.chrome.pt()` says where such a point is drawn while zoomed.) */
  map(p: P): P {
    let q = p;
    for (let n: Node | null = this; n; n = n.parent) q = n.mapOwn(q);
    return q;
  }
  private mapOwn(p: P): P {
    const cx = this.box.x + this.box.w / 2, cy = this.box.y + this.box.h / 2;
    const a = (this.rotate * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const dx = (p.x - cx) * this.scale * this.sx, dy = (p.y - cy) * this.scale * this.sy;
    return { x: cx + this.x + dx * c - dy * s, y: cy + this.y + dx * s + dy * c };
  }

  /**
   * A point on the element as it appears now: (u, v) in 0..1 of its box (0.5, 0.5 = centre) or a
   * side name ('left' = middle of the left edge, …), pushed out by `gap` px along that side.
   */
  at(u: number | Side, v = 0.5, gap = 0): P {
    let uu: number, vv: number, nx = 0, ny = 0;
    if (typeof u === 'string') {
      [uu, vv] = { left: [0, 0.5], right: [1, 0.5], top: [0.5, 0], bottom: [0.5, 1], center: [0.5, 0.5] }[u] as [number, number];
      [nx, ny] = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1], center: [0, 0] }[u] as [number, number];
      if (typeof v === 'number' && v !== 0.5) { if (u === 'left' || u === 'right') vv = v; else uu = v; }
    } else { uu = u; vv = v; }
    const b = this.box;
    const p = this.map({ x: b.x + uu * b.w, y: b.y + vv * b.h });
    if (!gap) return p;
    const o = this.map({ x: b.x + uu * b.w + nx, y: b.y + vv * b.h + ny });
    const l = Math.hypot(o.x - p.x, o.y - p.y) || 1;
    return { x: p.x + ((o.x - p.x) / l) * gap, y: p.y + ((o.y - p.y) / l) * gap };
  }
  /** Current on-screen centre. */
  get center(): P { return this.at(0.5, 0.5); }
  /** Axis-aligned bounds of the element as it appears now (padded by `pad` px). */
  bounds(pad = 0): Box {
    const b = this.box, cs = [this.map({ x: b.x, y: b.y }), this.map({ x: b.x + b.w, y: b.y }), this.map({ x: b.x, y: b.y + b.h }), this.map({ x: b.x + b.w, y: b.y + b.h })];
    const x0 = Math.min(...cs.map((c) => c.x)), x1 = Math.max(...cs.map((c) => c.x)), y0 = Math.min(...cs.map((c) => c.y)), y1 = Math.max(...cs.map((c) => c.y));
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  }
}

/** An element's layout box in stage px (transforms ignored): offsets up to the stage frame. */
export function layoutBox(el: HTMLElement, frame: HTMLElement): Box {
  let x = 0, y = 0, e: HTMLElement | null = el;
  while (e && e !== frame) {
    x += e.offsetLeft; y += e.offsetTop;
    const op = e.offsetParent as HTMLElement | null;
    // scrolled containers between the element and its offset parent
    for (let a: HTMLElement | null = e.parentElement; a && a !== op && a !== frame; a = a.parentElement) { x -= a.scrollLeft; y -= a.scrollTop; }
    if (op && op !== frame && !frame.contains(op)) { e = null; break; }
    e = op;
  }
  if (e !== frame) {
    // offsetParent chain escaped the frame (e.g. a fixed element): fall back to client rects
    const r = el.getBoundingClientRect(), f = frame.getBoundingClientRect(), k = frame.offsetWidth / (f.width || 1);
    return { x: (r.left - f.left) * k, y: (r.top - f.top) * k, w: r.width * k, h: r.height * k };
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
