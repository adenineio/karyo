/// <reference types="node" />
// The trust store (docs/KITS.md "Code in kits"): which versions of which kits the user allowed to run their own
// JavaScript. It lives in Karyo's home, `$KARYO_HOME/trust.json` (default ~/.adenine/karyo/trust.json), never in a
// project, so a repository can't trust itself. An entry is keyed by the kit's real (symlinks followed) absolute folder
// and the hash of its code (src/kits/code.ts): a kit moved, cloned elsewhere, or changed by one byte asks again.
// Trusting a new version of a kit replaces its old entry. Built-in kits need no entry: they are trusted automatically.
// Bun / node only; the page reaches it through the dev server (vite.config.ts `/__karyo/trust`), the terminal through
// `karyo kit trust | untrust | list`.
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { karyoHome } from './library';
import type { KitCode, KitSource } from './types';

export const TRUST_VERSION = 'trust/1';

export interface TrustEntry {
  /** The kit's folder, absolute, symlinks followed. */
  dir: string;
  name: string;
  source: KitSource;
  /** The hash of the code the user trusted (src/kits/code.ts `kitHash`). */
  hash: string;
  files: { path: string; sha256: string }[];
  /** When (ISO 8601). */
  trusted: string;
  /** From the page's warning panel or `karyo kit trust`. */
  via: 'page' | 'cli';
}
export interface TrustStore { karyo: typeof TRUST_VERSION; about: string; kits: TrustEntry[] }

const ABOUT = 'Kits whose JavaScript you allowed Karyo to run (docs/KITS.md "Code in kits"), one version each: a changed file asks again. Remove an entry (or run `karyo kit untrust <kit>`) to take it back.';

/** $KARYO_HOME/trust.json (default ~/.adenine/karyo/trust.json). */
export const trustFile = (env: Record<string, string | undefined> = process.env) => join(karyoHome(env), 'trust.json');

/** A folder as the store keys it: absolute, symlinks followed (as given when it doesn't exist). */
export function realDir(dir: string): string { try { return realpathSync(resolve(dir)); } catch { return resolve(dir); } }

export function readTrust(file: string): TrustStore {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (j && j.karyo === TRUST_VERSION && Array.isArray(j.kits)) return { karyo: TRUST_VERSION, about: ABOUT, kits: j.kits.filter((e: any) => e && typeof e.dir === 'string' && typeof e.hash === 'string') };
  } catch {}
  return { karyo: TRUST_VERSION, about: ABOUT, kits: [] };
}

function writeTrust(file: string, s: TrustStore) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ karyo: TRUST_VERSION, about: ABOUT, kits: s.kits }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch {}
}

export interface TrustState {
  /** This exact version is trusted (or the kit is built in). */
  trusted: boolean;
  builtin?: boolean;
  /** When it was trusted. */
  at?: string;
  /** Another version of this kit was trusted (so this one is a change). */
  changed?: boolean;
  /** Which files differ from the version that was trusted (new, changed or gone), when the caller passed its files. */
  changedFiles?: string[];
}

/** Is this version of the kit at `dir` trusted? */
export function trustState(file: string, dir: string, hash: string, source?: KitSource | string, files?: { path: string; sha256: string }[]): TrustState {
  if (source === 'builtin') return { trusted: true, builtin: true };
  const d = realDir(dir);
  const e = readTrust(file).kits.find((x) => x.dir === d);
  if (!e) return { trusted: false };
  if (e.hash === hash) return { trusted: true, at: e.trusted };
  if (!files) return { trusted: false, changed: true };
  const was = new Map(e.files.map((f) => [f.path, f.sha256])), now = new Map(files.map((f) => [f.path, f.sha256]));
  const changedFiles = [...new Set([...now.keys(), ...was.keys()])].filter((p) => was.get(p) !== now.get(p)).sort();
  return { trusted: false, changed: true, changedFiles };
}

/** Trust this version of a kit (replacing any other version's entry). Returns the entry. */
export function grantTrust(file: string, kit: { dir: string; name: string; source: KitSource }, code: KitCode, via: TrustEntry['via'], now = new Date()): TrustEntry {
  const d = realDir(kit.dir);
  const s = readTrust(file);
  const entry: TrustEntry = { dir: d, name: kit.name, source: kit.source, hash: code.hash, files: code.files.map((f) => ({ path: f.path, sha256: f.sha256 })), trusted: now.toISOString(), via };
  s.kits = [...s.kits.filter((x) => x.dir !== d), entry];
  writeTrust(file, s);
  return entry;
}

/** Take trust back from every version of the kit at `dir`. True when there was something to take back. */
export function revokeTrust(file: string, dir: string): boolean {
  const d = realDir(dir);
  const s = readTrust(file);
  const kits = s.kits.filter((x) => x.dir !== d);
  if (kits.length === s.kits.length) return false;
  writeTrust(file, { ...s, kits });
  return true;
}
