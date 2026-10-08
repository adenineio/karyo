// The docket on disk: where it lives, which repo it belongs to, who is writing, and how a change lands
// (home-wide lock → read → change → atomic write → commit in the home repo). The pure parts are in format.ts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyDocket, format, parse, type Docket } from './format';

export class DocketError extends Error { override name = 'DocketError'; }

export const AUTHOR = { name: 'Karyo docket', email: 'docket@karyo.invalid' };

export function home(): string {
  const h = process.env.KARYO_HOME;
  return path.resolve(h && h.trim() ? h.replace(/^~(?=$|\/)/, os.homedir()) : path.join(os.homedir(), '.adenine/karyo'));
}

// ---------------------------------------------------------------- git

function git(cwd: string, args: string[], env?: Record<string, string>): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() || (r.error ? String(r.error) : '') };
}

// ---------------------------------------------------------------- the repo a docket belongs to

export type Place = {
  /** the docket's key: <name>-<root sha8> (or <cwd name>-<path hash8> outside git) */
  key: string;
  name: string;
  root: string;
  git: boolean;
  /** the worktree the command runs in, and what's checked out there */
  worktree?: string;
  worktreePath?: string;
  branch?: string;
  sha?: string;
  warnings: string[];
};

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';

export function locate(dir: string): Place {
  const abs = path.resolve(dir);
  if (!existsSync(abs)) throw new DocketError(`no such directory: ${dir}`);
  const common = git(abs, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) return outsideGit(abs, `${abs} isn't in a git repository`);
  const top = git(abs, ['rev-parse', '--show-toplevel']);
  const commonDir = common.out;
  // The main worktree holds the common .git dir; a bare repo's common dir is the repo itself.
  const main = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir.replace(/\.git$/, '');
  const name = slug(path.basename(main));
  const roots = git(abs, ['rev-list', '--max-parents=0', 'HEAD']);
  if (!roots.ok || !roots.out) return { ...outsideGit(abs, `${name} has no commits yet`), name };
  let root = roots.out.split('\n')[0]!;
  const all = roots.out.split('\n').filter(Boolean);
  if (all.length > 1) {
    // Several root commits (merged histories): the oldest by committer date, ties by hash.
    const dated = git(abs, ['log', '--no-walk=unsorted', '--format=%ct %H', ...all]).out.split('\n')
      .map((l) => l.split(' ')).filter((p) => p.length === 2).map(([t, h]) => ({ t: +t!, h: h! }));
    dated.sort((a, b) => a.t - b.t || a.h.localeCompare(b.h));
    if (dated[0]) root = dated[0].h;
  }
  const branch = git(abs, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const sha = git(abs, ['rev-parse', '--short', 'HEAD']);
  const wt = top.ok ? top.out : undefined;
  return {
    key: `${name}-${root.slice(0, 8)}`, name, root: root.slice(0, 8), git: true,
    worktree: wt ? path.basename(wt) : undefined, worktreePath: wt,
    branch: branch.ok && branch.out ? branch.out : undefined, sha: sha.ok ? sha.out : undefined,
    warnings: [],
  };
}

function outsideGit(abs: string, why: string): Place {
  const h = createHash('sha256').update(abs).digest('hex').slice(0, 8);
  const name = slug(path.basename(abs));
  return { key: `${name}-${h}`, name, root: h, git: false, warnings: [`${why}; this docket is keyed by the directory path (${abs})`] };
}

// ---------------------------------------------------------------- the Claude Code session writing

export type Session = { name?: string; id?: string };

/** $CLAUDE_PID → <sessions dir>/<pid>.json → name (and sessionId); else the short $CLAUDE_CODE_SESSION_ID.
 *  Outside Claude Code: nothing. The sessions dir is $KARYO_CLAUDE_SESSIONS, default ~/.claude/sessions. */
export function session(override?: string): Session {
  const id = process.env.CLAUDE_CODE_SESSION_ID?.trim() || undefined;
  const s: Session = { id };
  const pid = process.env.CLAUDE_PID?.trim();
  if (pid && /^\d+$/.test(pid)) {
    const dir = process.env.KARYO_CLAUDE_SESSIONS?.trim() || path.join(os.homedir(), '.claude/sessions');
    try {
      const j = JSON.parse(readFileSync(path.join(dir, `${pid}.json`), 'utf8'));
      if (typeof j.name === 'string' && j.name.trim()) s.name = j.name.trim();
      if (typeof j.sessionId === 'string' && j.sessionId) s.id = j.sessionId;
    } catch { /* no session file: fall through */ }
  }
  if (!s.name && s.id) s.name = s.id.slice(0, 8);
  if (override !== undefined && override.trim()) s.name = override.trim();
  return s;
}

// ---------------------------------------------------------------- files

export type Sidecar = {
  /** the highest id ever handed out, so ids stay unique after items are deleted by hand */
  lastId: number;
  /** what the Markdown doesn't carry: the full worktree path and the session id, per item */
  items: Record<string, { worktreePath?: string; sessionId?: string; closedSessionId?: string }>;
};

export const paths = (p: Place) => {
  const dir = path.join(home(), 'dockets');
  return { dir, md: path.join(dir, `${p.key}.md`), side: path.join(dir, `${p.key}.json`) };
};

function readSidecar(file: string): Sidecar {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return { lastId: Number.isFinite(j.lastId) ? j.lastId : 0, items: j.items && typeof j.items === 'object' ? j.items : {} };
  } catch { return { lastId: 0, items: {} }; }
}

function atomicWrite(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export type Loaded = { place: Place; md: string; side: string; exists: boolean; text: string; docket: Docket; sidecar: Sidecar };

/** Read without locking (for list/show/…). A missing file reads as an empty docket. */
export function load(place: Place): Loaded {
  const p = paths(place);
  const exists = existsSync(p.md);
  const text = exists ? readFileSync(p.md, 'utf8') : emptyDocket({ name: place.name, root: place.root });
  return { place, md: p.md, side: p.side, exists, text, docket: parse(text), sidecar: readSidecar(p.side) };
}

// ---------------------------------------------------------------- lock

const LOCK_TIMEOUT = +(process.env.KARYO_DOCKET_LOCK_TIMEOUT_MS ?? 15000);
const STALE_MS = 60000;

function sleep(ms: number) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** One lock for the whole home (every docket shares the home repo's git index). O_EXCL create, retry with
 *  jitter, break it when its holder is gone or it's older than a minute. */
function withLock<T>(fn: () => T): T {
  const h = home();
  mkdirSync(h, { recursive: true });
  const lock = path.join(h, '.docket.lock');
  const t0 = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        const [pid] = readFileSync(lock, 'utf8').split(' ');
        const age = Date.now() - statSync(lock).mtimeMs;
        if ((pid && /^\d+$/.test(pid) && !alive(+pid) && age > 1000) || age > STALE_MS) { unlinkSync(lock); continue; }
      } catch { /* it went away between the checks: retry */ }
      if (Date.now() - t0 > LOCK_TIMEOUT) throw new DocketError(`another karyo docket command holds ${lock} (waited ${LOCK_TIMEOUT} ms); remove it if no karyo is running`);
      sleep(15 + Math.random() * 35);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}

// ---------------------------------------------------------------- the home repo

const gitId = { GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email };

function ensureHomeRepo(warnings: string[]): boolean {
  const h = home();
  mkdirSync(path.join(h, 'dockets'), { recursive: true });
  if (existsSync(path.join(h, '.git'))) return true;
  const init = git(h, ['init', '-q']);
  if (!init.ok) { warnings.push(`couldn't make ${h} a git repository (${init.err}); changes won't be committed`); return false; }
  git(h, ['config', 'user.name', AUTHOR.name]);
  git(h, ['config', 'user.email', AUTHOR.email]);
  git(h, ['config', 'commit.gpgsign', 'false']);
  return true;
}

function commit(files: string[], message: string, warnings: string[]): string | null {
  const h = home();
  const rel = files.map((f) => path.relative(h, f));
  const add = git(h, ['add', '--', ...rel]);
  if (!add.ok) { warnings.push(`git add failed in ${h}: ${add.err}`); return null; }
  if (git(h, ['diff', '--cached', '--quiet', '--', ...rel]).ok) return null; // nothing changed
  const c = git(h, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message, '--', ...rel], gitId);
  if (!c.ok) { warnings.push(`git commit failed in ${h}: ${c.err}`); return null; }
  return git(h, ['rev-parse', '--short', 'HEAD']).out || null;
}

export type Change<T> = (l: Loaded) => { result: T; message: string } | null;

/** Lock, read, change, write, commit. Hand edits made since the last commit are committed first, on their own
 *  ("docket: hand edit · <name>"), so every command's commit holds exactly that command's change. */
export function update<T>(place: Place, fn: Change<T>): { result: T | null; commit: string | null; warnings: string[] } {
  const warnings: string[] = [];
  return withLock(() => {
    const repo = ensureHomeRepo(warnings);
    const l = load(place);
    const files = [l.md, l.side];
    if (repo && l.exists) commit(files.filter((f) => existsSync(f)), `docket: hand edit · ${place.name}`, warnings);
    const r = fn(l);
    if (!r) return { result: null, commit: null, warnings };
    mkdirSync(path.dirname(l.md), { recursive: true });
    atomicWrite(l.side, JSON.stringify(l.sidecar, null, 2) + '\n');
    atomicWrite(l.md, format(l.docket));
    const sha = repo ? commit(files, r.message, warnings) : null;
    return { result: r.result, commit: sha, warnings };
  });
}

/** Commit whatever changed in the file (after `open` in a blocking editor). */
export function commitHandEdits(place: Place): { commit: string | null; warnings: string[] } {
  const warnings: string[] = [];
  return withLock(() => {
    if (!ensureHomeRepo(warnings)) return { commit: null, warnings };
    const p = paths(place);
    return { commit: commit([p.md, p.side].filter((f) => existsSync(f)), `docket: hand edit · ${place.name}`, warnings), warnings };
  });
}

/** Make sure the file exists (for `open`), committing its creation. */
export function ensureFile(place: Place): { created: boolean; warnings: string[] } {
  const r = update(place, (l) => (l.exists ? null : { result: true, message: `docket: create · ${place.name}` }));
  return { created: r.result === true, warnings: r.warnings };
}

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
