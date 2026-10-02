// The karyo CLI's plugin runtime: what a project needs to use Karyo from the Claude Code plugin (docs/PACKAGING.md).
//   karyo view [dir]      the project's web view (project.html) on a free local port; prints the URL
//   karyo jarvis [dir]    Jarvis mode (voice) for the project: the view plus the local Whisper + claude -p server
//   karyo stop [--all]    stop what view/jarvis started (this project's, or every one)
//   karyo setup           check bun/uv/python/Chrome and install the JS dependencies (and --jarvis's Python env) ahead of time
//   karyo model scan <package-dir>… | build   a model file (karyo.model.json) from the project's `# karyo:` directives
//
// Everything Karyo installs or writes for itself goes to its data dir, never into the project: the plugin's
// ${CLAUDE_PLUGIN_DATA} (~/.claude/plugins/data/karyo-<marketplace>/), which survives plugin updates. Commands run
// through Claude's Bash tool don't receive that variable, so it's also derived from where this checkout lives.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(realpathSync(import.meta.path)), '..');
const BUN = process.execPath;
/** Ports the plugin's servers use unless --port says otherwise (the dev checkout's `just dev` keeps 5180/5190). */
export const PORTS = { from: 5782, to: 5799 }   // never a port ending in 81 or 13;

export class RuntimeError extends Error {}

// ---------------------------------------------------------------- where things live

/** The plugin's persistent data dir, and how it was found. */
export function dataDir(): { dir: string; how: string } {
  const pick = (dir: string, how: string) => { mkdirSync(dir, { recursive: true }); return { dir, how }; };
  if (process.env.KARYO_DATA?.trim()) return pick(path.resolve(process.env.KARYO_DATA.trim()), '$KARYO_DATA');
  if (process.env.CLAUDE_PLUGIN_DATA?.trim()) return pick(path.resolve(process.env.CLAUDE_PLUGIN_DATA.trim()), '$CLAUDE_PLUGIN_DATA');
  // a marketplace install: <plugins root>/cache/<marketplace>/<plugin>/<version>/ → <plugins root>/data/<plugin>-<marketplace>/
  const m = ROOT.match(/^(.*)[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]([^\\/]+)$/);
  if (m && (existsSync(path.join(m[1]!, 'installed_plugins.json')) || existsSync(path.join(m[1]!, 'known_marketplaces.json')))) {
    const id = `${m[3]}@${m[2]}`.replace(/[^A-Za-z0-9_-]/g, '-');
    return pick(path.join(m[1]!, 'data', id), 'the plugin cache');
  }
  // loaded from its own folder (--plugin-dir, a dev checkout): Karyo's own home
  const home = process.env.KARYO_HOME?.trim() || path.join(os.homedir(), '.adenine/karyo');
  return pick(path.join(home, 'runtime'), 'not in a plugin cache (--plugin-dir or a checkout)');
}

/** An executable: $PATH first, then the usual install homes (Claude Desktop and fresh shells often lack them). */
export function which(name: string): string | null {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.bun/bin'), path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), '.cargo/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  for (const d of dirs) {
    if (!d) continue;
    const f = path.join(d, name);
    try { if (statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

const INSTALL_HINT: Record<string, string> = {
  bun: 'install bun: curl -fsSL https://bun.sh/install | bash   (https://bun.sh)',
  uv: 'install uv: curl -LsSf https://astral.sh/uv/install.sh | sh   (https://docs.astral.sh/uv/)',
  python3: 'install Python 3.12+ (e.g. `uv python install 3.12`, or python.org)',
};
export function need(name: string, why: string): string {
  const p = which(name);
  if (!p) throw new RuntimeError(`${why} needs ${name}, which isn't installed. ${INSTALL_HINT[name] ?? ''}`.trim());
  return p;
}

// ---------------------------------------------------------------- JS dependencies

const hasDeps = () => existsSync(path.join(ROOT, 'node_modules/vite/package.json')) && existsSync(path.join(ROOT, 'node_modules/three/package.json'));

/** Make sure <root>/node_modules has what the engine and the dev server need. A marketplace install normally has it
 *  already (Claude Code runs `bun install --frozen-lockfile --ignore-scripts` when it caches the plugin); otherwise
 *  install into the data dir, keyed by the lockfile, and link <root>/node_modules to it. Never touches the project. */
export function ensureDeps(log: (s: string) => void = (s) => console.error(s)): { installed: boolean; dir: string } {
  const nm = path.join(ROOT, 'node_modules');
  if (hasDeps()) return { installed: false, dir: realpathSync(nm) };
  const lock = ['bun.lock', 'bun.lockb'].map((f) => path.join(ROOT, f)).find(existsSync);
  const hash = createHash('sha256').update(readFileSync(path.join(ROOT, 'package.json'))).update(lock ? readFileSync(lock) : '').digest('hex').slice(0, 16);
  const dest = path.join(dataDir().dir, 'deps', hash);
  if (!existsSync(path.join(dest, 'node_modules/vite/package.json'))) {
    log(`karyo: first run: installing Karyo's JS dependencies into ${dest} (once per version; your project is untouched)…`);
    mkdirSync(dest, { recursive: true });
    copyFileSync(path.join(ROOT, 'package.json'), path.join(dest, 'package.json'));
    if (lock) copyFileSync(lock, path.join(dest, path.basename(lock)));
    const r = spawnSync(BUN, ['install', ...(lock ? ['--frozen-lockfile'] : []), '--ignore-scripts'], { cwd: dest, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (r.status !== 0) throw new RuntimeError(`bun install failed in ${dest}:\n${(r.stderr || r.stdout || '').trim()}`);
  }
  // link <root>/node_modules → the install (replacing a stale link, never a real folder)
  try {
    const st = lstatSync(nm);
    if (st.isSymbolicLink()) rmSync(nm);
    else throw new RuntimeError(`${nm} exists but lacks vite; run \`bun install\` in ${ROOT}`);
  } catch (e) { if (e instanceof RuntimeError) throw e; }
  try { symlinkSync(path.join(dest, 'node_modules'), nm, 'dir'); }
  catch (e) { throw new RuntimeError(`couldn't link ${nm} → ${dest}/node_modules: ${(e as Error).message}`); }
  if (!hasDeps()) throw new RuntimeError(`the dependencies in ${dest} are incomplete; delete that folder and rerun`);
  return { installed: true, dir: dest };
}

// ---------------------------------------------------------------- servers

type ServerRec = { kind: 'view' | 'jarvis'; project: string; port: number; pid: number; url: string; log: string; started: string };
const stateFile = () => path.join(dataDir().dir, 'servers.json');
function readState(): ServerRec[] { try { return JSON.parse(readFileSync(stateFile(), 'utf8')); } catch { return []; } }
function writeState(s: ServerRec[]) { writeFileSync(stateFile(), JSON.stringify(s, null, 2) + '\n'); }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function reachable(url: string) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.status < 500; } catch { return false; }
}
function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function freePort(avoid: number[] = []): Promise<number> {
  for (let p = PORTS.from; p <= PORTS.to; p++) {
    if (avoid.includes(p)) continue;
    if ((await portFree(p)) && !(await reachable(`http://localhost:${p}`))) return p;
  }
  throw new RuntimeError(`no free port in ${PORTS.from}–${PORTS.to}; pass --port, or \`karyo stop --all\``);
}

function startDetached(cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; log: string }): number {
  mkdirSync(path.dirname(o.log), { recursive: true });
  const fd = openSync(o.log, 'a');
  const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  return child.pid!;
}

/** The directory a command is about: the argument, else the enclosing git repo's top level, else the working dir. */
export function projectDir(arg?: string): string {
  if (arg) {
    const p = path.resolve(arg);
    if (!existsSync(p) || !statSync(p).isDirectory()) throw new RuntimeError(`not a directory: ${arg}`);
    return realpathSync(p);
  }
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' });
  return realpathSync(r.status === 0 && r.stdout.trim() ? r.stdout.trim() : process.cwd());
}

/** A running view server for the project (reused), or a new one. */
export async function viewServer(project: string, port?: number): Promise<ServerRec & { reused: boolean }> {
  const state = readState().filter((s) => alive(s.pid));
  const mine = state.find((s) => s.kind === 'view' && s.project === project && (!port || s.port === port));
  if (mine && (await reachable(`${mine.url}/__karyo/project`))) { writeState(state); return { ...mine, reused: true }; }
  ensureDeps();
  const data = dataDir().dir;
  const p = port ?? (await freePort(state.map((s) => s.port)));
  if (port && !(await portFree(port))) throw new RuntimeError(`port ${port} is taken`);
  const url = `http://localhost:${p}`;
  const log = path.join(data, 'logs', `view-${p}.log`);
  const pid = startDetached(BUN, ['x', 'vite', '--port', String(p), '--strictPort'], {
    cwd: ROOT, log,
    env: { ...process.env, KARYO_PROJECT: project, KARYO_VITE_CACHE: path.join(data, 'vite-cache') },
  });
  for (let i = 0; i < 300 && !(await reachable(`${url}/__karyo/project`)); i++) {
    if (!alive(pid)) break;
    await Bun.sleep(100);
  }
  if (!(await reachable(`${url}/__karyo/project`))) {
    try { process.kill(pid); } catch {}
    const tail = existsSync(log) ? readFileSync(log, 'utf8').split('\n').slice(-15).join('\n') : '';
    throw new RuntimeError(`the view server didn't start on ${url} (log: ${log})\n${tail}`);
  }
  const rec: ServerRec = { kind: 'view', project, port: p, pid, url, log, started: new Date().toISOString() };
  writeState([...state, rec]);
  return { ...rec, reused: false };
}

export function stopServers(project: string | null): ServerRec[] {
  const state = readState();
  const hit = state.filter((s) => project === null || s.project === project);
  for (const s of hit) {
    if (!alive(s.pid)) continue;
    try { process.kill(-s.pid, 'SIGTERM'); } catch { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
  }
  writeState(state.filter((s) => !hit.includes(s) && alive(s.pid)));
  return hit;
}

export function listServers(): ServerRec[] {
  const state = readState().filter((s) => alive(s.pid));
  writeState(state);
  return state;
}

// ---------------------------------------------------------------- jarvis

/** Jarvis's Python env (openai-whisper, torch: large on first run) in the data dir. */
export function jarvisEnv(log: (s: string) => void = (s) => console.error(s)): NodeJS.ProcessEnv {
  const uv = need('uv', 'Jarvis mode');
  const data = dataDir().dir;
  const env = { ...process.env, UV_PROJECT_ENVIRONMENT: path.join(data, 'venv/jarvis'), PYTHONPATH: path.join(ROOT, 'integrations/jarvis'),
    PYTHONPYCACHEPREFIX: path.join(data, 'pycache'), KARYO_WHISPER_MODELS: path.join(data, 'whisper') };
  if (!existsSync(path.join(data, 'venv/jarvis/pyvenv.cfg'))) log(`karyo: first run: installing Jarvis's Python env into ${path.join(data, 'venv/jarvis')} (openai-whisper and torch; a few minutes)…`);
  const r = spawnSync(uv, ['sync', '--quiet', '--frozen', '--project', path.join(ROOT, 'integrations/jarvis')], { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) throw new RuntimeError(`uv sync failed for Jarvis:\n${(r.stderr || r.stdout || '').trim()}`);
  return env;
}

export async function jarvisServer(project: string, viewPort: number, port?: number, extra: string[] = []): Promise<ServerRec & { reused: boolean }> {
  const state = readState().filter((s) => alive(s.pid));
  const mine = state.find((s) => s.kind === 'jarvis' && s.project === project);
  if (mine && (await reachable(`${mine.url}/health`))) return { ...mine, reused: true };
  const env = jarvisEnv();
  const uv = need('uv', 'Jarvis mode');
  const p = port ?? (await freePort([viewPort, ...state.map((s) => s.port)]));
  const url = `http://127.0.0.1:${p}`;
  const log = path.join(dataDir().dir, 'logs', `jarvis-${p}.log`);
  const pid = startDetached(uv, ['run', '--quiet', '--frozen', '--no-sync', '--project', path.join(ROOT, 'integrations/jarvis'),
    'python', '-m', 'jarvis', 'serve', '--port', String(p), '--project', project, ...extra], {
    cwd: project, log, env: { ...env, KARYO_JARVIS_PAGE: `http://localhost:${viewPort}/jarvis.html` },
  });
  for (let i = 0; i < 600 && !(await reachable(`${url}/health`)); i++) {
    if (!alive(pid)) break;
    await Bun.sleep(100);
  }
  if (!(await reachable(`${url}/health`))) {
    try { process.kill(pid); } catch {}
    const tail = existsSync(log) ? readFileSync(log, 'utf8').split('\n').slice(-15).join('\n') : '';
    throw new RuntimeError(`Jarvis didn't start on ${url} (log: ${log})\n${tail}`);
  }
  const rec: ServerRec = { kind: 'jarvis', project, port: p, pid, url, log, started: new Date().toISOString() };
  writeState([...state, rec]);
  return { ...rec, reused: false };
}

/** The MCP server's Python env (mcp, pillow), as scripts/plugin/karyo-mcp.sh makes it on its first start; `karyo setup`
 *  makes it ahead of time so that first start doesn't race Claude Code's connection timeout. */
export function mcpEnv(log: (s: string) => void = (s) => console.error(s)): string {
  const uv = need('uv', 'The Karyo MCP server');
  const venv = path.join(dataDir().dir, 'venv/mcp');
  if (!existsSync(path.join(venv, 'pyvenv.cfg'))) log(`karyo: installing the MCP server's Python env into ${venv}…`);
  const r = spawnSync(uv, ['sync', '--quiet', '--frozen', '--no-install-project', '--project', path.join(ROOT, 'integrations/mcp')],
    { env: { ...process.env, UV_PROJECT_ENVIRONMENT: venv }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) throw new RuntimeError(`uv sync failed for the MCP server:\n${(r.stderr || r.stdout || '').trim()}`);
  return venv;
}

// ---------------------------------------------------------------- models from directives

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '__pycache__', '.karyo', 'out', 'target']);

/** Python packages in a project: top-level folders (or src/*) with an __init__.py, holding a `# karyo:` directive. */
export function pythonPackages(project: string): string[] {
  const out: string[] = [];
  const bases = [project, path.join(project, 'src')].filter((d) => existsSync(d));
  for (const base of bases) {
    for (const name of readdirSync(base)) {
      if (SKIP.has(name) || name.startsWith('.')) continue;
      const d = path.join(base, name);
      try { if (!statSync(d).isDirectory() || !existsSync(path.join(d, '__init__.py'))) continue; } catch { continue; }
      if (hasDirective(d)) out.push(d);
    }
  }
  return out;
}
function hasDirective(dir: string, depth = 0): boolean {
  if (depth > 6) return false;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const f = path.join(dir, name);
    let st; try { st = statSync(f); } catch { continue; }
    if (st.isDirectory()) { if (hasDirective(f, depth + 1)) return true; }
    else if (name.endsWith('.py') && /#\s*karyo:/.test(readFileSync(f, 'utf8'))) return true;
  }
  return false;
}

/** Scan Python packages' directives (sdk/python, standard library only) into <project>/.karyo/, then build the model. */
/** Scan Python packages into .karyo/ and build the model. `auto`: automatic mode with the directives on top (true),
 *  directives only (false); undefined: the project's karyo/config.json mode when it has one, else the SDK's default
 *  (automatic mode only for code with no directives). */
export function modelScan(project: string, pkgs: string[], out: string, name: string, log: (s: string) => void, o: { auto?: boolean } = {}): { fragments: string[]; model: string; output: string } {
  const py = need('python3', 'scanning Python directives');
  let auto = o.auto;
  if (auto === undefined) {
    try { const mode = JSON.parse(readFileSync(path.join(project, 'karyo/config.json'), 'utf8'))?.mode; if (mode === 'auto' || mode === 'directives') auto = mode === 'auto'; } catch {}
  }
  const mode = auto === undefined ? [] : [auto ? '--auto' : '--no-auto'];
  const frags = path.join(project, '.karyo');
  mkdirSync(frags, { recursive: true });
  const written: string[] = [];
  let output = '';
  for (const pkg of pkgs) {
    const abs = path.resolve(project, pkg);
    const f = path.join(frags, `python.${path.basename(abs)}.static.karyo.json`);
    const r = spawnSync(py, ['-m', 'karyo', 'scan', abs, '-o', f, '--root', project, ...mode], {
      cwd: project, encoding: 'utf8', env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(dataDir().dir, 'pycache'), PYTHONPATH: [path.join(ROOT, 'sdk/python'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    });
    output += (r.stdout ?? '') + (r.stderr ?? '');
    if (r.status !== 0) throw new RuntimeError(`scanning ${pkg} failed:\n${(r.stderr || r.stdout || '').trim()}`);
    log(`scanned ${path.relative(project, abs) || '.'} → ${path.relative(project, f)}`);
    written.push(f);
  }
  const b = modelBuild(project, out, name);
  return { fragments: written, model: b.model, output: output + b.output };
}

export function modelBuild(project: string, out: string, name: string): { model: string; output: string } {
  const frags = path.join(project, '.karyo');
  const files = existsSync(frags) ? readdirSync(frags).filter((f) => f.endsWith('.karyo.json')).map((f) => path.join(frags, f)) : [];
  if (!files.length) throw new RuntimeError(`no fragments in ${frags}; run \`karyo model scan <package-dir>\` (or an SDK's record) first`);
  ensureDeps();
  const model = path.resolve(project, out);
  const tours = existsSync(path.join(project, 'tours')) ? ['--tours', 'tours/*.tour.json'] : [];
  const r = spawnSync(BUN, [path.join(ROOT, 'scripts/model.ts'), 'build', ...files, '-o', model, '--project', name, '--root', project, ...tours], { cwd: project, encoding: 'utf8' });
  if (r.status !== 0) throw new RuntimeError(`building the model failed:\n${(r.stderr || r.stdout || '').trim()}`);
  return { model, output: (r.stdout ?? '') + (r.stderr ?? '') };
}

// ---------------------------------------------------------------- setup / doctor

export function chromePath(): string | null {
  const c = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return c.find((p) => p && existsSync(p)) ?? null;
}

export function doctor(): Record<string, unknown> {
  const ver = (bin: string | null, args = ['--version']) => (bin ? (spawnSync(bin, args, { encoding: 'utf8' }).stdout ?? '').trim().split('\n')[0] : null);
  const d = dataDir();
  let manifest: any = {};
  try { manifest = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8')); } catch {}
  return {
    version: manifest.version ?? null,
    root: ROOT,
    data: d.dir,
    dataFrom: d.how,
    bun: { path: which('bun'), version: ver(which('bun')) },
    uv: { path: which('uv'), version: ver(which('uv')) },
    python3: { path: which('python3'), version: ver(which('python3')) },
    chrome: chromePath(),
    jsDeps: hasDeps(),
    mcpEnv: existsSync(path.join(d.dir, 'venv/mcp/pyvenv.cfg')),
    jarvisEnv: existsSync(path.join(d.dir, 'venv/jarvis/pyvenv.cfg')),
    whisperModel: existsSync(path.join(d.dir, 'whisper')) ? readdirSync(path.join(d.dir, 'whisper')).filter((f) => f.endsWith('.pt')) : [],
    servers: listServers(),
  };
}
