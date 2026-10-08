// The theme picker every page shares: one ordered list of themes (adenine, fresh), the load-time precedence, and a
// small settings (gear) button that opens a menu of them. The themes themselves live in karyo.css; this only sets
// `data-plate-theme` / `data-theme` on <html> (the stage re-reads its tokens when they change).
//
// Precedence on load (initTheme): a URL `&theme=` wins (with `&mode=` alongside it); else a URL `&mode=light|dark`
// draws in the engine's built-in neutral tokens in that mode (no plate theme: for light-mode stills and pages, never on
// a menu); else the stored choice (localStorage `karyo:theme`); else adenine. An id that isn't on the list (in a link or
// a stored choice) opens adenine; retired ids are aliases (THEME_ALIASES).
//
// No DOM access at import time, so THEMES can be imported outside a browser (e.g. under bun).
import { UI_SIZES, uiSize, setUiSize, onUiSize } from './uisize';
import type { FontKey } from './theme-fonts';
import './fonts.css';   // the main themes' faces, from this repo (a face downloads only when a theme draws in it)

export interface ThemeOption {
  /** What is stored and shown in menus' data-theme-id. */
  id: string;
  label: string;
  /** `data-plate-theme` on <html>. */
  plate: string;
  /** A one-line description of the look. */
  note?: string;
  /** Web fonts the look draws in (src/engine/theme-fonts.ts), and the faces to wait for before a plate measures
   *  (`document.fonts.load` specs). Live pages declare them with fonts.css; a standalone explainer inlines them. */
  fonts?: { families: FontKey[]; faces: string[] };
}

// The menu, in order: adenine (the default) and fresh. Every menu (the ⚙ menu, Jarvis's select, a standalone
// explainer's select) shows exactly these.
const CLEAN_FONTS: ThemeOption['fonts'] = { families: ['inter', 'geist', 'geist-mono', 'newsreader'],
  faces: ['400 16px Inter', '500 16px Inter', '600 16px Inter', '400 16px Geist', '400 16px "Geist Mono"', '400 32px Newsreader'] };
const FRESH_FONTS: ThemeOption['fonts'] = { families: ['inter', 'geist-mono'],
  faces: ['400 16px Inter', '500 16px Inter', '600 16px Inter', '500 16px "Geist Mono"'] };
export const THEMES: ThemeOption[] = [
  { id: 'adenine', label: 'Adenine', plate: 'adenine', note: 'a black canvas, frosted controls, hairlines that fade, a clear blue accent', fonts: CLEAN_FONTS },
  { id: 'fresh', label: 'Fresh', plate: 'fresh', note: 'graphite and smoked glass lit from the top left, a coral accent, film grain', fonts: FRESH_FONTS },
];
export const DEFAULT_THEME = 'adenine';
export const THEME_KEY = 'karyo:theme';
/** Retired ids, still accepted in links and stored picks, and the theme each one opens: the earlier looks (classic, its
 *  colour variants and the neutral menu entries) all open adenine. Any other unknown id opens adenine too. */
export const THEME_ALIASES: Record<string, string> = Object.fromEntries([
  ...['classic', 'adenine-alt', 'adenine-v2', 'adenine-periwinkle', 'adenine-jade', 'adenine-lavender', 'adenine-glacier', 'adenine-seafoam', 'adenine-graphite',
    'glass-clean', 'neutral', 'neutral-auto', 'neutral-light', 'neutral-dark'].map((id) => [id, 'adenine']),
  ['glass-fresh', 'fresh'],
]);

export const themeById = (id: string | null | undefined): ThemeOption | undefined => {
  if (!id) return undefined;
  const k = THEME_ALIASES[id] ?? id;
  return THEMES.find((t) => t.id === k);
};

// ---------------------------------------------------------------- state on <html>
const root = () => document.documentElement;

/** Apply a theme from the list (or an id in THEME_ALIASES). Unknown ids are ignored. */
export function applyTheme(id: string, el: HTMLElement = root()): ThemeOption | undefined {
  const t = themeById(id);
  if (!t) return undefined;
  el.dataset.plateTheme = t.plate;
  delete el.dataset.theme;
  if (el === root()) loadThemeFonts(t);
  return t;
}

// ---------------------------------------------------------------- web fonts of a theme
// fonts.css declares the faces (nothing is fetched until a theme draws in one). `themeFontsReady()` settles when the
// current theme's faces are in (or failed, or after 10 s), so a page can wait for it before a plate measures its text:
// stills then never catch the fallback face.
let fontsReady: Promise<void> = Promise.resolve();
function loadThemeFonts(t: ThemeOption) {
  const f = t.fonts;
  if (!f || typeof document === 'undefined' || !document.fonts) return;
  const faces = Promise.all(f.faces.map((s) => document.fonts.load(s).catch(() => []))).then(() => document.fonts.ready).then(() => undefined);
  fontsReady = Promise.race([faces, new Promise<void>((r) => setTimeout(r, 10000))]);
}
/** Settles once the current theme's web fonts are loaded (at once for a theme without any). */
export const themeFontsReady = () => fontsReady;

/** The list entry the attributes on <html> show (null for none: the neutral tokens of a `&mode=` page, or a value set by hand). */
export function currentTheme(el: HTMLElement = root()): string | null {
  return THEMES.find((t) => t.plate === el.dataset.plateTheme)?.id ?? null;
}

export function storedTheme(): string | null {
  try { const v = localStorage.getItem(THEME_KEY); return themeById(v)?.id ?? null; } catch { return null; }
}
export function saveTheme(id: string) {
  try { localStorage.setItem(THEME_KEY, themeById(id)?.id ?? id); } catch { /* not persisted */ }
}

/** Set the theme for this page load: URL `theme` (an unknown id: adenine), else URL `mode` (the neutral tokens in that
 *  mode), else stored, else adenine. `stored: false` skips localStorage (the renderer's export mode, so stills don't depend
 *  on a profile). */
export function initTheme(q: URLSearchParams = new URLSearchParams(location.search), opts: { stored?: boolean } = {}): void {
  const el = root();
  const theme = q.get('theme'), mode = q.get('mode');
  if (theme) {
    const use = themeById(theme) ?? themeById(DEFAULT_THEME)!;
    el.dataset.plateTheme = use.plate;
    if (mode) el.dataset.theme = mode;
    if (el === root()) loadThemeFonts(use);
    return;
  }
  if (mode) { delete el.dataset.plateTheme; el.dataset.theme = mode; return; }   // the neutral tokens, light or dark
  applyTheme((opts.stored !== false && storedTheme()) || DEFAULT_THEME, el);
}

/** A choice from a menu: apply, persist, and drop `theme`/`mode` from the address so a reload keeps it. */
export function pickTheme(id: string) {
  if (!applyTheme(id)) return;
  saveTheme(id);
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('theme') || u.searchParams.has('mode')) {
      u.searchParams.delete('theme'); u.searchParams.delete('mode');
      history.replaceState(history.state, '', u);
    }
  } catch { /* leave the address */ }
  for (const f of listeners) f(id);
}
const listeners = new Set<(id: string) => void>();
/** Called after every pickTheme (any picker on the page). */
export function onThemePick(f: (id: string) => void) { listeners.add(f); return () => listeners.delete(f); }

// ---------------------------------------------------------------- swatches, read from karyo.css
// A hidden same-origin iframe carries a copy of the page's style sheets; each theme's attributes go on its <html>
// and its probe .plate reports --pl-accent / --pl-bg. (A probe in this document would take <html>'s theme.)
const tokenCache = new Map<string, string>();
/** Each theme's value of the given tokens (e.g. '--pl-accent'), keyed by theme id, as karyo.css defines them. */
export function themeTokens(props: string[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const missing = props.filter((p) => !tokenCache.has(`${THEMES[0]!.id} ${p}`));
  if (missing.length) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    document.body.append(frame);
    try {
      const d = frame.contentDocument!;
      let css = '';
      for (const s of Array.from(document.styleSheets)) {
        try { css += Array.from(s.cssRules).map((r) => r.cssText).join('\n') + '\n'; } catch { /* cross-origin (fonts) */ }
      }
      d.open(); d.write(`<!doctype html><html><head><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div class="plate"></div></body></html>`); d.close();
      const p = d.querySelector('.plate')!;
      for (const t of THEMES) {
        applyTheme(t.id, d.documentElement);
        const cs = frame.contentWindow!.getComputedStyle(p);
        for (const k of missing) tokenCache.set(`${t.id} ${k}`, cs.getPropertyValue(k).trim());
      }
    } catch { /* no tokens */ }
    frame.remove();
  }
  for (const t of THEMES) out[t.id] = Object.fromEntries(props.map((k) => [k, tokenCache.get(`${t.id} ${k}`) ?? '']));
  return out;
}
export function themeSwatches(): Record<string, { accent: string; bg: string }> {
  const t = themeTokens(['--pl-accent', '--pl-bg']);
  return Object.fromEntries(Object.entries(t).map(([id, v]) => [id, { accent: v['--pl-accent']!, bg: v['--pl-bg']! }]));
}

// ---------------------------------------------------------------- the settings button
const CSS = `
.ky-tp { position: relative; display: inline-flex; }
.ky-tp-btn { display: inline-grid; place-items: center; width: 32px; height: 30px; padding: 0; background: transparent; color: inherit; border: 1px solid var(--page-rule, var(--rule, #8886)); border-radius: 6px; cursor: pointer; }
.ky-tp-btn:hover, .ky-tp-btn[aria-expanded="true"] { border-color: currentColor; }
.ky-tp-btn:focus-visible, .ky-tp-menu button:focus-visible { outline: 2px solid var(--page-accent, currentColor); outline-offset: 1px; }
.ky-tp-btn svg { width: 16px; height: 16px; }
.ky-tp-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 50; min-width: 200px; max-height: min(70vh, 480px); overflow: auto; padding: 6px; box-sizing: border-box;
  background: var(--page-card, var(--card, var(--page-bg, Canvas))); color: var(--page-fg, var(--fg, CanvasText)); border: 1px solid var(--page-rule, var(--rule, #8886)); border-radius: 8px;
  box-shadow: 0 10px 30px -10px rgb(0 0 0 / 0.45); font: 13px/1.3 ui-sans-serif, system-ui, -apple-system, sans-serif; text-align: left; }
.ky-tp-menu[hidden] { display: none; }
.ky-tp-menu h2 { margin: 2px 8px 6px; font: 600 10.5px/1 ui-monospace, Menlo, monospace; letter-spacing: 0.08em; text-transform: uppercase; color: var(--page-muted, var(--muted, GrayText)); }
.ky-tp-menu hr { border: 0; border-top: 1px solid var(--page-rule, var(--rule, #8886)); margin: 5px 4px; }
.ky-tp-menu button { display: flex; align-items: center; gap: 9px; width: 100%; padding: 6px 8px; background: transparent; color: inherit; border: 0; border-radius: 5px; font: inherit; text-align: left; cursor: pointer; }
.ky-tp-menu button:hover { background: color-mix(in srgb, currentColor 9%, transparent); }
.ky-tp-sw { flex: none; width: 14px; height: 14px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgb(127 127 127 / 0.45); }
.ky-tp-menu .ky-tp-name { flex: 1; }
.ky-tp-menu .ky-tp-on { width: 12px; text-align: center; opacity: 0; }
.ky-tp-menu button[aria-checked="true"] .ky-tp-on { opacity: 1; }
.ky-tp-menu button[aria-checked="true"] .ky-tp-name { font-weight: 600; }
.ky-tp-sizes { display: flex; gap: 4px; padding: 0 4px 2px; }
.ky-tp-menu .ky-tp-sizes button { justify-content: center; width: auto; flex: 1; font: 600 12px/1 ui-monospace, Menlo, monospace; border: 1px solid var(--page-rule, var(--rule, #8886)); }
.ky-tp-menu .ky-tp-sizes button[aria-checked="true"] { border-color: currentColor; background: color-mix(in srgb, currentColor 12%, transparent); }
@media (max-width: 480px) { .ky-tp-menu { position: fixed; top: auto; bottom: 12px; left: 16px; right: 16px; min-width: 0; } }
`;
const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
let menuCount = 0;

/** A settings (gear) button whose menu lists THEMES, each with its accent swatch, the current one checked.
 *  Choosing one applies and stores it. Returns the wrapper to place in the page. */
export function themePicker(): HTMLElement {
  if (!document.getElementById('ky-tp-css')) {
    const s = document.createElement('style'); s.id = 'ky-tp-css'; s.textContent = CSS; document.head.append(s);
  }
  const id = `ky-tp-menu-${++menuCount}`;
  const wrap = document.createElement('div');
  wrap.className = 'ky-tp';
  wrap.innerHTML = `<button type="button" class="ky-tp-btn" aria-label="Settings: theme" title="Settings" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}">${GEAR}</button>
    <div class="ky-tp-menu" id="${id}" role="menu" aria-label="Theme" hidden><h2>Theme</h2>${THEMES.map((t) =>
      `<button type="button" role="menuitemradio" aria-checked="false" data-theme-id="${t.id}"><span class="ky-tp-sw"></span><span class="ky-tp-name">${t.label}</span><span class="ky-tp-on" aria-hidden="true">✓</span></button>`).join('')}
      <hr role="separator"><h2>Interface size</h2><div class="ky-tp-sizes" role="group" aria-label="Interface size">${UI_SIZES.map((u) => `<button type="button" role="menuitemradio" aria-checked="false" data-ui-size="${u.id}" title="${u.label} interface: chrome drawn at ${Math.round(u.k * 100)}% ([ / ] on a plate)">${u.id}</button>`).join('')}</div></div>`;
  const btn = wrap.querySelector<HTMLButtonElement>('.ky-tp-btn')!;
  const menu = wrap.querySelector<HTMLElement>('.ky-tp-menu')!;
  const items = [...menu.querySelectorAll<HTMLButtonElement>('[data-theme-id]')];
  const sizes = [...menu.querySelectorAll<HTMLButtonElement>('[data-ui-size]')];
  const all = [...items, ...sizes];
  const sync = () => {
    const cur = currentTheme(), u = uiSize().id;
    for (const b of items) b.setAttribute('aria-checked', String(b.dataset.themeId === cur));
    for (const b of sizes) b.setAttribute('aria-checked', String(b.dataset.uiSize === u));
  };
  onUiSize(sync);
  let painted = false;
  const open = (on: boolean) => {
    menu.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    if (!on) return;
    if (!painted) {
      painted = true;
      const sw = themeSwatches();
      for (const b of items) { const s = sw[b.dataset.themeId!]; if (s) (b.firstElementChild as HTMLElement).style.background = `radial-gradient(circle, ${s.accent} 0 45%, ${s.bg} 48%)`; }
    }
    sync();
    (items.find((b) => b.getAttribute('aria-checked') === 'true') ?? items[0])!.focus();
  };
  btn.addEventListener('click', () => open(menu.hidden));
  for (const b of items) b.addEventListener('click', () => { pickTheme(b.dataset.themeId!); open(false); btn.focus(); });
  // the interface size stays open: try S, M, L and see
  for (const b of sizes) b.addEventListener('click', () => { setUiSize(b.dataset.uiSize!); sync(); });
  menu.addEventListener('keydown', (e) => {
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { open(false); btn.focus(); }
    else if (e.key === 'ArrowDown' || (e.key === 'ArrowRight' && i >= items.length)) all[(i + 1) % all.length]!.focus();
    else if (e.key === 'ArrowUp' || (e.key === 'ArrowLeft' && i >= items.length)) all[(i - 1 + all.length) % all.length]!.focus();
    else if (e.key === 'Home') all[0]!.focus();
    else if (e.key === 'End') all[all.length - 1]!.focus();
    else return;
    e.preventDefault(); e.stopPropagation();
  });
  menu.addEventListener('keydown', (e) => e.stopPropagation());   // a plate's keys never see menu typing
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !wrap.contains(e.target as Node)) open(false); });
  new MutationObserver(sync).observe(root(), { attributes: true, attributeFilter: ['data-theme', 'data-plate-theme'] });
  return wrap;
}

/** `<option>`s for a native select (Jarvis's settings panel): the menu's themes. */
export function themeOptionsHtml(): string {
  return THEMES.map((t) => `<option value="${t.id}">${t.label}</option>`).join('');
}
