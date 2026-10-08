/// <reference types="node" />
// Demos (bun / node): a folder demos/<name>/ holding a series of explainer specs and a demo.json manifest, built to
// one folder of self-contained HTML pages (`karyo demo <name>`). The landing spec becomes index.html and every other
// spec <id>.html beside it, so pages link to each other by relative file names and the folder opens from file://.
//
//   demo.json  { "title": "…", "description": "…", "landing": "index/index.explainer.json",
//                "components": "components", "specs": ["explainers/a/a.explainer.json", …] }
//
// `components` (optional) is the series' shared components folder: it stands in for $KARYO_COMPONENTS while the
// pages build. Built pages are cached in a folder keyed by Karyo's version and a hash of the demo's files, so a
// rebuild happens only when one of them changes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildHtml, ensureRuntime } from './build';

export class DemoError extends Error {}

export interface DemoManifest { title: string; description?: string; landing: string; components?: string; specs: string[] }
export interface DemoPage { spec: string; rel: string; id: string; file: string }
export interface Demo { name: string; dir: string; manifest: DemoManifest; components: string | null; pages: DemoPage[] }

const STAMP = '.karyo-demo.json';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The demo folder's manifest, checked: every path inside the folder and present, page names unique. */
export function readDemo(dir: string): Demo {
  const name = path.basename(dir);
  const mf = path.join(dir, 'demo.json');
  if (!existsSync(mf)) throw new DemoError(`demo "${name}" has no demo.json`);
  let m: any;
  try { m = JSON.parse(readFileSync(mf, 'utf8')); } catch (e) { throw new DemoError(`demo "${name}": demo.json is not valid JSON (${(e as Error).message})`); }
  const bad = (msg: string): never => { throw new DemoError(`demo "${name}": demo.json ${msg}`); };
  if (!m || typeof m !== 'object' || Array.isArray(m)) bad('must be an object');
  if (typeof m.title !== 'string' || !m.title.trim()) bad('needs a "title"');
  if (m.description !== undefined && typeof m.description !== 'string') bad('"description" must be a string');
  if (typeof m.landing !== 'string') bad('needs a "landing" spec (the page index.html is built from)');
  if (!Array.isArray(m.specs) || m.specs.some((s: unknown) => typeof s !== 'string')) bad('needs "specs", a list of spec paths');
  if (m.components !== undefined && typeof m.components !== 'string') bad('"components" must be a folder path');
  const inside = (rel: string, what: string) => {
    const abs = path.resolve(dir, rel);
    const r = path.relative(dir, abs);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) bad(`${what} "${rel}" is outside the demo's folder`);
    return abs;
  };
  const page = (rel: string, landing: boolean): DemoPage => {
    const spec = inside(rel, 'spec');
    if (!rel.endsWith('.explainer.json')) bad(`spec "${rel}" is not a *.explainer.json file`);
    if (!existsSync(spec)) bad(`names "${rel}", which doesn't exist`);
    const id = path.basename(spec, '.explainer.json');
    if (!ID.test(id)) bad(`spec "${rel}": "${id}" can't be a page name (letters, digits, - and _ only)`);
    return { spec, rel, id, file: landing ? 'index.html' : `${id}.html` };
  };
  const pages = [page(m.landing, true), ...m.specs.filter((s: string) => path.resolve(dir, s) !== path.resolve(dir, m.landing)).map((s: string) => page(s, false))];
  const seen = new Map<string, string>();
  for (const p of pages) {
    const prev = seen.get(p.file);
    if (prev) bad(`builds two pages named ${p.file} (${prev} and ${p.rel})`);
    seen.set(p.file, p.rel);
  }
  let components: string | null = null;
  if (m.components !== undefined) {
    components = inside(m.components, 'components folder');
    if (!existsSync(components) || !statSync(components).isDirectory()) bad(`names the components folder "${m.components}", which doesn't exist`);
  }
  return { name, dir, manifest: m as DemoManifest, components, pages };
}

/** Every demo under `root` (demos/), by name; one whose manifest is broken is listed with its problem. */
export function listDemos(root: string): { name: string; title: string; description: string; pages: number; dir: string; problem?: string }[] {
  if (!existsSync(root)) return [];
  const out: ReturnType<typeof listDemos> = [];
  for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(root, e.name);
    if (!e.isDirectory() || e.name.startsWith('.') || !existsSync(path.join(dir, 'demo.json'))) continue;
    try {
      const d = readDemo(dir);
      out.push({ name: d.name, title: d.manifest.title, description: d.manifest.description ?? '', pages: d.pages.length, dir });
    } catch (err) { out.push({ name: e.name, title: '', description: '', pages: 0, dir, problem: (err as Error).message }); }
  }
  return out;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base)); else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

/** A hash of everything in the demo's folder (paths and bytes; dotfiles left out). */
export function demoHash(dir: string): string {
  const h = createHash('sha256');
  for (const rel of walk(dir)) { h.update(rel.split(path.sep).join('/')); h.update('\0'); h.update(readFileSync(path.join(dir, rel))); h.update('\0'); }
  return h.digest('hex').slice(0, 16);
}

/** The cache key: Karyo's version and the demo's hash. */
export const demoKey = (dir: string, version: string) => `${version.replace(/[^A-Za-z0-9._-]/g, '-') || 'dev'}-${demoHash(dir)}`;

type Stamp = { key: string; demo: string; title: string; pages: string[]; built: string };
function readStamp(dir: string): Stamp | null { try { return JSON.parse(readFileSync(path.join(dir, STAMP), 'utf8')); } catch { return null; } }
const complete = (dir: string, key: string) => { const s = readStamp(dir); return !!s && s.key === key && s.pages.every((f) => existsSync(path.join(dir, f))); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export interface BuildDemoOpts {
  /** Karyo's version (part of the cache key). */
  version: string;
  /** Where cached builds live: <cacheRoot>/<demo>/<key>/. */
  cacheRoot: string;
  /** Build into this folder instead of the cache (its own stamp file keeps it current). */
  out?: string;
  /** Where the explainer runtime is cached (default: build.ts's). */
  runtimeDir?: string;
  /** Rebuild even when the key matches. */
  force?: boolean;
  /** Pages built at once. */
  parallel?: number;
  /** Called before building (with the page count) and after each page. */
  onProgress?: (done: number, total: number, page?: DemoPage) => void;
}
export interface BuildDemoResult { dir: string; index: string; key: string; built: boolean; ms: number; pages: { file: string; spec: string; bytes: number }[]; warnings: string[] }

/** Build the demo's pages into a folder keyed by version and content, or reuse the one already there. */
export async function buildDemo(demo: Demo, o: BuildDemoOpts): Promise<BuildDemoResult> {
  const key = demoKey(demo.dir, o.version);
  const target = o.out ? path.resolve(o.out) : path.join(o.cacheRoot, demo.name, key);
  const files = demo.pages.map((p) => p.file);
  if (!o.force && complete(target, key)) {
    return { dir: target, index: path.join(target, 'index.html'), key, built: false, ms: 0, warnings: [],
      pages: demo.pages.map((p) => ({ file: path.join(target, p.file), spec: p.rel, bytes: statSync(path.join(target, p.file)).size })) };
  }
  const t0 = performance.now();
  // the cache is built beside its final place and moved in when whole; --out is written in place, stamp last
  const work = o.out ? target : `${target}.tmp-${process.pid}`;
  if (!o.out) rmSync(work, { recursive: true, force: true });
  else rmSync(path.join(target, STAMP), { force: true });
  mkdirSync(work, { recursive: true });

  const prevEnv = process.env.KARYO_COMPONENTS;
  const env = demo.components ?? '';
  const warnings: string[] = [], errors: string[] = [];
  const built: BuildDemoResult['pages'] = [];
  o.onProgress?.(0, demo.pages.length);
  try {
    process.env.KARYO_COMPONENTS = env;
    try { await ensureRuntime(o.runtimeDir); }
    catch (e) { throw new DemoError(`couldn't build the explainer runtime: ${(e as Error).message}`); }
    // the series' own components only: not the user's shared library (a missing folder), so every machine builds the same pages
    const load = { env, adenineDir: path.join(work, '.no-shared-library'), runtimeDir: o.runtimeDir };
    const queue = [...demo.pages];
    let done = 0;
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        try {
          const r = await buildHtml(p.spec, path.join(work, p.file), load);
          for (const i of r.issues) (i.level === 'error' ? errors : warnings).push(`${p.rel}: ${i.path || '/'} ${i.message}${i.hint ? ` (${i.hint})` : ''}`);
          built.push({ file: path.join(target, p.file), spec: p.rel, bytes: r.bytes });
        } catch (e) { errors.push(`${p.rel}: ${(e as Error).message}`); }
        o.onProgress?.(++done, demo.pages.length, p);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.parallel ?? 4, demo.pages.length)) }, worker));
  } catch (e) {
    if (!o.out) rmSync(work, { recursive: true, force: true });
    throw e;
  } finally {
    if (prevEnv === undefined) delete process.env.KARYO_COMPONENTS; else process.env.KARYO_COMPONENTS = prevEnv;
  }
  if (errors.length) {
    if (!o.out) rmSync(work, { recursive: true, force: true });
    const shown = errors.slice(0, 8);
    throw new DemoError(`demo "${demo.name}" didn't build: ${errors.length} error(s)\n  ${shown.join('\n  ')}${errors.length > shown.length ? `\n  … and ${errors.length - shown.length} more` : ''}`);
  }
  const stamp: Stamp = { key, demo: demo.name, title: demo.manifest.title, pages: files, built: new Date().toISOString() };
  writeFileSync(path.join(work, STAMP), JSON.stringify(stamp, null, 2) + '\n');
  if (!o.out) {
    rmSync(target, { recursive: true, force: true });
    renameSync(work, target);
    // older builds of this demo (another version or older sources) and abandoned work folders go
    for (const e of readdirSync(path.dirname(target))) {
      if (e === key) continue;
      const m = e.match(/\.tmp-(\d+)$/);
      if (m && alive(+m[1]!)) continue;
      rmSync(path.join(path.dirname(target), e), { recursive: true, force: true });
    }
  }
  built.sort((a, b) => files.indexOf(path.basename(a.file)) - files.indexOf(path.basename(b.file)));
  return { dir: target, index: path.join(target, 'index.html'), key, built: true, ms: performance.now() - t0, pages: built, warnings };
}
