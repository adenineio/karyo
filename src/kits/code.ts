/// <reference types="node" />
// A kit's code (docs/KITS.md "Code in kits"), bun / node only: the script files its plate types name, read safely
// (inside the kit's folder, symlinks followed and checked, plain .js/.mjs files, 1 MB at most), plus kit.json, which
// says what runs; each file's sha256 and one hash over them all (`kitHashInput`, src/kits/warning.ts). The hash is what
// the user trusts: any byte changed in any of these files is a new version.
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type { KitCode, KitManifest } from './types';
import { kitHashInput, validScriptPath } from './warning';

export const MAX_SCRIPT_BYTES = 1_000_000;

export const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The hash over a kit's code files. */
export const kitHash = (files: { path: string; sha256: string }[]) => sha256(kitHashInput(files));

/** A path for people: the home folder as ~. */
export function tildePath(p: string, home = homedir()): string {
  return home && (p === home || p.startsWith(home + sep)) ? `~${p.slice(home.length)}` : p;
}

/** The scripts a manifest names (`script` plate types), in order, without repeats. */
export function scriptsOf(manifest: KitManifest): string[] {
  const out: string[] = [];
  for (const p of Array.isArray(manifest.plates) ? manifest.plates : []) if (p && typeof p === 'object' && p.view === 'script' && typeof p.script === 'string' && !out.includes(p.script)) out.push(p.script);
  return out;
}

/** A plain file inside `dir` (symlinks followed, and still inside it), at most `max` bytes; throws why not. Keeps a
 *  project from pointing kit.json at a FIFO, /dev/zero or a file outside the kit. */
export async function readPlainFile(dir: string, rel: string, max = MAX_SCRIPT_BYTES): Promise<Buffer> {
  const [realDirPath, real] = await Promise.all([realpath(dir), realpath(join(dir, rel))]);
  if (!real.startsWith(realDirPath + sep)) throw new Error(`${rel} leads outside the kit's folder`);
  const st = await stat(real);
  if (!st.isFile()) throw new Error(`${rel} is not a plain file`);
  if (st.size > max) throw new Error(`${rel} is ${st.size} bytes, more than ${max}`);
  return readFile(real);
}

export interface ReadCode { code: KitCode; sources: Record<string, string>; /** scripts that could not be read (their plates are dropped) */ failed: string[] }

/** A kit's code, read from disk: null when it names no script. `problems` gets what is wrong with a script (a path
 *  outside the folder, a missing file, a symlink out of the kit, too large); that script is left out. */
export async function readKitCode(dir: string, manifest: KitManifest, problems: { dir: string; message: string }[]): Promise<ReadCode | null> {
  const scripts = scriptsOf(manifest);
  if (!scripts.length) return null;
  const realDir = await realpath(dir);
  const sources: Record<string, string> = {};
  const failed: string[] = [];
  const files: KitCode['files'] = [];
  const kitJson = await readPlainFile(dir, 'kit.json');
  sources['kit.json'] = kitJson.toString('utf8');
  files.push({ path: 'kit.json', sha256: sha256(kitJson), bytes: kitJson.length });
  for (const s of scripts) {
    const bad = (why: string) => { problems.push({ dir, message: `script "${s}": ${why}; its plate type is left out` }); failed.push(s); };
    if (!validScriptPath(s)) { bad('must be a .js or .mjs file inside the kit\'s folder (a relative path of plain names)'); continue; }
    let real: string;
    try { real = await realpath(join(dir, s)); } catch { bad('the file is missing'); continue; }
    if (!(real + '').startsWith(realDir + sep)) { bad('it leads outside the kit\'s folder (a symlink?)'); continue; }
    const st = await stat(real);
    if (!st.isFile()) { bad('not a plain file'); continue; }
    if (st.size > MAX_SCRIPT_BYTES) { bad(`${st.size} bytes, more than ${MAX_SCRIPT_BYTES}`); continue; }
    const buf = await readFile(real);
    // the page re-hashes the text it received before it runs it (src/kits/trust-client.ts): the text must be the bytes
    if (!Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)) { bad('not UTF-8 text'); continue; }
    sources[s] = buf.toString('utf8');
    files.push({ path: s, sha256: sha256(buf), bytes: buf.length });
  }
  const sorted = files.slice(0, 1).concat(files.slice(1).sort((a, b) => (a.path < b.path ? -1 : 1)));
  return { code: { hash: kitHash(sorted), files: sorted }, sources, failed };
}
