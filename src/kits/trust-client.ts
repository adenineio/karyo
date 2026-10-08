// The page's side of trust (docs/KITS.md "Code in kits"): ask the dev server whether this version of a kit's code is
// trusted, record the user's "Trust this version", take it back; and check, before anything runs, that the text the
// page received is exactly what was hashed. Built-in kits are trusted without asking.
import type { BundledCode, KitSource } from './types';
import { devToken, TOKEN_HEADER } from './devtoken';
import { kitHashInput } from './warning';

export interface PageTrust {
  trusted: boolean;
  builtin?: boolean;
  at?: string;
  /** Another version of this kit was trusted: this one changed since. */
  changed?: boolean;
  /** The files that differ from the version that was trusted. */
  changedFiles?: string[];
  /** The kit on disk is no longer the version this page holds (it changed after the page loaded): reload. */
  stale?: boolean;
  /** No dev server answered (a built site): nothing can be trusted here, except the built-ins. */
  offline?: boolean;
  error?: string;
}

const headers = (json = false): HeadersInit => { const h: Record<string, string> = {}; const t = devToken(); if (t) h[TOKEN_HEADER] = t; if (json) h['content-type'] = 'application/json'; return h; };

export async function trustStatus(code: BundledCode, source: KitSource): Promise<PageTrust> {
  if (source === 'builtin') return { trusted: true, builtin: true };
  try {
    const r = await fetch(`/__karyo/trust?dir=${encodeURIComponent(code.dir)}&hash=${encodeURIComponent(code.hash)}`, { headers: headers(), cache: 'no-store' });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return { trusted: false, offline: r.status === 404, error: j?.error ?? `${r.status} ${r.statusText}` };
    return { trusted: j.trusted === true, ...(j.at ? { at: String(j.at) } : {}), ...(j.changed ? { changed: true } : {}), ...(Array.isArray(j.changedFiles) ? { changedFiles: j.changedFiles.map(String) } : {}), ...(j.stale ? { stale: true } : {}) };
  } catch (e) { return { trusted: false, offline: true, error: String((e as Error).message ?? e) }; }
}

export async function trustGrant(code: BundledCode): Promise<{ ok: boolean; at?: string; error?: string; changed?: boolean }> {
  try {
    const r = await fetch('/__karyo/trust', { method: 'POST', headers: headers(true), body: JSON.stringify({ dir: code.dir, hash: code.hash }) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) return { ok: false, error: j?.error ?? (r.status === 404 ? 'this page has no Karyo server behind it (a built site?), so it can\'t record trust; open it with `karyo view`' : `${r.status} ${r.statusText}`), ...(j?.changed ? { changed: true } : {}) };
    return { ok: true, at: j.at };
  } catch (e) { return { ok: false, error: `Karyo's local server didn't answer (${String((e as Error).message ?? e)})` }; }
}

export async function trustRevoke(code: BundledCode): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/__karyo/trust?dir=${encodeURIComponent(code.dir)}`, { method: 'DELETE', headers: headers() });
    const j = await r.json().catch(() => null);
    return r.ok && j?.ok ? { ok: true } : { ok: false, error: j?.error ?? `${r.status} ${r.statusText}` };
  } catch (e) { return { ok: false, error: String((e as Error).message ?? e) }; }
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

/** The code the page holds is exactly the code that was hashed (each file, and the kit's hash over them). Anything
 *  else, and nothing runs. */
export async function verifyCode(code: BundledCode): Promise<boolean> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return false;
  for (const f of code.files) {
    const src = code.sources[f.path];
    if (typeof src !== 'string' || (await sha256(src)) !== f.sha256) return false;
  }
  return (await sha256(kitHashInput(code.files))) === code.hash;
}
