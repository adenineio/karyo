// The stack of splices on the structure board (docs/ENGINE.md "Stack of splices"): the board lifts a Stack view
// (src/model/stack.ts, the same plate the history uses) over itself, laid out for the board's own size, so the real
// view and every splice can be compared side by side in depth; a click on a slice brings that splice back to the
// board to edit. This file is the host: it mounts that plate inside the board's (so stills, lint and the theater see
// one plate), keeps its keys and pointer events from reaching the board underneath, and shows the one question the
// stack asks (a combined slice is read-only: open which part?). Shape-neutral: the words come from the caller.
import { mount, settleChrome, fitScaleOf, type SceneClass, type Stage } from '../engine';
import { esc } from './scenes';
import type { StackApi, StackState } from './stack';

export interface StackHostOpts {
  /** Render it frame by frame from the board (stills, lint) rather than on its own clock. */
  preserve: boolean;
  /** Esc that the stack itself didn't use (nothing to collapse or unpin): leave the stack. */
  onEscape: () => void;
  /** The stack drew a frame whose state differs from the last one (the page's view of the board changed). */
  onChange: () => void;
  /** A key the board still owns while the stack shows (the theater's `f`). */
  onKey?: (e: KeyboardEvent) => boolean;
  /** CSS px per board px at the board's fit (the stack is drawn at its own fit inside the board, times this). */
  scale?: () => number;
}

/** One stack over the board, while it shows. `el` sits over the board's plate (its logical px), `stage` is the stack's plate. */
export class StackHost {
  readonly el: HTMLElement;
  private inner: HTMLElement;
  private dialog: HTMLElement;
  stage: Stage | null = null;
  ready: Promise<void> = Promise.resolve();
  private sig = '';
  /** The board's size the stack is laid out for (logical px). */
  private w = 0;
  private h = 0;

  constructor(parent: HTMLElement, private readonly o: StackHostOpts) {
    this.el = document.createElement('div');
    this.el.className = 'bs-host';
    this.el.dataset.plChrome = 'bare';   // it covers the board and zooms on its own: kept at the board's fit (docs/ENGINE.md "Zoom and pan")
    this.inner = document.createElement('div');
    this.inner.className = 'bs-plate';
    this.dialog = document.createElement('div');
    this.dialog.className = 'pl-card bs-ask';
    this.dialog.hidden = true;
    this.dialog.setAttribute('role', 'alertdialog');
    this.el.append(this.inner, this.dialog);
    parent.append(this.el);
    // the board underneath never hears what happens on the stack (its clicks place nodes, its keys move a cursor)
    for (const t of ['click', 'dblclick', 'pointerdown', 'pointermove', 'pointerup', 'wheel', 'contextmenu'] as const) this.el.addEventListener(t, (e) => e.stopPropagation());
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const typing = /^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement).tagName);
      if (e.defaultPrevented || typing) return;
      if (e.key === 'Escape') { e.preventDefault(); if (!this.dialog.hidden) this.ask(null); else this.o.onEscape(); return; }
      if (this.o.onKey?.(e)) e.preventDefault();
    });
  }

  /** Mount `Cls` laid out for the board's size (`w` × `h`, logical px), in `state` (a StackState; its own rest when omitted). */
  show(Cls: SceneClass, w: number, h: number, state?: Partial<StackState>) {
    this.drop();
    const root = document.createElement('div');
    // a theme forced on the board's plate holds for the stack too
    const outer = this.el.closest<HTMLElement>('.plate');
    for (const a of ['data-theme', 'data-plate-theme']) { const v = outer?.getAttribute(a); if (v) root.setAttribute(a, v); }
    this.inner.append(root);
    const s = mount(root, Cls, { preserve: this.o.preserve, theater: false, controls: false, zoom: !this.o.preserve });
    this.stage = s;
    this.w = w; this.h = h;
    // this host sizes the stack (the board's size): when the stack asks to be fitted again (the room its chrome needs
    // at the size it's drawn, a change of interface size), it is laid out for that size again, never for a page's
    s.onRefit(() => this.refit(this.w, this.h));
    this.ready = s.ready.then(() => {
      if (this.stage !== s) return;
      this.layout(s, w, h);
      if (state) s.scene.setState?.(state);
      s.pause(); s.t = s.duration; s.render(s.t, 0, true);
      s.onFrame(() => { const g = JSON.stringify(s.scene.getState?.() ?? null); if (g !== this.sig) { this.sig = g; this.o.onChange(); } });
      this.sig = JSON.stringify(s.scene.getState?.() ?? null);
      this.o.onChange();
    });
    return this.ready;
  }
  /** The board was laid out again (a theater relayout, a splice that changed its size): the stack too, for that size. */
  refit(w: number, h: number) {
    const s = this.stage;
    this.w = w; this.h = h;
    if (!s?.isReady) return;
    this.layout(s, w, h);
  }
  /** Lay the stack out for the board's size, with room for its chrome as the chrome floor will draw it there (docs/ENGINE.md
   *  "Chrome floor": the stack is drawn at its fit inside the board times the board's own scale on screen). */
  private layout(s: Stage, w: number, h: number) {
    Object.assign(this.el.style, { width: `${w}px`, height: `${h}px` });
    const fit = (k: number) => s.scene.fit?.({ w, h }, { chrome: k }) ?? { w: s.W, h: s.H };
    const bs = this.o.scale?.() || 1, boost = (scale: number) => s.chrome.boostAt(scale * bs);
    let r = fit(1);
    const k = boost(fitScaleOf({ w, h }, r));
    // laid out with room for chrome k times larger, it is drawn smaller: settled until the two agree
    if (k > 1.01) r = settleChrome({ w, h }, Math.ceil(k * 100) / 100, fit, boost);
    s.resize(r.w, r.h);
    this.size(w, h);
  }
  /** Size the host to the board (logical px) and the stack's plate to fit inside it, centred. */
  size(w: number, h: number) {
    Object.assign(this.el.style, { width: `${w}px`, height: `${h}px` });
    const s = this.stage;
    if (!s) return;
    const k = Math.min(w / s.W, h / s.H);
    Object.assign(this.inner.style, { width: `${Math.floor(s.W * k)}px` });
  }
  get scene(): (StackApi & { getState(): StackState }) | null { return (this.stage?.isReady ? this.stage.scene : null) as unknown as (StackApi & { getState(): StackState }) | null; }
  focus() { this.stage?.viewport.focus({ preventScroll: true }); }
  /** Render the stack at time `t` of its transition (the board's stills drive it frame by frame). */
  still(k: number) { const s = this.stage; if (s?.isReady) { s.pause(); s.t = k * s.duration; s.render(s.t, 0, true); } }
  /** A question over the stack: a line of text and buttons (label → action); null closes it. */
  ask(q: { text: string; buttons: { label: string; primary?: boolean; run: () => void }[] } | null) {
    const d = this.dialog;
    if (!q) { d.hidden = true; d.innerHTML = ''; this.focus(); return; }
    d.innerHTML = `<p>${esc(q.text)}</p><div class="bs-acts">${q.buttons.map((b, i) => `<button type="button" class="bd-btn${b.primary ? ' is-primary' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
    d.hidden = false;
    d.onclick = (e) => { const t = (e.target as HTMLElement).closest<HTMLElement>('[data-i]'); if (t) q.buttons[+t.dataset.i!]!.run(); };
    d.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }
  get asking() { return !this.dialog.hidden; }
  get question() { return this.dialog.hidden ? null : (this.dialog.querySelector('p')?.textContent ?? ''); }
  private drop() {
    this.dialog.hidden = true;
    if (this.stage) { this.stage.dispose(); this.stage = null; }
    this.inner.replaceChildren();
    this.sig = '';
  }
  dispose() { this.drop(); this.el.remove(); }
}

/** The host's CSS (inside the board's plate; theme tokens only). The stack's own plate brings its own. */
export const STACK_HOST_CSS = /* css */ `
  .bs-host { position: absolute; left: 0; top: 0; z-index: 60; display: grid; place-items: center; background: var(--pl-bg); }
  .bs-host .bs-plate { position: relative; }
  .bs-host .bs-plate > .plate { gap: 0; }
  .bs-host .bs-plate .plate-viewport { border-radius: 0; }
  .bs-ask { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 520px; box-sizing: border-box; z-index: 70; padding: 16px 18px; display: grid; gap: 12px; font: 14px/1.45 var(--pl-font); box-shadow: var(--pl-shadow), 0 0 0 1px var(--pl-accent); }
  .bs-ask[hidden] { display: none; }
  .bs-ask p { margin: 0; }
  .bs-ask .bs-acts { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
  .bs-ask .bd-btn.is-primary { border-color: var(--pl-accent); color: var(--pl-accent); }
`;
