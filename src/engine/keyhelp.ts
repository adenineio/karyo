// Key help: `?` on a plate opens a card listing the keys that work on it right now (docs/ENGINE.md "Key help").
//
// Each scene declares its keys with the `keys()` hook, context-aware: what applies in the current mode (Bench, a
// splice, a card open, drilled in …). Keys of another mode may be listed `off` with a `when` ("in Bench"): they are
// drawn dimmed. The engine adds its own (theater, Bench, the inspector, zoom and pan, a clip's transport, `?`), and a
// host page may add a group and leave some out (Jarvis: hold Space to talk). Nothing here knows what a card is.
//
// The card is page chrome, like the zoom control and the pinned inspector: it sits in the plate's viewport, outside
// the zoomed frame, so it covers only its plate and keeps a readable size at any zoom. `?` again, Esc, the ✕ or a
// click outside it close it; it traps focus while open (a modal dialog with a label). `?` never fires in a text
// field. On a page with one plate (Jarvis, the project view, `?scene=<id>`) `?` works from anywhere on the page;
// with many, on the focused plate (or the one in the theater).
import type { Stage } from './stage';
import { ZOOM_MAX } from './viewport';
import { uiSize, UI_SIZES } from './uisize';

/** One line of the card: a key (or alternatives that do the same) and what it does. */
export interface KeyHelp {
  /** A key or chord as drawn on its keycap: 'j', '⇧S', '⌘Z', 'Esc', 'Enter', 'Space', '←', 'PgDn', 'Delete', a range
   *  such as '1–5'; or alternatives that do the same: ['j', '↓', '→']. `⌘` reads Ctrl off Apple systems. */
  keys: string | string[];
  /** What it does, now: "open the card at the cursor", "leave Bench". */
  does: string;
  /** Where it applies ("in Bench", "with a card open"); shown beside it. Set it on an `off` key to say how to get there. */
  when?: string;
  /** The section it is listed under ('Navigate', 'Bench', 'Splice', 'View' …; default 'Keys'). */
  group?: string;
  /** Not available right now (it works in another mode): drawn dimmed with `when`. */
  off?: boolean;
  /** A pointer gesture rather than a key (pinch, Space + drag): drawn as text, never pressed by a check. */
  gesture?: boolean;
  /** An engine line's id (below), which a scene's `without` can leave out. */
  id?: string;
}
/** What a scene's `keys()` may return: its lines, and engine lines to leave out right now (by id: 'bench', 'theater',
 *  'theater-esc', 'inspector', 'zoom-in', 'zoom-out', 'fit', 'zoom-pointer', 'pan', 'ui-size', 'transport'). */
export type KeyHelpList = KeyHelp[] | { keys: KeyHelp[]; without?: string[] };
/** A host page's own keys (Jarvis): a group of lines, and keys it takes for itself (drawn nowhere else). */
export interface PageKeys { keys: () => KeyHelp[]; omit?: string[] }
export interface KeyGroup { name: string; keys: KeyHelp[] }

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** A keycap's text as this system writes it (⌘ is Ctrl off Apple systems, ⌥ is Alt). */
export const capText = (k: string) => (mac ? k : k.replace(/⌘\s*\+?\s*/g, 'Ctrl + ').replace(/⌥/g, 'Alt + ').replace(/⇧(?=\S)/g, 'Shift + '));
/** Every alternative of a line. */
export const keysOf = (h: KeyHelp) => (Array.isArray(h.keys) ? h.keys : [h.keys]);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const typing = (t: EventTarget | null) => { const e = t as HTMLElement | null; return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable); };
const isHelpKey = (e: KeyboardEvent) => e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey;

let seq = 0;
const all = new Set<KeyHelpCtl>();

export class KeyHelpCtl {
  /** Off in export mode and for a plate hosted inside another (its host lists its keys). */
  readonly enabled: boolean;
  private el: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private sub: HTMLElement | null = null;
  private close$: HTMLButtonElement | null = null;
  private btns: HTMLButtonElement[] = [];
  private page: PageKeys | null = null;
  private prev: HTMLElement | null = null;
  private html = '';
  private raf = 0;
  private offFrame: (() => void) | null = null;

  constructor(readonly stage: Stage, o: { enabled: boolean }) {
    this.enabled = o.enabled;
    if (!this.enabled) return;
    all.add(this);
    bindWindow();
  }

  get isOpen() { return !!this.el && !this.el.hidden; }

  /** A host page's keys (Jarvis): listed in their own group, and `omit` keys dropped from every other line. */
  setPage(p: PageKeys | null) { this.page = p; this.refresh(); }

  /** What the card lists now, grouped: the scene's lines, then the engine's, then the page's. */
  list(): KeyGroup[] {
    const s = this.stage;
    let mine: KeyHelp[] = [], without: string[] = [];
    if (s.isReady && s.scene.keys) {
      try {
        const r = s.scene.keys();
        if (Array.isArray(r)) mine = r; else { mine = r.keys; without = r.without ?? []; }
      } catch (e) { console.error('[karyo] keys():', e); }
    }
    const lines = [...mine, ...engineKeys(s).filter((h) => !h.id || !without.includes(h.id))];
    let page: KeyHelp[] = [];
    if (this.page) { try { page = this.page.keys(); } catch (e) { console.error('[karyo] page keys:', e); } }
    const omit = new Set(this.page?.omit ?? []);
    const kept = lines.map((h) => {
      if (!omit.size) return h;
      const ks = keysOf(h).filter((k) => !omit.has(k));
      return ks.length ? { ...h, keys: ks } : null;
    }).filter((h): h is KeyHelp => !!h);
    const groups: KeyGroup[] = [];
    for (const h of [...page, ...kept]) {
      const name = h.group ?? 'Keys';
      let g = groups.find((x) => x.name === name);
      if (!g) groups.push(g = { name, keys: [] });
      g.keys.push(h);
    }
    // what works now first, the other modes' keys after it
    for (const g of groups) g.keys = [...g.keys.filter((h) => !h.off), ...g.keys.filter((h) => h.off)];
    return groups;
  }

  /** `?` (and Esc while open) on the focused plate, from the Stage. True when handled. */
  key(e: KeyboardEvent): boolean {
    if (!this.enabled) return false;
    // a key from inside the open card (a Space the zoom held back) is the card's, never the plate's
    if (this.isOpen && this.el!.contains(e.target as globalThis.Node | null)) return true;
    if (!isHelpKey(e) || typing(e.target)) return false;
    this.toggle();
    return true;
  }
  toggle(on = !this.isOpen) { if (on) this.open(); else this.close(); }
  open() {
    if (!this.enabled || this.isOpen) return;
    for (const c of all) if (c !== this) c.close();
    this.build();
    const a = document.activeElement as HTMLElement | null;
    this.prev = a && a !== document.body ? a : null;
    this.render(true);
    this.el!.hidden = false;
    this.stage.viewport.classList.add('has-keys-open');
    for (const b of this.btns) b.setAttribute('aria-expanded', 'true');
    this.card!.focus({ preventScroll: true });
    addEventListener('pointerdown', this.onOutside, true);
    addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    this.offFrame = this.stage.onFrame(() => this.refresh());
  }
  close() {
    if (!this.isOpen) return;
    this.el!.hidden = true;
    this.stage.viewport.classList.remove('has-keys-open');
    for (const b of this.btns) b.setAttribute('aria-expanded', 'false');
    removeEventListener('pointerdown', this.onOutside, true);
    removeEventListener('wheel', this.onWheel, true);
    this.offFrame?.(); this.offFrame = null;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    // focus goes back where it was, unless the viewer has since put it somewhere else (a click outside)
    const a = document.activeElement;
    if (!a || a === document.body || this.el!.contains(a)) {
      const back = this.prev?.isConnected ? this.prev : this.stage.viewport;
      back.focus({ preventScroll: true });
    }
    this.prev = null;
  }

  /** The corner hint: a quiet `? keys` at rest, and the same at the right end of the zoom control where it shows. */
  mountHint() {
    if (!this.enabled || this.btns.length) return;
    const vp = this.stage.viewport;
    const make = (cls: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.innerHTML = '<kbd>?</kbd> keys';
      b.title = 'Keyboard shortcuts (?)';
      b.setAttribute('aria-label', 'Keyboard shortcuts');
      b.setAttribute('aria-haspopup', 'dialog');
      b.setAttribute('aria-expanded', 'false');
      b.addEventListener('click', () => this.toggle());
      this.btns.push(b);
      return b;
    };
    vp.append(make('plate-keys-btn plate-keys-hint'));
    vp.querySelector<HTMLElement>(':scope > .plate-zoom')?.append(make('plate-keys-btn'));
  }

  dispose() {
    this.close();
    all.delete(this);
    this.el?.remove();
    for (const b of this.btns) b.remove();
  }

  // ---------------------------------------------------------------- the card
  private build() {
    if (this.el) return;
    const id = `plate-keys-${++seq}`;
    const el = this.el = document.createElement('div');
    el.className = 'plate-keys';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', `${id}-t`);
    el.setAttribute('aria-describedby', `${id}-s`);
    el.innerHTML = `<div class="plate-keys-card" tabindex="-1">
        <div class="plate-keys-head"><h2 class="plate-keys-title" id="${id}-t">Keyboard shortcuts</h2>
          <span class="plate-keys-sub" id="${id}-s"></span>
          <button type="button" class="plate-keys-close" aria-label="Close keyboard shortcuts" title="Close (? or Esc)">✕</button></div>
        <div class="plate-keys-body" tabindex="0"></div>
        <div class="plate-keys-foot"><kbd>?</kbd> or <kbd>Esc</kbd> closes · dimmed keys work in another mode</div>
      </div>`;
    this.card = el.querySelector<HTMLElement>('.plate-keys-card');
    this.body = el.querySelector<HTMLElement>('.plate-keys-body');
    this.sub = el.querySelector<HTMLElement>('.plate-keys-sub');
    this.close$ = el.querySelector<HTMLButtonElement>('.plate-keys-close');
    this.close$!.addEventListener('click', () => this.close());
    el.addEventListener('keydown', this.onDialogKey);
    // the plate underneath never hears the card's pointer and wheel events
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick', 'contextmenu'] as const) el.addEventListener(t, (e) => e.stopPropagation());
    this.stage.viewport.append(el);
  }
  private refresh() {
    if (!this.isOpen || this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; if (this.isOpen) this.render(false); });
  }
  private render(force: boolean) {
    const groups = this.list();
    const cap = (k: string, gesture: boolean) => (gesture ? `<span class="plate-keys-gesture">${esc(capText(k))}</span>` : `<kbd>${esc(capText(k))}</kbd>`);
    const html = groups.map((g) => `<section class="plate-keys-group"><h3>${esc(g.name)}</h3><ul>${g.keys.map((h) => {
      const ks = keysOf(h).map((k) => cap(k, !!h.gesture)).join('<span class="plate-keys-or" aria-hidden="true">/</span>');
      const when = h.when ? ` <span class="plate-keys-when">${esc(h.when)}</span>` : '';
      return `<li class="plate-keys-row${h.off ? ' is-off' : ''}"${h.off ? ' aria-disabled="true"' : ''}><span class="plate-keys-caps">${ks}</span><span class="plate-keys-does">${esc(h.does)}${when}</span></li>`;
    }).join('')}</ul></section>`).join('');
    if (force || html !== this.html) { this.html = html; this.body!.innerHTML = html; }
    const t = this.stage.Cls.title;
    const sub = t ? `for ${t}` : '';
    if (this.sub!.textContent !== sub) this.sub!.textContent = sub;
  }
  private onDialogKey = (e: KeyboardEvent) => {
    e.stopPropagation();   // nothing on the plate hears a key while the card is open
    if (e.key === 'Escape' || isHelpKey(e)) { e.preventDefault(); this.close(); return; }
    if (e.key === 'Tab') {
      // focus stays in the card: the ✕ and the scrolling list
      const f = [this.close$!, this.body!];
      const i = f.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      f[(i < 0 ? 0 : i + (e.shiftKey ? f.length - 1 : 1)) % f.length]!.focus({ preventScroll: true });
    }
  };
  /** A press outside the card closes it; on the plate's scrim it does nothing else. */
  private onOutside = (e: PointerEvent) => {
    const t = e.target as globalThis.Node | null;
    if (t && this.card!.contains(t)) return;
    if (t && this.el!.contains(t)) { e.preventDefault(); e.stopPropagation(); }
    else if (t && this.btns.some((b) => b.contains(t))) return;   // the hint's own click toggles it
    this.close();
  };
  /** The wheel over the card scrolls the card, never zooms or pans the plate. */
  private onWheel = (e: WheelEvent) => {
    const t = e.target as globalThis.Node | null;
    if (!t || !this.el!.contains(t)) return;
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  };
}

/** The engine's own lines: a clip's transport, Bench, the theater, the inspector, zoom and pan, and `?`. */
/** The zoom and pan lines for a viewer (`stage.view`): the engine's own, and a scene hosting a zoomable plate lists its
 *  host's instead (the keys go to the plate that zooms). */
export function zoomKeys(v: Stage['view']): KeyHelp[] {
  const V = 'View', out: KeyHelp[] = [];
  if (v.enabled) {
    const z = v.zoomed, max = v.zoom >= ZOOM_MAX - 1e-6;
    out.push({ id: 'zoom-in', group: V, keys: ['+', '='], does: 'zoom in', ...(max ? { off: true, when: 'below 400%' } : {}) });
    out.push({ id: 'zoom-out', group: V, keys: '-', does: 'zoom out', ...(z ? {} : { off: true, when: 'while zoomed in' }) });
    out.push({ id: 'fit', group: V, keys: '0', does: 'back to fit (the whole plate)', ...(z ? {} : { off: true, when: 'while zoomed in' }) });
    out.push({ id: 'zoom-pointer', group: 'Pointer', gesture: true, keys: ['pinch', '⌘ + scroll'], does: 'zoom around the pointer' });
    out.push({ id: 'pan', group: 'Pointer', gesture: true, keys: ['drag blank space', 'Space + drag', 'scroll'], does: 'pan', ...(z ? {} : { off: true, when: 'while zoomed in' }) });
  }
  return out;
}

function engineKeys(s: Stage): KeyHelp[] {
  const out: KeyHelp[] = [];
  const has = (sel: string) => !!s.root.querySelector(`:scope > .plate-controls ${sel}, :scope > .plate-actions ${sel}`);
  if (!s.interactive) {
    const P = 'Play';
    out.push({ id: 'transport', group: P, keys: ['Space', 'k'], does: s.playing ? 'pause' : 'play' });
    out.push({ id: 'transport', group: P, keys: [',', '.'], does: 'one frame back / forward' });
    out.push({ id: 'transport', group: P, keys: ['←', '→'], does: 'back / forward 0.1 s (with ⇧: 1 s)' });
    out.push({ id: 'transport', group: P, keys: ['Home', 'End'], does: 'to the start / the end' });
  }
  if (s.Cls.bench && has('.plate-bench-btn')) out.push({ id: 'bench', group: 'Bench', keys: 'b', does: s.inBench ? 'leave Bench: read-only again' : 'Bench: rearrange this plate' });
  const V = 'View';
  if (has('.plate-theater-btn')) out.push({ id: 'theater', group: V, keys: 'f', does: s.inTheater ? 'leave the theater' : 'theater: fill the window' });
  if (s.inTheater) out.push({ id: 'theater-esc', group: V, keys: 'Esc', does: 'leave the theater', when: 'once nothing else is open' });
  const d = s.dock;
  if (d) out.push({ id: 'inspector', group: V, keys: 'i', does: d.pinned ? 'unpin the inspector' : 'pin the inspector beside the plate', ...(d.available ? {} : { off: true, when: 'in the theater' }) });
  out.push(...zoomKeys(s.view));
  // the interface size (docs/ENGINE.md "Chrome floor"): how large chrome is drawn, page-wide
  if (s.view.enabled) {
    const u = uiSize(), i = UI_SIZES.indexOf(u);
    out.push({ id: 'ui-size', group: V, keys: ['[', ']'], does: `smaller / larger interface (now ${u.label.toLowerCase()}${i === 0 ? ', the smallest' : i === UI_SIZES.length - 1 ? ', the largest' : ''})` });
  }
  out.push({ id: 'help', group: V, keys: '?', does: 'show or hide these keys' });
  return out;
}

// ---------------------------------------------------------------- `?` anywhere on a one-plate page
let bound = false;
function bindWindow() {
  if (bound || typeof addEventListener === 'undefined') return;
  bound = true;
  addEventListener('keydown', (e) => {
    const open = [...all].find((c) => c.isOpen);
    if (open && e.key === 'Escape' && !e.defaultPrevented) { open.close(); e.preventDefault(); return; }
    if (e.defaultPrevented || !isHelpKey(e) || typing(e.target)) return;
    if (open) { open.close(); e.preventDefault(); return; }
    const on = [...all].filter((c) => c.stage.root.isConnected);
    const target = on.find((c) => c.stage.inTheater) ?? (on.length === 1 ? on[0] : undefined);
    if (target) { target.open(); e.preventDefault(); }
  });
}
