// Themes are plain CSS custom properties on the .plate element (see karyo.css). The DOM
// layer uses them directly; the GL layers read the same tokens here so canvas colours always
// match the page. Colours are kept in sRGB 0..1 (the GL layers blend like CSS does).

export type RGB = [number, number, number];

export interface Theme {
  name: string;
  bg: RGB;
  fg: RGB;
  muted: RGB;
  line: RGB;
  accent: RGB;
  accent2: RGB;
  /** Success / done state. */
  ok: RGB;
  card: RGB;
  /** 0..1+: strength of the soft halo around glowing lines and sparks. */
  glow: number;
  /** 0..1: film grain on the fx background (--pl-grain; a whisper of it in the adenine themes). */
  grain: number;
  /** True when the background is dark (glows read as light; on light themes they read as ink). */
  dark: boolean;
}

export type ThemeColor = 'bg' | 'fg' | 'muted' | 'line' | 'accent' | 'accent2' | 'ok' | 'card';

let probe: CanvasRenderingContext2D | null = null;
/** Any CSS colour string → sRGB 0..1 (via a 1×1 canvas, so every syntax the browser knows works). */
export function parseColor(css: string, fallback: RGB = [1, 0, 1]): RGB {
  const s = css.trim();
  if (!s) return fallback;
  probe ??= (() => { const c = document.createElement('canvas'); c.width = c.height = 1; return c.getContext('2d', { willReadFrequently: true })!; })();
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = s;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0]! / 255, d[1]! / 255, d[2]! / 255];
}

const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export function readTheme(el: HTMLElement): Theme {
  const cs = getComputedStyle(el);
  const v = (k: string) => cs.getPropertyValue(k);
  const bg = parseColor(v('--pl-bg'), [1, 1, 1]);
  return {
    name: v('--pl-theme-name').trim().replace(/['"]/g, '') || 'neutral',
    bg,
    fg: parseColor(v('--pl-fg'), [0, 0, 0]),
    muted: parseColor(v('--pl-muted'), [0.5, 0.5, 0.5]),
    line: parseColor(v('--pl-line'), [0.6, 0.6, 0.6]),
    accent: parseColor(v('--pl-accent'), [0.2, 0.4, 1]),
    accent2: parseColor(v('--pl-accent-2'), [1, 0.5, 0.2]),
    ok: parseColor(v('--pl-ok'), [0.12, 0.62, 0.33]),
    card: parseColor(v('--pl-card'), [1, 1, 1]),
    glow: parseFloat(v('--pl-glow')) || 0,
    grain: parseFloat(v('--pl-grain')) || 0,
    dark: lum(bg) < 0.4,
  };
}

/** Mix two colours (sRGB). */
export const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
