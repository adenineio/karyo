// Zoom and pan: the viewer's view of an interactive plate (docs/ENGINE.md "Zoom and pan").
//
// The Stage fits its logical canvas to the space it has (`scale`); the view multiplies that by the viewer's zoom
// (1 = fit … ZOOM_MAX) and pans it. It is view state only: the scene never sees it (a frame is still a pure function of
// t), stills and lint render at fit unless a state sets `view`, and the fit / theater / resize logic composes with it
// (a resize keeps the zoom relative to fit; reset goes back to fit).
//
// View = { zoom, x, y }: x, y are the stage px at the viewport's top-left corner, so a resize keeps the same content in
// view. At zoom 1, x = y = 0 (the whole plate). The Stage owns the transform and the fx layers (which redraw only the
// visible part of the stage, at the zoomed pixel density, so hairlines and halos stay sharp); this class owns the
// gestures and the zoom control:
//   - ctrl + wheel (a trackpad pinch) and ⌘/Ctrl + mouse wheel zoom around the pointer;
//   - a plain wheel / two-finger scroll pans while zoomed in, and scrolls the page at fit;
//   - a drag on blank space pans (the engine's backdrop, anything marked `data-pl-blank`, and what the scene's
//     `isBlank(e, byDefault)` hook allows); Space + drag and a middle-button drag pan from anywhere;
//   - `+` / `=`, `-`, `0` (reset to fit) on the focused plate;
//   - a small − 100% + control in the viewport's corner (on hover and focus, and always while zoomed).
import type { Stage } from './stage';
import { clamp } from './util';

export interface View {
  /** Zoom relative to fit: 1 = the whole plate … ZOOM_MAX. */
  zoom: number;
  /** The stage px at the viewport's top-left corner. */
  x: number;
  y: number;
}
type Pt = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };
export const ZOOM_MAX = 4;
const STEP = 1.25;
/** CSS px a press on blank space travels before it becomes a pan (below it, it is still a click). */
const THRESHOLD = 4;

export class ViewCtl {
  zoom = 1;
  x = 0;
  y = 0;
  /** Gestures and the zoom control (off in export mode and for a plate hosted inside another). */
  readonly enabled: boolean;
  private ui: { box: HTMLElement; pct: HTMLButtonElement; minus: HTMLButtonElement; plus: HTMLButtonElement } | null = null;
  private listeners = new Set<(v: View) => void>();
  private over = false;
  private space: { e: KeyboardEvent; used: boolean } | null = null;
  private panning = false;
  private storeKey: string | null = null;

  constructor(private readonly stage: Stage, o: { enabled: boolean; storeKey?: string | null }) {
    this.enabled = o.enabled;
    if (!this.enabled) return;
    this.storeKey = o.storeKey ?? null;
    const vp = stage.viewport;
    // a plate hosted inside this one that zooms on its own (a board's stack of splices) keeps its gestures
    vp.classList.add('pl-zoomable');
    vp.addEventListener('wheel', this.onZoomWheel, { passive: false, capture: true });
    vp.addEventListener('wheel', this.onPanWheel, { passive: false });
    vp.addEventListener('pointerdown', this.onForcedDown, true);
    vp.addEventListener('pointerdown', this.onBlankDown);
    vp.addEventListener('pointermove', this.onHover);
    vp.addEventListener('pointerenter', () => { this.over = true; });
    vp.addEventListener('pointerleave', () => { this.over = false; vp.classList.remove('pl-grab'); });
    addEventListener('keydown', this.onSpaceDown, true);
    addEventListener('keyup', this.onSpaceUp, true);
    addEventListener('blur', this.disarm);
    this.buildUi();
  }

  // ---------------------------------------------------------------- the view
  get(): View { return { zoom: this.zoom, x: this.x, y: this.y }; }
  get zoomed() { return this.zoom > 1 + 1e-6; }
  /** The part of the stage on screen (stage px). */
  rect() { return { x: this.x, y: this.y, w: this.stage.W / this.zoom, h: this.stage.H / this.zoom }; }
  /** The part of the stage on screen that no chrome band covers (stage px): the visible part less the bands along its
   *  edges (docs/ENGINE.md "Zoom and pan"). At fit, `rect()`. */
  clear() {
    const v = this.rect();
    if (!this.zoomed) return v;
    const i = this.stage.chrome.insets, k = 1 / this.zoom;
    return { x: v.x + i.l * k, y: v.y + i.t * k, w: Math.max(40, v.w - (i.l + i.r) * k), h: Math.max(40, v.h - (i.t + i.b) * k) };
  }
  /** Place a card the scene shows beside the pointer (a hover card, w×h stage px at fit) inside the visible part of the
   *  stage, clear of the chrome, at its fit size on screen however far in: `place` is the scene's own placement over a
   *  W×H area (avoiding `avoid`). Returns the Node's x, y and scale. At fit it is exactly `place(at, w, h, W, H, avoid)`. */
  overlay(at: Pt, w: number, h: number, avoid: Box[], place: (at: Pt, w: number, h: number, W: number, H: number, avoid: Box[]) => Pt): { x: number; y: number; scale: number } {
    if (!this.zoomed) return { ...place(at, w, h, this.stage.W, this.stage.H, avoid), scale: 1 };
    const v = this.clear(), k = 1 / this.zoom;
    const rel = (r: Box) => ({ x: r.x - v.x, y: r.y - v.y, w: r.w, h: r.h });
    const p = place({ x: at.x - v.x, y: at.y - v.y }, w * k, h * k, v.w, v.h, [...avoid, ...this.stage.chrome.shown()].map(rel));
    // a Node scales around its centre: shift so the scaled card's corner lands on p
    return { x: p.x + v.x - (w * (1 - k)) / 2, y: p.y + v.y - (h * (1 - k)) / 2, scale: k };
  }
  /** Follow the view (the zoom control, a host page). Returns an unsubscribe. */
  onChange(fn: (v: View) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Set the view (clamped: zoom 1 … ZOOM_MAX, and the plate always covers the viewport). */
  set(v: Partial<View>) {
    const z = clamp(finite(v.zoom, this.zoom), 1, ZOOM_MAX);
    const b = this.bounds(z, this.stage.W, this.stage.H);
    const x = clamp(finite(v.x, this.x), b.x0, b.x1), y = clamp(finite(v.y, this.y), b.y0, b.y1);
    if (z === this.zoom && x === this.x && y === this.y) return;
    this.zoom = z; this.x = x; this.y = y;
    this.stage.applyView();
    this.changed();
  }
  /** Back to fit. */
  reset() { this.set({ zoom: 1, x: 0, y: 0 }); }
  /** Zoom to `z`, keeping the stage point under a client point where it is (default: the viewport's centre). */
  zoomTo(z: number, clientX?: number, clientY?: number) {
    const r = this.stage.viewport.getBoundingClientRect();
    const cx = clientX ?? r.left + r.width / 2, cy = clientY ?? r.top + r.height / 2;
    const p = this.stage.toStage(cx, cy), z1 = clamp(z, 1, ZOOM_MAX);
    this.set({ zoom: z1, x: p.x - ((p.x - this.x) * this.zoom) / z1, y: p.y - ((p.y - this.y) * this.zoom) / z1 });
  }
  zoomIn(clientX?: number, clientY?: number) { this.zoomTo(this.zoom * STEP, clientX, clientY); }
  zoomOut(clientX?: number, clientY?: number) { this.zoomTo(this.zoom / STEP, clientX, clientY); }
  /** Move the view by a screen distance (CSS px): the content follows the pointer. */
  panBy(dx: number, dy: number) { const S = this.stage.zoom; this.set({ x: this.x - dx / S, y: this.y - dy / S }); }
  /** Centre a stage-px box and zoom so it fills about half the view (or to `zoom`). */
  focusBox(b: { x: number; y: number; w: number; h: number }, zoom?: number) {
    const W = this.stage.W, H = this.stage.H;
    const z = clamp(zoom ?? Math.min(2.5, (W * 0.5) / Math.max(1, b.w), (H * 0.5) / Math.max(1, b.h)), zoom ? 1 : 1.5, ZOOM_MAX);
    this.set({ zoom: z, x: b.x + b.w / 2 - W / z / 2, y: b.y + b.h / 2 - H / z / 2 });
  }
  /** Centre an element of the plate (measured on screen, so any transform counts). */
  focusEl(el: Element, zoom?: number) {
    const r = el.getBoundingClientRect(), S = this.stage.zoom, p = this.stage.toStage(r.left, r.top);
    this.focusBox({ x: p.x, y: p.y, w: r.width / S, h: r.height / S }, zoom);
  }
  /** Keep the view inside a new logical size (the theater's relayout) without redrawing. */
  clampTo(W: number, H: number) {
    const b = this.bounds(this.zoom, W, H);
    this.x = clamp(this.x, b.x0, b.x1); this.y = clamp(this.y, b.y0, b.y1);
  }
  /** Where the view's top-left may go at zoom z: the plate covers the viewport, and where chrome bands run along an edge
   *  the view may pan past it by up to the band's depth (never so far that the stage's edge leaves the band's inner edge),
   *  so every edge of the content can be brought out from under the chrome. */
  private bounds(z: number, W: number, H: number) {
    const i = this.stage.chrome?.insets ?? { l: 0, t: 0, r: 0, b: 0 }, f = z > 1 ? Math.min(1 / z, 1 - 1 / z) : 0;
    return { x0: -i.l * f, x1: W - W / z + i.r * f, y0: -i.t * f, y1: H - H / z + i.b * f };
  }
  /** Restore the view this tab last had for the plate (sessionStorage), once the plate is laid out. */
  restore() {
    if (!this.storeKey) return;
    try {
      const v = JSON.parse(sessionStorage.getItem(this.storeKey) ?? 'null');
      if (v && typeof v === 'object') this.set(v);
    } catch { /* storage unavailable */ }
  }

  private changed() {
    const v = this.get();
    this.stage.viewport.classList.toggle('is-zoomed', this.zoomed);
    if (!this.zoomed) this.stage.viewport.classList.remove('pl-grab');
    this.syncUi();
    if (this.storeKey) { try { if (this.zoomed) sessionStorage.setItem(this.storeKey, JSON.stringify(v)); else sessionStorage.removeItem(this.storeKey); } catch { /* not kept */ } }
    for (const l of this.listeners) l(v);
  }

  // ---------------------------------------------------------------- keys (called by the Stage for the focused plate)
  /** `+` / `=` zoom in, `-` zooms out, `0` resets to fit. True when handled. */
  key(e: KeyboardEvent): boolean {
    if (!this.enabled || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || !this.mine(e.target)) return false;
    if (e.key === '+' || e.key === '=') this.zoomIn();
    else if (e.key === '-' || e.key === '_') this.zoomOut();
    else if (e.key === '0') this.reset();
    else return false;
    return true;
  }
  /** Space held over a zoomed plate arms a pan from anywhere; Space's own meaning (play, open) runs on release when it
   *  never panned. */
  private onSpaceDown = (e: KeyboardEvent) => {
    if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (this.space) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.repeat || !this.over || !this.zoomed || typing(e.target) || isControl(e.target) || !this.mine(e.target)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    this.space = { e, used: false };
    this.stage.viewport.classList.add('pl-space');
  };
  private onSpaceUp = (e: KeyboardEvent) => {
    if (e.key !== ' ' || !this.space) return;
    const s = this.space;
    this.disarm();
    e.preventDefault(); e.stopImmediatePropagation();
    const t = s.e.target as globalThis.Node | null;
    if (!s.used && t && (this.stage.viewport.contains(t) || this.stage.dock?.el.contains(t))) this.stage.replayKey(s.e);
  };
  private disarm = () => { this.space = null; this.stage.viewport.classList.remove('pl-space'); };

  /** Is this event this plate's to zoom or pan, rather than a zoomable plate hosted inside it? */
  private mine(t: EventTarget | null) {
    const vp = (t as Element | null)?.closest?.('.plate-viewport.pl-zoomable');
    return !vp || vp === this.stage.viewport || !this.stage.viewport.contains(vp);
  }

  // ---------------------------------------------------------------- wheel
  /** ctrl + wheel (pinch) and ⌘ + wheel zoom around the pointer, anywhere on the plate. */
  private onZoomWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey) || !this.mine(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    const d = clamp(wheelPx(e).dy, -100, 100);
    this.zoomTo(this.zoom * Math.pow(2, -d / 150), e.clientX, e.clientY);
  };
  /** A plain wheel pans while zoomed in (a region that scrolls itself keeps the wheel); at fit the page scrolls. */
  private onPanWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey || !this.zoomed || e.defaultPrevented || !this.mine(e.target)) return;
    let { dx, dy } = wheelPx(e);
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    if (scrollsItself(e.target as Element | null, this.stage.viewport, dx, dy)) return;
    e.preventDefault();
    this.panBy(-dx, -dy);
  };

  // ---------------------------------------------------------------- drag to pan
  /** Is a press here on blank space? The engine's backdrop (viewport, frame, the scene's root) and elements marked
   *  `data-pl-blank`, then the scene's `isBlank(e, byDefault)` hook (a wire drawn on the fx layer is not blank). */
  isBlank(e: PointerEvent): boolean {
    const t = e.target as HTMLElement | null, s = this.stage;
    const d = !!t && (t === s.viewport || t === s.frame || t === s.dom || t.classList.contains('plate-fx') || t.hasAttribute('data-pl-blank'));
    if (!s.isReady) return d;
    try { return s.scene.isBlank?.(e, d) ?? d; } catch { return d; }
  }
  private onHover = (e: PointerEvent) => {
    if (this.panning || e.buttons) return;
    this.stage.viewport.classList.toggle('pl-grab', this.zoomed && this.isBlank(e));
  };
  /** Space + drag and a middle-button drag pan from anywhere (capture: nothing under the pointer sees the press). */
  private onForcedDown = (e: PointerEvent) => {
    if (!this.zoomed || !((e.button === 0 && this.space) || e.button === 1) || !this.mine(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    if (this.space) this.space.used = true;
    this.begin(e, true);
  };
  /** A press on blank space pans once it moves; a click that never moves keeps its meaning. */
  private onBlankDown = (e: PointerEvent) => {
    if (!this.zoomed || e.button !== 0 || this.panning || !this.mine(e.target) || !this.isBlank(e)) return;
    // no text selection from a press on the backdrop; focus as a press would
    e.preventDefault();
    this.stage.viewport.focus({ preventScroll: true });
    this.begin(e, false);
  };
  private begin(e: PointerEvent, now: boolean) {
    const vp = this.stage.viewport, sx = e.clientX, sy = e.clientY, x0 = this.x, y0 = this.y;
    let moving = now;
    this.panning = true;
    if (now) vp.classList.add('is-panning');
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!moving) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
        moving = true;
        vp.classList.add('is-panning');
      }
      // nothing else sees a pan's moves (no wire hover, no hover cards while the view slides)
      ev.stopPropagation();
      const S = this.stage.zoom;
      this.set({ x: x0 - (ev.clientX - sx) / S, y: y0 - (ev.clientY - sy) / S });
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      removeEventListener('pointermove', move, true); removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true);
      this.panning = false;
      vp.classList.remove('is-panning');
      if (!moving) return;
      // a pan is not a click: eat the click this release makes
      const eat = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
      addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', eat, true), 0);
    };
    addEventListener('pointermove', move, true); addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
  }

  // ---------------------------------------------------------------- the zoom control
  private buildUi() {
    const box = document.createElement('div');
    box.className = 'plate-zoom';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Zoom');
    const btn = (cls: string, text: string, title: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = cls; b.textContent = text; b.title = title; b.setAttribute('aria-label', title);
      b.addEventListener('click', fn);
      box.append(b);
      return b;
    };
    const minus = btn('plate-zoom-out', '−', 'Zoom out (-)', () => this.zoomOut());
    const pct = btn('plate-zoom-pct', '100%', 'Reset to fit (0)', () => this.reset());
    const plus = btn('plate-zoom-in', '+', 'Zoom in (+; pinch or ⌘/Ctrl + wheel)', () => this.zoomIn());
    this.stage.viewport.append(box);
    this.ui = { box, pct, minus, plus };
    this.syncUi();
  }
  private syncUi() {
    const u = this.ui;
    if (!u) return;
    u.pct.textContent = `${Math.round(this.zoom * 100)}%`;
    u.minus.disabled = !this.zoomed;
    u.plus.disabled = this.zoom >= ZOOM_MAX - 1e-6;
  }

  dispose() {
    if (!this.enabled) return;
    removeEventListener('keydown', this.onSpaceDown, true);
    removeEventListener('keyup', this.onSpaceUp, true);
    removeEventListener('blur', this.disarm);
    this.ui?.box.remove();
  }
}

const finite = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** A wheel event's movement in CSS px, whatever its unit. */
function wheelPx(e: WheelEvent) {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
  return { dx: e.deltaX * k, dy: e.deltaY * k };
}
/** Does an element between the target and the viewport scroll in this direction on its own (a details body)? */
function scrollsItself(t: Element | null, stop: Element, dx: number, dy: number) {
  for (let e = t; e && e !== stop; e = e.parentElement) {
    const cs = getComputedStyle(e);
    const oy = /(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1;
    const ox = /(auto|scroll)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1;
    if (oy && ((dy > 0 && e.scrollTop + e.clientHeight < e.scrollHeight - 1) || (dy < 0 && e.scrollTop > 0))) return true;
    if (ox && ((dx > 0 && e.scrollLeft + e.clientWidth < e.scrollWidth - 1) || (dx < 0 && e.scrollLeft > 0))) return true;
  }
  return false;
}
function typing(t: EventTarget | null) { const e = t as HTMLElement | null; return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable); }
function isControl(t: EventTarget | null) { const e = t as HTMLElement | null; return !!e && (e.tagName === 'BUTTON' || e.tagName === 'A'); }
