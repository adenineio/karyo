#!/usr/bin/env bun
// Merge Karyo model fragments from any language and reconcile them.
//
//   bun scripts/model.ts build <fragments...> -o model.json [--project name] [--tours 'tours/*.tour.json'] [--root dir]
//                              [--curation karyo/curation.json | --no-curation] [--strict]
//   bun scripts/model.ts check <model.json> [--strict]
//
// --tours (a glob, repeatable or comma-separated; quote it) resolves authored tours into `model.tours`:
// code excerpts are read from files relative to --root (default: the working directory), timings
// from the recorded flows. See docs/MODEL.md "Tours".
//
// --curation applies a curation file (docs/MODEL.md "Curation": renames, categories, tags, groups, which nodes are their own
// cards or folded, which are hidden). Without the flag, `karyo/curation.json` under --root is used when it exists.
//
// Prints errors (✖), warnings (⚠) and notes (·). Exits 1 on any error (an identity conflict or a broken
// engine invariant: the model can't be drawn truthfully, see docs/MODEL.md "Identity"), and with
// --strict on any warning too; 0 otherwise.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { FRAGMENT_CHECKS, invariants, isBuildCheck, merge, normalize, reconcile, relations, type MCheck, type Model } from '../src/model/model';
import { applyCuration, type Curation } from '../src/model/curation';
import { resolveTours, type AuthoredTour } from '../src/model/tours';

const argv = process.argv.slice(2);
const cmd = argv[0];
const VALUED: Record<string, string> = { '-o': 'out', '--out': 'out', '--project': 'project', '--tours': 'tours', '--root': 'root', '--curation': 'curation' };
const opts: Record<string, string[]> = {};
const files: string[] = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]!;
  if (VALUED[a]) (opts[VALUED[a]!] ??= []).push(argv[++i] ?? '');
  else if (!a.startsWith('-')) files.push(a);
}
const opt = (k: string) => opts[k]?.at(-1);

/** Print the model's summary and checks; returns how many errors and warnings it has. */
function report(m: Model) {
  const errors = (m.checks ?? []).filter((c) => c.level === 'error'), warns = (m.checks ?? []).filter((c) => c.level === 'warn'), notes = (m.checks ?? []).filter((c) => c.level === 'info');
  const n = m.nodes.filter((x) => x.kind !== 'module').length;
  console.log(`${m.project ?? 'model'}: ${n} nodes, ${relations(m).length} edges, ${m.flows.length} flow(s), from ${[...new Set((m.producers ?? []).map((p) => p.lang))].join(' + ') || '?'}`);
  for (const f of m.flows) {
    const langs = [...new Set(f.spans.map((s) => s.lang))].join(' → ');
    const ms = f.spans.length ? ((Math.max(...f.spans.map((s) => s.end ?? s.start)) - Math.min(...f.spans.map((s) => s.start))) / 1e6).toFixed(1) : '0';
    console.log(`  flow ${f.id}: ${f.spans.length} spans, ${ms} ms, ${langs}`);
  }
  for (const t of m.tours ?? []) {
    const coded = t.steps.filter((s) => s.code).length, timed = t.steps.filter((s) => s.timing).length;
    console.log(`  tour ${t.id}: ${t.steps.length} steps, ${coded} with code, ${timed} timed${t.flow ? ` (flow ${t.flow})` : ''}`);
  }
  for (const c of errors) console.error(`  ✖ ${c.code.padEnd(16)} ${c.message}`);
  for (const c of warns) console.log(`  ⚠ ${c.code.padEnd(16)} ${c.message}`);
  for (const c of notes) console.log(`  · ${c.code.padEnd(16)} ${c.message}`);
  if (!errors.length && !warns.length && !notes.length) console.log('  code and docs agree');
  if (errors.length) console.error(`${errors.length} error(s): the model can't be drawn truthfully until they're fixed.`);
  return { errors: errors.length, warns: warns.length };
}
const exitCode = (r: { errors: number; warns: number }) => (r.errors || (argv.includes('--strict') && r.warns) ? 1 : 0);

/** Read the tour files matching the --tours globs and resolve them against the model. */
async function tours(model: Model): Promise<MCheck[]> {
  const globs = (opts.tours ?? []).flatMap((g) => g.split(',')).map((g) => g.trim()).filter(Boolean);
  if (!globs.length) return [];
  const checks: MCheck[] = [];
  const authored: AuthoredTour[] = [];
  for (const g of globs) {
    const paths = [...new Bun.Glob(g).scanSync({ cwd: process.cwd() })].sort();
    if (!paths.length) checks.push({ level: 'warn', code: 'tour-invalid', subject: `tours:${g}`, message: `no tour files match ${g}.` });
    for (const p of paths) {
      try { authored.push(JSON.parse(readFileSync(p, 'utf8'))); }
      catch (e) { checks.push({ level: 'warn', code: 'tour-invalid', subject: `tours:${p}`, message: `${p} is not valid JSON: ${(e as Error).message}` }); }
    }
  }
  const root = resolve(opt('root') ?? '.');
  const readFile = (f: string) => { try { return readFileSync(resolve(root, f), 'utf8'); } catch { return undefined; } };
  const r = resolveTours(model, authored, readFile);
  model.tours = r.tours;
  return [...checks, ...r.checks];
}

if (cmd === 'build') {
  if (!files.length) { console.error('no fragments given'); process.exit(1); }
  const frags = await Promise.all(files.map((f) => Bun.file(f).json()));
  // the curation file: --curation, else karyo/curation.json under --root when it exists (--no-curation: none)
  const curFile = argv.includes('--no-curation') ? undefined : opt('curation') ?? (existsSync(resolve(opt('root') ?? '.', 'karyo/curation.json')) ? resolve(opt('root') ?? '.', 'karyo/curation.json') : undefined);
  let curation: Curation | undefined, curError: MCheck | undefined;
  if (curFile) {
    try { curation = JSON.parse(readFileSync(curFile, 'utf8')); console.log(`curation: ${curFile}`); }
    catch (e) { curError = { level: 'warn', code: 'curation-invalid', subject: 'curation:/', message: `${curFile} can't be read as JSON (${(e as Error).message}); no curation applied.` }; }
  }
  const model = merge(frags, opt('project'), curation ? { curate: (m) => applyCuration(m, curation!, curFile) } : {});
  if (curError) model.checks = [curError, ...(model.checks ?? [])];
  model.checks = [...(model.checks ?? []), ...(await tours(model))];
  const out = opt('out');
  if (out) await Bun.write(out, JSON.stringify(model, null, 1) + '\n');
  const r = report(model);
  if (out) console.log(`wrote ${out}`);
  process.exit(exitCode(r));
} else if (cmd === 'check') {
  const raw = (await Bun.file(files[0]!).json()) as Model;
  // a model with several edges for one pair (a declared `reads` and an observed `calls`) is read as one edge per pair
  const model = normalize(raw);
  const folded = (raw.edges ?? []).length - model.edges.length;
  // tours were resolved against the source at build time, and the SDKs' own checks came with the fragments: keep them
  const kept = (model.checks ?? []).filter((c) => isBuildCheck(c) || FRAGMENT_CHECKS.has(c.code));
  model.checks = [...kept.filter((c) => FRAGMENT_CHECKS.has(c.code)), ...kept.filter((c) => c.code.startsWith('curation-')), ...reconcile(model), ...kept.filter((c) => c.code.startsWith('tour-'))];
  if (folded) model.checks.push({ level: 'info', code: 'normalized', message: `${folded} edge record(s) repeated a relationship (a model from an older merge); read as one edge per pair. Rebuild the model to rewrite the file.` });
  model.checks.push(...invariants(model));
  process.exit(exitCode(report(model)));
} else {
  console.error("usage: bun scripts/model.ts build <fragments...> -o model.json [--project p] [--tours 'tours/*.tour.json'] [--root dir] [--strict] | check <model.json>");
  process.exit(1);
}
