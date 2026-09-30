// Adopting Karyo (docs/ADOPT.md): `karyo init` detection, the plan and its dry run, idempotency, the justfile /
// Makefile / .claude/settings.json / git-hook writers, `karyo refresh` and `karyo record` on the sample project
// (tests/fixtures/adopt-notes), the refresh hook's debounce, and `karyo init --remove` leaving the project as it was.
// Every project is a copy under $KARYO_TEST_SANDBOX (else the temp folder); Karyo's home is sandboxed there too.
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BEGIN, END, blockOf, detect, gitHookText, gitignoreBlock, justBlock, makeBlock, planInit, planRemove, removeBlock,
  settingsWithHooks, upsertBlock, type Detection,
} from '../src/cli/init';

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/adopt-notes');
const BASE = process.env.KARYO_TEST_SANDBOX?.trim() || os.tmpdir();
mkdirSync(BASE, { recursive: true });
const SANDBOX = mkdtempSync(path.join(BASE, 'karyo-adopt-'));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));
// never the real home: Karyo's data dir, git's config and Claude's config all live in the sandbox
const ENV = { ...process.env, HOME: path.join(SANDBOX, 'home'), KARYO_HOME: path.join(SANDBOX, 'karyo-home'), CLAUDE_CONFIG_DIR: path.join(SANDBOX, 'claude'),
  GIT_CONFIG_GLOBAL: path.join(SANDBOX, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', KARYO_CLI: '' };
writeFileSync(ENV.GIT_CONFIG_GLOBAL, '[user]\n\tname = Sample Dev\n\temail = dev@example.invalid\n[init]\n\tdefaultBranch = main\n');

let n = 0;
/** A fresh copy of the sample project, committed once. */
function project(edit?: (dir: string) => void): string {
  const dir = path.join(SANDBOX, `notes-${++n}`);
  cpSync(FIXTURE, dir, { recursive: true });
  edit?.(dir);
  sh(dir, 'git', 'init', '-q');
  sh(dir, 'git', 'add', '-A');
  sh(dir, 'git', 'commit', '-qm', 'notes app');
  return dir;
}
function sh(cwd: string, cmd: string, ...args: string[]) {
  const r = spawnSync(cmd, args, { cwd, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
}
function karyo(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(ROOT, 'cli/karyo.ts'), ...args], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}
/** Every file under a dir (not .git, not caches) with its content: a project's state, to compare. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      if (f === '.git' || f === '__pycache__' || f === '.venv') continue;
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p); else out[path.relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
const opts = { version: '0.2.0' };
const which = (bin: string) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;

describe('detect', () => {
  test('the sample project: a uv Python package with no directives, pytest, a justfile, GitHub Actions', () => {
    const d = detect(project());
    expect(d.python.packages).toEqual(['notes']);
    expect(d.python.directives).toBe(false);
    expect(d.python.codeForm).toEqual([]);
    expect(d.testRunner).toBe('pytest');
    expect(d.testCommand).toEqual(['uv', 'run', 'pytest', '-q']);
    expect(d.packageManager).toBe('uv');
    expect(d.ci.github).toBe(true);
    expect(d.justfile).toBe('justfile');
    expect(d.makefile).toBeNull();
    expect(d.gitRoot).not.toBeNull();
    expect(d.installed).toEqual({ hooks: [], ci: false, recipes: false, gitignore: false, launcher: false, modelIgnored: false });
  });

  test('src/ layout, directives, the code form, pip, a Makefile, Go modules', () => {
    const dir = project((d) => {
      mkdirSync(path.join(d, 'src'));
      cpSync(path.join(d, 'notes'), path.join(d, 'src/billing'), { recursive: true });
      rmSync(path.join(d, 'notes'), { recursive: true });
      writeFileSync(path.join(d, 'src/billing/charge.py'), 'import karyo\n\n# karyo:node id=billing.charge\ndef charge(amount: int) -> int:\n    return amount\n');
      writeFileSync(path.join(d, 'pyproject.toml'), '[project]\nname = "billing"\nversion = "0.1.0"\n');
      writeFileSync(path.join(d, 'requirements-dev.txt'), 'pytest\n');
      rmSync(path.join(d, 'justfile'));
      writeFileSync(path.join(d, 'Makefile'), 'test:\n\tpython3 -m pytest -q\n');
      mkdirSync(path.join(d, 'worker'));
      writeFileSync(path.join(d, 'worker/go.mod'), 'module example.com/worker\n\ngo 1.22\n');
    });
    const d = detect(dir);
    expect(d.python.packages).toEqual(['src/billing']);
    expect(d.python.directives).toBe(true);
    expect(d.python.codeForm).toEqual(['src/billing/charge.py']);
    expect(d.packageManager).toBe('pip');
    expect(d.testCommand).toEqual(['python3', '-m', 'pytest', '-q']);
    expect(d.makefile).toBe('Makefile');
    expect(d.justfile).toBeNull();
    expect(d.go.modules).toEqual(['worker']);
    // the code form: karyo as a dev dependency, in the dev requirements file
    const dep = planInit(d, opts).find((c) => c.what === 'karyo as a dev dependency')!;
    expect(dep.path).toBe('requirements-dev.txt');
    expect(dep.action).toBe('update');
    expect(dep.content).toContain('karyo @ git+https://github.com/adenineio/karyo@v0.2.0#subdirectory=sdk/python');
  });

  test('a uv project in the code form gets `uv add --dev`, one in automatic mode no dependency', () => {
    const auto = planInit(detect(project()), opts).find((c) => c.path === 'pyproject.toml')!;
    expect(auto.action).toBe('skip');
    expect(auto.why).toContain('automatic mode needs no dependency');
    const code = planInit(detect(project((d) => writeFileSync(path.join(d, 'notes/tracing.py'), 'import karyo\nkaryo.watch("notes")\n'))), opts)
      .find((c) => c.path === 'pyproject.toml')!;
    expect(code.action).toBe('run');
    expect(code.command).toEqual(['uv', 'add', '--dev', 'karyo @ git+https://github.com/adenineio/karyo@v0.2.0#subdirectory=sdk/python']);
  });
});

describe('marked blocks', () => {
  const block = [BEGIN, 'x', END].join('\n');
  test('upsert then remove gives the text back; a second upsert replaces in place', () => {
    for (const t of ['', 'a\n', 'a\nb\n\n', '# top\n\nrecipe:\n    echo hi\n']) {
      const once = upsertBlock(t, block);
      expect(blockOf(once)).toBe(block);
      expect(upsertBlock(once, block)).toBe(once);
      const other = upsertBlock(once, [BEGIN, 'y', END].join('\n'));
      expect(other.split(BEGIN).length).toBe(2);
      expect(removeBlock(once)).toBe(t);
    }
  });
  test('.gitignore: fragments always, the model unless it is committed', () => {
    expect(gitignoreBlock(false)).toMatch(/^\.karyo\/$/m);
    expect(gitignoreBlock(false)).toMatch(/^karyo\.model\.json$/m);
    expect(gitignoreBlock(true)).not.toMatch(/^karyo\.model\.json$/m);
  });
});

describe('writers', () => {
  const d = detect(project());
  test('justfile recipes parse and name the detected test command', () => {
    const b = justBlock(d);
    expect(b).toContain('karyo-scan:\n    karyo/karyo.sh refresh');
    expect(b).toContain('karyo-record:\n    karyo/karyo.sh record -- uv run pytest -q');
    expect(b).toContain('karyo-view:\n    karyo/karyo.sh view');
    if (which('just')) {
      const f = path.join(SANDBOX, 'justfile-check');
      writeFileSync(f, upsertBlock(readFileSync(path.join(FIXTURE, 'justfile'), 'utf8'), b));
      const r = spawnSync('just', ['--justfile', f, '--summary'], { encoding: 'utf8' });
      expect(r.stdout.trim().split(/\s+/).sort()).toEqual(['karyo-record', 'karyo-scan', 'karyo-view', 'test']);
    }
  });
  test('Makefile targets are tab-indented and phony', () => {
    const b = makeBlock(d);
    expect(b).toContain('.PHONY: karyo-scan karyo-record karyo-view');
    expect(b).toContain('karyo-scan:\n\tkaryo/karyo.sh refresh');
    if (which('make')) {
      const dir = path.join(SANDBOX, 'make-check');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'Makefile'), upsertBlock('test:\n\techo test\n', b));
      const r = spawnSync('make', ['-n', 'karyo-scan'], { cwd: dir, encoding: 'utf8' });
      expect(r.stdout.trim()).toBe('karyo/karyo.sh refresh');
    }
  });
  test('a recipe the file already has is not overwritten', () => {
    const dir = project((p) => writeFileSync(path.join(p, 'justfile'), 'karyo-scan:\n    echo mine\n'));
    const c = planInit(detect(dir), opts).find((x) => x.path === 'justfile')!;
    expect(c.action).toBe('skip');
    expect(c.why).toContain('karyo-scan');
  });
  test('.claude/settings.json keeps what is there and holds exactly the chosen Karyo hooks', () => {
    const mine = { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } };
    const text = JSON.stringify(mine, null, 2) + '\n';
    const withStop = settingsWithHooks(text, ['stop']).text!;
    const s = JSON.parse(withStop);
    expect(s.permissions).toEqual(mine.permissions);
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[1].hooks[0]).toMatchObject({ type: 'command', async: true });
    expect(s.hooks.Stop[1].hooks[0].command).toContain('"$CLAUDE_PROJECT_DIR/karyo/karyo.sh" refresh --hook');
    expect(settingsWithHooks(withStop, ['stop']).text).toBe(withStop);
    const edit = JSON.parse(settingsWithHooks(withStop, ['edit']).text!);
    expect(edit.hooks.Stop).toEqual(mine.hooks.Stop);
    expect(edit.hooks.PostToolUse[0].matcher).toBe('Edit|Write|MultiEdit');
    expect(JSON.parse(settingsWithHooks(withStop, []).text!)).toEqual(mine);
    expect(settingsWithHooks(null, []).text).toBeNull();
    expect(settingsWithHooks('{ not json', ['stop']).problem).toContain("isn't valid JSON");
  });
  test('git post-commit: a new hook, an existing shell hook kept, a non-shell hook left alone, removal restores it', () => {
    const fresh = gitHookText(null, true).text!;
    expect(fresh.startsWith('#!/bin/sh\n')).toBe(true);
    expect(fresh).toContain('"./karyo/karyo.sh" refresh --hook >/dev/null 2>&1 &');
    expect(gitHookText(fresh, false).text).toBeNull();
    const theirs = '#!/usr/bin/env bash\necho committed\n';
    const both = gitHookText(theirs, true).text!;
    expect(both.startsWith(theirs)).toBe(true);
    expect(gitHookText(both, false).text).toBe(theirs);
    expect(gitHookText('#!/usr/bin/env python3\nprint(1)\n', true).problem).toContain("isn't a shell script");
    expect(gitHookText(null, true, 'apps/notes').text).toContain('"./apps/notes/karyo/karyo.sh"');
  });
});

describe('karyo init', () => {
  test('--dry-run shows the plan and writes nothing', () => {
    const dir = project();
    const before = snapshot(dir);
    const r = karyo(dir, 'init', '--dry-run', '--hook', 'stop', '--ci');
    expect(r.code).toBe(0);
    for (const s of ['create  karyo/karyo.sh', 'update  .gitignore', 'update  justfile', 'create  .github/workflows/karyo.yml', 'create  .claude/settings.json', 'dry run: nothing written'])
      expect(r.out).toContain(s);
    expect(r.out).toContain('karyo-record:');
    expect(snapshot(dir)).toEqual(before);
    // without a terminal and without --yes it never writes either
    expect(karyo(dir, 'init').out).toContain('pass --yes to apply');
    expect(snapshot(dir)).toEqual(before);
  });

  test('--yes applies, prints what changed, and a second run changes nothing', () => {
    const dir = project();
    const r = karyo(dir, 'init', '--yes', '--hook', 'stop,git', '--ci');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Changed (6):');
    for (const f of ['karyo/karyo.sh', '.github/workflows/karyo.yml', '.claude/settings.json', '.git/hooks/post-commit']) expect(existsSync(path.join(dir, f))).toBe(true);
    expect(statSync(path.join(dir, 'karyo/karyo.sh')).mode & 0o111).toBeTruthy();
    expect(statSync(path.join(dir, '.git/hooks/post-commit')).mode & 0o111).toBeTruthy();
    expect(readFileSync(path.join(dir, '.karyo/cli-path'), 'utf8').trim()).toBe(path.join(ROOT, 'cli/karyo'));
    const after = snapshot(dir);
    const again = karyo(dir, 'init', '--yes', '--json');
    expect(JSON.parse(again.out).changed).toBe(false);
    expect(karyo(dir, 'init', '--yes').out).toContain('nothing to change');
    expect(snapshot(dir)).toEqual(after);
    // the launcher, the recipes and the ignore file are committed; nothing machine-specific is
    const tracked = sh(dir, 'git', 'status', '--porcelain', '--untracked-files=all');
    expect(tracked).not.toContain('.karyo/');
    expect(readFileSync(path.join(dir, 'karyo/karyo.sh'), 'utf8')).not.toContain(ROOT);
    expect(readFileSync(path.join(dir, '.claude/settings.json'), 'utf8')).not.toContain(ROOT);
  });

  test('--hook switches the refresh hook, --hook none and --no-ci take them out', () => {
    const dir = project();
    karyo(dir, 'init', '--yes', '--hook', 'stop', '--ci');
    expect(detect(dir).installed.hooks).toEqual(['stop']);
    karyo(dir, 'init', '--yes', '--hook', 'edit');
    expect(detect(dir).installed.hooks).toEqual(['edit']);
    karyo(dir, 'init', '--yes', '--hook', 'git');
    expect(detect(dir).installed.hooks).toEqual(['git']);
    karyo(dir, 'init', '--yes', '--hook', 'none', '--no-ci');
    const d = detect(dir);
    expect(d.installed.hooks).toEqual([]);
    expect(d.installed.ci).toBe(false);
    expect(existsSync(path.join(dir, '.claude/settings.json'))).toBe(false);
    expect(existsSync(path.join(dir, '.git/hooks/post-commit'))).toBe(false);
  });
});

describe('karyo refresh and record', () => {
  const dir = project();
  karyo(dir, 'init', '--yes');

  test('refresh scans in automatic mode and builds the model; --if-stale skips a current one', () => {
    const r = karyo(dir, 'refresh', '--json', '--outline');
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out);
    expect(s.nodes).toBeGreaterThanOrEqual(10);
    expect(s.outline.join('\n')).toContain('notes.service.NotesService');
    expect(existsSync(path.join(dir, 'karyo.model.json'))).toBe(true);
    const t = statSync(path.join(dir, 'karyo.model.json')).mtimeMs;
    expect(karyo(dir, 'refresh', '--if-stale').code).toBe(0);
    expect(statSync(path.join(dir, 'karyo.model.json')).mtimeMs).toBe(t);
  });

  test('record runs a command under sys.monitoring: flows, not exercised, and drift', () => {
    const r = karyo(dir, 'record', '--json', '--', 'python3', '-c', 'from notes import NotesService\ns = NotesService()\ns.create("Weekly plan", "call the plumber")\nassert s.find("plumber")');
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out);
    expect(s.flows).toBeGreaterThanOrEqual(1);
    expect(s.drift.notExercised).toBeGreaterThan(0);
    expect(s.drift.coverage).toContain('exercised');
  });

  test('a curation entry that no longer matches is reported, and --check fails on it', () => {
    writeFileSync(path.join(dir, 'karyo/curation.json'), JSON.stringify({ karyo: 'curation/1', nodes: { 'notes.service.NoteService': { label: 'Notes service' } } }));
    const r = karyo(dir, 'refresh', '--check');
    expect(r.code).toBe(1);
    expect(r.out).toContain('curation-unresolved');
    expect(r.out).toContain('NotesService');
    rmSync(path.join(dir, 'karyo/curation.json'));
  });

  test('the hook: quiet, never fails, and a second one while the first runs waits its turn', () => {
    writeFileSync(path.join(dir, '.karyo/refresh.lock'), `${process.pid} ${new Date().toISOString()}\n`);
    const busy = karyo(dir, 'refresh', '--hook');
    expect(busy.code).toBe(0);
    expect(busy.out).toBe('');
    expect(existsSync(path.join(dir, '.karyo/refresh.pending'))).toBe(true);
    rmSync(path.join(dir, '.karyo/refresh.lock'));
    // the launcher, as Claude Code runs it after an edit
    writeFileSync(path.join(dir, 'notes/pins.py'), 'def pinned(ids: list[str]) -> list[str]:\n    """Pinned notes."""\n    return sorted(ids)\n');
    // no hook was chosen for this project: run the launcher the way the hook would
    const r = spawnSync('sh', ['-c', 'KARYO_HOOK=1 "$P/karyo/karyo.sh" refresh --hook'], { cwd: os.tmpdir(), env: { ...ENV, P: dir }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const m = JSON.parse(readFileSync(path.join(dir, 'karyo.model.json'), 'utf8'));
    expect(m.nodes.some((x: any) => x.id === 'notes.pins.pinned')).toBe(true);
    expect(existsSync(path.join(dir, '.karyo/refresh.pending'))).toBe(false);
    expect(readFileSync(path.join(dir, '.karyo/refresh.log'), 'utf8')).toContain('refreshed');
  });
});

describe('karyo init --remove', () => {
  test('takes out everything init wrote and the generated files; keeps the curation unless --purge', () => {
    const dir = project();
    const before = snapshot(dir);
    expect(karyo(dir, 'init', '--yes', '--hook', 'stop,git', '--ci').code).toBe(0);
    expect(karyo(dir, 'refresh').code).toBe(0);
    mkdirSync(path.join(dir, 'karyo'), { recursive: true });
    writeFileSync(path.join(dir, 'karyo/curation.json'), JSON.stringify({ karyo: 'curation/1', hide: ['notes.cli.*'] }));
    const plan = planRemove(detect(dir));
    expect(plan.find((c) => c.path === 'karyo/curation.json')?.action).toBe('skip');
    const r = karyo(dir, 'init', '--remove', '--yes');
    expect(r.code).toBe(0);
    const after = snapshot(dir);
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), 'karyo/curation.json'].sort());
    for (const [f, t] of Object.entries(before)) expect(after[f]).toBe(t);
    expect(existsSync(path.join(dir, '.git/hooks/post-commit'))).toBe(false);
    expect(karyo(dir, 'init', '--remove', '--yes', '--purge').code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    expect(sh(dir, 'git', 'status', '--porcelain')).toBe('');
  });

  test('an existing post-commit hook and settings of your own survive a round trip', () => {
    const dir = project((p) => { mkdirSync(path.join(p, '.claude')); writeFileSync(path.join(p, '.claude/settings.json'), '{\n  "model": "opus"\n}\n'); });
    const hookFile = path.join(dir, '.git/hooks/post-commit');
    writeFileSync(hookFile, '#!/bin/sh\necho committed\n');
    const before = snapshot(dir), hookBefore = readFileSync(hookFile, 'utf8');
    karyo(dir, 'init', '--yes', '--hook', 'stop,git');
    expect(JSON.parse(readFileSync(path.join(dir, '.claude/settings.json'), 'utf8')).model).toBe('opus');
    expect(readFileSync(hookFile, 'utf8')).toContain('echo committed');
    karyo(dir, 'init', '--remove', '--yes');
    expect(readFileSync(hookFile, 'utf8')).toBe(hookBefore);
    expect(JSON.parse(readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'))).toEqual({ model: 'opus' });
    const after = snapshot(dir);
    delete after['.claude/settings.json']; delete before['.claude/settings.json'];
    expect(after).toEqual(before);
  });
});

// the Detection type is part of the module's surface (the skill reads `karyo init --json`)
export type { Detection };
