/// <reference types="node" />
// `karyo kit check` (docs/KITS.md): one kit folder against the schema (spec/karyo-kit.schema.json) and what it means:
// every kind's component.json, its example fields against its fields schema, its templates (card, sections, mini)
// rendered with the example as a board would render them, the board's hooks in the card, theme-token-only CSS, and
// each plate type's view and source. Bun / node only.
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import schemaJson from '../../spec/karyo-kit.schema.json';
import { checkSchema } from '../explainer/jsonschema';
import { cssProblems, parseTemplate, TemplateError } from '../explainer/template';
import { readKit, bundleKits, type KitProblem, type LoadedKind } from './library';
import { KitSet, type KitNode } from './registry';
import { PLATE_VIEWS, type KitManifest } from './types';
import { isSequenceFold } from '../model/sequence-fold';

const schema = schemaJson as unknown as Record<string, any>;

export interface KitIssue { path: string; level: 'error' | 'warn'; message: string; hint?: string }
export interface KitCheck { name: string; dir: string; ok: boolean; kinds: string[]; plates: string[]; issues: KitIssue[] }

/** The hooks the board relies on in a card (badges, the category's kind colour, a splice's rename and reference line). */
const HOOKS: [string, string][] = [['mm-top', 'badges (warnings, a splice\'s mark) go in it'], ['mm-kind', 'the category tints it'], ['mm-name', 'a splice renames it (double-click)'], ['mm-ref', 'a splice says there what it does to the card']];
const BOARD_OWN = ['summary', 'calls', 'checks'];

/** The node a kind's example renders as. */
function exampleNode(k: LoadedKind): KitNode {
  const e = k.meta.node?.exampleNode ?? {};
  return {
    id: e.id ?? `example.${k.name}`, kind: k.name as KitNode['kind'], label: e.label ?? `An example ${k.name}`, sources: ['declared'],
    ...(e.summary ? { summary: e.summary } : {}), ...(e.category ? { category: e.category } : {}), ...(e.tags ? { tags: e.tags } : {}), ...(e.lang ? { lang: e.lang } : {}),
    ...(e.ref ? { ref: e.ref } : {}), fields: (k.meta.example ?? {}) as Record<string, unknown>,
  };
}
const EXAMPLE_STATS = { in: 2, out: 1, calls: 3, ops: [{ label: 'first', count: 2 }, { label: 'second', count: 1 }], callers: ['A caller'], callees: ['A callee'] };

export async function checkKit(dir0: string): Promise<KitCheck> {
  const dir = resolve(dir0), name = basename(dir);
  const issues: KitIssue[] = [];
  const err = (path: string, message: string, hint?: string) => issues.push({ path, level: 'error', message, ...(hint ? { hint } : {}) });
  const warn = (path: string, message: string, hint?: string) => issues.push({ path, level: 'warn', message, ...(hint ? { hint } : {}) });
  let manifest: KitManifest | null = null;
  try { manifest = JSON.parse(await readFile(join(dir, 'kit.json'), 'utf8')); }
  catch (e) { err('kit.json', (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no kit.json' : `not valid JSON: ${(e as Error).message}`, 'a kit is a folder with kit.json (karyo kit new <name> scaffolds one)'); }
  if (!manifest) return { name, dir, ok: false, kinds: [], plates: [], issues };
  for (const e of checkSchema(manifest, schema)) err(`kit.json#${e.path}`, e.message, e.hint);
  if (typeof manifest.description === 'string' && /^TODO\b/.test(manifest.description)) warn('kit.json#/description', 'the description is still the scaffold\'s TODO');

  const problems: KitProblem[] = [];
  const r = await readKit(dir, 'project', problems);
  const rel = (p: string) => (p.startsWith(dir) ? p.slice(dir.length + 1) || '.' : p);
  for (const p of problems) err(rel(p.dir), p.message);
  if (!r) return { name, dir, ok: false, kinds: [], plates: [], issues };

  // every kind: its component.json, its example, its templates rendered as the board renders them, its CSS
  const kits = new KitSet(bundleKits({ kits: [r.kit], kinds: Object.fromEntries(r.kinds.map((k) => [k.name, k])), plates: Object.fromEntries(r.plates.map((p) => [p.id, p])), shadowed: [], problems: [], searched: [] }));
  for (const k of r.kinds) {
    const at = `kinds/${k.name}/component.json`;
    const raw = JSON.parse(await readFile(join(k.dir, 'component.json'), 'utf8'));
    for (const e of checkSchema(raw, schema.$defs.kind, '', schema)) err(`${at}#${e.path}`, e.message, e.hint);
    if (typeof raw.description === 'string' && /^TODO\b/.test(raw.description)) warn(`${at}#/description`, 'the description is still the scaffold\'s TODO');
    if (raw.script !== undefined || raw.node?.script !== undefined) err(`${at}#/script`, 'a node kind can\'t run a script: only a plate type can ("view": "script"); a kind is a template', 'draw the card with template.html, or make a script plate type (docs/KITS.md "Code in kits")');
    if (raw.example === undefined) warn(`${at}#/example`, 'no example fields', 'an example shows authors (and Claude) what the fields look like; the check renders the card with it');
    else for (const e of checkSchema(raw.example, k.meta.props as never, '/example')) err(`${at}#${e.path}`, `example: ${e.message}`, e.hint);
    const tpl = (file: string, src: string) => { try { parseTemplate(src); return true; } catch (e) { if (e instanceof TemplateError) { err(`kinds/${k.name}/${file}`, `broken template: ${e.message}`); return false; } throw e; } };
    const node = exampleNode(k);
    if (tpl('template.html', k.template)) {
      const html = kits.cardInner(node, EXAMPLE_STATS) ?? '';
      if (/template error:/.test(html)) err(`kinds/${k.name}/template.html`, 'the example does not render', html.replace(/<[^>]+>/g, ' ').trim());
      for (const [h, why] of HOOKS) if (!new RegExp(`class="[^"]*\\b${h}\\b`).test(html)) warn(`kinds/${k.name}/template.html`, `no .${h} in the card: ${why}`, `keep <div class="${h}">…</div> (karyo kit new scaffolds all four)`);
      if (!/\S/.test(html.replace(/<[^>]*>/g, ''))) err(`kinds/${k.name}/template.html`, 'the card renders empty with the example');
    }
    for (const [i, s] of (k.meta.node?.sections ?? []).entries()) {
      if (BOARD_OWN.includes(s.id)) err(`${at}#/node/sections/${i}/id`, `"${s.id}" is one of the board's own sections (${BOARD_OWN.join(', ')})`, 'name it after what it lists');
      const sec = k.sections.find((x) => x.id === s.id);
      if (!sec) continue;
      if (tpl(s.template, sec.template) && (!sec.compact || tpl(s.compact!, sec.compact))) {
        const out = kits.sections(node, EXAMPLE_STATS).find((x) => x.id === s.id);
        if (!out || /template error:/.test(out.html)) err(`kinds/${k.name}/${s.template}`, 'the section does not render with the example');
        else if (!/data-item="/.test(out.html)) warn(`kinds/${k.name}/${s.template}`, 'the section marks no items (data-item="<name>") with the example', 'the board counts, measures and scrolls to items by name');
      }
    }
    if (k.mini !== undefined && tpl(k.meta.node!.mini!, k.mini) && kits.mini(node, EXAMPLE_STATS) === null) err(`kinds/${k.name}/${k.meta.node!.mini}`, 'the mini template does not render with the example');
    for (const p of cssProblems(k.css)) (/hard-codes colours/.test(p) ? err : warn)(`kinds/${k.name}/style.css`, `style.css ${p}`);
  }
  // plate types: a view the engine has, drawn from what that view takes
  const seen = new Set<string>();
  (manifest.plates ?? []).forEach((p, i) => {
    const at = `kit.json#/plates/${i}`;
    if (!p || typeof p !== 'object') return;
    if (seen.has(p.id)) err(`${at}/id`, `plate type "${p.id}" is declared twice`); seen.add(p.id);
    const want = PLATE_VIEWS[p.view as keyof typeof PLATE_VIEWS];
    if (want && p.from !== want) err(`${at}/from`, `a ${p.view} plate is drawn from a ${want}, not a ${p.from}`, `"from": "${want}"`);
    if (p.filter && (p.view === 'trace' || p.view === 'tour' || p.view === 'script')) warn(`${at}/filter`, `a ${p.view} plate draws its whole ${p.from}: the filter is not used`);
    const fold = (p.options as Record<string, unknown> | undefined)?.fold;
    if (fold !== undefined && p.view !== 'sequence') warn(`${at}/options/fold`, `only a sequence plate folds lanes: the option is not used on a ${p.view} plate`);
    else if (fold !== undefined && !isSequenceFold(fold)) err(`${at}/options/fold`, 'fold is "auto", "none", or groups of node ids ([["a", "b"], …])', '"fold": "auto"');
    // code (docs/KITS.md "Code in kits")
    if (p.script !== undefined && p.view !== 'script') err(`${at}/script`, `only a "script" plate runs a script (this one is a ${p.view} plate)`, 'drop "script", or make it "view": "script"');
    if (p.view === 'script') {
      if (typeof p.script !== 'string') err(`${at}/script`, 'a script plate needs "script": the .js file that draws it', '"script": "plates/<name>.js"');
      else {
        const src = r.kit.code?.sources[p.script];
        if (src !== undefined) {
          // parsed as the frame will load it: an ES module that exports render and imports nothing (the frame can't fetch)
          let exports: string[] | null = null, imports: string[] = [];
          try {
            const B = (globalThis as { Bun?: { Transpiler: new (o: { loader: 'js' }) => { scan(s: string): { exports: string[]; imports: { path: string }[] } } } }).Bun;
            if (B) { const sc = new B.Transpiler({ loader: 'js' }).scan(src); exports = sc.exports; imports = sc.imports.map((i) => i.path); }
          } catch (e) { err(p.script, `the script doesn't parse: ${(e as Error).message.split('\n')[0]}`); exports = []; }
          const hasRender = exports ? exports.includes('render') : /\bexport\s+(?:async\s+)?(?:function\s+render\b|(?:const|let|var)\s+render\b)|\bexport\s*\{[^}]*\brender\b/.test(src);
          if (!hasRender && !issues.some((i) => i.path === p.script)) err(p.script, 'the script exports no render(host, ctx) function');
          if (imports.length) err(p.script, `the script imports ${imports.join(', ')}: a kit script runs alone in a sealed frame and can't load other files`, 'put what it needs in the one file');
        }
        warn(`${at}`, `plate type "${p.id}" runs the kit's own JavaScript: every page asks the viewer to trust this version before it runs, and shows a notice while it does`, 'built-in kits are trusted automatically; see docs/KITS.md "Code in kits"');
        if (p.deterministic !== true) warn(`${at}/deterministic`, 'not declared deterministic: stills and lint show a notice instead of the plate', 'draw the same picture from the same inputs (no clock, no randomness), then say "deterministic": true');
      }
    }
  });
  if (!r.kinds.length && !(manifest.plates ?? []).length) warn('kit.json', 'the kit adds no node kind and no plate type');
  return { name, dir, ok: !issues.some((i) => i.level === 'error'), kinds: r.kinds.map((k) => k.name), plates: r.plates.map((p) => p.id), issues };
}
