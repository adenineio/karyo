// The pinned inspector: page chrome beside a plate, outside the scaled stage, where a scene shows the details
// it would otherwise show inside the plate (docs/ENGINE.md, "Pinned inspector"). The engine owns the frame (its
// side, width, the pin / lock / side controls, the resize edge, the saved preferences) and the space it takes:
// the Stage fits the plate into what is left. What the dock shows is the scene's: it writes `body` and says
// whether there is something to lock (`subject`). Nothing here knows what a card or a section is.
import { clamp } from './util';

export type DockSide = 'left' | 'right';
export type DockChange = 'pin' | 'lock' | 'side' | 'width' | 'place';

/** Sizes (CSS px): the narrowest a dock gets, the share of the window it may take at most, the gap to the plate. */
export const DOCK = { min: 320, maxFrac: 0.6, gap: 12, pad: 16, width: 540 } as const;
const SK = 'karyo:inspector';

const svg = (d: string) => `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">${d}</svg>`;
/** The dock's icons (inline SVG in currentColor, so they take the theme's tokens); `pin` also marks a scene's own pin button. */
export const DOCK_ICON = {
  pin: svg('<path d="M5.4 1.5h5.2l-.9 4.3 2.8 2.7v1.3H8.7v4.7L8 15.2l-.7-.7V9.8H3.5V8.5l2.8-2.7z" fill="currentColor"/>'),
  lock: svg('<rect x="3" y="7" width="10" height="7.5" rx="1.2" fill="currentColor"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="currentColor" stroke-width="1.6"/>'),
  unlock: svg('<rect x="3" y="7" width="10" height="7.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.5-.7" fill="none" stroke="currentColor" stroke-width="1.6"/>'),
  side: svg('<path d="M1.5 8h13M4.5 5 1.5 8l3 3M11.5 5l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>'),
};

/** What the Stage gives the dock: whether it can show now (theater, fill, or a host page), and a change hook. */
export interface DockOwner { dockAvailable(): boolean; dockChanged(what: DockChange): void }

export class Dock {
  readonly el: HTMLElement;
  /** The scene's content goes here (a flex column that fills the dock under its header). */
  readonly body: HTMLElement;
  pinned = false;
  locked = false;
  side: DockSide = 'right';
  /** The width the viewer chose (CSS px); `px()` is what it gets in the current window. */
  width: number = DOCK.width;
  /** Placed by a host page into its own layout (Jarvis) rather than the plate's theater / fill overlay. */
  hosted = false;
  /** What the dock shows (a label), or null while it shows a hint: the lock needs something to hold. */
  subject: string | null = null;
  private title: HTMLElement;
  private btn: { lock: HTMLButtonElement; side: HTMLButtonElement; pin: HTMLButtonElement };
  private grip: HTMLElement;

  constructor(private owner: DockOwner) {
    this.load();
    const el = this.el = document.createElement('aside');
    el.className = 'plate-dock';
    el.setAttribute('aria-label', 'Inspector');
    el.innerHTML = `<div class="plate-dock-grip" role="separator" aria-orientation="vertical" aria-label="Resize the inspector" tabindex="0"></div>
      <div class="plate-dock-head"><span class="plate-dock-title">Inspector</span>
        <button type="button" class="plate-dock-btn" data-dock="lock"></button>
        <button type="button" class="plate-dock-btn" data-dock="side"></button>
        <button type="button" class="plate-dock-btn" data-dock="pin" aria-pressed="true" title="Unpin: the inspector goes back into the plate (i)" aria-label="Unpin the inspector">${DOCK_ICON.pin}</button></div>
      <div class="plate-dock-body"></div>`;
    const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
    this.title = q('.plate-dock-title');
    this.body = q('.plate-dock-body');
    this.grip = q('.plate-dock-grip');
    this.btn = { lock: q('[data-dock="lock"]'), side: q('[data-dock="side"]'), pin: q('[data-dock="pin"]') };
    this.btn.lock.addEventListener('click', () => this.lock());
    this.btn.side.addEventListener('click', () => this.setSide(this.side === 'right' ? 'left' : 'right'));
    this.btn.pin.addEventListener('click', () => this.pin(false));
    this.bindGrip();
    this.sync();
  }

  /** The host can show it now (the plate fills the window, or a page placed it). */
  get available() { return this.owner.dockAvailable(); }
  /** Pinned and available: on screen, taking its space. */
  get shown() { return this.pinned && this.available; }
  /** Its width in this window: the viewer's choice, kept between `DOCK.min` and `DOCK.maxFrac` of the window. */
  px(winW = innerWidth) { const max = Math.floor(winW * DOCK.maxFrac); return Math.round(clamp(this.width, Math.min(DOCK.min, max), max)); }
  /** The width it takes from the plate's space (0 when not shown). */
  reserve(winW = innerWidth) { return this.shown ? this.px(winW) + DOCK.gap : 0; }

  /** Pin (or unpin) it; unpinning also unlocks. False when nothing changed. */
  pin(on = !this.pinned): boolean {
    if (on === this.pinned) return false;
    this.pinned = on;
    if (!on) this.locked = false;
    this.save(); this.sync();
    this.owner.dockChanged('pin');
    return true;
  }
  /** Lock it on what it shows (it stops following), or unlock. Locking needs something shown. */
  lock(on = !this.locked): boolean {
    if (on === this.locked) return true;
    if (on && (!this.shown || this.subject === null)) return false;
    this.locked = on;
    this.sync();
    this.owner.dockChanged('lock');
    return true;
  }
  setSide(side: DockSide) {
    if (side === this.side) return;
    this.side = side;
    this.save(); this.sync();
    this.owner.dockChanged('side');
  }
  /** Resize (CSS px); `persist` false while dragging, true when let go. */
  setWidth(w: number, persist = true) {
    const nw = Math.round(clamp(w, DOCK.min, Math.max(DOCK.min, innerWidth * DOCK.maxFrac)));
    const changed = nw !== this.width;
    this.width = nw;
    if (persist) this.save();
    if (!changed) return;
    this.sync();
    this.owner.dockChanged('width');
  }
  /** A host page's own layout (Jarvis) takes the dock; null gives it back to the plate. */
  place(parent: HTMLElement, hosted: boolean) {
    this.hosted = hosted;
    parent.append(this.el);
    this.sync();
    this.owner.dockChanged('place');
  }
  /** The scene shows something lockable (a label for the header), or null: `hint` fills the body instead. */
  setSubject(label: string | null, hint = '') {
    if (label === null) {
      const h = `<p class="plate-dock-hint">${hint.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</p>`;
      if (this.subject !== null || this.body.innerHTML !== h) this.body.innerHTML = h;
    }
    if (label === this.subject) return;
    this.subject = label;
    this.sync();
  }

  /** Attributes and control states follow the fields (called after every change). */
  sync() {
    const el = this.el;
    el.hidden = !this.shown;
    el.dataset.side = this.side;
    el.classList.toggle('is-locked', this.locked);
    el.style.setProperty('--dock-w', `${this.px()}px`);
    this.title.textContent = this.locked ? `Inspector · locked${this.subject ? ` on ${this.subject}` : ''}` : 'Inspector';
    const b = this.btn;
    b.lock.innerHTML = this.locked ? DOCK_ICON.lock : DOCK_ICON.unlock;
    b.lock.setAttribute('aria-pressed', String(this.locked));
    b.lock.disabled = !this.locked && this.subject === null;
    b.lock.title = this.locked ? 'Unlock: follow the card you open again' : this.subject === null ? 'Lock: open something first' : `Lock on ${this.subject} while you look around`;
    b.lock.setAttribute('aria-label', this.locked ? 'Unlock the inspector' : 'Lock the inspector on what it shows');
    b.side.innerHTML = DOCK_ICON.side;
    b.side.title = `Move the inspector to the ${this.side === 'right' ? 'left' : 'right'}`;
    b.side.setAttribute('aria-label', b.side.title);
    this.grip.setAttribute('aria-valuenow', String(this.px()));
    this.grip.setAttribute('aria-valuemin', String(DOCK.min));
    this.grip.setAttribute('aria-valuemax', String(Math.floor(innerWidth * DOCK.maxFrac)));
  }

  // ------------------------------------------------------------ resize: drag the inner edge (or arrow keys on it)
  private bindGrip() {
    const g = this.grip;
    let drag: { id: number } | null = null, raf = 0, want = 0;
    const apply = () => { raf = 0; this.setWidth(want, false); };
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag = { id: e.pointerId };
      g.setPointerCapture(e.pointerId);
      this.el.classList.add('is-resizing');
    });
    g.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = this.el.getBoundingClientRect();
      want = this.side === 'right' ? r.right - e.clientX : e.clientX - r.left;
      if (!raf) raf = requestAnimationFrame(apply);
    });
    const end = (e: PointerEvent) => {
      if (!drag) return;
      drag = null;
      if (raf) { cancelAnimationFrame(raf); apply(); }
      if (g.hasPointerCapture(e.pointerId)) g.releasePointerCapture(e.pointerId);
      this.el.classList.remove('is-resizing');
      this.save();
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
    g.addEventListener('keydown', (e) => {
      const grow = this.side === 'right' ? 'ArrowLeft' : 'ArrowRight', shrink = this.side === 'right' ? 'ArrowRight' : 'ArrowLeft';
      if (e.key !== grow && e.key !== shrink) return;
      e.preventDefault(); e.stopPropagation();
      this.setWidth(this.px() + (e.key === grow ? 1 : -1) * (e.shiftKey ? 64 : 16));
    });
  }

  // ------------------------------------------------------------ preferences (this browser)
  private load() {
    try {
      const v = JSON.parse(localStorage.getItem(SK) ?? 'null');
      if (!v || typeof v !== 'object') return;
      if (typeof v.pinned === 'boolean') this.pinned = v.pinned;
      if (v.side === 'left' || v.side === 'right') this.side = v.side;
      if (typeof v.width === 'number' && Number.isFinite(v.width)) this.width = Math.max(DOCK.min, Math.round(v.width));
    } catch { /* storage unavailable: defaults */ }
  }
  private save() {
    try { localStorage.setItem(SK, JSON.stringify({ pinned: this.pinned, side: this.side, width: this.width })); } catch { /* not persisted */ }
  }
}
