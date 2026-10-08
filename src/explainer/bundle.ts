/// <reference types="node" />
// Bundle an explainer (bun / node): the spec, plus only the components it uses (meta, template,
// css), with images under the spec's folder inlined as data: URIs, so the result renders anywhere
// (the dev host, a single HTML file). Issues = validateSpec + shadowing + image problems.
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, relative, isAbsolute, sep } from 'node:path';
import { loadLibrary, type LoadOpts } from './library';
import { validateSpec } from './validate';
import type { BundledComponent, ExplainerBundle, ExplainerSpec, Issue } from './types';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.avif': 'image/avif' };
const IMG = /\.(png|jpe?g|gif|svg|webp|avif)(\?.*)?$/i;
const MAX_IMAGE = 8 * 1024 * 1024;

const pointer = (parts: (string | number)[]) => parts.map((p) => `/${String(p).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

async function dataUri(file: string): Promise<string> {
  const buf = await readFile(file);
  if (buf.length > MAX_IMAGE) throw new Error(`${file} is ${(buf.length / 1e6).toFixed(1)} MB (limit ${MAX_IMAGE / 1e6} MB)`);
  return `data:${MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'};base64,${buf.toString('base64')}`;
}
const inside = (root: string, file: string) => { const r = relative(root, file); return !!r && !r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r); };

type Schema = { format?: string; properties?: Record<string, Schema>; items?: Schema | Schema[]; anyOf?: Schema[]; oneOf?: Schema[] } | undefined;
/** The schema of `k` under `s` (properties, then the first anyOf/oneOf branch that has it). */
const propSchema = (s: Schema, k: string): Schema => s?.properties?.[k] ?? [...(s?.anyOf ?? []), ...(s?.oneOf ?? [])].map((b) => b?.properties?.[k]).find(Boolean);
const itemSchema = (s: Schema): Schema => (Array.isArray(s?.items) ? s.items[0] : s?.items);
/** Is this a declared image source? `"format": "image"` in the component's props schema; a prop named `src` counts
 *  too when the schema says nothing about it (components written before the marker). Any other string is text, even
 *  one that ends in .png (a file name in a file tree, say). */
const isImageProp = (s: Schema, key: string | number | undefined) => s?.format === 'image' || (key === 'src' && !s?.format);

/** Replace the image sources under `v` (relative to `root`) with data: URIs: only where the component's props
 *  schema `schema` declares an image (see isImageProp). */
async function inlineImages(v: unknown, root: string, path: (string | number)[], issues: Issue[], schema: Schema, image = false): Promise<unknown> {
  if (typeof v === 'string') {
    if (!image || !IMG.test(v) || /^data:/i.test(v)) return v;
    if (/^(https?:)?\/\//i.test(v)) { issues.push({ path: pointer(path), level: 'warn', message: `remote image ${v}: the explainer needs the network to show it`, hint: 'save it next to the spec and use a relative path; it is inlined when bundled' }); return v; }
    const file = resolve(root, v.replace(/\?.*$/, ''));
    if (!inside(root, file)) { issues.push({ path: pointer(path), level: 'error', message: `image ${v} is outside the spec's folder`, hint: 'copy it next to the spec (or below it)' }); return v; }
    try { return await dataUri(file); }
    catch (e) { issues.push({ path: pointer(path), level: 'error', message: `image ${v}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : (e as Error).message}`, hint: `looked for ${file}` }); return v; }
  }
  if (Array.isArray(v)) { const it = itemSchema(schema); return Promise.all(v.map((x, i) => inlineImages(x, root, [...path, i], issues, it, image || it?.format === 'image'))); }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) { const ks = propSchema(schema, k); out[k] = await inlineImages(x, root, [...path, k], issues, ks, isImageProp(ks, k)); }
    return out;
  }
  return v;
}

/** url(relative) in a component stylesheet → data: URI (files inside the component's folder only). */
async function inlineCssUrls(css: string, dir: string): Promise<string> {
  let out = css;
  for (const m of css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
    const u = m[2]!.trim();
    if (/^(data:|https?:|\/\/|#)/i.test(u)) continue;
    const file = resolve(dir, u);
    if (!inside(dir, file)) continue;
    try { out = out.replace(m[0], `url("${await dataUri(file)}")`); } catch { /* left as is */ }
  }
  return out;
}

export interface BundleResult extends ExplainerBundle { issues: Issue[] }

export async function bundleSpec(specPath: string, opts: Omit<LoadOpts, 'specDir'> = {}): Promise<BundleResult> {
  const file = resolve(specPath);
  const dir = dirname(file);
  let spec: ExplainerSpec;
  try { spec = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { spec: {} as ExplainerSpec, components: {}, issues: [{ path: '', level: 'error', message: code === 'ENOENT' ? `no such file: ${file}` : `not valid JSON: ${(e as Error).message}` }] };
  }
  const lib = await loadLibrary({ ...opts, specDir: dir });
  const issues = validateSpec(spec, lib);
  const elements = Array.isArray(spec?.elements) ? spec.elements : [];
  const used = [...new Set(elements.map((e) => e?.type).filter((t): t is string => typeof t === 'string' && !!lib.components[t]))];
  const components: Record<string, BundledComponent> = {};
  for (const name of used) {
    const c = lib.components[name]!;
    components[name] = { name, meta: c.meta, template: c.template, css: await inlineCssUrls(c.css, c.dir) };
    const sh = lib.shadowed.find((x) => x.name === name);
    const first = elements.findIndex((e) => e?.type === name);
    if (sh) issues.push({ path: pointer(['elements', first, 'type']), level: 'warn', message: `component "${name}" from ${sh.used.source} (${sh.used.dir}) shadows ${sh.hidden.map((h) => `${h.source} (${h.dir})`).join(', ')}` });
    for (const p of lib.problems.filter((p) => p.dir === c.dir)) issues.push({ path: pointer(['elements', first, 'type']), level: 'warn', message: `component "${name}": ${p.message}` });
  }
  // images: element props and step `set` values
  //   (only the props each component's schema declares as images)
  const schemaOf = (type: unknown): Schema => (typeof type === 'string' ? lib.components[type]?.meta.props as Schema : undefined);
  const typeOf = new Map(elements.map((e) => [e?.id, e?.type]));
  if (Array.isArray(spec.elements)) spec.elements = await Promise.all(spec.elements.map(async (e, i) => (e && e.props ? { ...e, props: await inlineImages(e.props, dir, ['elements', i, 'props'], issues, schemaOf(e.type)) as Record<string, unknown> } : e)));
  if (Array.isArray(spec.steps)) spec.steps = await Promise.all(spec.steps.map(async (s, i) => {
    if (!s || !s.set) return s;
    const set: Record<string, Record<string, unknown>> = {};
    for (const [id, props] of Object.entries(s.set)) set[id] = await inlineImages(props, dir, ['steps', i, 'set', id], issues, schemaOf(typeOf.get(id))) as Record<string, unknown>;
    return { ...s, set };
  }));
  return { spec, components, issues };
}
