// The web fonts the main themes draw in, trimmed and kept in src/engine/fonts/ (dev/scripts/subset-fonts.py makes them;
// each folder holds its OFL licence). Live pages declare them with fonts.css (imported by the theme picker), so a font
// downloads only when a theme draws in it; a standalone explainer inlines the ones its themes need (src/explainer/build.ts).
// No DOM access: build.ts imports this under bun.

export type FontKey = 'inter' | 'geist' | 'geist-mono' | 'newsreader';
export interface FontFile { family: string; dir: string; file: string; weight: string }

export const FONT_FILES: Record<FontKey, FontFile> = {
  inter: { family: 'Inter', dir: 'inter', file: 'Inter.woff2', weight: '400 700' },
  geist: { family: 'Geist', dir: 'geist', file: 'Geist.woff2', weight: '400 700' },
  'geist-mono': { family: 'Geist Mono', dir: 'geist-mono', file: 'GeistMono.woff2', weight: '400 700' },
  newsreader: { family: 'Newsreader', dir: 'newsreader', file: 'Newsreader.woff2', weight: '400' },
};

/** `@font-face` rules for these fonts, each `src` given by `url(key)` (a path, or a data: URI). */
export function fontFaceCss(keys: Iterable<FontKey>, url: (f: FontFile) => string): string {
  return [...new Set(keys)].map((k) => {
    const f = FONT_FILES[k];
    return `@font-face{font-family:"${f.family}";src:url(${url(f)}) format("woff2");font-weight:${f.weight};font-style:normal;font-display:swap}`;
  }).join('\n');
}
