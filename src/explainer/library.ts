/// <reference types="node" />
// Component libraries (bun / node only). A component is a folder `<name>/` holding component.json,
// template.html and style.css. Resolution order, first match wins (later copies are "shadowed"):
//   1. <spec dir>/components            source 'project'  (then opts.extra folders, also 'project')
//   2. $KARYO_COMPONENTS (":"-separated) source 'env'
//   3. ~/.adenine/karyo/components       source 'adenine'
//   4. the repo's components/            source 'builtin'
// Kits' node kinds (docs/KITS.md) are components too: each joins at its kit's place in the same order (a project kit's
// kind before a shared component of the same name, a built-in component before a built-in kit's kind).
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve, delimiter, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ComponentMeta, ComponentSource, Library, LibraryComponent } from './types';
import { loadKits, type LoadKitsOpts } from '../kits/library';

/** The repo's built-in components folder. */
export const BUILTIN_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../components');

export interface LoadOpts {
  /** Folder of the spec file: its `components/` comes first. */
  specDir?: string;
  /** More library folders, searched right after the spec's (source 'project'). */
  extra?: string[];
  /** Override ~/.adenine/karyo/components (tests). */
  adenineDir?: string;
  /** Override the repo's components/ (tests). */
  builtinDir?: string;
  /** Override $KARYO_COMPONENTS (tests); '' disables it. */
  env?: string;
  /** Kits whose node kinds join the library (docs/KITS.md): false leaves them out. Default: the spec's project kits,
   *  $KARYO_KITS, the shared library (beside `adenineDir` when that is given) and the built-ins. */
  kits?: false | LoadKitsOpts;
}

export interface LibraryProblem { dir: string; message: string }
export type LoadedLibrary = Library & { problems: LibraryProblem[] };

const exists = async (p: string) => { try { return (await stat(p)).isDirectory(); } catch { return false; } };

async function readComponent(dir: string, name: string, source: ComponentSource, problems: LibraryProblem[]): Promise<LibraryComponent | null> {
  let meta: ComponentMeta;
  try { meta = JSON.parse(await readFile(join(dir, 'component.json'), 'utf8')); }
  catch (e) { problems.push({ dir, message: `component.json: ${e instanceof Error ? e.message : String(e)}` }); return null; }
  let template: string;
  try { template = await readFile(join(dir, 'template.html'), 'utf8'); }
  catch { problems.push({ dir, message: 'template.html is missing' }); return null; }
  const css = await readFile(join(dir, 'style.css'), 'utf8').catch(() => '');
  if (!meta || typeof meta !== 'object') { problems.push({ dir, message: 'component.json is not an object' }); return null; }
  if (meta.name !== name) problems.push({ dir, message: `component.json name "${meta.name}" differs from its folder "${name}" (the folder name is used)` });
  if (!meta.props || typeof meta.props !== 'object') { problems.push({ dir, message: 'component.json has no "props" schema (treated as any object)' }); meta.props = { type: 'object' }; }
  return { name, dir, source, meta: { ...meta, name }, template, css };
}

/** Load every component folder on the resolution path. */
export async function loadLibrary(opts: LoadOpts = {}): Promise<LoadedLibrary> {
  const roots: { dir: string; source: ComponentSource }[] = [];
  if (opts.specDir) roots.push({ dir: resolve(opts.specDir, 'components'), source: 'project' });
  for (const d of opts.extra ?? []) roots.push({ dir: resolve(d), source: 'project' });
  const env = opts.env ?? process.env.KARYO_COMPONENTS ?? '';
  for (const d of env.split(delimiter).map((s) => s.trim()).filter(Boolean)) roots.push({ dir: resolve(d), source: 'env' });
  roots.push({ dir: resolve(opts.adenineDir ?? join(homedir(), '.adenine', 'karyo', 'components')), source: 'adenine' });
  roots.push({ dir: resolve(opts.builtinDir ?? BUILTIN_DIR), source: 'builtin' });
  // the same folder twice (e.g. the spec lives in the repo root) counts once, at its first place
  const seen = new Set<string>();
  const searched = roots.filter((r) => (seen.has(r.dir) ? false : (seen.add(r.dir), true)));

  const lib: LoadedLibrary = { components: {}, shadowed: [], searched, problems: [] };
  const copies = new Map<string, { dir: string; source: ComponentSource }[]>();
  for (const root of searched) {
    if (!(await exists(root.dir))) continue;
    const names = (await readdir(root.dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_')).map((e) => e.name).sort();
    for (const name of names) {
      const dir = join(root.dir, name);
      try { await stat(join(dir, 'component.json')); } catch { continue; }
      const c = await readComponent(dir, name, root.source, lib.problems);
      if (!c) continue;
      (copies.get(name) ?? copies.set(name, []).get(name)!).push({ dir, source: root.source });
      if (!lib.components[name]) lib.components[name] = c;
    }
  }
  // kits' node kinds: at their kit's place in the order (a nearer copy wins either way)
  if (opts.kits !== false) {
    const rank: Record<ComponentSource, number> = { project: 0, env: 1, adenine: 2, builtin: 3 };
    const kl = await loadKits({ projectDir: opts.specDir, ...(opts.adenineDir ? { homeDir: join(dirname(resolve(opts.adenineDir)), 'kits') } : {}), ...(opts.kits ?? {}) });
    for (const k of Object.values(kl.kinds)) {
      const at = { dir: k.dir, source: k.source }, have = lib.components[k.name];
      const list = copies.get(k.name) ?? copies.set(k.name, []).get(k.name)!;
      if (!have || rank[k.source] < rank[have.source]) {
        lib.components[k.name] = { name: k.name, dir: k.dir, source: k.source, meta: k.meta, template: k.template, css: k.css };
        list.unshift(at);
      } else list.push(at);
    }
    lib.problems.push(...kl.problems);
  }
  for (const [name, list] of copies) if (list.length > 1) lib.shadowed.push({ name, used: list[0]!, hidden: list.slice(1) });
  return lib;
}

/** Write a starter component `<dir>/<name>/` (component.json, template.html, style.css). Returns its folder. */
export async function scaffoldComponent(dir: string, name: string): Promise<string> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`component names are lowercase letters, digits and - (got "${name}")`);
  const at = resolve(dir, name);
  if (await exists(at)) throw new Error(`${at} already exists`);
  await mkdir(at, { recursive: true });
  const meta: ComponentMeta = {
    name,
    description: `TODO: what a ${name} shows, in one sentence.`,
    version: '0.1.0',
    props: {
      type: 'object',
      required: ['title', 'value'],
      additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1 },
        value: { type: 'number', description: 'counts up when it appears or a step sets it' },
        note: { type: 'string', description: 'markdown-lite' },
      },
    },
    size: { w: 280 },
    motion: ['appear', 'emphasize', 'count'],
    example: { title: 'Example', value: 42, note: 'Some **markdown-lite**.' },
  };
  await writeFile(join(at, 'component.json'), JSON.stringify(meta, null, 2) + '\n');
  await writeFile(join(at, 'template.html'), `<!-- {{prop}} escaped · {{{prop}}} markdown-lite · {{#each list}}…{{this}}…{{/each}} · {{#if prop}}…{{else}}…{{/if}}
     data-k-num="prop" counts a number · data-k-scale="value/max" drives --k (0..1) · data-k-draw on an SVG path draws it on -->
<div class="pl-card box">
  <div class="pl-label">{{title}}</div>
  <div class="num" data-k-num="value">{{value}}</div>
  {{#if note}}<div class="note">{{{note}}}</div>{{/if}}
</div>
`);
  await writeFile(join(at, 'style.css'), `/* Scoped under .kc-${name} by the loader: ".box" means ".kc-${name} .box"; ":host" is the element itself.
   Theme tokens only (var(--pl-*)); no transitions or animations (the engine owns time). */
.box { height: 100%; display: flex; flex-direction: column; gap: 6px; }
.num { font: 800 36px/1.1 var(--pl-font-display); font-variant-numeric: tabular-nums; }
.note { font-size: 14px; color: var(--pl-muted); }
.note p { margin: 0; }
:host(.is-lit) .box { border-color: var(--pl-accent); }
`);
  return at;
}
