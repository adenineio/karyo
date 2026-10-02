// The interface size (docs/ENGINE.md "Chrome floor"): one page-wide setting, S / M / L, that multiplies the size chrome
// is drawn at (a plate's header, legend, toolbars, banners, panels and hover cards; never its cards and wires). Chosen
// in the ⚙ menu, Jarvis's Settings or with `[` / `]` on a plate; kept in localStorage (`karyo:ui-size`).

export interface UiSize { id: 'S' | 'M' | 'L'; label: string; k: number }
export const UI_SIZES: readonly UiSize[] = [
  { id: 'S', label: 'Small', k: 0.9 },
  { id: 'M', label: 'Medium', k: 1 },
  { id: 'L', label: 'Large', k: 1.2 },
];
const KEY = 'karyo:ui-size';
const DEFAULT: UiSize['id'] = 'M';

let cur: UiSize['id'] | null = null;
const listeners = new Set<(s: UiSize) => void>();

const byId = (id: unknown) => UI_SIZES.find((s) => s.id === id);
/** The current interface size (the stored choice, else M). */
export function uiSize(): UiSize {
  if (cur === null) {
    let v: string | null = null;
    try { v = localStorage.getItem(KEY); } catch { /* storage unavailable */ }
    cur = byId(v)?.id ?? DEFAULT;
  }
  return byId(cur)!;
}
/** Set the interface size (S, M or L): every plate on the page redraws its chrome; the choice is stored. */
export function setUiSize(id: string) {
  const s = byId(id);
  if (!s || s.id === uiSize().id) return;
  cur = s.id;
  try { localStorage.setItem(KEY, s.id); } catch { /* not kept */ }
  for (const l of listeners) l(s);
}
/** One step smaller (-1) or larger (+1); stays at the ends. Returns the size now. */
export function stepUiSize(d: number): UiSize {
  const i = UI_SIZES.findIndex((s) => s.id === uiSize().id);
  setUiSize(UI_SIZES[Math.max(0, Math.min(UI_SIZES.length - 1, i + Math.sign(d)))]!.id);
  return uiSize();
}
/** Follow changes (every plate, the menus). Returns an unsubscribe. */
export function onUiSize(fn: (s: UiSize) => void) { listeners.add(fn); return () => listeners.delete(fn); }

// another tab changed it
if (typeof addEventListener !== 'undefined') addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  const s = byId(e.newValue);
  if (s && s.id !== cur) { cur = s.id; for (const l of listeners) l(s); }
});
