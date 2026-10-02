// The theme picker every page shares: one ordered list of themes, the load-time precedence, and a small
// settings (gear) button that opens a menu of them. The themes themselves live in karyo.css; this only sets
// `data-plate-theme` / `data-theme` on <html> (the stage re-reads its tokens when they change).
//
// Precedence on load (initTheme): a URL `&theme=` wins (with `&mode=` alongside it); else a URL
// `&mode=light|dark` forces the neutral theme in that mode; else the stored choice (localStorage
// `karyo:theme`); else adenine. An id that isn't on the list (in a link or a stored choice) falls back to
// adenine. So `render.ts --theme adenine-jade` and `--mode dark` mean what they say.
//
// No DOM access at import time, so THEMES can be imported outside a browser (e.g. under bun).
import { UI_SIZES, uiSize, setUiSize, onUiSize } from './uisize';

export interface ThemeOption {
  /** What is stored and shown in menus' data-theme-id. */
  id: string;
  label: string;
  /** `data-plate-theme` on <html>; null = the neutral theme (attribute removed). */
  plate: string | null;
  /** `data-theme` on <html>; 'auto' removes it. */
  mode: 'auto' | 'light' | 'dark';
  /** Menu section: 0 Adenine and its closest variants, 1 more adenine themes, 2 neutral. */
  group: 0 | 1 | 2;
  /** A one-line description of the look. */
  note?: string;
}

export const THEMES: ThemeOption[] = [
  { id: 'adenine', label: 'Adenine', plate: 'adenine', mode: 'auto', group: 0, note: 'sea-foam accent leaning cyan; labels from one colour family' },
  { id: 'adenine-periwinkle', label: 'Periwinkle', plate: 'adenine-periwinkle', mode: 'auto', group: 0, note: 'periwinkle blue accent on the adenine structure' },
  { id: 'adenine-jade', label: 'Jade', plate: 'adenine-jade', mode: 'auto', group: 0, note: 'a deeper, greener teal' },
  { id: 'adenine-alt', label: 'Adenine alt', plate: 'adenine-alt', mode: 'auto', group: 1, note: 'calmer: signature cyan, labels under one chroma ceiling, sage for green' },
  { id: 'adenine-lavender', label: 'Lavender', plate: 'adenine-lavender', mode: 'auto', group: 1, note: 'soft lilac accent, near-neutral surfaces' },
  { id: 'adenine-glacier', label: 'Glacier', plate: 'adenine-glacier', mode: 'auto', group: 1, note: 'sky blue accent, cool surfaces' },
  { id: 'adenine-seafoam', label: 'Seafoam', plate: 'adenine-seafoam', mode: 'auto', group: 1, note: 'pale sea-foam, the greenest of the set' },
  { id: 'adenine-graphite', label: 'Graphite', plate: 'adenine-graphite', mode: 'auto', group: 1, note: 'neutral grey surfaces, an ice accent; the labels carry the colour' },
  { id: 'neutral', label: 'Neutral · auto', plate: null, mode: 'auto', group: 2 },
  { id: 'neutral-light', label: 'Neutral · light', plate: null, mode: 'light', group: 2 },
  { id: 'neutral-dark', label: 'Neutral · dark', plate: null, mode: 'dark', group: 2 },
];
export const DEFAULT_THEME = 'adenine';
export const THEME_KEY = 'karyo:theme';
/** Other ids also accepted, stored or in links, and the theme each one means. */
export const THEME_ALIASES: Record<string, string> = { 'adenine-v2': 'adenine-alt', 'neutral-auto': 'neutral' };

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
  if (t.plate) el.dataset.plateTheme = t.plate; else delete el.dataset.plateTheme;
  if (t.mode === 'auto') delete el.dataset.theme; else el.dataset.theme = t.mode;
  return t;
}

/** The list entry the attributes on <html> show (null when they are something off the list, set by hand). */
export function currentTheme(el: HTMLElement = root()): string | null {
  const plate = el.dataset.plateTheme && el.dataset.plateTheme !== 'neutral' ? el.dataset.plateTheme : null;
  const mode = el.dataset.theme === 'light' || el.dataset.theme === 'dark' ? el.dataset.theme : 'auto';
  const hit = THEMES.find((t) => t.plate === plate && (plate ? true : t.mode === mode));
  return hit?.id ?? null;
}

export function storedTheme(): string | null {
  try { const v = localStorage.getItem(THEME_KEY); return themeById(v)?.id ?? null; } catch { return null; }
}
export function saveTheme(id: string) {
  try { localStorage.setItem(THEME_KEY, themeById(id)?.id ?? id); } catch { /* not persisted */ }
}

/** Set the theme for this page load: URL `theme`, else URL `mode` (neutral in that mode), else stored, else adenine.
 *  `stored: false` skips localStorage (the renderer's export mode, so stills don't depend on a profile). */
export function initTheme(q: URLSearchParams = new URLSearchParams(location.search), opts: { stored?: boolean } = {}): void {
  const el = root();
  const theme = q.get('theme'), mode = q.get('mode');
  if (theme) {
    const t = themeById(theme);
    if (t && !t.plate) {   // neutral, neutral-light, neutral-dark
      delete el.dataset.plateTheme;
      const m = mode || (t.mode === 'auto' ? null : t.mode);
      if (m) el.dataset.theme = m;
      return;
    }
    const use = t ?? themeById(DEFAULT_THEME)!;   // an id not on the list: the default, silently
    el.dataset.plateTheme = use.plate!;
    if (mode) el.dataset.theme = mode;
    return;
  }
  if (mode) { el.dataset.theme = mode; return; }   // the neutral theme, forced light or dark
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
    <div class="ky-tp-menu" id="${id}" role="menu" aria-label="Theme" hidden><h2>Theme</h2>${THEMES.map((t, i) =>
      `${i && THEMES[i - 1]!.group !== t.group ? '<hr role="separator">' : ''}<button type="button" role="menuitemradio" aria-checked="false" data-theme-id="${t.id}"><span class="ky-tp-sw"></span><span class="ky-tp-name">${t.label}</span><span class="ky-tp-on" aria-hidden="true">✓</span></button>`).join('')}
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

/** `<option>`s for a native select (Jarvis's settings panel), grouped like the menu. */
export function themeOptionsHtml(): string {
  const names = ['Adenine', 'More themes', 'Neutral'];
  return [0, 1, 2].map((g) => `<optgroup label="${names[g]}">${THEMES.filter((t) => t.group === g).map((t) => `<option value="${t.id}">${t.label}</option>`).join('')}</optgroup>`).join('');
}
