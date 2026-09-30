// The words Karyo uses whenever a kit's code is about to run, or could (docs/KITS.md "Code in kits"). One source for the
// page's warning panel and notice (src/kits/script-plate.ts) and the terminal (`karyo kit trust`, `karyo kit list`,
// `karyo view`), so people read the same thing wherever they meet it. Pure: no DOM, no fs.
import type { KitSource } from './types';

/** What trusting a kit means, in plain words. */
export const KIT_CODE_WARNING = "This kit runs its own JavaScript in this page. It can read the diagram's data and, because Karyo's local server is running, could try to change files in this project. Only trust kits whose code you have read or whose author you trust.";

/** What Karyo does to limit it; a safety net, not a reason to trust. */
export const KIT_CODE_SANDBOX = "Karyo runs it in a sealed frame: it is handed the diagram's data and draws, it has no key to Karyo's local server (which refuses requests without one), and most ways out to the network are blocked, though not all. That is a safety net, not a reason to run code you haven't read.";

/** Where trust is kept, and why a project can't trust itself. */
export const KIT_TRUST_WHERE = "Trust is kept in your home folder, never in the project, and only for this exact version: if any of these files changes, Karyo asks again.";

/** Where a kit comes from, in words: "this project (…)", "your kits (~/.adenine/…)", "built into Karyo". */
export function whereWords(source: KitSource | string, shownDir: string): string {
  switch (source) {
    case 'project': return `this project (${shownDir})`;
    case 'adenine': return `your kits (${shownDir})`;
    case 'env': return `your KARYO_KITS folders (${shownDir})`;
    case 'builtin': return 'built into Karyo';
    default: return shownDir;
  }
}

/** A timestamp as the local day it fell on (YYYY-MM-DD). */
export function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The notice a running kit plate always shows ("warn whenever loading"). */
export function noticeWords(kit: string, source: KitSource | string, where: string, trustedAt: string | null): string {
  const when = source === 'builtin' ? 'trusted automatically' : trustedAt ? `trusted ${localDay(trustedAt)}` : 'not trusted';
  return `⚠ runs code from kit ${kit} · ${when} · ${where}`;
}

/** The text a kit's hash is the sha256 of: a format line, then each file's path and sha256, in path order (kit.json
 *  first). The browser checks it (crypto.subtle) before it runs anything; bun computes it with node:crypto. */
export function kitHashInput(files: { path: string; sha256: string }[]): string {
  const sorted = [...files].sort((a, b) => (a.path === 'kit.json' ? -1 : b.path === 'kit.json' ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return `karyo-kit-code/1\n${sorted.map((f) => `${f.path}\n${f.sha256}\n`).join('')}`;
}

/** A script path a kit may name: relative, inside the kit's folder, plain segments, a .js or .mjs file. */
export const SCRIPT_PATH_RE = /^(?:[A-Za-z0-9_][\w.-]*\/)*[A-Za-z0-9_][\w.-]*\.m?js$/;
export const validScriptPath = (p: unknown): p is string => typeof p === 'string' && SCRIPT_PATH_RE.test(p) && !p.split('/').some((s) => s === '..' || s === '.');

/** Characters that change how text reads or don't show at all (bidi controls, zero-width characters, a BOM, a soft
 *  hyphen): code can look different from what runs ("Trojan Source"). The source viewer and `karyo kit trust` mark them. */
export const HIDDEN_CHARS = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
export const hiddenCount = (src: string) => (src.match(HIDDEN_CHARS) ?? []).length;
export const hiddenName = (c: string) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
/** Text safe for a terminal: control characters (C0 but newline and tab, C1, ESC sequences) and the characters above
 *  shown as ⟦U+…⟧, so a kit's name or description can't rewrite the warning around it. */
export const termSafe = (s: string) => s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, (c) => `⟦${hiddenName(c)}⟧`).replace(HIDDEN_CHARS, (c) => `⟦${hiddenName(c)}⟧`);
