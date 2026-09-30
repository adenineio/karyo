/// <reference types="node" />
// Dev-only persistence for splices (docs/MODEL.md "Splices"): the Vite dev server mounts this (vite.config.ts,
// next to the layout saver) so a plate can list, open, save and delete `<project>/karyo/splices/<id>.splice.json`.
// Same safety rules as the layout saver: a path allow-list (`**/karyo/splices/*.splice.json`, no `.`/`..`
// segments, no dot-folders, no node_modules), resolved inside the repo, and the real folder (symlinks followed)
// must be inside the repo too. Anything else is a 403. Writes are atomic (temp file + rename).
//
//   GET    /__karyo/splices?dir=<repo-relative dir>   → [{ id, title, updated, ops, file }]  (dir: a project folder or its karyo/splices)
//   GET    /__karyo/splice?file=<…/karyo/splices/x.splice.json>  → the splice JSON
//   POST   /__karyo/splice?file=…   body: the splice   → { ok: true, file, issues }  (400 with { ok: false, error, issues } when invalid)
//   DELETE /__karyo/splice?file=…                       → { ok: true, file }
import type { IncomingMessage, ServerResponse } from 'node:http';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { SPLICE_DIR, SPLICE_FILE_RE, validateSplice } from './splice';

const SEG = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const MAX_BODY = 2_000_000;

export interface SpliceListItem { id: string; title: string; updated: string | null; ops: number; file: string; error?: string }

/** A repo-relative path made only of plain segments (no `.`, `..`, dot-folders, node_modules). */
const plain = (p: string) => p.split('/').every((s) => SEG.test(s) && s !== 'node_modules');
/** `rel` as an absolute path inside `root`, or null. */
function within(root: string, rel: string): string | null {
  const abs = resolve(root, rel), r = relative(root, abs);
  return r && !r.startsWith('..') && !isAbsolute(r) ? abs : null;
}
/** The real (symlinks followed) nearest existing folder at or above `abs` is inside the real root. */
async function reallyInside(root: string, abs: string): Promise<boolean> {
  const realRoot = await realpath(root);
  let p = abs;
  for (;;) {
    try { const r = await realpath(p); return r === realRoot || (r + sep).startsWith(realRoot + sep); }
    catch (e: any) { if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e; }
    const up = dirname(p);
    if (up === p) return false;
    p = up;
  }
}
/** `file` param → absolute path, or an error reply's status and message. */
function checkFile(root: string, file: string): { abs: string } | { code: number; error: string } {
  if (!file) return { code: 400, error: 'add ?file=<…/karyo/splices/<id>.splice.json>' };
  if (!SPLICE_FILE_RE.test(file) || !plain(file)) return { code: 403, error: 'only **/karyo/splices/*.splice.json inside the repo' };
  const abs = within(root, file);
  return abs ? { abs } : { code: 403, error: 'outside the repo' };
}
/** `dir` param → the splices folder: a project folder (karyo/splices appended) or a karyo/splices folder. */
function checkDir(root: string, dir: string): { abs: string; rel: string } | { code: number; error: string } {
  const d = dir.replace(/^\.\/?/, '').replace(/\/+$/, '');
  const rel = d === '' ? SPLICE_DIR : /(^|\/)karyo\/splices$/.test(d) ? d : `${d}/${SPLICE_DIR}`;
  if (!plain(rel)) return { code: 403, error: 'dir must be a plain repo-relative folder' };
  const abs = within(root, rel);
  return abs ? { abs, rel } : { code: 403, error: 'outside the repo' };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let body = '', size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { fail(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; } body += c; });
    req.on('end', () => ok(body));
    req.on('error', fail);
  });
}

/** Connect-style middleware for `/__karyo/splices` and `/__karyo/splice`; anything else goes to `next`.
 *  `root` is the repo: every path is relative to it and must stay inside it. */
export function spliceMiddleware(root: string) {
  return async (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '');
    if (route !== '/__karyo/splices' && route !== '/__karyo/splice') return next ? next() : void (res.statusCode = 404, res.end());
    const reply = (code: number, body: unknown) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)); };
    try {
      if (route === '/__karyo/splices') {
        if (req.method !== 'GET') return reply(405, { ok: false, error: 'GET only' });
        const d = checkDir(root, url.searchParams.get('dir') ?? '');
        if ('code' in d) return reply(d.code, { ok: false, error: d.error });
        if (!(await reallyInside(root, d.abs))) return reply(403, { ok: false, error: 'outside the repo' });
        let names: string[];
        try { names = await readdir(d.abs); } catch (e: any) { if (e?.code === 'ENOENT') return reply(200, []); throw e; }
        const items: SpliceListItem[] = [];
        for (const name of names.filter((n) => n.endsWith('.splice.json') && SEG.test(n)).sort()) {
          const abs = `${d.abs}${sep}${name}`, file = `${d.rel}/${name}`, stem = name.slice(0, -'.splice.json'.length);
          const st = await lstat(abs);
          if (!st.isFile()) continue; // symlinks and folders are never listed
          try {
            const j = JSON.parse(await readFile(abs, 'utf8'));
            items.push({ id: typeof j?.id === 'string' ? j.id : stem, title: typeof j?.title === 'string' ? j.title : stem, updated: typeof j?.updated === 'string' ? j.updated : null, ops: Array.isArray(j?.ops) ? j.ops.length : 0, file });
          } catch (e) { items.push({ id: stem, title: stem, updated: null, ops: 0, file, error: `not JSON: ${String((e as Error).message ?? e)}` }); }
        }
        items.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || a.id.localeCompare(b.id));
        return reply(200, items);
      }
      // /__karyo/splice
      const f = checkFile(root, url.searchParams.get('file') ?? '');
      if ('code' in f) return reply(f.code, { ok: false, error: f.error });
      const file = url.searchParams.get('file')!;
      if (req.method === 'GET') {
        let text: string;
        try {
          if (!(await reallyInside(root, f.abs))) return reply(403, { ok: false, error: 'outside the repo' });
          text = await readFile(f.abs, 'utf8');
        } catch (e: any) { if (e?.code === 'ENOENT') return reply(404, { ok: false, error: `no such splice: ${file}` }); throw e; }
        try { return reply(200, JSON.parse(text)); } catch (e) { return reply(422, { ok: false, error: `${file} is not JSON: ${String((e as Error).message)}` }); }
      }
      if (req.method === 'POST') {
        let j: unknown;
        try { j = JSON.parse(await readBody(req)); } catch (e: any) { return reply(e?.status ?? 400, { ok: false, error: e?.status ? String(e.message) : `body is not JSON: ${String(e?.message ?? e)}` }); }
        const issues = validateSplice(j);
        const errors = issues.filter((x) => x.level === 'error');
        if (errors.length) return reply(400, { ok: false, error: errors.map((x) => `${x.path || '/'}: ${x.message}`).join('; '), issues });
        const stem = basename(f.abs).slice(0, -'.splice.json'.length);
        if ((j as { id: string }).id !== stem) return reply(400, { ok: false, error: `the splice's id "${(j as { id: string }).id}" must match its file name (${stem}.splice.json)`, issues });
        const dir = dirname(f.abs);
        if (!(await reallyInside(root, dir))) return reply(403, { ok: false, error: 'outside the repo' });
        await mkdir(dir, { recursive: true });
        if (!(await reallyInside(root, dir))) return reply(403, { ok: false, error: 'outside the repo' });
        try { if ((await lstat(f.abs)).isSymbolicLink()) return reply(403, { ok: false, error: 'refusing to write through a symlink' }); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
        const tmp = `${f.abs}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        try { await writeFile(tmp, JSON.stringify(j, null, 2) + '\n'); await rename(tmp, f.abs); }
        catch (e) { await unlink(tmp).catch(() => {}); throw e; }
        return reply(200, { ok: true, file, issues });
      }
      if (req.method === 'DELETE') {
        let st;
        try { st = await lstat(f.abs); } catch (e: any) { if (e?.code === 'ENOENT') return reply(404, { ok: false, error: `no such splice: ${file}` }); throw e; }
        if (!st.isFile()) return reply(403, { ok: false, error: 'not a plain file' });
        if (!(await reallyInside(root, dirname(f.abs)))) return reply(403, { ok: false, error: 'outside the repo' });
        await unlink(f.abs);
        return reply(200, { ok: true, file });
      }
      return reply(405, { ok: false, error: 'GET, POST or DELETE' });
    } catch (e) { return reply(500, { ok: false, error: String(e instanceof Error ? e.message : e) }); }
  };
}
