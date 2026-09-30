// The docket (src/docket): pure parse/format, and the CLI end to end (`karyo docket …` in spawned processes)
// against temp git repos, with $KARYO_HOME in a temp dir. Run: `just test` or `bun test tests/docket.test.ts`.
import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addItem, closeItem, editItem, emptyDocket, format, items, parse, reopenItem } from '../src/docket/format';

const ROOT = path.resolve(import.meta.dir, '..');
const CLI = path.join(ROOT, 'cli/karyo.ts');
const TMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'karyo-docket-')));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let home = '';
let n = 0;
const fresh = (name: string) => { const d = path.join(TMP, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d; };

/** Environment for a spawned CLI: our home, no Claude Code session unless the test gives one. */
function env(extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CLAUDE_(PID|CODE_SESSION_ID)$/.test(k)) e[k] = v;
  return { ...e, KARYO_HOME: home, ...extra };
}

function karyo(cwd: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, 'docket', ...args], { cwd, env: env(extra), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function kj(cwd: string, args: string[], extra: Record<string, string> = {}) {
  const r = karyo(cwd, [...args, '--json'], extra);
  if (r.code !== 0) throw new Error(`karyo docket ${args.join(' ')} → ${r.code}\n${r.out}\n${r.err}`);
  return JSON.parse(r.out);
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo named `name` with one commit, plus worktrees on their own branches. */
function repo(name: string, worktrees: string[] = []) {
  const base = fresh('r');
  const main = path.join(base, name);
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(main, 'README.md'), '# hi\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'first');
  const wts = worktrees.map((w) => {
    const p = path.join(base, `${name}-${w}`);
    git(main, 'worktree', 'add', '-q', '-b', `feat/${w}`, p);
    return p;
  });
  return { main, wts, root: git(main, 'rev-list', '--max-parents=0', 'HEAD').slice(0, 8) };
}

beforeEach(() => { home = fresh('home'); });

// ---------------------------------------------------------------- pure

const SAMPLE = `# Docket · notes-app
<!-- karyo docket · repo root 3f9c2e1a · edit freely; keep the **D-n** ids -->

Milestones: rc1 (the first demo) · 1.0 — anything you like, no format

## Needs a decision
- [ ] **D-14** Sync runs on every keystroke — keep, or batch the writes?
  before: rc1 · from: feat/sync @ 3c1e9a2 · worktree: notes-app-sync · session: notes-session · ref: src/sync/merge.ts:48 · 2030-04-29
  > Why: costs battery on phones; a timer would lose the last edit after a crash.

## To review
- [ ] **D-12** Read the new lock code
  from: main @ 1111111 · 2030-04-28

## Come back to
- [ ] **D-9** Look at retries again
  2030-04-20

## Closed
- [x] **D-7** Pick a storage format — decided: plain Markdown, one file per repo · closed 2030-04-29 · session: notes-session
`;

describe('format', () => {
  test('parse → format is byte-stable, and fields read right', () => {
    const d = parse(SAMPLE);
    expect(format(d)).toBe(SAMPLE);
    const all = items(d);
    expect(all.map((l) => [l.item.n, l.kind, l.status])).toEqual([[14, 'decision', 'open'], [12, 'review', 'open'], [9, 'later', 'open'], [7, null, 'closed']]);
    const d14 = all[0]!.item;
    expect(d14.summary).toBe('Sync runs on every keystroke — keep, or batch the writes?');
    expect([d14.before, d14.from, d14.worktree, d14.session, d14.ref, d14.date]).toEqual(['rc1', 'feat/sync @ 3c1e9a2', 'notes-app-sync', 'notes-session', 'src/sync/merge.ts:48', '2030-04-29']);
    expect(d14.why).toBe("costs battery on phones; a timer would lose the last edit after a crash.");
    const d7 = all[3]!.item;
    expect([d7.summary, d7.resolution, d7.closed, d7.closedSession]).toEqual(['Pick a storage format', 'decided: plain Markdown, one file per repo', '2030-04-29', 'notes-session']);
  });

  test('a re-formatted item parses back to the same fields', () => {
    const d = parse(SAMPLE);
    for (const l of items(d)) delete l.item.raw;
    const again = parse(format(d));
    const strip = (x: ReturnType<typeof items>) => x.map((l) => ({ ...l.item, raw: undefined }));
    expect(strip(items(again))).toEqual(strip(items(parse(SAMPLE))));
  });

  test('close → reopen → edit move items between sections and keep the rest byte-identical', () => {
    const d = parse(emptyDocket({ name: 'x', root: 'abcd1234' }));
    addItem(d, 1, { summary: 'one', kind: 'decision', date: '2030-04-29' });
    addItem(d, 2, { summary: 'two — with a dash', kind: 'review', date: '2030-04-29', why: 'because' });
    closeItem(d, 2, { resolution: 'fine — shipped', date: '2030-04-30', session: 'S' });
    const closed = parse(format(d));
    const c = items(closed).find((l) => l.item.n === 2)!;
    expect([c.status, c.item.kind, c.item.summary, c.item.resolution, c.item.why]).toEqual(['closed', 'review', 'two — with a dash', 'fine – shipped', 'because']);
    reopenItem(closed, 2);
    const r = items(parse(format(closed))).find((l) => l.item.n === 2)!;
    expect([r.status, r.kind, r.item.resolution, r.item.closed]).toEqual(['open', 'review', undefined, undefined]);
    editItem(closed, 1, { kind: 'later', before: 'v1', why: 'w' });
    const e = items(parse(format(closed))).find((l) => l.item.n === 1)!;
    expect([e.kind, e.item.before, e.item.why]).toEqual(['later', 'v1', 'w']);
    editItem(closed, 1, { before: '' });
    expect(items(parse(format(closed))).find((l) => l.item.n === 1)!.item.before).toBeUndefined();
    // Sections emptied again look like new ones.
    expect(format(closed)).toContain('## Needs a decision\n\n## To review\n\n- [ ] **D-2**');
  });
});

// ---------------------------------------------------------------- CLI

describe('karyo docket', () => {
  setDefaultTimeout(30000); // every CLI test spawns bun + git a dozen times
  test('two worktrees on different branches write to one file, each item with its own branch and worktree', () => {
    const r = repo('proj', ['alpha', 'beta']);
    const a = kj(r.wts[0]!, ['add', 'From alpha', '--kind', 'review']);
    const b = kj(r.wts[1]!, ['add', 'From beta', '--before', 'rc1']);
    const m = kj(r.main, ['add', 'From main', '--kind', 'later']);
    expect(a.path).toBe(path.join(home, 'dockets', `proj-${r.root}.md`));
    expect(b.path).toBe(a.path);
    expect(m.path).toBe(a.path);
    expect([a.id, b.id, m.id]).toEqual(['D-1', 'D-2', 'D-3']);
    expect(a.item.branch).toBe('feat/alpha');
    expect(a.item.worktree).toBe('proj-alpha');
    expect(a.item.worktreePath).toBe(r.wts[0]);
    expect(b.item.from).toMatch(/^feat\/beta @ [0-9a-f]{7,}$/);
    expect(b.item.worktree).toBe('proj-beta');
    expect(m.item.branch).toBe('main');
    expect(m.item.worktree).toBe('proj');
    const md = readFileSync(a.path, 'utf8');
    expect(md).toContain('# Docket · proj');
    expect(md).toContain(`repo root ${r.root}`);
    expect(md).toMatch(/\*\*D-1\*\* From alpha\n {2}from: feat\/alpha @ \w+ · worktree: proj-alpha · \d{4}-/);
    expect(md).toMatch(/\*\*D-2\*\* From beta\n {2}before: rc1 · from: feat\/beta @ \w+ · worktree: proj-beta/);
    // --repo from anywhere lands on the same docket.
    expect(kj(TMP, ['path', '--repo', r.wts[1]!]).path).toBe(a.path);
    // A detached checkout records the sha only.
    git(r.wts[0]!, 'checkout', '-q', '--detach');
    expect(kj(r.wts[0]!, ['add', 'Detached']).item.from).toMatch(/^[0-9a-f]{7,}$/);
  });

  test('a hand-edited docket (prose, reordered items, an unknown section) survives an add untouched', () => {
    const r = repo('hand');
    const file = kj(r.main, ['path']).path;
    for (const s of ['first', 'second', 'third']) kj(r.main, ['add', s]);
    const edited = readFileSync(file, 'utf8')
      .replace('Milestones: none yet (write anything here: names, dates, what each one means)', 'Milestones: v1 — the demo; v2 whenever')
      .replace(/(- \[ \] \*\*D-1\*\*[^\n]*\n[^\n]*\n)(- \[ \] \*\*D-2\*\*[^\n]*\n[^\n]*\n)/, '$2$1') // D-2 before D-1
      .replace('## To review', 'Some prose the user wrote about decisions.\n  - [ ] a plain checkbox, not an item\n\n## Parking lot\n\n- [ ] **D-3** third, moved here by hand\n  a note in my own words\n\n## To review')
      .replace(/- \[ \] \*\*D-3\*\* third\n[^\n]*\n/, '');
    writeFileSync(file, edited);
    const added = kj(r.main, ['add', 'fourth']);
    expect(added.id).toBe('D-4');
    const after = readFileSync(file, 'utf8');
    const lines = after.split('\n');
    const at = lines.findIndex((l) => l.includes('**D-4**'));
    // Remove exactly the new item's lines: what's left is the hand-edited file, byte for byte.
    expect([...lines.slice(0, at), ...lines.slice(at + 2)].join('\n')).toBe(edited);
    expect(lines[at - 2]).toContain('**D-1**'); // appended after the last item of its section (D-1, moved below D-2 by hand)
    // The unknown section's item is still listed, under its own heading.
    const list = kj(r.main, ['list']);
    expect(list.items.map((i: any) => `${i.id}:${i.section}`)).toEqual(['D-2:Needs a decision', 'D-1:Needs a decision', 'D-4:Needs a decision', 'D-3:Parking lot']);
    expect(list.items.find((i: any) => i.id === 'D-3').notes).toEqual(['  a note in my own words']);
    // The hand edit got its own commit before the add's.
    const log = git(home, 'log', '--format=%s').split('\n');
    expect(log.slice(0, 2)).toEqual(['docket: add D-4 · hand', 'docket: hand edit · hand']);
  });

  test('ids are monotonic: a deleted item\'s id is never reused', () => {
    const r = repo('ids');
    const file = kj(r.main, ['add', 'a']).path;
    kj(r.main, ['add', 'b']);
    kj(r.main, ['add', 'c']);
    writeFileSync(file, readFileSync(file, 'utf8').replace(/- \[ \] \*\*D-3\*\* c\n[^\n]*\n/, ''));
    expect(kj(r.main, ['add', 'd']).id).toBe('D-4');
    // Even with the sidecar gone, ids continue from the highest one in the file.
    rmSync(file.replace(/\.md$/, '.json'));
    expect(kj(r.main, ['add', 'e']).id).toBe('D-5');
  });

  test('close, reopen, edit, show, list filters and milestones', () => {
    const r = repo('ops');
    kj(r.main, ['add', 'Pick a sync format', '--before', 'rc1', '--why', 'two devices edit offline']);
    kj(r.main, ['add', 'Review the lockfile', '--kind', 'review', '--before', 'rc1', '--ref', 'src/docket/store.ts:120']);
    kj(r.main, ['add', 'Retry policy', '--kind', 'later', '--before', 'beta']);
    kj(r.main, ['add', 'No milestone here', '--kind', 'later']);

    const c = kj(r.main, ['close', 'D-1', 'decided: a CRDT, merges offline edits']);
    expect([c.item.status, c.item.resolution, c.item.kind, c.item.section]).toEqual(['closed', 'decided: a CRDT, merges offline edits', 'decision', 'Closed']);
    expect(karyo(r.main, ['close', 'D-1', 'again']).code).toBe(2);
    expect(kj(r.main, ['list']).items.map((i: any) => i.id)).toEqual(['D-2', 'D-3', 'D-4']);
    expect(kj(r.main, ['list', '--all']).items.map((i: any) => i.id)).toEqual(['D-2', 'D-3', 'D-4', 'D-1']);
    expect(kj(r.main, ['list', '--kind', 'closed']).items.map((i: any) => i.id)).toEqual(['D-1']);
    expect(kj(r.main, ['list', '--kind', 'later']).items.map((i: any) => i.id)).toEqual(['D-3', 'D-4']);
    expect(kj(r.main, ['list', '--before', 'RC1']).items.map((i: any) => i.id)).toEqual(['D-2']);

    const ms = kj(r.main, ['milestones']);
    expect(ms.milestones).toEqual([
      { before: 'rc1', open: 1, closed: 1 },
      { before: 'beta', open: 1, closed: 0 },
      { before: null, open: 1, closed: 0 },
    ]);

    const re = kj(r.main, ['reopen', 'd-1']);
    expect([re.item.status, re.item.section, re.item.resolution]).toEqual(['open', 'Needs a decision', null]);
    const md = readFileSync(re.path, 'utf8');
    expect(md).not.toContain('kind: decision');

    const e = kj(r.main, ['edit', '2', '--kind', 'decision', '--summary', 'Review the lock file', '--ref', '']);
    expect([e.item.section, e.item.summary, e.item.ref, e.item.before]).toEqual(['Needs a decision', 'Review the lock file', null, 'rc1']);
    const s = kj(r.main, ['show', 'D-2']);
    expect(s.item.summary).toBe('Review the lock file');
    expect(kj(r.main, ['show', 'D-1']).item.why).toBe('two devices edit offline');

    expect(karyo(r.main, ['show', 'D-99']).code).toBe(2);
    expect(JSON.parse(karyo(r.main, ['show', 'D-99', '--json']).out).error).toMatch(/no D-99/);
    expect(karyo(r.main, ['add', 'x', '--kind', 'nope']).code).toBe(2);
    expect(karyo(r.main, ['frob']).code).toBe(2);
    // Human output: the id and the path.
    const h = karyo(r.main, ['add', 'Plain output']);
    expect(h.code).toBe(0);
    expect(h.out).toMatch(/^D-5 · Needs a decision\n.*ops-[0-9a-f]{8}\.md\n$/);
  });

  test('20 parallel adds from separate processes: 20 distinct ids, file intact, 20 commits', async () => {
    const r = repo('race', ['x']);
    const procs = Array.from({ length: 20 }, (_, i) => Bun.spawn([process.execPath, CLI, 'docket', 'add', `parallel ${i}`, '--json'], {
      cwd: i % 2 ? r.main : r.wts[0]!, env: env(), stdout: 'pipe', stderr: 'pipe',
    }));
    const outs = await Promise.all(procs.map(async (p) => {
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code !== 0) throw new Error(`add failed (${code}): ${out}\n${err}`);
      return JSON.parse(out);
    }));
    const ids = outs.map((o) => o.id).sort((a, b) => +a.slice(2) - +b.slice(2));
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => `D-${i + 1}`));
    const d = parse(readFileSync(outs[0].path, 'utf8'));
    const all = items(d);
    expect(all.length).toBe(20);
    expect(new Set(all.map((l) => l.item.summary)).size).toBe(20);
    expect(format(d)).toBe(readFileSync(outs[0].path, 'utf8'));
    expect(git(home, 'rev-list', '--count', 'HEAD')).toBe('20');
    expect(git(home, 'status', '--porcelain')).toBe('');
  }, 60000);

  test('session: $CLAUDE_PID → sessions dir → name; else the short session id; --session overrides', () => {
    const r = repo('sess');
    const sessions = fresh('sessions');
    writeFileSync(path.join(sessions, '4242.json'), JSON.stringify({ pid: 4242, sessionId: '904efa06-8f1a-40ce-a578-4cf6658bbcb8', name: 'notes-session' }));
    const a = kj(r.main, ['add', 'from a session'], { CLAUDE_PID: '4242', KARYO_CLAUDE_SESSIONS: sessions });
    expect([a.item.session, a.item.sessionId]).toEqual(['notes-session', '904efa06-8f1a-40ce-a578-4cf6658bbcb8']);
    expect(readFileSync(a.path, 'utf8')).toContain('session: notes-session');
    const b = kj(r.main, ['add', 'id only'], { CLAUDE_PID: '9999', KARYO_CLAUDE_SESSIONS: sessions, CLAUDE_CODE_SESSION_ID: 'deadbeef-0000-1111' });
    expect([b.item.session, b.item.sessionId]).toEqual(['deadbeef', 'deadbeef-0000-1111']);
    const c = kj(r.main, ['add', 'override', '--session', 'Named'], { CLAUDE_PID: '4242', KARYO_CLAUDE_SESSIONS: sessions });
    expect(c.item.session).toBe('Named');
    const d = kj(r.main, ['add', 'outside Claude Code']);
    expect([d.item.session, d.item.sessionId]).toEqual([null, null]);
    expect(readFileSync(d.path, 'utf8')).toMatch(/outside Claude Code\n {2}from: main @ \w+ · worktree: sess · \d{4}-\d{2}-\d{2}\n/);
    const cl = kj(r.main, ['close', 'D-4', 'ok'], { CLAUDE_PID: '4242', KARYO_CLAUDE_SESSIONS: sessions });
    expect([cl.item.closedSession, cl.item.closedSessionId]).toEqual(['notes-session', '904efa06-8f1a-40ce-a578-4cf6658bbcb8']);
  });

  test('the home repo gets one commit per change, with the repo-local identity', () => {
    const r = repo('log');
    kj(r.main, ['add', 'one']);
    kj(r.main, ['add', 'two', '--kind', 'review']);
    kj(r.main, ['close', 'D-1', 'done']);
    kj(r.main, ['reopen', 'D-1']);
    kj(r.main, ['edit', 'D-2', '--before', 'v1']);
    kj(r.main, ['list']); kj(r.main, ['show', 'D-1']); kj(r.main, ['milestones']); // reads: no commits
    expect(git(home, 'log', '--format=%s').split('\n')).toEqual([
      'docket: edit D-2 · log', 'docket: reopen D-1 · log', 'docket: close D-1 · log', 'docket: add D-2 · log', 'docket: add D-1 · log',
    ]);
    expect(git(home, 'log', '-1', '--format=%an <%ae>')).toBe('Karyo docket <docket@karyo.invalid>');
    expect(git(home, 'config', '--local', 'user.email')).toBe('docket@karyo.invalid');
    expect(git(home, 'status', '--porcelain')).toBe('');
  });

  test('outside git: keyed by the directory, with a warning', () => {
    const dir = fresh('plain');
    const a = kj(dir, ['add', 'no repo here']);
    expect(a.warnings.join(' ')).toMatch(/isn't in a git repository/);
    expect(path.basename(a.path)).toMatch(/^plain-\d+-[0-9a-f]{8}\.md$/);
    expect(a.item.from).toBeNull();
    expect(karyo(dir, ['list']).err).toMatch(/warning/);
  });
});
