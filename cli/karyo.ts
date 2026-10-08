#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// karyo: author, check, preview and ship Karyo explainers (*.explainer.json) from any directory.
// Thin by design: the explainer core (src/explainer/*) validates, bundles and builds; scripts/render.ts
// renders stills and lints layout. This file resolves paths, orders the steps, and prints results for
// people (default) or for tools (--json: one JSON document on stdout, also on failure).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The repo root, from this file's real location (cli/karyo.ts, possibly reached through a symlink).
const ROOT = path.resolve(path.dirname(realpathSync(import.meta.path)), '..');
const BUN = process.execPath;
const REST_T = 60; // seconds; the engine clamps to the transition's end, so this is the step at rest

// ---------------------------------------------------------------- args

type Args = { _: string[]; flags: Record<string, string | true> };
const BOOL = new Set(['json', 'global', 'force', 'help', 'h', 'no-validate', 'quiet', 'all', 'open', 'jarvis', 'no-whisper', 'no-brain', 'yes', 'y', 'no-open']);
function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i]!;
    if (s === '--') { a._.push(...argv.slice(i + 1)); break; }
    if (s.startsWith('--') || (s.startsWith('-') && s.length === 2 && isNaN(+s))) {
      let k = s.replace(/^--?/, ''), v: string | true = true;
      const eq = k.indexOf('=');
      if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
      else if (!BOOL.has(k) && i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) v = argv[++i]!;
      if (k === 'o') k = 'out';
      a.flags[k] = v;
    } else a._.push(s);
  }
  return a;
}

class UserError extends Error {}
const args = parseArgs(process.argv.slice(2));
const JSON_OUT = args.flags.json === true;
const str = (k: string) => (typeof args.flags[k] === 'string' ? (args.flags[k] as string) : undefined);
// Control characters (an ESC sequence could rewrite a warning printed around a kit's name) and invisible or
// direction-changing ones are shown as ⟦U+…⟧ (src/kits/warning.ts termSafe, inlined: --help works without the core).
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const termSafe = (s: string) => s.replace(HIDDEN, (c) => `⟦U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`);
const say = (s = '') => { if (!JSON_OUT) console.log(termSafe(s)); };
const emit = (o: unknown) => console.log(JSON.stringify(o, null, 2));

// ---------------------------------------------------------------- core (loaded lazily, so --help works without it)

type Issue = { path: string; level: 'error' | 'warn'; message: string; hint?: string };
type Comp = { name: string; dir: string; source: string; meta?: { description?: string; props?: unknown; example?: unknown; [k: string]: unknown }; [k: string]: unknown };

async function core<T = any>(file: string): Promise<T> {
  const p = path.join(ROOT, 'src/explainer', file);
  if (!existsSync(p)) throw new UserError(`the explainer core is missing (${path.relative(ROOT, p)}); this Karyo install is incomplete`);
  return import(p);
}

async function library(specFile?: string) {
  const { loadLibrary } = await core('library.ts');
  return loadLibrary({ specDir: specFile ? path.dirname(specFile) : undefined });
}

/** The components of a Library, whatever collection shape it keeps them in. */
function comps(lib: any): Comp[] {
  const c = lib?.components ?? lib;
  if (c instanceof Map) return [...c.values()];
  if (Array.isArray(c)) return c;
  if (c && typeof c === 'object') return Object.values(c);
  return [];
}
function findComp(lib: any, name: string): Comp | undefined {
  return (typeof lib?.get === 'function' ? lib.get(name) : undefined) ?? comps(lib).find((c) => c.name === name);
}

// ---------------------------------------------------------------- spec files

function specPath(p: string | undefined): string {
  if (!p) throw new UserError('which explainer? pass a path to a *.explainer.json file (or its folder)');
  let f = path.resolve(p);
  if (existsSync(f) && statSync(f).isDirectory()) {
    const found = readdirSync(f).filter((n) => n.endsWith('.explainer.json'));
    if (found.length !== 1) throw new UserError(found.length ? `${p} holds several explainers (${found.join(', ')}); name one` : `no *.explainer.json in ${p}`);
    f = path.join(f, found[0]!);
  }
  if (!existsSync(f)) throw new UserError(`no such file: ${p}`);
  return f;
}

function readSpec(file: string): { spec: any; issues: Issue[] } {
  const text = readFileSync(file, 'utf8');
  try { return { spec: JSON.parse(text), issues: [] }; }
  catch (e) { return { spec: undefined, issues: [{ path: '', level: 'error', message: `not valid JSON: ${(e as Error).message}`, hint: 'fix the syntax first (a trailing comma or an unquoted key is the usual cause)' }] }; }
}

async function check(file: string): Promise<{ spec: any; issues: Issue[] }> {
  const r = readSpec(file);
  if (r.issues.length) return r;
  const { validateSpec } = await core('validate.ts');
  return { spec: r.spec, issues: validateSpec(r.spec, await library(file)) };
}

const errorsIn = (issues: Issue[]) => issues.filter((i) => i.level === 'error');
const rel = (f: string) => { const r = path.relative(process.cwd(), f); return r && !r.startsWith('..') ? r : f; };

function printIssues(issues: Issue[], file: string) {
  if (JSON_OUT) return;
  if (!issues.length) { console.log(`${rel(file)}: ok`); return; }
  for (const i of issues) {
    console.log(`${i.level === 'error' ? 'error' : 'warn '}  ${i.path || '/'}  ${i.message}`);
    if (i.hint) console.log(`       hint: ${i.hint}`);
  }
  const e = errorsIn(issues).length, w = issues.length - e;
  console.log(`${rel(file)}: ${e} error(s), ${w} warning(s)`);
}

/** Steps the plate has: one per `steps` entry; a spec without steps is one step showing everything. */
function stepCount(spec: any): number {
  return Array.isArray(spec?.steps) && spec.steps.length ? spec.steps.length : 1;
}

// ---------------------------------------------------------------- templates for `karyo new`

type Template = 'blank' | 'steps' | 'graph';
const TEMPLATES = path.join(ROOT, 'cli/templates');
async function starter(id: string, title: string, template: Template): Promise<any> {
  const f = path.join(TEMPLATES, `${template}.explainer.json`);
  if (!existsSync(f)) throw new UserError(`unknown template "${template}" (have: ${readdirSync(TEMPLATES).filter((n) => n.endsWith('.explainer.json')).map((n) => n.replace('.explainer.json', '')).join(', ')})`);
  const { $schema: _, karyo, id: __, title: ___, ...rest } = JSON.parse(readFileSync(f, 'utf8'));
  // the schema by absolute path, so editors complete and check the file wherever it lives
  return { $schema: path.join(ROOT, 'spec/karyo-explainer.schema.json'), karyo, id, title, ...rest };
}

// ---------------------------------------------------------------- render.ts

async function render(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([BUN, path.join(ROOT, 'scripts/render.ts'), ...argv], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: process.env });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

function renderFlags(): string[] {
  const f: string[] = [];
  for (const k of ['theme', 'mode', 'dpr']) if (str(k)) f.push(`--${k}`, str(k)!);
  return f;
}

/** Where render.ts loads explainers from. The shared dev server (:5180) bundles components with ITS
 *  environment, so with $KARYO_COMPONENTS set here (the MCP server always sets it) a private server
 *  started from this process renders instead; one server serves every step of a run. */
async function renderServer(): Promise<{ flags: string[]; stop: () => void }> {
  // a fresh install (Claude Desktop, Cowork) may have no JS dependencies yet and no Chrome: set both up first, on stderr
  await withRuntime(async (r) => { r.ensureDeps((s) => console.error(s)); r.ensureBrowser((s) => console.error(s)); });
  if (str('url')) return { flags: ['--url', str('url')!], stop: () => {} };
  if (!(process.env.KARYO_COMPONENTS ?? '').trim() && (await reachable('http://localhost:5180'))) return { flags: [], stop: () => {} };
  let port = '';
  do port = String(5400 + Math.floor(Math.random() * 400)); while (/(81|13)$/.test(port));   // never a port ending in 81 or 13
  const child = Bun.spawn([BUN, 'x', 'vite', '--port', port, '--strictPort'], { cwd: ROOT, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, KARYO_NO_HMR: '1' } });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 200 && !(await reachable(url)); i++) await Bun.sleep(100);
  if (!(await reachable(url))) { child.kill(); throw new UserError(`couldn't start a vite server for rendering (${url})`); }
  return { flags: ['--url', url], stop: () => child.kill() };
}

// ---------------------------------------------------------------- dev server

async function reachable(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

/** The URL of a Karyo dev server: the one on `port` when it answers, else a new vite started in the repo
 *  (detached, so it outlives this command; its log goes to <data dir>/logs/karyo-serve-<port>.log). */
async function devServer(port: string): Promise<{ url: string; started: boolean; log?: string; pid?: number }> {
  const url = `http://localhost:${port}`;
  if (await reachable(url)) return { url, started: false };
  const { dataDir } = await runtime();
  const log = path.join(dataDir().dir, 'logs', `karyo-serve-${port}.log`);
  mkdirSync(path.dirname(log), { recursive: true });
  const fd = openSync(log, 'a');
  const child = spawn(BUN, ['x', 'vite', '--port', port, '--strictPort'], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  for (let i = 0; i < 200; i++) {
    if (await reachable(url)) return { url, started: true, log, pid: child.pid };
    await Bun.sleep(100);
  }
  throw new UserError(`started vite in ${ROOT} but ${url} didn't answer within 20 s; see ${log}`);
}

// ---------------------------------------------------------------- commands

const HELP = `karyo: visual explainers as a validated JSON spec, previewed as stills, shipped as one HTML file

usage: karyo <command> [args] [--json]

  new <path> [--title T] [--template blank|steps|graph] [--force]
                                  start an explainer: <path>.explainer.json (or <dir>/<dir>.explainer.json)
                                  plus an empty components/ folder next to it
  validate <spec>                 check a spec against the schema and the component library; exit 1 on errors
  info <spec>                     title, steps and components of a spec
  components [--spec <spec>]      every component the spec can use, with where it comes from
  component show <name> [--spec <spec>]
                                  a component's description, props schema and example
  component new <name> [--global | --project <dir>]
                                  scaffold a custom component: --global puts it in ~/.adenine/karyo/components,
                                  --project in <dir>/components (default: ./components)
  component check <name|dir> [--spec <spec>]
                                  load one component and check its metadata and example
  kit new <name> [--project [dir] | --global] [--kind K]
                                  scaffold a kit (docs/KITS.md): kit.json and one node kind (card template, style, a
                                  details section, a fields schema). --project (the default) puts it in
                                  <dir>/karyo/kits (dir: .); --global in the shared library, $KARYO_HOME/kits
                                  (~/.adenine/karyo/kits)
  kit list [--project <dir>]      every kit the project sees, nearest first (project, $KARYO_KITS, shared, built-in):
                                  its node kinds, plate types, what a nearer one hides, and whether it runs code
                                  (JavaScript) and if you trust that version
  kit trust <name|dir> [--project <dir>] [--yes]
                                  let a kit's JavaScript run (docs/KITS.md "Code in kits"): shows what that means and
                                  every file it runs with its sha256, then asks y/N (--yes: don't ask). Kept in
                                  $KARYO_HOME/trust.json for this exact version: a changed file asks again
  kit untrust <name|dir> [--project <dir>]
                                  take that back (every version of the kit)
  kit check <name|dir> [--project <dir>]
                                  check a kit: schema, required fields, each kind's templates rendered with its
                                  example, theme-token-only CSS, plate types; exit 1 on errors
  stills <spec> [--step N|all] [--theme <id>] [--mode light|dark] [--dpr 1] [--out dir]
                                  validate, then render each step at rest to PNG; prints the paths
  lint <spec> [--theme …] [--mode …]
                                  layout lint of every step (elements off the stage, clipped text)
  serve <spec> [--port 5180]      make sure a dev server runs (reuses one on the port, else starts vite)
                                  and print the explainer's live URL
  build <spec> [-o file.html] [--target artifact]
                                  one self-contained HTML file (default: next to the spec); --target artifact builds
                                  it for a hosted artifact frame (short title, theme follows the colour scheme)
  artifact build <spec>           the explainer as a page for a Claude artifact, in <project>/.karyo/artifacts/<id>.html;
                                  prints its path, size and sha256 (docs/ARTIFACTS.md). Karyo never publishes: Claude
                                  does, with its Artifact tool
  artifact link <spec> <url> [--hash H]
                                  record that the spec is published at that artifact url, with the hash of the page
                                  published (default: the last \`artifact build\` of it), in karyo/artifacts.json
  artifact unlink <spec>          forget the link
  artifact status                 every linked explainer, up to date or stale (and why), and the unlinked ones
                                  (artifact commands take [--project <dir>]: default the git repo you're in)
  open <spec> [-o file.html]      build, then open it in the browser
  view [dir] [--port N] [--open]  the project's web view: its models (structure boards, Bench, Splice, flows) and
                                  explainers, served locally on a free port (5782–5799); prints the URL.
                                  [dir] defaults to the git repo you're in (else the working dir)
  jarvis [dir] [--port N] [--spec <spec>] [--no-whisper] [--no-brain]
                                  Jarvis mode (voice, local only): the view plus the Whisper + claude -p server;
                                  prints the page URL. Needs uv; the Whisper model is downloaded on first use
                                  (--no-whisper: typed commands only; --no-brain: no claude -p)
  stop [dir] [--all]              stop the view/jarvis servers started for the project (or every one)
  status                          the running view/jarvis servers
  model scan [<package-dir>…] [-o karyo.model.json] [--name N]
                                  read the project's Python '# karyo:' directives (sdk/python) into .karyo/ and
                                  build karyo.model.json (no package given: every package holding a directive);
                                  karyo/config.json's mode when the project has one
  model build [-o karyo.model.json] [--name N]
                                  merge the fragments in .karyo/ (from scans and recorded runs) into the model
  init [dir] [--hook stop|edit|git|none] [--ci | --no-ci] [--mode auto|directives] [--dry-run] [--yes] [--remove [--purge]]
                                  set a project up for Karyo (docs/ADOPT.md): shows what it will change, asks, then
                                  writes the launcher (karyo/karyo.sh), the settings (karyo/config.json: mode auto,
                                  every class and function with directives refining theirs, or directives only),
                                  .gitignore entries, karyo-* recipes in an existing justfile/Makefile, and the
                                  refresh hook / CI workflow you pick; idempotent.
                                  --remove takes out everything it wrote (--purge: your karyo/ files too)
  refresh [dir] [--if-stale] [--check] [--outline] [--hook]
                                  re-scan the code (in karyo/config.json's mode: automatic, directives on top) and rebuild
                                  karyo.model.json with karyo/curation.json; reports curation-unresolved entries and
                                  drift. --check exits 1 on unresolved entries; --hook: quiet, debounced, never fails
  record [dir] [--keep] [-- <command …>]
                                  run the tests (default: the detected test command) once under the sys.monitoring
                                  recorder, then rebuild: the board shows real calls and what was not exercised
  demo [name] [--no-open] [--out DIR] [--force]
                                  a demo series that ships with Karyo (demos/<name>/): no name lists them; with one,
                                  builds every page to self-contained HTML (cached in the plugin's data dir, rebuilt
                                  only when Karyo's version or the demo changes; --out: build into DIR instead) and
                                  opens its index.html in the browser (--no-open: just print the path)
  setup [--jarvis]                check bun, uv, python3 and Chrome; install the JS dependencies and the MCP
                                  server's Python env (with --jarvis, Jarvis's too) into the plugin's data dir
  docket <command> …              the project's docket: decisions, reviews and come-back-tos that need you
                                  (add, list, show, close, reopen, edit, milestones, path, open;
                                  karyo docket --help)

  --json                          machine-readable output (one JSON document on stdout, errors as {"error": …})
  <spec> is a path to a *.explainer.json file, or to a folder holding exactly one.

Spec format: docs/EXPLAINERS.md in ${ROOT}
Model format: docs/MODEL.md there.
Component resolution: <spec dir>/components, $KARYO_COMPONENTS, ~/.adenine/karyo/components, built-ins.
Kit resolution: <project>/karyo/kits, $KARYO_KITS, $KARYO_HOME/kits (~/.adenine/karyo/kits), built-ins (docs/KITS.md).`;

async function cmdNew() {
  const target = args._[1];
  if (!target) throw new UserError('usage: karyo new <path> [--title T] [--template blank|steps|graph]');
  const abs = path.resolve(target);
  const file = abs.endsWith('.explainer.json') ? abs : path.join(abs, `${path.basename(abs)}.explainer.json`);
  const id = path.basename(file, '.explainer.json');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new UserError(`"${id}" isn't a usable explainer name: letters, digits, - and _ only`);
  if (existsSync(file) && args.flags.force !== true) throw new UserError(`${rel(file)} already exists (--force replaces it)`);
  const title = str('title') ?? id.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const spec = await starter(id, title, (str('template') ?? 'steps') as Template);
  mkdirSync(path.join(path.dirname(file), 'components'), { recursive: true });
  writeFileSync(file, JSON.stringify(spec, null, 2) + '\n');
  const { issues } = await check(file).catch((e) => (e instanceof UserError ? { issues: [] as Issue[] } : Promise.reject(e)));
  if (JSON_OUT) return emit({ file, id, spec, issues });
  say(`wrote ${rel(file)}  (${stepCount(spec)} step(s); components/ is for this explainer's own components)`);
  if (issues.length) printIssues(issues, file);
  say(`next: edit it (docs/EXPLAINERS.md), then  karyo validate ${rel(file)}  and  karyo stills ${rel(file)}`);
}

async function cmdValidate() {
  const file = specPath(args._[1]);
  const { issues } = await check(file);
  const ok = errorsIn(issues).length === 0;
  if (JSON_OUT) emit({ file, ok, issues }); else printIssues(issues, file);
  return ok ? 0 : 1;
}

async function cmdInfo() {
  const file = specPath(args._[1]);
  const { spec, issues } = readSpec(file);
  if (issues.length) throw new UserError(issues[0]!.message);
  const list: any[] = Array.isArray(spec.steps) && spec.steps.length ? spec.steps : [{ title: spec.title }];
  const steps = list.map((s: any, i: number) => ({ n: i + 1, title: String(s?.title ?? `Step ${i + 1}`) }));
  const used = [...new Set((Array.isArray(spec.elements) ? spec.elements : []).map((e: any) => e?.type).filter((t: unknown) => typeof t === 'string'))];
  const o = { file, id: path.basename(file, '.explainer.json'), title: spec.title ?? '', steps, components: used, html: file.replace(/\.explainer\.json$/, '.html') };
  if (JSON_OUT) return emit(o);
  say(`${o.title}  (${rel(file)})`);
  for (const s of steps) say(`  step-${s.n}  ${s.title}`);
}

async function cmdComponents() {
  const spec = str('spec') ? specPath(str('spec')) : undefined;
  const lib = await library(spec);
  const list = comps(lib).map((c) => ({ name: c.name, source: c.source, description: c.meta?.description ?? '', dir: c.dir }));
  if (JSON_OUT) return emit({ components: list });
  const w = Math.max(4, ...list.map((c) => c.name.length));
  for (const c of list) say(`${c.name.padEnd(w)}  ${c.source.padEnd(8)}  ${c.description}`);
  if (!list.length) say('no components found');
}

async function cmdComponent() {
  const sub = args._[1], name = args._[2];
  if (sub === 'show') {
    if (!name) throw new UserError('usage: karyo component show <name> [--spec <spec>]');
    const lib = await library(str('spec') ? specPath(str('spec')) : undefined);
    const c = findComp(lib, name);
    if (!c) throw new UserError(`no component "${name}" (have: ${comps(lib).map((c) => c.name).join(', ')})`);
    const o = { name: c.name, source: c.source, dir: c.dir, description: c.meta?.description ?? '', props: c.meta?.props ?? {}, example: c.meta?.example ?? null,
      size: c.meta?.size ?? null, motion: c.meta?.motion ?? [] };
    if (JSON_OUT) return emit(o);
    say(`${o.name}  (${o.source}: ${o.dir})\n${o.description}\n\nprops:\n${JSON.stringify(o.props, null, 2)}\n\nexample:\n${JSON.stringify(o.example, null, 2)}`);
    return;
  }
  if (sub === 'new') {
    if (!name) throw new UserError('usage: karyo component new <name> [--global | --project <dir>]');
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new UserError(`component names are lowercase kebab-case (got "${name}")`);
    let dir: string;
    if (args.flags.global === true) dir = path.join(os.homedir(), '.adenine/karyo/components');
    else {
      const p = path.resolve(str('project') ?? '.');
      const base = existsSync(p) && statSync(p).isFile() ? path.dirname(p) : p;
      dir = path.basename(base) === 'components' ? base : path.join(base, 'components');
    }
    if (existsSync(path.join(dir, name))) throw new UserError(`${rel(path.join(dir, name))} already exists`);
    mkdirSync(dir, { recursive: true });
    const { scaffoldComponent } = await core('library.ts');
    const made = await scaffoldComponent(dir, name);
    const out = typeof made === 'string' ? made : made?.dir ?? path.join(dir, name);
    const files = existsSync(out) ? readdirSync(out).map((f) => path.join(out, f)) : [];
    if (JSON_OUT) return emit({ name, dir: out, files });
    say(`scaffolded ${rel(out)}/`);
    for (const f of files) say(`  ${rel(f)}`);
    say(`edit them, then: karyo component check ${rel(out)}`);
    return;
  }
  if (sub === 'check') {
    if (!name) throw new UserError('usage: karyo component check <name|dir> [--spec <spec>]');
    return cmdComponentCheck(name);
  }
  throw new UserError('usage: karyo component show|new|check <name> …');
}

/** Load one component (by name, or from a folder not yet on the search path) and try its example. */
async function cmdComponentCheck(nameOrDir: string) {
  const { loadLibrary } = await core('library.ts');
  const { validateSpec } = await core('validate.ts');
  const asDir = path.resolve(nameOrDir);
  const isDir = existsSync(asDir) && statSync(asDir).isDirectory();
  const spec = str('spec') ? specPath(str('spec')) : undefined;
  const lib = await loadLibrary({ specDir: spec ? path.dirname(spec) : undefined, extra: isDir ? [path.dirname(asDir)] : undefined });
  const name = isDir ? path.basename(asDir) : nameOrDir;
  const c = comps(lib).find((c) => c.name === name && (!isDir || path.resolve(c.dir) === asDir)) ?? findComp(lib, name);
  // loader problems (bad component.json, missing template) for this component's folder
  const problems: { dir: string; message: string }[] = lib?.problems ?? [];
  const issues: Issue[] = problems.filter((p) => path.basename(p.dir) === name && (!isDir || path.resolve(p.dir) === asDir))
    .map((p) => ({ path: '', level: 'error' as const, message: p.message }));
  if (!c) issues.push({ path: '', level: 'error', message: `component "${name}" didn't load`, hint: 'it needs a component.json with a description, a props schema and an example' });
  else {
    const d = c.meta?.description;
    if (typeof d !== 'string' || !d.trim()) issues.push({ path: '/description', level: 'error', message: 'no description', hint: 'one sentence on what it shows: authors pick components by it' });
    else if (/^TODO\b/.test(d)) issues.push({ path: '/description', level: 'warn', message: 'the description is still the scaffold\'s TODO' });
    const example = c.meta?.example;
    if (example === undefined) issues.push({ path: '/example', level: 'warn', message: 'no example', hint: 'an example shows authors (and Claude) how to use it' });
    else {
      // the example, dropped into a one-step explainer, must validate
      // the example, as the props of a one-element explainer, must validate (props schema, template, CSS);
      // paths point into component.json: /example/… for props, '' for the template and style
      const where = (p: string) => (p.startsWith('/elements/0/props') ? `/example${p.slice('/elements/0/props'.length)}` : p.startsWith('/elements/0') ? '' : p);
      issues.push(...validateSpec(probeSpec(c, example), lib).filter((i: Issue) => !i.path.startsWith('/steps'))
        .map((i: Issue) => ({ ...i, path: where(i.path) })));
    }
  }
  const ok = errorsIn(issues).length === 0;
  if (JSON_OUT) emit({ name, dir: c?.dir ?? (isDir ? asDir : null), source: c?.source ?? null, ok, issues });
  else printIssues(issues, c?.dir ?? nameOrDir);
  return ok ? 0 : 1;
}

/** A one-element explainer that uses the component with its example props (the example is the props,
 *  or tolerated: a whole element { type, props }). */
function probeSpec(c: Comp, example: unknown): any {
  const ex = (example ?? {}) as Record<string, unknown>;
  const props = ex.type === c.name && typeof ex.props === 'object' ? ex.props : ex;
  return { karyo: 'explainer/1', id: 'probe', title: `${c.name} example`, ...(c.source === 'builtin' ? {} : { uses: [c.name] }),
    elements: [{ id: 'probe', type: c.name, props }], steps: [{ title: 'probe' }] };
}

async function stepsFor(spec: any): Promise<number[]> {
  const n = stepCount(spec);
  const s = str('step') ?? 'all';
  if (s === 'all') return Array.from({ length: n }, (_, i) => i + 1);
  const want = s.split(',').flatMap((p) => {
    const m = p.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new UserError(`--step takes N, N-M, a comma list, or all (got "${s}")`);
    const a = +m[1]!, b = m[2] ? +m[2] : a;
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
  for (const k of want) if (k < 1 || k > n) throw new UserError(`step ${k} doesn't exist (the explainer has ${n})`);
  return want;
}

async function cmdStills() {
  const file = specPath(args._[1]);
  const { spec, issues } = await check(file);
  if (errorsIn(issues).length) {
    if (JSON_OUT) emit({ file, ok: false, issues, stills: [] }); else { printIssues(issues, file); console.error('fix the errors first: stills need a valid spec'); }
    return 1;
  }
  const steps = await stepsFor(spec);
  const out = path.resolve(str('out') ?? path.join(path.dirname(file), 'stills'));
  mkdirSync(out, { recursive: true });
  const tag = [str('theme'), str('mode')].filter(Boolean).join('-');
  const srv = await renderServer();
  const flags = [...renderFlags(), ...srv.flags];
  if (!flags.includes('--dpr')) flags.push('--dpr', '1');
  // one render.ts run per step (it applies one state); render into a scratch folder, keep step-N.png
  const renderStep = async (n: number) => {
    const tmp = path.join(out, `.render-${process.pid}-${n}`);
    try {
      const r = await render(['stills', '--spec', file, '--state', `step-${n}`, '--t', String(REST_T), '--out', tmp, ...flags]);
      const png = r.out.split('\n').map((l) => l.trim()).find((l) => l.endsWith('.png'));
      if (r.code !== 0 || !png) throw new UserError(`rendering step ${n} failed:\n${(r.err || r.out).trim()}`);
      // what the page itself complained about (a component the render server can't see, a script error)
      const said = r.err.split('\n').filter((l) => /SCENE ERRORS|pageerror|\[karyo\] error/.test(l)).slice(0, 4);
      if (said.length) issues.push({ path: '', level: 'warn', message: `step ${n}: the page reported ${said.map((l) => l.trim()).join(' | ')}` });
      const dest = path.join(out, `step-${n}${tag ? `.${tag}` : ''}.png`);
      await Bun.write(dest, Bun.file(png));
      return dest;
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  };
  const stills: { step: number; file: string }[] = [];
  try {
    for (const n of steps) {
      stills.push({ step: n, file: await renderStep(n) });
      say(stills.at(-1)!.file);
    }
  } finally { srv.stop(); }
  if (JSON_OUT) emit({ file, ok: true, issues, stills });
  else if (issues.length) printIssues(issues, file);
  return 0;
}

async function cmdLint() {
  const file = specPath(args._[1]);
  const { issues } = await check(file);
  if (errorsIn(issues).length) {
    if (JSON_OUT) emit({ file, ok: false, issues, lint: [] }); else { printIssues(issues, file); console.error('fix the errors first'); }
    return 1;
  }
  const srv = await renderServer();
  const r = await render(['lint', '--spec', file, ...renderFlags(), ...srv.flags]).finally(srv.stop);
  if (r.code !== 0) throw new UserError(`lint failed:\n${(r.err || r.out).trim()}`);
  const found = r.out.split('\n').filter((l) => l.includes(' @') && l.includes('s: '));
  if (JSON_OUT) emit({ file, ok: found.length === 0, issues, lint: found });
  else { process.stdout.write(r.out); if (r.err.trim()) console.error(r.err.trim()); }
  return found.length ? 1 : 0;
}

async function cmdServe() {
  const file = specPath(args._[1]);
  const { url, started, log, pid } = await devServer(str('port') ?? '5180');
  const view = `${url}/explain.html?spec=${encodeURIComponent(file)}`;
  if (JSON_OUT) return emit({ file, url: view, started, log, pid });
  say(started ? `started a dev server at ${url} (pid ${pid}, log: ${log})` : `dev server already running at ${url}`);
  if (!started && (process.env.KARYO_COMPONENTS ?? '').trim()) say(`note: that server bundles components with its own environment; if it wasn't started with this $KARYO_COMPONENTS, use --port to start one that is`);
  say(view);
}

async function cmdBuild(openIt = false) {
  const target = str('target') ?? 'file';
  if (target !== 'file' && target !== 'artifact') throw new UserError(`--target takes file or artifact (got "${target}")`);
  const file = specPath(args._[1]);
  const { issues: pre } = await check(file);
  if (errorsIn(pre).length) {
    if (JSON_OUT) emit({ file, ok: false, issues: pre }); else { printIssues(pre, file); console.error('fix the errors first: build needs a valid spec'); }
    return 1;
  }
  const out = path.resolve(str('out') ?? file.replace(/\.explainer\.json$/, '.html'));
  mkdirSync(path.dirname(out), { recursive: true });
  const { buildHtml } = await core('build.ts');
  const r = await buildHtml(file, out, { target });
  const issues: Issue[] = r.issues ?? [];
  if (JSON_OUT) emit({ file, ok: errorsIn(issues).length === 0, html: r.file, bytes: r.bytes, target, title: r.title, issues });
  else {
    say(`${rel(r.file)}  ${(r.bytes / 1024).toFixed(1)} KB`);
    if (issues.length) printIssues(issues, file);
  }
  if (openIt) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    await Bun.spawn([opener, r.file], { stdout: 'ignore', stderr: 'ignore' }).exited;
    say(`opened ${rel(r.file)}`);
  }
  return errorsIn(issues).length ? 1 : 0;
}

// ---------------------------------------------------------------- artifacts (src/cli/artifact.ts, docs/ARTIFACTS.md)

type ArtifactMod = typeof import('../src/cli/artifact.ts');
const artifactMod = (): Promise<ArtifactMod> => import(path.join(ROOT, 'src/cli/artifact.ts'));
const KARYO_BIN = path.join(ROOT, 'cli/karyo');
const ARTIFACT_SKILL = '/karyo:artifact';

/** Renders a spec's artifact page in memory: the runtime cached in the plugin's data dir, as `karyo demo` does. */
async function artifactRender(r: Runtime, log: (s: string) => void = say) {
  r.ensureDeps(log);
  const { renderHtml } = await core('build.ts');
  const runtimeDir = path.join(r.dataDir().dir, 'explainer-runtime');
  return {
    runtimeDir,
    render: async (spec: string) => {
      const x = await renderHtml(spec, { target: 'artifact', runtimeDir });
      return { html: x.html as string, title: x.title as string, issues: x.issues as Issue[], errors: errorsIn(x.issues).map((i) => `${i.path || '/'} ${i.message}`) };
    },
  };
}

async function cmdArtifact(): Promise<number> {
  const sub = args._[1];
  const a = await artifactMod();
  return withRuntime(async (r) => {
    const project = r.projectDir(str('project'));
    try {
      if (sub === 'build') return await artifactBuild(a, r, project);
      if (sub === 'link') return artifactLink(a, project);
      if (sub === 'unlink') return artifactUnlink(a, project);
      if (sub === 'status') return await artifactStatus(a, r, project);
      if (sub === 'hook') return await artifactHook(a, r, project);
    } catch (e) { if (e instanceof a.ArtifactError) throw new UserError(e.message); throw e; }
    throw new UserError('usage: karyo artifact build <spec> | link <spec> <url> [--hash H] | unlink <spec> | status   [--project <dir>] [--json]');
  });
}

async function artifactBuild(a: ArtifactMod, r: Runtime, project: string): Promise<number> {
  const file = specPath(args._[2]);
  const key = a.specKey(project, file);
  const { issues: pre } = await check(file);
  if (errorsIn(pre).length) {
    if (JSON_OUT) emit({ spec: key, ok: false, issues: pre }); else { printIssues(pre, file); console.error('fix the errors first: the build needs a valid spec'); }
    return 1;
  }
  const { render, runtimeDir } = await artifactRender(r, JSON_OUT ? () => {} : say);
  const x = await render(file);
  const out = a.artifactFile(project, file);
  a.ensureOutDir(project);
  writeFileSync(out, x.html);
  const { ARTIFACT_MAX_BYTES, ensureRuntime } = await core('build.ts');
  // the page is mostly the runtime: a copy without it is what Claude reads before publishing (skills/artifact)
  const rv = a.reviewCopy(x.html, await ensureRuntime(runtimeDir));
  const review = a.reviewFile(project, file);
  writeFileSync(review, rv.text);
  const bytes = Buffer.byteLength(x.html), hash = a.sha256(x.html), content = a.contentHash(x.html);
  const over = bytes > ARTIFACT_MAX_BYTES;
  const linked = a.readRecord(project).artifacts.find((l) => l.spec === key) ?? null;
  const ok = !over && errorsIn(x.issues).length === 0;
  if (JSON_OUT) emit({ spec: key, ok, html: out, review, runtimeVerified: rv.verified, bytes, hash, content, title: x.title, maxBytes: ARTIFACT_MAX_BYTES, linked: linked ? { url: linked.url, upToDate: linked.hash === hash } : null, issues: x.issues });
  else {
    say(`${out}`);
    say(`  ${(bytes / 1024).toFixed(1)} KB  sha256 ${hash}  title "${x.title}"`);
    say(`  review copy (read this before publishing): ${review}${rv.verified ? '' : '  (runtime NOT verified: read the whole page)'}`);
    if (x.issues.length) printIssues(x.issues, file);
    if (over) console.error(`karyo: ${(bytes / 1e6).toFixed(1)} MB is over the 16 MB an artifact may hold; use smaller images`);
    if (linked) say(linked.hash === hash ? `  already published as is at ${linked.url}` : `  linked to ${linked.url}: republish it there, then  karyo artifact link ${key} ${linked.url}`);
    else say(`  not linked yet: publish it, then  karyo artifact link ${key} <url>`);
  }
  return ok ? 0 : 1;
}

function artifactLink(a: ArtifactMod, project: string): number {
  const file = specPath(args._[2]);
  const url = args._[3];
  if (!url) throw new UserError('usage: karyo artifact link <spec> <url> [--hash H]');
  let hash = str('hash'), content: string | null = null, title: string | undefined, note = '';
  if (!hash) {
    const built = a.artifactFile(project, file);
    if (!existsSync(built)) throw new UserError(`no build of it yet (${rel(built)}): run  karyo artifact build ${rel(file)}  first, or pass --hash`);
    const html = readFileSync(built, 'utf8');
    hash = a.sha256(html); content = a.contentHash(html);
    title = html.match(/<title>([^<]*)<\/title>/)?.[1];
    if (statSync(file).mtimeMs > statSync(built).mtimeMs) note = `note: the spec changed after the last build; if you published that build, \`karyo artifact status\` will call it stale (rebuild and republish)`;
  }
  const e = a.link(project, file, { url, hash, content, title });
  if (JSON_OUT) { emit({ ...e, record: a.recordPath(project), note: note || undefined }); return 0; }
  say(`linked ${e.spec} → ${e.url}  (sha256 ${e.hash.slice(0, 12)}…, in ${rel(a.recordPath(project))})`);
  if (note) say(note);
  return 0;
}

function artifactUnlink(a: ArtifactMod, project: string): number {
  const arg = args._[2];
  if (!arg) throw new UserError('usage: karyo artifact unlink <spec>');
  // a spec that's gone can still be named: by its path from here, or by its path in the record
  const target = existsSync(path.resolve(arg)) ? specPath(arg) : path.resolve(arg);
  const hit = a.unlink(project, target) ?? (existsSync(path.resolve(arg)) ? null : a.unlink(project, path.join(project, arg)));
  if (JSON_OUT) { emit({ removed: hit, record: a.recordPath(project) }); return 0; }
  say(hit ? `unlinked ${hit.spec} (was ${hit.url}); the artifact itself stays where it is` : `${arg} wasn't linked`);
  return 0;
}

async function artifactStatus(a: ArtifactMod, r: Runtime, project: string): Promise<number> {
  const rec = a.readRecord(project);
  const { render } = rec.artifacts.length ? await artifactRender(r, JSON_OUT ? () => {} : say) : { render: async () => ({ html: '', errors: [] as string[] }) };
  const st = await a.status(project, render, { unlinked: true });
  if (JSON_OUT) { emit(st); return 0; }
  if (!st.linked.length && !st.unlinked.length) { say(`no explainers in ${project}`); return 0; }
  for (const l of st.linked) say(`${l.state.padEnd(10)}  ${l.spec}  ${l.url}${l.reason ? `\n            ${l.reason}` : ''}`);
  for (const u of st.unlinked) say(`${'unlinked'.padEnd(10)}  ${u}`);
  const stale = st.linked.filter((l) => l.state === 'stale').length;
  if (stale) say(`\n${stale} stale: rebuild (karyo artifact build <spec>), republish to the same url, then karyo artifact link <spec> <url>`);
  return 0;
}

/** `karyo artifact hook stop|session-start`: the plugin's hooks (hooks/hooks.json). Reads the hook's JSON on stdin,
 *  prints the hook's JSON answer or nothing; never fails the session (a problem goes to stderr, exit 0). */
async function artifactHook(a: ArtifactMod, r: Runtime, project: string): Promise<number> {
  const kind = args._[2];
  try {
    let input: any = {};
    try { const t = await Bun.stdin.text(); if (t.trim()) input = JSON.parse(t); } catch { /* no input */ }
    if (!existsSync(a.recordPath(project))) return 0;
    const quiet = () => {};
    const render = async (spec: string) => (await artifactRender(r, quiet)).render(spec);
    const o = { render, karyo: KARYO_BIN, skill: ARTIFACT_SKILL };
    const out = kind === 'stop' ? await a.stopHook(project, input, o) : kind === 'session-start' ? await a.sessionStartHook(project, o) : null;
    if (out) console.log(JSON.stringify(out));
  } catch (e) { console.error(`karyo artifact hook: ${(e as Error).message}`); }
  return 0;
}

// ---------------------------------------------------------------- docket (src/docket: parse/format, store, commands)

async function cmdDocket(): Promise<number> {
  const { runDocket, DocketError } = await import(path.join(ROOT, 'src/docket/cli.ts'));
  try {
    return await runDocket(args._.slice(1), args.flags, JSON_OUT);
  } catch (e) {
    if (e instanceof DocketError) throw new UserError((e as Error).message);
    throw e;
  }
}

// ---------------------------------------------------------------- plugin runtime (scripts/karyo-runtime.ts): view, jarvis, stop, setup, model

type Runtime = typeof import('../scripts/karyo-runtime.ts');
let rt: Runtime | undefined;
async function runtime(): Promise<Runtime> { return (rt ??= await import(path.join(ROOT, 'scripts/karyo-runtime.ts'))); }
/** Runtime failures (a missing tool, a server that won't start) are the user's to fix: print them plainly. */
async function withRuntime<T>(fn: (r: Runtime) => Promise<T>): Promise<T> {
  const r = await runtime();
  try { return await fn(r); } catch (e) { if (e instanceof r.RuntimeError) throw new UserError(e.message); throw e; }
}
const numFlag = (k: string) => { const v = str(k); if (v === undefined) return undefined; if (!/^\d+$/.test(v)) throw new UserError(`--${k} takes a number`); return +v; };

async function cmdView() {
  return withRuntime(async (r) => {
    const project = r.projectDir(args._[1]);
    const srv = await r.viewServer(project, numFlag('port'));
    const url = `${srv.url}/project.html`;
    const idx: any = await fetch(`${srv.url}/__karyo/project`).then((x) => x.json()).catch(() => null);
    if (args.flags.open === true) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      Bun.spawn([opener, url], { stdout: 'ignore', stderr: 'ignore' });
    }
    if (JSON_OUT) return emit({ project, url, reused: srv.reused, port: srv.port, pid: srv.pid, log: srv.log, models: idx?.models?.map((m: any) => m.rel) ?? [], explainers: idx?.explainers?.map((e: any) => e.rel) ?? [] });
    say(`${srv.reused ? 'Karyo view already running' : 'Karyo view started'} for ${project}`);
    say(url);
    if (idx) {
      say(`  ${idx.models.length} model(s)${idx.models.length ? ': ' + idx.models.map((m: any) => m.rel).join(', ') : ''}`);
      say(`  ${idx.explainers.length} explainer(s)${idx.explainers.length ? ': ' + idx.explainers.map((e: any) => e.rel).join(', ') : ''}`);
      if (!idx.models.length && !idx.explainers.length) say('  nothing to draw yet: `karyo model scan` reads `# karyo:` directives into a model; `karyo new <dir>` starts an explainer');
    }
    await codeKitWarning(project);
    say(`stop it with: karyo stop${args._[1] ? ' ' + args._[1] : ''}   (log: ${srv.log})`);
  });
}

/** `karyo view`: a warning line when the project sees kits that run their own JavaScript (docs/KITS.md "Code in kits"). */
async function codeKitWarning(project: string) {
  const { loadKits } = await kitCore('library.ts');
  const lib = await loadKits({ projectDir: project });
  const code = lib.kits.filter((k: any) => k.code && k.source !== 'builtin');
  if (!code.length) return;
  const states = await Promise.all(code.map(async (k: any) => `${k.name} (${k.source === 'project' ? 'this project' : k.source}; ${(await kitCodeState(k)).words})`));
  say(`⚠ kits here run their own JavaScript: ${states.join(', ')}. The page asks before running any version you haven't trusted, and shows a notice while one runs.`);
  say(`  review them: karyo kit list --project ${rel(project) || '.'}   then: karyo kit trust <name> --project ${rel(project) || '.'}`);
}

async function cmdJarvis() {
  return withRuntime(async (r) => {
    const project = r.projectDir(args._[1]);
    const view = await r.viewServer(project);
    let spec = str('spec') ? specPath(str('spec')) : undefined;
    if (!spec) {
      const idx: any = await fetch(`${view.url}/__karyo/project`).then((x) => x.json()).catch(() => null);
      const first = idx?.explainers?.[0];
      if (first) spec = first.abs;
    }
    const j = await r.jarvisServer(project, view.port, numFlag('port'), ['no-whisper', 'no-brain'].filter((k) => args.flags[k] === true).map((k) => `--${k}`));
    const ws = `ws://127.0.0.1:${j.port}/ws`;
    const url = `${view.url}/jarvis.html?ws=${encodeURIComponent(ws)}${spec ? `&spec=${encodeURIComponent(spec)}` : ''}`;
    const models = path.join(r.dataDir().dir, 'whisper');
    if (JSON_OUT) return emit({ project, url, ws, jarvis: { port: j.port, pid: j.pid, log: j.log, reused: j.reused }, view: { port: view.port, pid: view.pid }, spec: spec ?? null, whisperModels: models });
    say(`Jarvis ${j.reused ? 'already running' : 'started'} for ${project} (log: ${j.log})`);
    say(url);
    say(`Hold Space to talk. The Whisper model (large-v3-turbo, about 1.5 GB) is downloaded on first use from OpenAI's official URL, SHA-256 checked, into ${models}.`);
    if (!spec) say('note: the page shows a built-in plate; for a plate of this project pass --spec <explainer> (Jarvis draws built-in scenes and explainers, not a project model board)');
    say('stop with: karyo stop');
  });
}

async function cmdStop() {
  return withRuntime(async (r) => {
    const project = args.flags.all === true ? null : r.projectDir(args._[1]);
    const hit = r.stopServers(project);
    if (JSON_OUT) return emit({ stopped: hit });
    if (!hit.length) say(project ? `nothing running for ${project}` : 'nothing running');
    for (const s of hit) say(`stopped ${s.kind} on port ${s.port} (${s.project})`);
  });
}

async function cmdStatus() {
  return withRuntime(async (r) => {
    const list = r.listServers();
    if (JSON_OUT) return emit({ servers: list });
    if (!list.length) say('no Karyo servers running');
    for (const s of list) say(`${s.kind.padEnd(6)} ${s.url}${s.kind === 'view' ? '/project.html' : ''}  ${s.project}  (pid ${s.pid})`);
  });
}

async function cmdModel() {
  return withRuntime(async (r) => {
    const sub = args._[1];
    const project = r.projectDir(str('project'));
    const out = str('out') ?? 'karyo.model.json';
    const name = str('name') ?? path.basename(project);
    if (sub === 'scan') {
      const pkgs = args._.slice(2).length ? args._.slice(2) : r.pythonPackages(project);
      if (!pkgs.length) throw new UserError(`no Python package with a \`# karyo:\` directive found in ${project}; name one: karyo model scan <package-dir>`);
      const res = r.modelScan(project, pkgs, out, name, say);
      if (JSON_OUT) return emit(res);
      if (res.output.trim()) say(res.output.trim());
      if (!res.output.includes(res.model)) say(`wrote ${rel(res.model)}`);
      return;
    }
    if (sub === 'build') {
      const res = r.modelBuild(project, out, name);
      if (JSON_OUT) return emit(res);
      if (res.output.trim()) say(res.output.trim());
      if (!res.output.includes(res.model)) say(`wrote ${rel(res.model)}`);
      return;
    }
    throw new UserError('usage: karyo model scan [<package-dir>…] | karyo model build   [-o karyo.model.json] [--name N] [--project DIR]');
  });
}

async function cmdSetup() {
  return withRuntime(async (r) => {
    const problems: string[] = [];
    let deps: unknown = null;
    try { deps = r.ensureDeps(say); } catch (e) { problems.push((e as Error).message); }
    if (r.which('uv')) { try { r.mcpEnv(say); } catch (e) { problems.push((e as Error).message); } }
    if (args.flags.jarvis === true) { try { r.jarvisEnv(say); } catch (e) { problems.push((e as Error).message); } }
    const d = r.doctor();
    // in a sandbox (Cowork's shell) neither runs: the MCP server starts on the user's computer, and Jarvis can't
    if ((!d.uv || !(d.uv as any).path) && !r.inSandbox()) problems.push('uv is missing (the MCP server and Jarvis need it): curl -LsSf https://astral.sh/uv/install.sh | sh');
    if (!d.chrome) { try { d.chrome = r.ensureBrowser(say); } catch (e) { problems.push((e as Error).message); } }
    if (JSON_OUT) { emit({ ...d, deps, problems }); return problems.length ? 1 : 0; }
    say(`karyo ${d.version ?? ''}  root ${d.root}`);
    say(`data   ${d.data}  (${d.dataFrom})`);
    for (const k of ['bun', 'uv', 'python3'] as const) { const t = d[k] as any; say(`${k.padEnd(7)}${t.path ? `${t.version}  ${t.path}` : 'missing'}`); }
    say(`chrome ${d.chrome ?? 'missing'}`);
    say(`deps   ${d.jsDeps ? 'installed' : 'missing'}`);
    say(`mcp    ${d.mcpEnv ? 'Python env ready' : 'Python env not installed (needs uv)'}`);
    say(`jarvis ${d.jarvisEnv ? 'Python env ready' : 'Python env not installed (karyo setup --jarvis, or on first `karyo jarvis`)'}; whisper model ${(d.whisperModel as string[]).length ? 'present' : 'fetched on first use'}`);
    for (const p of problems) say(`problem: ${p}`);
    return problems.length ? 1 : 0;
  });
}

// ---------------------------------------------------------------- demos (src/explainer/demo.ts): demos/<name>/demo.json

const DEMOS = path.join(ROOT, 'demos');

function karyoVersion(): string {
  try { return String(JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8')).version ?? 'dev'); } catch { return 'dev'; }
}

/** Open a file in the default browser, without waiting for it. */
function openInBrowser(file: string) {
  const cmd = process.platform === 'darwin' ? ['open', file] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""', file] : ['xdg-open', file];
  try { Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' }).unref(); return true; } catch { return false; }
}

async function cmdDemo(): Promise<number> {
  const { listDemos, readDemo, buildDemo, DemoError } = await core('demo.ts');
  const name = args._[1];
  const all = listDemos(DEMOS);
  if (!name) {
    if (JSON_OUT) { emit({ demos: all }); return 0; }
    if (!all.length) { say('no demos in this Karyo install'); return 0; }
    const w = Math.max(...all.map((d: any) => d.name.length));
    for (const d of all) say(`${d.name.padEnd(w)}  ${d.problem ? `broken: ${d.problem}` : `${d.title} (${d.pages} pages)${d.description ? `: ${d.description}` : ''}`}`);
    say(`
open one with: karyo demo <name>`);
    return 0;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) || !existsSync(path.join(DEMOS, name, 'demo.json')))
    throw new UserError(`no demo "${name}"${all.length ? ` (have: ${all.map((d: any) => d.name).join(', ')})` : ''}`);
  return withRuntime(async (r) => {
    try {
      const demo = readDemo(path.join(DEMOS, name));
      r.ensureDeps(say);   // vite and three, for the explainer runtime (a fresh install's first run)
      const data = r.dataDir().dir;
      const tty = !JSON_OUT && process.stdout.isTTY;
      const res = await buildDemo(demo, {
        version: karyoVersion(), cacheRoot: path.join(data, 'demos'), runtimeDir: path.join(data, 'explainer-runtime'),
        out: str('out'), force: args.flags.force === true,
        onProgress: (done: number, total: number) => {
          if (JSON_OUT) return;
          if (done === 0) { if (tty) process.stdout.write(`building ${total} pages… `); else say(`building ${total} pages…`); }
          else if (tty) process.stdout.write(`\rbuilding ${total} pages… ${done}/${total} `);
        },
      });
      const open = args.flags['no-open'] !== true;
      const opened = open ? openInBrowser(res.index) : false;
      if (JSON_OUT) { emit({ demo: name, title: demo.manifest.title, index: res.index, dir: res.dir, key: res.key, built: res.built, seconds: +(res.ms / 1000).toFixed(2), pages: res.pages, warnings: res.warnings, opened }); return 0; }
      if (res.built) { if (tty) process.stdout.write(`\rbuilding ${res.pages.length} pages… done in ${(res.ms / 1000).toFixed(1)} s\n`); else say(`done in ${(res.ms / 1000).toFixed(1)} s`); }
      else say(`${res.pages.length} pages, already built for this version (cached)`);
      if (res.warnings.length) say(`${res.warnings.length} warning(s); --json lists them`);
      say(`${demo.manifest.title}: ${res.index}`);
      if (open) say(opened ? 'opened it in your browser' : `couldn't start the browser; open the file above`);
      return 0;
    } catch (e) {
      if (e instanceof DemoError || e instanceof UserError || e instanceof r.RuntimeError) throw new UserError((e as Error).message);
      throw new UserError(`demo "${name}" didn't build: ${(e as Error).message}`);
    }
  });
}

// ---------------------------------------------------------------- adoption (src/cli/adopt.ts, docs/ADOPT.md): init, refresh, record

async function cmdAdopt(cmd: string): Promise<number> {
  const { run, AdoptError } = await import(path.join(ROOT, 'src/cli/adopt.ts'));
  const argv = process.argv.slice(2);
  argv.splice(argv.indexOf(cmd), 1);
  try { return await run(cmd, argv, ROOT); } catch (e) { if (e instanceof AdoptError) throw new UserError((e as Error).message); throw e; }
}

// ---------------------------------------------------------------- kits (docs/KITS.md)

async function kitCore<T = any>(file: string): Promise<T> { return import(path.join(ROOT, 'src/kits', file)); }
/** The project a kit command is about: --project <dir>, else the working directory. */
const kitProject = () => path.resolve(typeof args.flags.project === 'string' ? args.flags.project : '.');

async function cmdKit(sub0?: string): Promise<number> {
  const sub = sub0 ?? args._[1], name = sub0 ? undefined : args._[2];
  if (sub === 'new') {
    if (!name) throw new UserError('usage: karyo kit new <name> [--project [dir] | --global] [--kind K]');
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new UserError(`kit names are lowercase kebab-case (got "${name}")`);
    const { scaffoldKit, homeKitsDir } = await kitCore('library.ts');
    const dir = args.flags.global === true ? homeKitsDir() : path.join(kitProject(), 'karyo', 'kits');
    if (existsSync(path.join(dir, name))) throw new UserError(`${rel(path.join(dir, name))} already exists`);
    mkdirSync(dir, { recursive: true });
    const out: string = await scaffoldKit(dir, name, { kind: str('kind') });
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
    walk(out);
    if (JSON_OUT) { emit({ name, dir: out, files }); return 0; }
    say(`scaffolded ${rel(out)}/`);
    for (const f of files) say(`  ${rel(f)}`);
    say(`edit them (a node kind's card: kinds/<kind>/template.html), then: karyo kit check ${rel(out)}`);
    return 0;
  }
  if (sub === 'list') {
    const { loadKits, shadowText } = await kitCore('library.ts');
    const lib = await loadKits({ projectDir: kitProject() });
    const list = await Promise.all(lib.kits.map(async (k: any) => ({ name: k.name, source: k.source, dir: k.dir, version: k.manifest.version ?? '', description: k.manifest.description ?? '',
      kinds: k.kinds.filter((n: string) => lib.kinds[n]?.kit === k.name), plates: k.plates.filter((p: string) => lib.plates[p]?.kit === k.name),
      ...(k.code ? { code: { hash: k.code.hash, files: k.code.files.map((f: any) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })), ...(await kitCodeState(k)) } } : {}) })));
    const shadowed = lib.shadowed.map(shadowText), problems = lib.problems.map((p: any) => `${p.dir}: ${p.message}`);
    if (JSON_OUT) { emit({ kits: list, searched: lib.searched, shadowed, problems }); return 0; }
    if (!list.length) say('no kits found');
    for (const k of list) {
      say(`${k.name}  ${k.source}  ${k.version}  ${rel(k.dir)}`);
      if (k.description) say(`  ${k.description}`);
      if (k.kinds.length) say(`  node kinds: ${k.kinds.join(', ')}`);
      if (k.plates.length) say(`  plate types: ${k.plates.join(', ')}`);
      if (k.code) {
        say(`  ⚠ runs JavaScript (${k.code.files.filter((f: any) => f.path !== 'kit.json').map((f: any) => f.path).join(', ')}): ${k.code.words}`);
        if (!k.code.trusted) say(`    review it, then: karyo kit trust ${k.name}${typeof args.flags.project === 'string' ? ` --project ${args.flags.project}` : ''}`);
      }
    }
    for (const x of shadowed) say(`warn  ${x}`);
    for (const x of problems) say(`warn  ${x}`);
    say(`searched: ${lib.searched.map((r: any) => `${r.source} ${rel(r.dir)}`).join(' · ')}`);
    return 0;
  }
  if (sub === 'trust' || sub === 'untrust') return cmdKitTrust(sub, name);
  if (sub === 'check') {
    if (!name) throw new UserError('usage: karyo kit check <name|dir> [--project <dir>]');
    let dir = path.resolve(name);
    if (!(existsSync(dir) && statSync(dir).isDirectory())) {
      const { loadKits } = await kitCore('library.ts');
      const lib = await loadKits({ projectDir: kitProject() });
      const k = lib.kits.find((x: any) => x.name === name);
      if (!k) throw new UserError(`no kit "${name}" (have: ${lib.kits.map((x: any) => x.name).join(', ') || 'none'}); pass its folder instead`);
      dir = k.dir;
    }
    const { checkKit } = await kitCore('check.ts');
    const r = await checkKit(dir);
    if (JSON_OUT) emit(r);
    else printIssues(r.issues, r.dir);
    return r.ok ? 0 : 1;
  }
  throw new UserError('usage: karyo kit new|list|check|trust|untrust …');
}

/** A kit's code and whether this version is trusted, in words for `kit list` and `view`. */
async function kitCodeState(k: any): Promise<{ trusted: boolean; builtin: boolean; at: string | null; changed: boolean; words: string }> {
  const { trustFile, trustState } = await kitCore('trust.ts');
  const { localDay } = await kitCore('warning.ts');
  const t = trustState(trustFile(), k.dir, k.code.hash, k.source);
  const words = t.builtin ? 'built into Karyo: trusted automatically'
    : t.trusted ? `trusted ${localDay(String(t.at))}`
    : t.changed ? 'CHANGED since you trusted it: not trusted' : 'NOT trusted';
  return { trusted: t.trusted, builtin: !!t.builtin, at: t.at ?? null, changed: !!t.changed, words };
}

/** `karyo kit trust|untrust <name|dir>` (docs/KITS.md "Code in kits"). */
async function cmdKitTrust(sub: 'trust' | 'untrust', name: string | undefined): Promise<number> {
  if (!name) throw new UserError(`usage: karyo kit ${sub} <name|dir> [--project <dir>]${sub === 'trust' ? ' [--yes]' : ''}`);
  const { loadKits, readKit } = await kitCore('library.ts');
  const { tildePath } = await kitCore('code.ts');
  const { KIT_CODE_WARNING, KIT_CODE_SANDBOX, KIT_TRUST_WHERE, whereWords } = await kitCore('warning.ts');
  const { trustFile, grantTrust, revokeTrust, realDir } = await kitCore('trust.ts');
  const lib = await loadKits({ projectDir: kitProject() });
  const asDir = path.resolve(name);
  const found = existsSync(asDir) && statSync(asDir).isDirectory()
    ? lib.kits.find((x: any) => realDir(x.dir) === realDir(asDir)) ?? { dir: asDir, source: 'project' }
    : lib.kits.find((x: any) => x.name === name);
  if (!found) throw new UserError(`no kit "${name}" (have: ${lib.kits.map((x: any) => x.name).join(', ') || 'none'}); pass its folder instead`);
  const file = trustFile();
  if (sub === 'untrust') {
    const removed = revokeTrust(file, found.dir);
    if (JSON_OUT) { emit({ dir: realDir(found.dir), removed, trustFile: file }); return 0; }
    say(removed ? `took trust back from ${rel(found.dir)}: its code won't run until you trust it again` : `${rel(found.dir)} was not trusted (nothing to take back)`);
    return 0;
  }
  const problems: any[] = [];
  const r = await readKit(found.dir, found.source, problems);
  if (!r) throw new UserError(`${rel(found.dir)} is not a kit: ${problems.map((p) => p.message).join('; ')}`);
  const k = r.kit, where = whereWords(k.source, tildePath(k.dir));
  if (!k.code) { if (JSON_OUT) emit({ kit: k.name, dir: k.dir, code: false }); else say(`kit ${k.name} runs no code (its plate types and kinds are data and templates): nothing to trust`); return 0; }
  if (k.source === 'builtin') { if (JSON_OUT) emit({ kit: k.name, dir: k.dir, builtin: true, trusted: true }); else say(`kit ${k.name} is built into Karyo: it is trusted automatically`); return 0; }
  const st = await kitCodeState(k);
  const width = Math.max(...k.code.files.map((f: any) => f.path.length));
  if (!JSON_OUT) {
    say(`⚠ Kit "${k.name}" runs its own JavaScript`);
    say(`  from ${where}`);
    say('');
    for (const para of [KIT_CODE_WARNING, KIT_CODE_SANDBOX]) say(wrap(para, 100, '  '));
    say('');
    say('  Files it would run:');
    for (const f of k.code.files) say(`    ${f.path.padEnd(width)}  ${String(f.bytes).padStart(7)} B  sha256 ${f.sha256}`);
    const { hiddenCount } = await kitCore('warning.ts');
    for (const f of k.code.files) { const n = hiddenCount(k.code.sources[f.path] ?? ''); if (n) say(`  ⚠ ${f.path} has ${n} invisible or direction-changing character(s): it can read differently from what runs; look at it in an editor that shows them`); }
    say(`  version (sha256 over them): ${k.code.hash}`);
    say(`  now: ${st.words}`);
    say('');
    say(wrap(KIT_TRUST_WHERE, 100, '  '));
    say(`  Read them first (${rel(k.dir)}).`);
  }
  if (st.trusted) { if (JSON_OUT) emit({ kit: k.name, dir: realDir(k.dir), hash: k.code.hash, files: k.code.files, trusted: true, at: st.at, already: true, trustFile: file }); else say(`\nthis version is already trusted (${st.words})`); return 0; }
  if (args.flags.yes !== true && args.flags.y !== true) {
    if (JSON_OUT || !process.stdin.isTTY) throw new UserError('not asking without a terminal: review the files above, then pass --yes');
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    // no answer (Ctrl-D, Ctrl-C, the input closed) is a no
    const a = (await rl.question(`\nTrust this version of kit ${k.name}? [y/N] `).catch(() => '')).trim().toLowerCase();
    rl.close();
    if (a !== 'y' && a !== 'yes') { say('not trusted: its code stays off'); return 1; }
  }
  const e = grantTrust(file, { dir: k.dir, name: k.name, source: k.source }, k.code, 'cli');
  if (JSON_OUT) { emit({ kit: k.name, dir: e.dir, hash: e.hash, files: k.code.files, trusted: true, at: e.trusted, trustFile: file }); return 0; }
  say(`trusted kit ${k.name} (this version, ${e.hash.slice(0, 12)}…) in ${tildePath(file)}; reload the page to run it`);
  return 0;
}

/** A paragraph wrapped for the terminal. */
function wrap(text: string, width: number, indent = ''): string {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    if (line && (indent + line + ' ' + w).length > width) { out.push(indent + line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(indent + line);
  return out.join('\n');
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || (cmd !== 'docket' && (args.flags.help === true || args.flags.h === true))) { console.log(HELP); return 0; }
  switch (cmd) {
    case 'new': await cmdNew(); return 0;
    case 'validate': return cmdValidate();
    case 'info': await cmdInfo(); return 0;
    case 'components': await cmdComponents(); return 0;
    case 'component': return (await cmdComponent()) ?? 0;
    case 'kit': return cmdKit();
    case 'kits': return cmdKit('list');
    case 'stills': return cmdStills();
    case 'lint': return cmdLint();
    case 'serve': await cmdServe(); return 0;
    case 'build': return cmdBuild();
    case 'open': return cmdBuild(true);
    case 'artifact': case 'artifacts': return cmdArtifact();
    case 'docket': return cmdDocket();
    case 'view': await cmdView(); return 0;
    case 'jarvis': await cmdJarvis(); return 0;
    case 'stop': await cmdStop(); return 0;
    case 'status': await cmdStatus(); return 0;
    case 'model': await cmdModel(); return 0;
    case 'setup': return cmdSetup();
    case 'demo': case 'demos': return cmdDemo();
    case 'init': case 'refresh': case 'record': return cmdAdopt(cmd);
    default: throw new UserError(`unknown command "${cmd}" (karyo --help lists them)`);
  }
}

try {
  process.exitCode = await main();
} catch (e) {
  const user = e instanceof UserError;
  const msg = user ? e.message : `${(e as Error)?.stack ?? e}`;
  if (JSON_OUT) emit({ error: msg }); else console.error(termSafe(`karyo: ${msg}`));
  process.exitCode = 2;
}
