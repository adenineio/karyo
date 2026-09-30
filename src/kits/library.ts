/// <reference types="node" />
// Kit libraries (bun / node only; docs/KITS.md). A kit is a folder `<name>/` holding kit.json, and node kinds in
// kinds/<kind>/ (each a component: component.json with a `node` block, template.html, style.css, section templates).
// Resolution order, nearest first; the first kit, kind or plate type of a name wins and hides the later ones (a
// warning names both):
//   1. the project's karyo/kits           source 'project'  (the nearest folder, from the model or spec upwards; then opts.extra)
//   2. $KARYO_KITS (":"-separated)        source 'env'
//   3. $KARYO_HOME/kits                   source 'adenine'  (default ~/.adenine/karyo/kits: the shared library)
//   4. the plugin's kits/                 source 'builtin'
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { BundledKind, BundledPlate, KitBundle, KitCode, KitManifest, KitSource, KindMeta, PlateType } from './types';
import { KIT_VERSION } from './types';
import { readKitCode, readPlainFile, tildePath } from './code';
import { whereWords } from './warning';

/** The plugin's built-in kits folder. */
export const BUILTIN_KITS_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../kits');

/** Karyo's shared home: $KARYO_HOME, else ~/.adenine/karyo. The kit library is its kits/ folder. */
export const karyoHome = (env: Record<string, string | undefined> = process.env) => (env.KARYO_HOME ? resolve(env.KARYO_HOME) : join(homedir(), '.adenine', 'karyo'));
export const homeKitsDir = (env: Record<string, string | undefined> = process.env) => join(karyoHome(env), 'kits');

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** A project's kits folder: `karyo/kits` in `start` or the nearest folder above it that has one, stopping at the
 *  repository root (a folder holding `.git`). Null when there is none. */
export function findProjectKits(start: string): string | null {
  for (let d = resolve(start); ; d = dirname(d)) {
    if (isDir(join(d, 'karyo', 'kits'))) return join(d, 'karyo', 'kits');
    if (existsSync(join(d, '.git')) || dirname(d) === d) return null;
  }
}

export interface LoadKitsOpts {
  /** Where the project is (a model's or spec's folder, or the project root): its karyo/kits, found upwards, comes first. */
  projectDir?: string;
  /** More kit folders, searched right after the project's (source 'project'). */
  extra?: string[];
  /** Override $KARYO_KITS (tests); '' disables it. */
  env?: string;
  /** Override the shared library, $KARYO_HOME/kits (tests). */
  homeDir?: string;
  /** Override the built-in kits/ (tests). */
  builtinDir?: string;
}

export interface LoadedKind extends BundledKind { dir: string }
export interface LoadedPlate extends BundledPlate { dir: string }
export interface LoadedKit {
  name: string; dir: string; source: KitSource; manifest: KitManifest; kinds: string[]; plates: string[];
  /** Its code, when a plate type runs a script (docs/KITS.md "Code in kits"): the files, their hashes, their text. */
  code?: KitCode & { sources: Record<string, string> };
}
/** A kit, kind or plate type hidden by a nearer one of the same name. */
export interface KitShadow { what: 'kit' | 'kind' | 'plate'; name: string; used: { kit: string; dir: string; source: KitSource }; hidden: { kit: string; dir: string; source: KitSource }[] }
export interface KitProblem { dir: string; message: string }
export interface KitLibrary {
  kits: LoadedKit[];
  kinds: Record<string, LoadedKind>;
  plates: Record<string, LoadedPlate>;
  shadowed: KitShadow[];
  problems: KitProblem[];
  searched: { dir: string; source: KitSource }[];
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One kind folder: component.json (with its `node` block), template.html, style.css and the templates it names. */
export async function readKind(dir: string, name: string, kit: string, source: KitSource, problems: KitProblem[]): Promise<LoadedKind | null> {
  let meta: KindMeta;
  try { meta = JSON.parse(await readFile(join(dir, 'component.json'), 'utf8')); }
  catch (e) { problems.push({ dir, message: `component.json: ${errText(e)}` }); return null; }
  if (!meta || typeof meta !== 'object') { problems.push({ dir, message: 'component.json is not an object' }); return null; }
  let template: string;
  try { template = await readFile(join(dir, 'template.html'), 'utf8'); }
  catch { problems.push({ dir, message: 'template.html is missing' }); return null; }
  const css = await readFile(join(dir, 'style.css'), 'utf8').catch(() => '');
  if (meta.name !== name) problems.push({ dir, message: `component.json name "${meta.name}" differs from its folder "${name}" (the folder name is used)` });
  if (!meta.props || typeof meta.props !== 'object') { problems.push({ dir, message: 'component.json has no "props" schema (the fields are treated as any object)' }); meta.props = { type: 'object' }; }
  if (!meta.node || typeof meta.node !== 'object') { problems.push({ dir, message: 'component.json has no "node" block: it is a component, not a node kind (add "node": {})' }); meta.node = {}; }
  const sz = meta.size as Partial<KindMeta['size']> | undefined;
  if (!sz || !Number.isFinite(sz.w) || !Number.isFinite(sz.h)) problems.push({ dir, message: 'component.json needs "size": { "w", "h" } (the card size boards lay out and route by); using 188 × 72' });
  meta.size = { w: Number.isFinite(sz?.w) ? sz!.w! : 188, h: Number.isFinite(sz?.h) ? sz!.h! : 72 };
  const file = async (f: string, what: string) => {
    if (typeof f !== 'string' || !/^[\w.-]+\.html$/.test(f)) { problems.push({ dir, message: `${what}: "${f}" must be an .html file in the kind's folder` }); return null; }
    try { return await readFile(join(dir, f), 'utf8'); } catch { problems.push({ dir, message: `${what}: ${f} is missing` }); return null; }
  };
  const sections: BundledKind['sections'] = [];
  for (const s of Array.isArray(meta.node.sections) ? meta.node.sections : []) {
    if (!s || typeof s.id !== 'string') { problems.push({ dir, message: 'a section has no id' }); continue; }
    const t = await file(s.template, `section "${s.id}" template`);
    if (t === null) continue;
    const c = s.compact ? await file(s.compact, `section "${s.id}" compact`) : null;
    sections.push({ id: s.id, title: s.title || s.id, ...(s.noun ? { noun: s.noun } : {}), ...(s.keywords ? { keywords: s.keywords } : {}), template: t, ...(c !== null ? { compact: c } : {}) });
  }
  const mini = meta.node.mini ? await file(meta.node.mini, 'mini template') : null;
  return { name, kit, source, dir, meta: { ...meta, name }, template, css, sections, ...(mini !== null ? { mini } : {}) };
}

/** One kit folder: kit.json and its kinds. Null (with a problem) when kit.json can't be read. */
export async function readKit(dir: string, source: KitSource, problems: KitProblem[]): Promise<{ kit: LoadedKit; kinds: LoadedKind[]; plates: LoadedPlate[] } | null> {
  let manifest: KitManifest;
  try { manifest = JSON.parse((await readPlainFile(dir, 'kit.json')).toString('utf8')); }
  catch (e) { problems.push({ dir, message: `kit.json: ${errText(e)}` }); return null; }
  if (!manifest || typeof manifest !== 'object') { problems.push({ dir, message: 'kit.json is not an object' }); return null; }
  const name = dir.split(/[\\/]/).filter(Boolean).pop()!;
  if (manifest.karyo !== KIT_VERSION) problems.push({ dir, message: `kit.json "karyo" is ${JSON.stringify(manifest.karyo)}, expected "${KIT_VERSION}"` });
  if (manifest.name !== name) problems.push({ dir, message: `kit.json name "${manifest.name}" differs from its folder "${name}" (the folder name is used)` });
  const kdir = join(dir, 'kinds');
  const onDisk = isDir(kdir) ? (await readdir(kdir, { withFileTypes: true })).filter((e) => e.isDirectory() && !/^[._]/.test(e.name)).map((e) => e.name).sort() : [];
  const listed = Array.isArray(manifest.kinds) ? manifest.kinds : onDisk;
  for (const k of listed) if (!onDisk.includes(k)) problems.push({ dir, message: `kit.json lists kind "${k}", but there is no kinds/${k}/ folder` });
  const kinds: LoadedKind[] = [];
  for (const k of listed.filter((k) => onDisk.includes(k))) {
    const c = await readKind(join(kdir, k), k, name, source, problems);
    if (c) kinds.push(c);
  }
  // code (docs/KITS.md "Code in kits"): a `script` plate type's file, read and hashed; one that can't be read drops its plate
  const code = await readKitCode(dir, manifest, problems);
  const plates: LoadedPlate[] = (Array.isArray(manifest.plates) ? manifest.plates : [])
    .filter((p): p is PlateType => !!p && typeof p === 'object' && typeof p.id === 'string')
    .filter((p) => {
      if (p.view !== 'script') return true;
      if (typeof p.script !== 'string') { problems.push({ dir, message: `plate type "${p.id}" is a script plate with no "script" file; it is left out` }); return false; }
      return !code?.failed.includes(p.script);
    })
    .map((p) => ({ ...p, kit: name, source, dir }));
  return { kit: { name, dir, source, manifest: { ...manifest, name }, kinds: kinds.map((k) => k.name), plates: plates.map((p) => p.id), ...(code && code.code.files.length > 1 ? { code: { ...code.code, sources: code.sources } } : {}) }, kinds, plates };
}

/** Every kit on the resolution path, with the kinds and plate types that win. */
export async function loadKits(opts: LoadKitsOpts = {}): Promise<KitLibrary> {
  const roots: { dir: string; source: KitSource }[] = [];
  const proj = opts.projectDir ? findProjectKits(opts.projectDir) : null;
  if (proj) roots.push({ dir: proj, source: 'project' });
  for (const d of opts.extra ?? []) roots.push({ dir: resolve(d), source: 'project' });
  const env = opts.env ?? process.env.KARYO_KITS ?? '';
  for (const d of env.split(delimiter).map((s) => s.trim()).filter(Boolean)) roots.push({ dir: resolve(d), source: 'env' });
  roots.push({ dir: resolve(opts.homeDir ?? homeKitsDir()), source: 'adenine' });
  roots.push({ dir: resolve(opts.builtinDir ?? BUILTIN_KITS_DIR), source: 'builtin' });
  // the same folder twice (the project is this checkout) counts once, at its first place
  const seen = new Set<string>();
  const searched = roots.filter((r) => (seen.has(r.dir) ? false : (seen.add(r.dir), true)));

  const lib: KitLibrary = { kits: [], kinds: {}, plates: {}, shadowed: [], problems: [], searched };
  const copies = { kit: new Map<string, KitShadow['used'][]>(), kind: new Map<string, KitShadow['used'][]>(), plate: new Map<string, KitShadow['used'][]>() };
  const note = (what: keyof typeof copies, name: string, at: KitShadow['used']) => (copies[what].get(name) ?? copies[what].set(name, []).get(name)!).push(at);
  for (const root of searched) {
    if (!isDir(root.dir)) continue;
    const names = (await readdir(root.dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !/^[._]/.test(e.name)).map((e) => e.name).sort();
    for (const name of names) {
      const dir = join(root.dir, name);
      try { await stat(join(dir, 'kit.json')); } catch { continue; }
      const r = await readKit(dir, root.source, lib.problems);
      if (!r) continue;
      note('kit', name, { kit: name, dir, source: root.source });
      // a nearer kit of the same name hides this one whole
      if (lib.kits.some((k) => k.name === name)) continue;
      lib.kits.push(r.kit);
      for (const k of r.kinds) { note('kind', k.name, { kit: name, dir: k.dir, source: k.source }); if (!lib.kinds[k.name]) lib.kinds[k.name] = k; }
      for (const p of r.plates) { note('plate', p.id, { kit: name, dir, source: p.source }); if (!lib.plates[p.id]) lib.plates[p.id] = p; }
    }
  }
  for (const what of ['kit', 'kind', 'plate'] as const)
    for (const [name, list] of copies[what]) if (list.length > 1) lib.shadowed.push({ what, name, used: list[0]!, hidden: list.slice(1) });
  return lib;
}

/** A shadowing in words: "kind queue: kit queues (project, …/karyo/kits/queues) hides kit messaging (builtin, …)". */
export function shadowText(s: KitShadow): string {
  const at = (u: KitShadow['used']) => `kit ${u.kit} (${u.source}, ${u.dir})`;
  return `${s.what} "${s.name}": ${at(s.used)} hides ${s.hidden.map(at).join(', ')}`;
}

/** What a page needs of a library (the `virtual:karyo-kits` module). */
export function bundleKits(lib: KitLibrary): KitBundle {
  const strip = <T extends { dir: string }>(x: T): Omit<T, 'dir'> => { const { dir: _, ...rest } = x; return rest; };
  return {
    kits: lib.kits.map((k) => ({ name: k.name, source: k.source, description: k.manifest.description ?? '', version: k.manifest.version ?? '', kinds: k.kinds.filter((n) => lib.kinds[n]?.kit === k.name), plates: k.plates.filter((p) => lib.plates[p]?.kit === k.name),
      // code travels with its text (shown before it runs) and where it is from, in words and as the trust store's key
      ...(k.code ? { code: { hash: k.code.hash, files: k.code.files, sources: k.code.sources, dir: k.dir, where: whereWords(k.source, tildePath(k.dir)) } } : {}) })),
    kinds: Object.fromEntries(Object.entries(lib.kinds).map(([k, v]) => [k, strip(v) as BundledKind])),
    plates: Object.fromEntries(Object.entries(lib.plates).map(([k, v]) => [k, strip(v) as BundledPlate])),
    warnings: [...lib.shadowed.map(shadowText), ...lib.problems.map((p) => `${p.dir}: ${p.message}`)],
  };
}

/** Write a starter kit `<dir>/<name>/`: kit.json and one node kind, kinds/<kind>/ (component.json, template.html,
 *  style.css, a section template). Returns the kit's folder. */
export async function scaffoldKit(dir: string, name: string, o: { kind?: string } = {}): Promise<string> {
  const re = /^[a-z][a-z0-9-]*$/;
  if (!re.test(name)) throw new Error(`kit names are lowercase letters, digits and - (got "${name}")`);
  const kind = o.kind ?? name;
  if (!re.test(kind)) throw new Error(`kind names are lowercase letters, digits and - (got "${kind}")`);
  const at = resolve(dir, name);
  if (existsSync(at)) throw new Error(`${at} already exists`);
  const kd = join(at, 'kinds', kind);
  await mkdir(kd, { recursive: true });
  const manifest: KitManifest = {
    $schema: resolve(BUILTIN_KITS_DIR, '../spec/karyo-kit.schema.json'),
    karyo: KIT_VERSION, name, description: `TODO: what the ${name} kit adds, in one sentence.`, version: '0.1.0', kinds: [kind], plates: [],
  };
  await writeFile(join(at, 'kit.json'), JSON.stringify(manifest, null, 2) + '\n');
  const meta: KindMeta = {
    name: kind,
    description: `TODO: what a ${kind} is, in one sentence.`,
    version: '0.1.0',
    props: {
      type: 'object',
      additionalProperties: false,
      properties: {
        note: { type: 'string', description: 'one line on the card' },
        items: { type: 'array', items: { type: 'string' }, description: 'listed in the details section' },
      },
    },
    size: { w: 188, h: 96 },
    example: { note: 'An example note.', items: ['first', 'second'] },
    node: {
      label: kind, plural: `${kind}s`, glyph: kind.slice(0, 1).toUpperCase(),
      sections: [{ id: 'items', title: 'items', noun: 'items', keywords: ['list', 'contents'], template: 'items.html' }],
      exampleNode: { id: `example.${kind}`, label: `An example ${kind}`, summary: `What this ${kind} does.` },
    },
  };
  await writeFile(join(kd, 'component.json'), JSON.stringify(meta, null, 2) + '\n');
  await writeFile(join(kd, 'template.html'), `{{! The card's inside; the board draws its frame (border, category edge and ring). Keep the four hooks:
    .mm-top (badges go here), .mm-kind (the kind label, tinted by the category), .mm-name (renamed in a splice), .mm-ref
    (what a splice says about the card). In scope: your fields (note, items), node.* (id, label, kind, kindLabel, summary,
    category, tags, lang, group, where, proposed) and stats.* (in, out, calls, ops [{label, count}], callers, callees). }}
<div class="mm-top"><span class="mm-kind">{{node.kindLabel}}</span><span class="mm-lang">{{node.lang}}</span></div>
<div class="mm-name">{{node.label}}</div>
{{#if note}}<div class="note">{{note}}</div>{{/if}}
<div class="mm-ref">{{node.where}}</div>
`);
  await writeFile(join(kd, 'style.css'), `/* Scoped under .kc-${kind} (the card) and .ks-${kind} (its sections) by the loader: ".note" means ".kc-${kind} .note";
   ":host" is the card itself. Theme tokens only (var(--pl-*), color-mix of them); no transitions or animations. */
:host { gap: 4px; }
.note { font-size: 12px; line-height: 1.3; color: var(--pl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.items { display: grid; gap: 4px; }
.item { font: 12px/1.3 var(--pl-font-mono); padding: 4px 6px; border: 1px solid var(--pl-card-border); border-radius: min(var(--pl-radius), 4px); }
`);
  await writeFile(join(kd, 'items.html'), `{{! A details section: mark each thing it lists with data-item="<name>" (the board counts, measures and scrolls to them). }}
<div class="items">{{#each items}}<div class="item" data-item="{{this}}">{{this}}</div>{{/each}}{{#unless items}}<div class="bd-none">none</div>{{/unless}}</div>
`);
  return at;
}
