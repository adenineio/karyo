// The stage: one plate on a page. It owns a fixed logical canvas (e.g. 960×540 px) that is
// scaled to fit its container, an HTML layer holding the scene's real elements, and WebGL fx
// layers under / over it. It renders any time t deterministically:
//   1. every Node goes back to rest            4. every Node's layout box is measured
//   2. scene.update(f) animates the HTML        5. scene.draw(f, fx) draws wires, lights, sparks
//   3. changed styles/text are written          6. the fx layers are rendered
// so scrubbing, looping, stills and video export all show exactly the same frame.
import { Node } from './node';
import { FxLayer } from './fx';
import { readTheme, type Theme } from './theme';
import { clamp } from './util';
import { Dock, type DockChange } from './dock';
import { ViewCtl, type View } from './viewport';
import { ChromeLayer, Z0 } from './chrome';
import { KeyHelpCtl, type KeyHelpList } from './keyhelp';

export interface Frame {
  /** Clip time (s). */
  t: number;
  /** Time since the previous rendered frame (0 after a seek). */
  dt: number;
  /** 0..1 progress through the clip. */
  p: number;
  duration: number;
  W: number;
  H: number;
  theme: Theme;
}

export interface Fx {
  under: FxLayer;
  over: FxLayer | null;
  /** Where to draw fx that belong to chrome (docs/ENGINE.md "Zoom and pan"), in the plate's fit coordinates: the under
   *  layer itself at fit; while the viewer is zoomed in, a layer over the chrome's backdrops and under its HTML, shown
   *  where the chrome is (so an outline around a legend entry or a step rail stays with it, at its fit size). */
  readonly front: FxLayer;
}

export abstract class Scene {
  /** Shown in galleries and the player's accessible label. */
  static title = '';
  /** Clip length (s). */
  static duration = 6;
  /** Logical stage size in px: lay the HTML out in these px; the stage scales to fit. */
  static width = 960;
  static height = 540;
  /** Time shown when the viewer prefers reduced motion (default: the end of the clip). */
  static poster?: number;
  /** Which fx canvases the scene draws on. */
  static fx: 'under' | 'over' | 'both' = 'under';
  /** An interactive plate rests on a state instead of playing a clip: `duration` is the length of one
   *  transition, the plate rests at t = duration, and `stage.transition()` replays 0 → duration after the
   *  scene changes its state. See docs/ENGINE.md, "Interactive plates". */
  static interactive = false;
  /** The plate can be rearranged: the Stage shows a Bench button (and the `b` key) that toggles
   *  `stage.inBench` and calls `setBench(on)`. See docs/ENGINE.md, "Bench". */
  static bench = false;
  /** Start in Bench unless the page says otherwise (`mount(…, { bench })`). */
  static benchOpen = false;
  /** The scene shows details a viewer can pin beside the plate: the Stage makes a dock (`stage.dock`, the `i` key)
   *  that shows while the plate fills the window (theater, fill) or a host page places it. See docs/ENGINE.md,
   *  "Pinned inspector". */
  static inspector = false;

  constructor(readonly stage: Stage) {}
  /** Build (or adopt, if the page supplied markup) the scene's HTML inside `dom`. Called once. */
  abstract build(dom: HTMLElement): void | Promise<void>;
  /** Animate the HTML for time f.t by setting Node properties. Must be a pure function of f.t. */
  abstract update(f: Frame): void;
  /** Draw fx for time f.t (runs after layout, so node positions are current). */
  draw?(f: Frame, fx: Fx): void;
  /** Interactive plates: the view state as plain JSON (for stills, lint and restoring a view)… */
  getState?(): unknown;
  /** …and applying one (at rest, no transition). */
  setState?(state: unknown): void;
  /** Interactive plates: named example states that stills and lint render (`render.ts --state <name>`). */
  states?(): { name: string; state: unknown }[];
  /** After setState: a promise when the state needs a moment before it can be drawn (a plate it hosts is still booting);
   *  the renderer (render.ts) waits for it. */
  settled?(): Promise<unknown> | null | void;
  /** Interactive plates: a key pressed while the plate has focus. Return true when handled. */
  onKey?(e: KeyboardEvent): boolean;
  /** Bench plates: the Stage entered (true) or left (false) Bench. Called before the frame is redrawn. */
  setBench?(on: boolean): void;
  /** Aspect-aware relayout (docs/ENGINE.md, "Theater"). The Stage calls it when it enters the theater and on every
   *  window resize there, with the space the plate may fill (CSS px), and with null when it leaves (back to the page).
   *  Return the logical size the plate wants for that space (lay the plate out for it first: this runs before the next
   *  frame), or nothing to keep the current size. The Stage then scales that size to fit the space whole. Must be a
   *  pure function of (the scene's content, the space): the same space always gives the same layout. */
  fit?(space: { w: number; h: number } | null): { w: number; h: number } | void;
  /** Inspector plates: the dock was pinned or unpinned, locked or unlocked, moved or resized (`stage.dock` has the
   *  new values). Called before the plate is refitted and redrawn; the scene fills `dock.body` in update(). */
  dockChanged?(what: DockChange): void;
  /** Zoom and pan (docs/ENGINE.md "Zoom and pan"): is a press at `e` on blank space, so that a drag there pans the view?
   *  `byDefault` is the engine's answer (the plate's own backdrop, or an element marked `data-pl-blank`). Say no for
   *  what the scene draws on the fx layer and takes the pointer for (a wire), and for handles that are not elements. */
  isBlank?(e: PointerEvent, byDefault: boolean): boolean;
  /** Key help (docs/ENGINE.md "Key help"): the keys that work on the plate right now, for the `?` card. Context-aware:
   *  what applies in the current mode; another mode's keys may be listed `off` with a `when`. */
  keys?(): KeyHelpList;

  /** The Node for the first element matching `sel` inside the stage (created on first use). */
  protected $(sel: string | HTMLElement) { return this.stage.node(sel); }
  /** Nodes for every element matching `sel`. */
  protected $$(sel: string) { return this.stage.nodes(sel); }
  /** Like $(), but null when nothing matches. */
  protected $opt(sel: string) { return this.stage.dom.querySelector<HTMLElement>(sel) ? this.stage.node(sel) : null; }
}

export type SceneClass = (new (stage: Stage) => Scene) & { title: string; duration: number; width: number; height: number; poster?: number; fx: 'under' | 'over' | 'both'; interactive?: boolean; bench?: boolean; benchOpen?: boolean; inspector?: boolean };

export interface StageOpts {
  autoplay?: boolean;
  loop?: boolean;
  controls?: boolean;
  /** Start time (s). */
  start?: number;
  /** Keep the GL drawing buffer (needed for screenshots/export). */
  preserve?: boolean;
  /** Playback rate multiplier. */
  rate?: number;
  /** A "Theater" button (and the `f` key) that lifts the plate out of the page to fill the window.
   *  Default: on, except in export mode (`preserve`). */
  theater?: boolean;
  /** Bench plates (`static bench = true`): start in Bench. Default: the scene's `static benchOpen`. */
  bench?: boolean;
  /** The plate is the page: it fills the browser window with the theater's fit (the scene's relayout for the window's
   *  aspect, the whole plate scaled to fit, no scrolling), from the start and on every resize. No Theater button. */
  fill?: boolean;
  /** Zoom and pan (docs/ENGINE.md "Zoom and pan"): pinch / ⌘-wheel, drag on blank space, `+ - 0`, a zoom control.
   *  Default: on for interactive plates, off for clips, in export mode and for a plate hosted inside another plate. */
  zoom?: boolean;
}

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** One motion dial for every interactive plate on the page: 1 = designed speed, 0 = no motion (every
 *  transition lands on its end state at once). Reduced motion forces 0. Clips are unaffected. */
let motionDial = 1;
export function setMotion(k: number) { motionDial = clamp(k, 0, 2); }
export function motion() { return reducedMotion() ? 0 : motionDial; }
const MAX_CONTEXTS = 12;
const live: Stage[] = [];

export class Stage {
  readonly root: HTMLElement;
  readonly viewport: HTMLElement;
  readonly frame: HTMLElement;
  readonly dom: HTMLElement;
  /** Logical stage size (px). Starts at the scene's `static width/height`; `resize()` (the theater's relayout) changes it. */
  W: number;
  H: number;
  readonly duration: number;
  readonly fx: Fx;
  scene!: Scene;
  theme!: Theme;
  t = 0;
  playing = false;
  readonly interactive: boolean;
  loop: boolean;
  rate: number;
  ready: Promise<void>;
  isReady = false;
  visible = true;
  errors: string[] = [];
  /** The pinned inspector (scenes with `static inspector = true`, not in export mode), else null. */
  readonly dock: Dock | null = null;
  /** The viewer's zoom and pan (docs/ENGINE.md "Zoom and pan"): view state, never part of a frame. */
  readonly view: ViewCtl;
  /** Chrome (elements marked `data-pl-chrome`) stays at its fit place and size while the viewer zooms (docs/ENGINE.md
   *  "Zoom and pan"): `chrome.shown()` is where it is drawn now, `chrome.insets` how deep its bands reach in. */
  readonly chrome: ChromeLayer;
  /** The `?` card of the keys that work now (docs/ENGINE.md "Key help"). */
  readonly keyHelp: KeyHelpCtl;
  /** Per-frame hooks for helpers that own DOM state (e.g. Space3D): reset before update, flush after. */
  plugins: { reset(): void; flush(): void }[] = [];
  private nodeMap = new Map<HTMLElement, Node>();
  private nodeList: Node[] = [];
  private lastT = -1;
  private scale = 1;
  private listeners = new Set<(t: number) => void>();
  private ro: ResizeObserver;
  private io: IntersectionObserver | null = null;
  private mo: MutationObserver;

  constructor(root: HTMLElement, readonly Cls: SceneClass, opts: StageOpts = {}) {
    this.root = root;
    this.W = Cls.width; this.H = Cls.height; this.duration = Cls.duration;
    this.interactive = !!Cls.interactive;
    this.loop = this.interactive ? false : opts.loop ?? true;
    this.rate = opts.rate ?? 1;
    root.classList.add('plate');
    // authored markup (if any) becomes the scene's DOM layer
    const authored = [...root.childNodes];
    this.viewport = el('div', 'plate-viewport');
    this.viewport.style.aspectRatio = `${this.W} / ${this.H}`;
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute('role', 'figure');
    this.viewport.setAttribute('aria-label', Cls.title || 'Animation');
    this.frame = el('div', 'plate-frame');
    Object.assign(this.frame.style, { width: `${this.W}px`, height: `${this.H}px` });
    this.dom = el('div', 'plate-dom');
    authored.forEach((n) => this.dom.appendChild(n));
    const preserve = opts.preserve ?? false;
    this.exportMode = preserve;
    const stage = this;
    this.fx = { under: new FxLayer('under', preserve), over: Cls.fx === 'under' ? null : new FxLayer('over', preserve), get front() { return stage.frontLayer(); } };
    this.frame.append(this.fx.under.canvas, this.dom);
    if (this.fx.over) this.frame.append(this.fx.over.canvas);
    this.viewport.append(this.frame);
    root.append(this.viewport);
    const controls = (opts.controls ?? !this.interactive) ? new Controls(this) : null;
    this.bar = controls?.bar ?? null;
    if (Cls.bench && !opts.preserve) this.benchButton();
    this.filling = !!opts.fill;
    if (opts.theater ?? (!opts.preserve && !this.filling)) this.theaterButton();
    if (this.filling) { root.classList.add('is-fill'); document.documentElement.classList.add('plate-fill-open'); addEventListener('resize', this.onWinResize); }
    if (Cls.inspector && !opts.preserve) {
      this.dock = new Dock({ dockAvailable: () => this.inTheater || this.filling || !!this.dock?.hosted, dockChanged: (w) => this.onDockChange(w) });
      root.append(this.dock.el);
      this.dock.el.addEventListener('keydown', this.onKeyDown);
      this.layoutDock();
    }

    // zoom and pan: interactive plates on a page (not stills, not a plate hosted inside another plate's scene)
    const nested = !!root.parentElement?.closest('.plate-dom');
    const zoomable = !preserve && (opts.zoom ?? (this.interactive && !nested));
    this.view = new ViewCtl(this, { enabled: zoomable, storeKey: zoomable ? `karyo:view:${location.pathname}:${root.id || root.dataset.scene || Cls.title || Cls.name}` : null });
    this.chrome = new ChromeLayer(this, (e) => this.nodeMap.get(e), (e) => this.parentNode(e));
    this.keyHelp = new KeyHelpCtl(this, { enabled: !preserve && !nested });
    this.keyHelp.mountHint();

    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.viewport);
    this.mo = new MutationObserver(() => this.refreshTheme());
    this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-plate-theme', 'class', 'style'] });
    this.mo.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-plate-theme', 'class', 'style'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.refreshTheme());
    this.bindKeys();

    this.ready = this.boot(opts);
  }

  private async boot(opts: StageOpts) {
    this.theme = readTheme(this.root);
    this.scene = new this.Cls(this);
    const bench = !!this.Cls.bench && (opts.bench ?? !!this.Cls.benchOpen);
    this.inBench = bench;
    this.root.classList.toggle('is-bench', bench);
    this.syncBenchBtn();
    try { await this.scene.build(this.dom); if (bench) this.scene.setBench?.(true); } catch (e) { this.fail(e); }
    await document.fonts?.ready;
    this.layout();
    this.isReady = true;
    if (this.filling) this.fitTheater();
    this.view.restore();
    this.dock?.sync();
    const rm = reducedMotion();
    if (this.interactive) { this.t = clamp(opts.start ?? this.duration, 0, this.duration); this.playing = false; }
    else {
      this.t = rm ? this.Cls.poster ?? this.duration : clamp(opts.start ?? 0, 0, this.duration);
      this.playing = !rm && (opts.autoplay ?? true);
    }
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver((es) => { this.visible = es.some((e) => e.isIntersecting); if (this.visible) this.render(this.t, 0, true); }, { rootMargin: '200px' });
      this.io.observe(this.viewport);
    }
    this.render(this.t, 0, true);
    live.push(this);
    Ticker.add(this);
  }

  private fail(e: unknown) {
    const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    if (!this.errors.includes(msg)) { this.errors.push(msg); console.error(`[karyo] ${this.Cls.title || this.Cls.name}:`, e); }
  }

  // ---------------------------------------------------------------- nodes
  /** Node for an element (or the first match of a selector inside the stage). */
  node(sel: string | HTMLElement): Node {
    const e = typeof sel === 'string' ? this.dom.querySelector<HTMLElement>(sel) : sel;
    if (!e) throw new Error(`karyo: no element matches ${String(sel)}`);
    let n = this.nodeMap.get(e);
    if (!n) {
      n = new Node(e, this.frame);
      this.nodeMap.set(e, n);
      this.nodeList.push(n);
      for (const m of this.nodeList) m.parent = this.parentNode(m.el);
      n.measure();
    }
    return n;
  }
  nodes(sel: string): Node[] { return [...this.dom.querySelectorAll<HTMLElement>(sel)].map((e) => this.node(e)); }
  private parentNode(e: HTMLElement): Node | null {
    for (let a = e.parentElement; a && a !== this.frame; a = a.parentElement) { const n = this.nodeMap.get(a); if (n) return n; }
    return null;
  }

  // ---------------------------------------------------------------- layout & theme
  /** Change the logical size at runtime (a relayout for the theater): frame, viewport aspect, fx canvases, then a
   *  re-measured frame. The scene must already be laid out for the new size. */
  resize(w: number, h: number) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (w === this.W && h === this.H) return;
    this.W = w; this.H = h;
    this.view.clampTo(w, h);
    this.viewport.style.aspectRatio = `${w} / ${h}`;
    Object.assign(this.frame.style, { width: `${w}px`, height: `${h}px` });
    if (this.inTheater || this.filling) this.sizeTheater();
    this.layout();
  }
  private layout() {
    const w = this.viewport.clientWidth || this.W;
    this.scale = w / this.W;
    this.applyView();
  }
  /** The frame's transform and the fx canvases for the fit (`scale`) and the viewer's zoom and pan (`view`), then a
   *  redrawn frame. At fit this is exactly the plain fitted plate. */
  applyView() {
    const v = this.view, S = this.scale * v.zoom;
    this.frame.style.transform = v.zoomed ? `translate(${-v.x * S}px, ${-v.y * S}px) scale(${S})` : `scale(${this.scale})`;
    this.sizeFx();
    if (this.isReady) this.render(this.t, 0, true);
  }
  /** The fx canvases: the whole stage at fit; zoomed in, only its visible part, at the zoomed density. */
  private sizeFx() {
    const v = this.view, px = Math.min(3, this.scale * (window.devicePixelRatio || 1)) * v.zoom, r = v.zoomed ? v.rect() : null;
    this.fx.under.resize(this.W, this.H, px, r);
    this.fx.over?.resize(this.W, this.H, px, r);
  }
  refreshTheme() {
    const th = readTheme(this.root);
    if (JSON.stringify(th) === JSON.stringify(this.theme)) return;
    this.theme = th;
    if (this.isReady) this.render(this.t, 0, true);
  }

  // ---------------------------------------------------------------- rendering
  /** Render time t now. */
  render(t: number, dt = 0, force = false) {
    if (!this.isReady) return;
    t = clamp(t, 0, this.duration);
    if (!force && t === this.lastT) return;
    this.lastT = t;
    const f: Frame = { t, dt, p: this.duration ? t / this.duration : 0, duration: this.duration, W: this.W, H: this.H, theme: this.theme };
    try {
      for (const n of this.nodeList) n.reset();
      for (const p of this.plugins) p.reset();
      this.scene.update(f);
      for (const n of this.nodeList) n.flush();
      for (const p of this.plugins) p.flush();
      for (const n of this.nodeList) n.measure();
      this.chrome.update();
      if (this.visible || force) {
        this.acquire();
        this.fx.under.begin(this.theme);
        this.fx.over?.begin(this.theme);
        this.frontLive = false;
        this.scene.draw?.(f, this.fx);
        this.fx.under.render(t, this.theme);
        this.fx.over?.render(t, this.theme);
        if (this.frontFx) {
          if (this.frontLive) this.frontFx.render(t, this.theme);
          this.frontFx.canvas.style.display = this.frontLive ? '' : 'none';
        }
      }
    } catch (e) { this.fail(e); }
    for (const l of this.listeners) l(t);
  }
  // ---------------------------------------------------------------- fx.front: the chrome's fx while zoomed
  private frontFx: FxLayer | null = null;
  private frontLive = false;
  private frontLayer(): FxLayer {
    if (!this.view.zoomed) return this.fx.under;
    let L = this.frontFx;
    if (!L) {
      L = this.frontFx = new FxLayer('front', this.exportMode);
      L.canvas.style.zIndex = String(Z0 + 1);
      L.bg.grain = false;
    }
    if (!L.canvas.isConnected) this.dom.append(L.canvas);
    if (!this.frontLive) {
      L.ensure();
      L.resize(this.W, this.H, Math.min(3, this.scale * (window.devicePixelRatio || 1)), null, this.view.rect());
      L.begin(this.theme);
      this.frontLive = true;
    }
    return L;
  }
  private acquire() {
    if (this.fx.under.renderer) return;
    this.fx.under.ensure(); this.fx.over?.ensure();
    this.sizeFx();
    // browsers cap live WebGL contexts: release the ones scrolled far away
    const withGL = live.filter((s) => s !== this && s.fx.under.renderer);
    for (const s of withGL.filter((s) => !s.visible).slice(0, Math.max(0, withGL.length + 1 - MAX_CONTEXTS))) {
      s.fx.under.release(); s.fx.over?.release(); s.frontFx?.release();
    }
  }

  // ---------------------------------------------------------------- interactive plates
  /** Replay the transition clip (0 → duration) after the scene changed its state; lands on the end
   *  state at once when motion is off. The scene interpolates from what was on screen to the new state. */
  transition() {
    const k = motion();
    if (k === 0) { this.playing = false; this.t = this.duration; this.render(this.t, 0, true); this.emit(); return; }
    this.rate = k; this.t = 0; this.playing = true; this.render(0, 0, true); this.emit();
  }
  /** Re-render the current frame (e.g. after a hover or a drag moved something at rest). */
  redraw() { this.render(this.t, 0, true); }
  /** Client (pointer) coordinates → stage px (the fit, the viewer's zoom and pan included). */
  toStage(clientX: number, clientY: number) {
    const r = this.frame.getBoundingClientRect(), S = this.zoom;
    return { x: (clientX - r.left) / S, y: (clientY - r.top) / S };
  }
  /** CSS px on screen per stage px, the viewer's zoom included (divide pointer deltas by this). */
  get zoom() { return this.scale * this.view.zoom; }
  /** CSS px per stage px at fit (the viewer's zoom left out). */
  get fitScale() { return this.scale; }

  /** The scene's view state plus the viewer's `view` ({zoom, x, y}; docs/ENGINE.md "Zoom and pan"). */
  getState(): unknown {
    const s = this.scene.getState?.();
    return s && typeof s === 'object' && !Array.isArray(s) ? { ...s, view: this.view.get() } : s;
  }
  /** Apply a view state: the scene's part to the scene; a `view` in it sets the zoom and pan (none: the view stays). */
  setState(st: unknown) {
    let view: Partial<View> | null = null;
    if (st && typeof st === 'object' && !Array.isArray(st) && 'view' in st) {
      const { view: v, ...rest } = st as { view?: Partial<View> };
      view = v && typeof v === 'object' ? v : null;
      st = rest;
    }
    this.scene.setState?.(st);
    if (view) this.view.set(view);
  }

  // ---------------------------------------------------------------- transport
  seek(t: number) { this.t = clamp(t, 0, this.duration); this.render(this.t, 0); }
  play() { if (this.t >= this.duration && !this.loop) this.t = 0; this.playing = true; this.emit(); }
  pause() { this.playing = false; this.emit(); }
  toggle() { this.playing ? this.pause() : this.play(); }
  step(frames: number) { this.pause(); this.seek(this.t + frames / 60); }
  onFrame(fn: (t: number) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const l of this.listeners) l(this.t); }
  /** Advance by wall-clock dt (called by the shared ticker). */
  tick(dt: number) {
    if (!this.playing || !this.isReady) return;
    let t = this.t + dt * this.rate;
    if (t >= this.duration) {
      if (this.loop) t %= this.duration || 1;
      else { t = this.duration; this.playing = false; }
    }
    this.t = t;
    if (this.visible) this.render(t, dt);
  }

  /** A key the view held back (Space, in case it became a pan) and hands on after all. */
  replayKey(e: KeyboardEvent) { this.onKeyDown(e); }
  private bindKeys() { this.viewport.addEventListener('keydown', this.onKeyDown); }
  /** Keys on the focused plate (and in its dock). */
  private onKeyDown = (e: KeyboardEvent) => {
      // `?`: the key help card
      if (this.keyHelp.key(e)) { e.preventDefault(); return; }
      // zoom keys (+ = - 0) first: no scene uses them
      if (this.view.key(e)) { e.preventDefault(); return; }
      // the scene unwinds its own state first (Esc closes a panel before it closes the theater)
      if (this.interactive && this.isReady && this.scene.onKey?.(e)) { e.preventDefault(); return; }
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      if ((e.key === 'f' && plain && this.theaterBtn && !isTyping(e)) || (e.key === 'Escape' && this.inTheater)) { this.theater(); e.preventDefault(); return; }
      if (e.key === 'b' && plain && this.Cls.bench && !isTyping(e)) { this.bench(); e.preventDefault(); return; }
      if (e.key === 'i' && plain && this.dock?.available && !isTyping(e)) { this.dock.pin(); e.preventDefault(); return; }
      if (this.interactive) return;
      const k = e.key;
      if (k === ' ' || k === 'k') this.toggle();
      else if (k === ',') this.step(-1);
      else if (k === '.') this.step(1);
      else if (k === 'ArrowLeft') { this.pause(); this.seek(this.t - (e.shiftKey ? 1 : 0.1)); }
      else if (k === 'ArrowRight') { this.pause(); this.seek(this.t + (e.shiftKey ? 1 : 0.1)); }
      else if (k === 'Home') this.seek(0);
      else if (k === 'End') this.seek(this.duration);
      else return;
      e.preventDefault();
  };

  // ---------------------------------------------------------------- actions row (Bench, Theater)
  private bar: HTMLElement | null = null;
  private actions: HTMLElement | null = null;
  private exportMode = false;
  /** Export mode (render.ts, `preserve`): stills and video, no chrome. A scene that hosts another plate renders it with its own frames. */
  get isExport() { return this.exportMode; }
  /** Put a scene's own button in the plate's actions row (beside Bench and Theater). Not in export mode (render.ts):
   *  returns false there, and the scene keeps its other ways in (keys, its own chrome). */
  addAction(b: HTMLElement): boolean {
    if (this.exportMode) return false;
    this.actionHost().append(b);
    return true;
  }
  /** Buttons beside the plate: in the transport bar when there is one, else a row under the plate. */
  private actionHost() {
    if (this.bar) return this.bar;
    if (!this.actions) { this.actions = el('div', 'plate-actions'); this.root.append(this.actions); }
    return this.actions;
  }

  // ---------------------------------------------------------------- bench
  private benchBtn: HTMLButtonElement | null = null;
  /** In Bench the plate can be rearranged (drag, reset, tags); outside it the plate is read-only. */
  inBench = false;
  private benchButton() {
    const b = el('button', 'plate-btn plate-bench-btn') as HTMLButtonElement;
    b.type = 'button';
    b.textContent = 'Bench';
    b.title = 'Rearrange this plate: drag cards, reset the layout (b)';
    b.addEventListener('click', () => this.bench());
    this.actionHost().append(b);
    this.benchBtn = b;
    this.syncBenchBtn();
  }
  private syncBenchBtn() {
    if (!this.benchBtn) return;
    this.benchBtn.setAttribute('aria-pressed', String(this.inBench));
    this.benchBtn.title = this.inBench ? 'Leave Bench: the plate is read-only again (b)' : 'Rearrange this plate: drag cards, reset the layout (b)';
  }
  /** Enter or leave Bench (toggle, or force with `on`). Only for scenes with `static bench = true`. */
  bench(on = !this.inBench) {
    if (!this.Cls.bench || on === this.inBench) return;
    this.inBench = on;
    this.root.classList.toggle('is-bench', on);
    this.syncBenchBtn();
    if (!this.isReady) return;
    try { this.scene.setBench?.(on); } catch (e) { this.fail(e); }
    this.redraw();
    this.emit();
  }

  // ---------------------------------------------------------------- theater
  private theaterBtn: HTMLButtonElement | null = null;
  inTheater = false;
  private onWinKey = (e: KeyboardEvent) => { const t = e.target as globalThis.Node | null; if (e.key === 'Escape' && !this.viewport.contains(t) && !this.dock?.el.contains(t)) this.theater(false); };
  /** `fill`: the plate fills the window (the theater's fit, always on). */
  private filling = false;
  private onWinResize = () => { if (this.inTheater || this.filling) this.fitTheater(); };
  /** The space a plate may fill in the theater (CSS px): the window, less the padding and the actions row. */
  private theaterSpace() {
    const pad = 16, gap = 8;
    const row = (this.bar ?? this.actions)?.getBoundingClientRect().height ?? 0;
    // a pinned inspector takes its side of the window (a hosted one is the host page's to account for)
    const dock = this.dock && !this.dock.hosted ? this.dock.reserve() : 0;
    return { w: Math.max(200, innerWidth - 2 * pad - dock), h: Math.max(150, innerHeight - 2 * pad - (row ? row + gap : 0)) };
  }
  private theaterButton() {
    const b = el('button', 'plate-btn plate-theater-btn') as HTMLButtonElement;
    b.type = 'button';
    b.textContent = 'Theater';
    b.title = 'Fill the window with this plate (f; Esc to leave)';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => this.theater());
    this.actionHost().append(b);
    this.theaterBtn = b;
  }
  /** Lift the plate out of the page to fill the window (toggle, or force with `on`). */
  theater(on = !this.inTheater) {
    if (on === this.inTheater || !this.theaterBtn) return;
    if (on) for (const s of live) if (s !== this && s.inTheater) s.theater(false);
    this.inTheater = on;
    this.root.classList.toggle('is-theater', on);
    document.documentElement.classList.toggle('plate-theater-open', on);
    this.theaterBtn.textContent = on ? 'Close' : 'Theater';
    this.theaterBtn.setAttribute('aria-pressed', String(on));
    if (on) { addEventListener('keydown', this.onWinKey); addEventListener('resize', this.onWinResize); this.layoutDock(); this.fitTheater(); }
    else {
      removeEventListener('keydown', this.onWinKey); removeEventListener('resize', this.onWinResize);
      this.viewport.style.width = ''; this.root.style.removeProperty('--plate-w');
      this.layoutDock();
      // back to the page: the scene's default layout and size
      if (this.isReady && this.scene.fit) { let r: { w: number; h: number } | void = undefined; try { r = this.scene.fit(null); } catch (e) { this.fail(e); } this.resize(r?.w ?? this.Cls.width, r?.h ?? this.Cls.height); }
    }
    this.viewport.focus({ preventScroll: true });
    if (!on) this.viewport.scrollIntoView({ block: 'nearest' });
  }
  /** The whole plate on screen, always (no scrolling): the scene may first relayout for the window's aspect
   *  (`scene.fit`), then the plate is scaled to fit both dimensions of the space. */
  private fitTheater() {
    this.layoutDock();
    if (this.isReady && this.scene.fit) {
      let r: { w: number; h: number } | void = undefined;
      try { r = this.scene.fit(this.theaterSpace()); } catch (e) { this.fail(e); }
      if (r) this.resize(r.w, r.h);
    }
    this.sizeTheater();
  }
  private sizeTheater() {
    const sp = this.theaterSpace();
    const w = Math.floor(Math.min(sp.w, sp.h * (this.W / this.H)));
    this.viewport.style.width = `${w}px`;
    this.root.style.setProperty('--plate-w', `${w}px`);
  }

  // ---------------------------------------------------------------- the pinned inspector (docs/ENGINE.md "Pinned inspector")
  /** In the theater or with fill, the dock sits inside the plate's overlay, on its side; the plate's padding on that
   *  side makes room so the plate centres in what is left. A hosted dock is laid out by its page. */
  private layoutDock() {
    const d = this.dock;
    if (!d) return;
    d.sync();
    const own = (this.inTheater || this.filling) && !d.hosted, r = own ? d.reserve() : 0;
    const pad = (side: 'left' | 'right') => (r && d.side === side ? `${16 + r}px` : '');
    this.root.style.paddingLeft = pad('left');
    this.root.style.paddingRight = pad('right');
    this.root.classList.toggle('has-dock', !!r);
  }
  private refitListeners = new Set<() => void>();
  /** A host page that sizes the plate itself (Jarvis) hears here when the scene asks to be fitted again. */
  onRefit(fn: () => void) { this.refitListeners.add(fn); return () => this.refitListeners.delete(fn); }
  /** The scene's content changed shape (a relayout of its own, e.g. a splice adding cards): fit it again for the space
   *  it has, as the theater would on a resize. Elsewhere, `fit(space)` with the space the scene was last laid out for
   *  (null: the page; a still's `--fit`); a host page that sizes the plate (onRefit) does it itself. */
  refit(space: { w: number; h: number } | null = null) {
    if (!this.isReady) return;
    if (this.refitListeners.size) { for (const l of this.refitListeners) l(); return; }
    if (this.inTheater || this.filling) { this.fitTheater(); return; }
    let r: { w: number; h: number } | void = undefined;
    try { r = this.scene.fit?.(space); } catch (e) { this.fail(e); }
    if (r) this.resize(r.w, r.h);
  }
  private dockListeners = new Set<(what: DockChange) => void>();
  /** Follow the dock's changes (a host page that lays it out itself). Returns an unsubscribe. */
  onDock(fn: (what: DockChange) => void) { this.dockListeners.add(fn); return () => this.dockListeners.delete(fn); }
  private onDockChange(what: DockChange) {
    if (this.isReady) { try { this.scene.dockChanged?.(what); } catch (e) { this.fail(e); } }
    if ((this.inTheater || this.filling) && !this.dock?.hosted) this.fitTheater(); else this.layoutDock();
    for (const l of this.dockListeners) l(what);
    if (this.isReady) { this.redraw(); this.emit(); }
  }

  dispose() {
    this.theater(false);
    this.dock?.el.remove();
    if (this.filling) removeEventListener('resize', this.onWinResize);
    Ticker.remove(this);
    this.ro.disconnect(); this.io?.disconnect(); this.mo.disconnect();
    this.view.dispose();
    this.keyHelp.dispose();
    this.fx.under.release(); this.fx.over?.release(); this.frontFx?.release();
    const i = live.indexOf(this); if (i >= 0) live.splice(i, 1);
  }
}

/** One requestAnimationFrame loop for every stage on the page. */
const Ticker = new (class {
  private stages = new Set<Stage>();
  private last = 0;
  private running = false;
  add(s: Stage) { this.stages.add(s); if (!this.running) { this.running = true; this.last = performance.now(); requestAnimationFrame(this.loop); } }
  remove(s: Stage) { this.stages.delete(s); }
  private loop = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    for (const s of this.stages) s.tick(dt);
    if (this.stages.size) requestAnimationFrame(this.loop); else this.running = false;
  };
})();

/** Transport bar under the stage: play/pause, scrubber, time. */
class Controls {
  readonly bar: HTMLElement;
  constructor(stage: Stage) {
    const bar = this.bar = el('div', 'plate-controls');
    const btn = el('button', 'plate-btn') as HTMLButtonElement;
    btn.type = 'button';
    const range = el('input', 'plate-scrub') as HTMLInputElement;
    Object.assign(range, { type: 'range', min: '0', max: String(stage.duration), step: '0.001', value: '0' });
    range.setAttribute('aria-label', 'Animation time');
    const time = el('span', 'plate-time');
    bar.append(btn, range, time);
    stage.root.append(bar);
    let dragging = false, wasPlaying = false;
    const sync = (t: number) => {
      btn.textContent = stage.playing ? 'Pause' : 'Play';
      btn.setAttribute('aria-pressed', String(stage.playing));
      if (!dragging) range.value = String(t);
      time.textContent = `${t.toFixed(2)} / ${stage.duration.toFixed(2)} s`;
    };
    stage.onFrame(sync);
    btn.addEventListener('click', () => stage.toggle());
    range.addEventListener('pointerdown', () => { dragging = true; wasPlaying = stage.playing; stage.pause(); });
    range.addEventListener('input', () => { if (!dragging) stage.pause(); stage.seek(+range.value); });
    const end = () => { if (dragging) { dragging = false; if (wasPlaying) stage.play(); } };
    range.addEventListener('pointerup', end);
    range.addEventListener('change', end);
    sync(0);
  }
}

/** A key typed into a text field inside the plate (not a command). */
function isTyping(e: KeyboardEvent) { const t = e.target as HTMLElement | null; return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); }
function el(tag: string, cls: string) { const e = document.createElement(tag); e.className = cls; return e; }

/** Mount a scene into an element. */
export function mount(root: HTMLElement, Cls: SceneClass, opts: StageOpts = {}) { return new Stage(root, Cls, opts); }
