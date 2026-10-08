// The adoption commands of the karyo CLI (docs/ADOPT.md), called from cli/karyo.ts:
//   karyo init [dir]      set a project up for Karyo (src/cli/init.ts plans it; this asks, applies, summarizes)
//   karyo refresh [dir]   re-scan the code (in karyo/config.json's mode: automatic mode with the directives refining its
//                         nodes, or directives only; `// karyo:` markers in a Swift project, src/cli/markers.ts) and rebuild
//                         karyo.model.json; what the recipes, the hooks and the karyo-adopt skill run
//   karyo record [dir] [-- cmd]   run the tests (or cmd) once under the sys.monitoring recorder, then rebuild
// Scans and records use the plugin's own copy of the Python SDK (sdk/python on PYTHONPATH): the project installs nothing.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import {
  CONFIG, HOOK_KINDS, LAUNCHER, RECOMMENDED_HOOK, SCAN_MODES, applyChanges, describeChange, describeDetection, detect, markerLanguages, planInit, planRemove,
  pythonPackages, scanMode, shellCommand, type Change, type HookKind, type ScanMode,
} from './init';
import { scanMarkers, sourceFiles } from './markers';

class AdoptError extends Error {}
export { AdoptError };

type Flags = Record<string, string | true>;
interface Parsed { pos: string[]; flags: Flags; rest: string[] | null }
const VALUED = new Set(['hook', 'sample', 'project', 'name', 'mode']);

export function parse(argv: string[]): Parsed {
  const p: Parsed = { pos: [], flags: {}, rest: null };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i]!;
    if (s === '--') { p.rest = argv.slice(i + 1); break; }
    if (s.startsWith('-') && s.length > 1) {
      let k = s.replace(/^--?/, ''), v: string | true = true;
      const eq = k.indexOf('=');
      if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
      else if (VALUED.has(k) && i + 1 < argv.length) v = argv[++i]!;
      if (k === 'y') k = 'yes';
      p.flags[k] = v;
    } else p.pos.push(s);
  }
  return p;
}

interface Ctx { root: string; json: boolean; say: (s?: string) => void; err: (s: string) => void }

// ---------------------------------------------------------------- shared

async function runtime(root: string): Promise<any> { return import(path.join(root, 'scripts/karyo-runtime.ts')); }

/** The project: the argument; else the nearest folder up from here with Karyo's launcher; else the git repo; else here. */
function projectFor(arg: string | undefined): string {
  if (arg) {
    const p = path.resolve(arg);
    if (!existsSync(p) || !statSync(p).isDirectory()) throw new AdoptError(`not a directory: ${arg}`);
    return p;
  }
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, LAUNCHER))) return d;
    if (path.dirname(d) === d) break;
  }
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : process.cwd();
}

/** Remember which Karyo ran here, so the launcher (and so the hooks) find it without a path in any committed file. */
function rememberCli(dir: string, root: string) {
  const f = path.join(dir, '.karyo', 'cli-path');
  const cli = path.join(root, 'cli', 'karyo');
  try {
    if (existsSync(f) && readFileSync(f, 'utf8').trim() === cli) return;
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, cli + '\n');
  } catch {}
}

function version(root: string): string {
  try { return JSON.parse(readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; }
}

async function ask(q: string): Promise<string> {
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(q).catch(() => '')).trim().toLowerCase();
  rl.close();
  return a;
}

function parseHooks(v: string | true | undefined): HookKind[] | undefined {
  if (v === undefined) return undefined;
  if (v === true) throw new AdoptError(`--hook takes ${HOOK_KINDS.join(', ')}, a comma list, or none`);
  const alias: Record<string, HookKind> = { claude: 'stop', 'post-commit': 'git' };
  const list = v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length === 1 && list[0] === 'none') return [];
  return [...new Set(list.map((s) => {
    const k = (alias[s] ?? s) as HookKind;
    if (!HOOK_KINDS.includes(k)) throw new AdoptError(`unknown hook "${s}" (have: ${HOOK_KINDS.join(', ')}, none)`);
    return k;
  }))];
}

function parseMode(v: string | true | undefined): ScanMode | undefined {
  if (v === undefined) return undefined;
  const m = v === true ? '' : v.trim().toLowerCase();
  const alias: Record<string, ScanMode> = { automatic: 'auto', directive: 'directives', 'directives-only': 'directives' };
  const k = (alias[m] ?? m) as ScanMode;
  if (!SCAN_MODES.includes(k)) throw new AdoptError(`--mode takes ${SCAN_MODES.join(' or ')} (auto: every class and public function a node, directives refining theirs; directives: only what directives declare)`);
  return k;
}

/** The mode a refresh or recording reads the Python code in, and what to say about it: a project with directives whose
 *  settings don't say (adopted before karyo/config.json) is read in automatic mode now, with the directives on top. */
function modeFor(dir: string, directives: () => boolean): { auto: boolean; note: string | null } {
  const m = scanMode(dir);
  const note = m.problem ? `note: ${m.problem}`
    : m.from === 'default' && directives() ? `note: automatic mode, with the \`# karyo:\` directives refining the nodes of the defs they sit on (${CONFIG} doesn't say; before, directives switched automatic mode off). \`karyo init --mode directives\` reads directives only; \`karyo init\` records the choice`
      : null;
  return { auto: m.mode === 'auto', note };
}

export const HOOK_WORDS: Record<HookKind | 'none', string> = {
  stop: 'Claude Code Stop hook: after each Claude turn that changed code, re-scan in the background (recommended: one scan per turn, and it follows the edits Claude makes)',
  edit: 'Claude Code PostToolUse hook on Edit|Write|MultiEdit: re-scan after every file edit (debounced; more scans, fresher mid-turn)',
  git: 'git post-commit hook: re-scan after each commit, whoever or whatever made it (this clone only)',
  none: 'none: run `karyo/karyo.sh refresh` (or `just karyo-scan`) yourself',
};

// ---------------------------------------------------------------- init

async function cmdInit(p: Parsed, c: Ctx): Promise<number> {
  const dir = projectFor(p.pos[0]);
  const d = detect(dir);
  const tty = !!process.stdin.isTTY && !c.json;
  const yes = p.flags.yes === true;

  if (p.flags.remove === true) {
    const plan = planRemove(d, { purge: p.flags.purge === true });
    return finish(plan, dir, c, { dry: p.flags['dry-run'] === true, yes, tty, title: 'remove Karyo from this project', detection: d });
  }

  if (!c.json) { for (const l of describeDetection(d)) c.say(l); c.say(''); }
  let hooks = parseHooks(p.flags.hook);
  if (hooks === undefined && tty && !yes && !d.installed.hooks.length && p.flags['dry-run'] !== true) {
    c.say('Keep the model current automatically? A refresh hook re-scans after changes (installed in this project only):');
    const opts: (HookKind | 'none')[] = ['stop', 'edit', 'git', 'none'];
    opts.forEach((k, i) => c.say(`  ${i + 1}. ${HOOK_WORDS[k]}`));
    const a = await ask(`Pick 1-4 [4, none; ${RECOMMENDED_HOOK === 'stop' ? '1' : ''} is recommended]: `);
    const k = opts[Number(a) - 1];
    hooks = !k || k === 'none' ? [] : [k];
  }
  let ci: boolean | undefined = p.flags.ci === true ? true : p.flags['no-ci'] === true ? false : undefined;
  if (ci === undefined && tty && !yes && d.ci.github && !d.installed.ci && d.python.packages.length && p.flags['dry-run'] !== true) {
    ci = ['y', 'yes'].includes(await ask('Add a CI workflow (.github/workflows/karyo.yml: check-prod, the inert check, plus a model build)? [y/N] '));
  }
  const plan = planInit(d, {
    hooks, ci, recipes: p.flags['no-recipes'] === true ? false : undefined,
    commitModel: p.flags['commit-model'] === true ? true : p.flags['no-commit-model'] === true ? false : undefined,
    version: version(c.root), mode: parseMode(p.flags.mode),
  });
  const code = await finish(plan, dir, c, { dry: p.flags['dry-run'] === true, yes, tty, title: 'set up Karyo', detection: d });
  if (code === 0 && p.flags['dry-run'] !== true && (yes || tty)) rememberCli(dir, c.root);
  return code;
}

/** Show the plan; unless it's a dry run (or nobody can say yes), ask, apply, run, and summarize what changed. */
async function finish(plan: Change[], dir: string, c: Ctx, o: { dry: boolean; yes: boolean; tty: boolean; title: string; detection: unknown }): Promise<number> {
  const pending = plan.filter((x) => x.action === 'create' || x.action === 'update' || x.action === 'remove' || x.action === 'run');
  const show = (x: Change) => {
    c.say(describeChange(x));
    if (x.preview && !c.json) for (const l of x.preview.split('\n')) c.say(`        │ ${l}`);
  };
  if (!c.json) { c.say(`Plan (${o.title}):`); for (const x of plan) show(x); }
  if (!pending.length) {
    if (c.json) c.say(JSON.stringify({ dir, detection: o.detection, plan, applied: [], changed: false }, null, 2));
    else c.say('\nnothing to change: the project is already set up this way');
    return 0;
  }
  if (o.dry || (!o.yes && !o.tty)) {
    if (c.json) c.say(JSON.stringify({ dir, detection: o.detection, plan, applied: [], changed: false, dryRun: true }, null, 2));
    else c.say(`\ndry run: nothing written${o.dry ? '' : ' (no terminal to ask; pass --yes to apply)'}`);
    return 0;
  }
  if (!o.yes && !['y', 'yes'].includes(await ask(`\nApply these ${pending.length} change(s)? [y/N] `))) { c.say('nothing written'); return 1; }
  const done = applyChanges(dir, plan);
  const ran: Change[] = [];
  for (const x of plan.filter((x) => x.action === 'run' && x.command)) {
    const r = spawnSync(x.command![0]!, x.command!.slice(1), { cwd: dir, stdio: c.json ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    if (r.status !== 0) c.err(`karyo: \`${shellCommand(x.command!)}\` failed (exit ${r.status}); add the dependency yourself`);
    else ran.push(x);
  }
  const all = [...done, ...ran];
  if (c.json) c.say(JSON.stringify({ dir, detection: o.detection, plan, applied: all.map(({ content, ...x }) => x), changed: all.length > 0 }, null, 2));
  else {
    c.say(`\nChanged (${all.length}):`);
    for (const x of all) c.say(`  ${describeChange({ ...x, preview: undefined })}`);
  }
  return 0;
}

// ---------------------------------------------------------------- refresh

interface Summary {
  model: string; nodes: number; edges: number; flows: number; folded: number;
  checks: Record<string, number>; unresolved: string[]; invalid: string[];
  drift: { seenNotInCode: number; notExercised: number; exercised: number; coverage: string | null };
}

export function summarize(modelFile: string): Summary {
  const m = JSON.parse(readFileSync(modelFile, 'utf8'));
  const nodes: any[] = (m.nodes ?? []).filter((n: any) => n.kind !== 'module');
  const checks: Record<string, number> = {};
  for (const k of m.checks ?? []) checks[k.code] = (checks[k.code] ?? 0) + 1;
  const msgs = (code: string) => (m.checks ?? []).filter((k: any) => k.code === code).map((k: any) => String(k.message));
  return {
    model: modelFile, nodes: nodes.length, edges: (m.edges ?? []).filter((e: any) => e.kind !== 'imports').length, flows: (m.flows ?? []).length,
    folded: nodes.filter((n) => n.fold).length, checks, unresolved: msgs('curation-unresolved'), invalid: msgs('curation-invalid'),
    drift: {
      seenNotInCode: checks['undeclared-call'] ?? 0,
      notExercised: nodes.filter((n) => n.exercised === false).length,
      exercised: nodes.filter((n) => n.exercised === true).length,
      coverage: msgs('coverage')[0] ?? null,
    },
  };
}

/** A compact outline of the model for proposing a curation: groups, then each card with what it folds. */
export function outline(modelFile: string, max = 400): string[] {
  const m = JSON.parse(readFileSync(modelFile, 'utf8'));
  const nodes: any[] = (m.nodes ?? []).filter((n: any) => n.kind !== 'module');
  const deg = new Map<string, { in: number; out: number }>();
  for (const e of m.edges ?? []) {
    if (e.kind === 'imports') continue;
    const a = deg.get(e.from) ?? { in: 0, out: 0 }, b = deg.get(e.to) ?? { in: 0, out: 0 };
    a.out++; b.in++; deg.set(e.from, a); deg.set(e.to, b);
  }
  const kids = new Map<string, any[]>();
  for (const n of nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const mark = (n: any) => (n.exercised === false ? ' not-exercised' : n.exercised === true ? ' ran' : '');
  const line = (n: any, ind: string) => {
    const g = deg.get(n.id) ?? { in: 0, out: 0 };
    return `${ind}${n.id}  ${n.kind}${n.category ? ` [${n.category}]` : ''}${n.label && n.label !== n.id.split('.').pop() ? ` "${n.label}"` : ''}  in ${g.in} out ${g.out}${mark(n)}${n.summary ? `  — ${String(n.summary).slice(0, 80)}` : ''}`;
  };
  const groups = new Map<string, any[]>();
  for (const n of nodes) if (!n.parent || !nodes.some((p) => p.id === n.parent)) groups.set(n.group ?? '(no group)', [...(groups.get(n.group ?? '(no group)') ?? []), n]);
  const out: string[] = [];
  const glabel = new Map<string, string>((m.groups ?? []).map((g: any) => [g.id, g.label ?? g.id]));
  for (const [g, list] of [...groups].sort()) {
    out.push(`group ${g}${glabel.get(g) && glabel.get(g) !== g ? ` "${glabel.get(g)}"` : ''} (${list.length})`);
    for (const n of list.sort((a, b) => a.id.localeCompare(b.id))) {
      out.push(line(n, '  '));
      for (const k of (kids.get(n.id) ?? []).sort((a, b) => a.id.localeCompare(b.id))) out.push(line(k, `    ${k.fold ? '⊂ ' : '↳ '}`));
    }
  }
  return out.length > max ? [...out.slice(0, max), `… ${out.length - max} more line(s): read ${path.basename(modelFile)} for the rest`] : out;
}

function newestPy(dir: string, depth = 0): number {
  let t = 0;
  if (depth > 8) return t;
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return t; }
  for (const n of names) {
    if (n.startsWith('.') || n === '__pycache__' || n === 'node_modules') continue;
    const f = path.join(dir, n);
    let st; try { st = statSync(f); } catch { continue; }
    if (st.isDirectory()) t = Math.max(t, newestPy(f, depth + 1));
    else if (n.endsWith('.py')) t = Math.max(t, st.mtimeMs);
  }
  return t;
}
const mtime = (f: string) => { try { return statSync(f).mtimeMs; } catch { return 0; } };

/** Is the model older than the code, the curation, or a recorded fragment? `files`: other sources (marker languages). */
export function isStale(dir: string, pkgs: string[], files: string[] = []): boolean {
  const model = mtime(path.join(dir, 'karyo.model.json'));
  if (!model) return true;
  const frags = path.join(dir, '.karyo');
  let newest = Math.max(mtime(path.join(dir, 'karyo/curation.json')), mtime(path.join(dir, CONFIG)), ...pkgs.map((p) => newestPy(path.join(dir, p))), ...files.map((f) => mtime(path.join(dir, f))));
  try { for (const f of readdirSync(frags)) if (f.endsWith('.karyo.json') && !f.includes('.static.')) newest = Math.max(newest, mtime(path.join(frags, f))); } catch {}
  return newest > model;
}

/** One refresh at a time per project: a second one while it runs leaves a note (refresh.pending), and the first runs
 *  once more when it ends. A lock whose process is gone, or older than 10 minutes, is taken over. */
function lock(dir: string): (() => void) | null {
  const f = path.join(dir, '.karyo', 'refresh.lock');
  mkdirSync(path.dirname(f), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(f, 'wx');
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      return () => rmSync(f, { force: true });
    } catch {
      const [pid] = (existsSync(f) ? readFileSync(f, 'utf8') : '').split(' ');
      const alive = (() => { try { process.kill(Number(pid), 0); return true; } catch { return false; } })();
      if (alive && Date.now() - mtime(f) < 10 * 60_000) return null;
      rmSync(f, { force: true });
    }
  }
  return null;
}
function takePending(dir: string): boolean {
  const f = path.join(dir, '.karyo', 'refresh.pending');
  if (!existsSync(f)) return false;
  rmSync(f, { force: true });
  return true;
}

async function refreshOnce(dir: string, c: Ctx, quiet: boolean): Promise<Summary> {
  const rt = await runtime(c.root);
  const pkgs = pythonPackages(dir);
  const frags = path.join(dir, '.karyo');
  // fragments of packages that are gone would keep drawing them
  const keep = new Set(pkgs.map((p) => `python.${path.basename(p)}.static.karyo.json`));
  try { for (const f of readdirSync(frags)) if (/^python\..+\.static\.karyo\.json$/.test(f) && !keep.has(f)) rmSync(path.join(frags, f)); } catch {}
  const name = path.basename(dir);
  const log = quiet ? () => {} : c.json ? c.err : c.say;
  // `// karyo:` markers (a Swift project): one fragment for all of them, read in-process
  const langs = markerLanguages(dir);
  const markerFrag = path.join(frags, 'markers.static.karyo.json');
  if (langs.length) {
    const s = scanMarkers(dir, { langs, version: version(c.root), at: new Date().toISOString() });
    mkdirSync(frags, { recursive: true });
    writeFileSync(markerFrag, JSON.stringify(s.fragment, null, 1) + '\n');
    const exts = langs.flatMap((l) => l.exts).join(', ');
    log(`read ${s.files} ${exts} file(s): ${s.markers} marker(s) → .karyo/markers.static.karyo.json`);
    for (const k of s.fragment.checks ?? []) log(`${k.code}: ${k.message}`);
    if (!s.markers) log('no markers yet: Claude writes `// karyo:node` markers above the parts that matter (the karyo-adopt skill), then refresh again');
  } else rmSync(markerFrag, { force: true });
  try {
    let auto = true;
    if (pkgs.length) {
      const m = modeFor(dir, () => detectsDirectives(dir, pkgs));
      auto = m.auto;
      if (m.note) log(m.note);
    }
    const res = pkgs.length
      ? rt.modelScan(dir, pkgs.map((p) => path.join(dir, p)), 'karyo.model.json', name, log, { auto })
      : rt.modelBuild(dir, 'karyo.model.json', name);
    if (!quiet && res.output?.trim()) log(res.output.trim());
  } catch (e) {
    if (e instanceof rt.RuntimeError) throw new AdoptError((e as Error).message);
    throw e;
  }
  return summarize(path.join(dir, 'karyo.model.json'));
}

/** Does any module of these packages carry a `# karyo:` directive or `@karyo.node` (what used to switch automatic mode off)? */
function detectsDirectives(dir: string, pkgs: string[]): boolean {
  const re = /^[ \t]*#\s?karyo:(?:node|span|external|edge)\b|\bkaryo\.node\(/m;
  const walk = (d: string, depth = 0): boolean => {
    if (depth > 8) return false;
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return false; }
    for (const n of names) {
      if (n.startsWith('.') || n === '__pycache__' || n === 'node_modules') continue;
      const f = path.join(d, n);
      let st; try { st = statSync(f); } catch { continue; }
      if (st.isDirectory()) { if (walk(f, depth + 1)) return true; }
      else if (n.endsWith('.py')) { try { if (re.test(readFileSync(f, 'utf8'))) return true; } catch {} }
    }
    return false;
  };
  return pkgs.some((p) => walk(path.join(dir, p)));
}

function report(s: Summary, c: Ctx) {
  c.say(`karyo.model.json: ${s.nodes} node(s) (${s.folded} folded into their type), ${s.edges} relationship(s), ${s.flows} recorded flow(s)`);
  if (s.drift.coverage) c.say(`coverage: ${s.drift.coverage}`);
  if (s.drift.seenNotInCode) c.say(`seen, not in the code: ${s.drift.seenNotInCode} call(s) a recorded run made that static analysis doesn't find (dynamic calls, or a stale recording: \`karyo record\` again)`);
  if (s.drift.notExercised) c.say(`not exercised: ${s.drift.notExercised} node(s) the recorded run never ran`);
  for (const u of s.unresolved) c.say(`curation-unresolved: ${u}`);
  for (const u of s.invalid) c.say(`curation-invalid: ${u}`);
  const other = Object.entries(s.checks).filter(([k]) => !['curation-unresolved', 'curation-invalid', 'undeclared-call', 'coverage'].includes(k));
  if (other.length) c.say(`other checks: ${other.map(([k, n]) => `${k} ${n}`).join(', ')}`);
}

async function cmdRefresh(p: Parsed, c: Ctx): Promise<number> {
  const hook = p.flags.hook === true;
  const dir = projectFor(p.pos[0]);
  const quiet = hook || p.flags.quiet === true;
  const ifStale = hook || p.flags['if-stale'] === true;
  if (hook) {
    // a hook never fails or talks: its output goes to .karyo/refresh.log
    mkdirSync(path.join(dir, '.karyo'), { recursive: true });
    const logFile = path.join(dir, '.karyo', 'refresh.log');
    // the last 200 lines are kept
    const line = (s = '') => {
      try {
        const old = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-199) : [];
        writeFileSync(logFile, [...old, `${new Date().toISOString()} ${s}`].join('\n') + '\n');
      } catch {}
    };
    c = { ...c, say: line, err: line, json: false };
  }
  rememberCli(dir, c.root);
  const pkgs = pythonPackages(dir);
  const langs = markerLanguages(dir);
  const markerFiles = langs.length ? sourceFiles(dir, langs) : [];
  const l = lock(dir);
  if (!l) {
    writeFileSync(path.join(dir, '.karyo', 'refresh.pending'), `${new Date().toISOString()}\n`);
    if (hook) { c.say('refresh already running: it will run once more when it ends'); return 0; }
    throw new AdoptError(`a refresh is already running for ${dir} (.karyo/refresh.lock); it runs once more when it ends`);
  }
  let s: Summary | null = null;
  const model = path.join(dir, 'karyo.model.json');
  try {
    let rounds = 0;
    do {
      if (ifStale && existsSync(model) && !isStale(dir, pkgs, markerFiles)) {
        s = summarize(model);
        if (hook) c.say('the model is current: nothing to do');
      } else {
        s = await refreshOnce(dir, c, quiet);
        if (hook) c.say(`refreshed: ${s.nodes} nodes, ${s.edges} relationships, ${s.unresolved.length} unresolved curation entr${s.unresolved.length === 1 ? 'y' : 'ies'}`);
      }
    } while (takePending(dir) && ++rounds < 3);
  } catch (e) {
    if (hook) { c.say(`refresh failed: ${(e as Error).message}`); return 0; }
    throw e;
  } finally { l(); }
  if (!s) throw new AdoptError('no model built');
  const out = { dir, ...s, ...(p.flags.outline === true ? { outline: outline(s.model) } : {}) };
  if (c.json) c.say(JSON.stringify(out, null, 2));
  else if (!hook) {
    report(s, c);
    if (p.flags.outline === true) { c.say(''); for (const x of out.outline!) c.say(x); }
  }
  if (p.flags.check === true && (s.unresolved.length || s.invalid.length)) {
    if (!c.json) c.err(`karyo refresh --check: ${s.unresolved.length + s.invalid.length} curation entr${s.unresolved.length + s.invalid.length === 1 ? 'y no longer matches' : 'ies no longer match'} the code; update karyo/curation.json`);
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------- record

async function cmdRecord(p: Parsed, c: Ctx): Promise<number> {
  const dir = projectFor(p.pos[0]);
  const d = detect(dir);
  const cmd = p.rest?.length ? p.rest : d.testCommand;
  if (!cmd) throw new AdoptError('no test command found; give one: karyo record -- <command …>');
  if (!d.python.packages.length) throw new AdoptError(`no Python package in ${dir} to record`);
  const rt = await runtime(c.root);
  const py = rt.need('python3', 'recording');
  rememberCli(dir, c.root);
  const out = path.join(dir, '.karyo');
  mkdirSync(out, { recursive: true });
  // a new recording replaces the last one (--keep adds to it): a stale run would read as drift
  if (p.flags.keep !== true) for (const f of readdirSync(out)) if (/^python-\d+\.karyo\.json$/.test(f)) rmSync(path.join(out, f));
  const mods = d.python.packages.map((x) => path.basename(x));
  const mode = modeFor(dir, () => d.python.directives);
  if (mode.note && !c.json) c.say(mode.note);
  const args = ['-m', 'karyo', 'record', '--monitor', mode.auto ? '--auto' : '--no-auto', '--package', mods.join(','), '--root', dir, '--out', out, '--project', path.basename(dir),
    ...(typeof p.flags.sample === 'string' ? ['--sample', p.flags.sample] : []), '--', ...cmd];
  if (!c.json) c.say(`recording: ${shellCommand(cmd)}  (sys.monitoring, packages ${mods.join(', ')})`);
  const sdk = path.join(c.root, 'sdk/python');
  const r = spawnSync(py, args, {
    cwd: dir, stdio: c.json ? ['inherit', 2, 'inherit'] : 'inherit',
    env: { ...process.env, PYTHONPATH: [sdk, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
  });
  const recorded = existsSync(out) && readdirSync(out).some((f) => /^python-\d+\.karyo\.json$/.test(f));
  if (!recorded) throw new AdoptError(`the recording wrote no fragment (the command exited ${r.status}); is it a Python command, on Python 3.12+?`);
  const s = await refreshOnce(dir, c, true);
  if (c.json) c.say(JSON.stringify({ dir, command: cmd, exit: r.status, ...s }, null, 2));
  else {
    if (r.status !== 0) c.say(`note: the command exited ${r.status}; what ran is recorded all the same`);
    report(s, c);
  }
  return r.status === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- entry

export async function run(cmd: string, argv: string[], root: string): Promise<number> {
  const p = parse(argv);
  const json = p.flags.json === true;
  const c: Ctx = { root, json, say: (s = '') => console.log(s), err: (s) => console.error(s) };
  if (cmd === 'init') return cmdInit(p, c);
  if (cmd === 'refresh') return cmdRefresh(p, c);
  if (cmd === 'record') return cmdRecord(p, c);
  throw new AdoptError(`unknown command ${cmd}`);
}
