// Text effects on real HTML text: split into per-word / per-character spans once (in build),
// then reveal, highlight or type them as a pure function of time.
import { clamp, prog, ease } from './util';

/**
 * Wrap each word (or character) of an element's text in <span class="pl-w"> / <span class="pl-c">.
 * Whitespace stays as text nodes, so wrapping and copy/paste behave like the original text.
 * Nested elements (e.g. <code>, <b>) are split recursively and kept.
 */
export function splitText(root: HTMLElement, by: 'words' | 'chars' = 'words'): HTMLSpanElement[] {
  const out: HTMLSpanElement[] = [];
  const walk = (n: Node) => {
    for (const c of [...n.childNodes]) {
      if (c.nodeType === 3) {
        const parts = (c.textContent ?? '').split(by === 'words' ? /(\s+)/ : /(\s)/);
        const frag = document.createDocumentFragment();
        for (const part of parts) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); continue; }
          const pieces = by === 'chars' ? [...part] : [part];
          for (const p of pieces) {
            const s = document.createElement('span');
            s.className = by === 'words' ? 'pl-w' : 'pl-c';
            s.textContent = p;
            frag.appendChild(s);
            out.push(s);
          }
        }
        c.replaceWith(frag);
      } else if (c.nodeType === 1) walk(c);
    }
  };
  walk(root);
  return out;
}

/** The first n characters of `text` (for typewriter effects); `k` in 0..1. */
export const typed = (text: string, k: number) => text.slice(0, Math.round(clamp(k) * text.length));

/** Typewriter timing: characters appear at `cps` characters per second from t0. */
export const typedAt = (text: string, t: number, t0: number, cps = 28) => text.slice(0, clamp(Math.floor((t - t0) * cps), 0, text.length));

/** Staggered 0..1 progress for item i of a list: starts at t0 + i*stagger, lasts dur. */
export const stagger = (t: number, i: number, t0: number, stag: number, dur: number, fn = ease.outCubic) => prog(t, t0 + i * stag, t0 + i * stag + dur, fn);

/** Format a number tween (e.g. counters): value at k between a and b with fixed decimals. */
export const countTo = (a: number, b: number, k: number, decimals = 0) => (a + (b - a) * clamp(k)).toFixed(decimals);
