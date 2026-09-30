// `karyo init`: what a project needs to adopt Karyo, as a plan of file changes (docs/ADOPT.md).
//   detect(dir)          what the project is: git root, Python packages, Go modules, test runner, package manager, CI,
//                        justfile / Makefile, Claude Code settings, and what an earlier `karyo init` already wrote
//   planInit(d, opts)    every change, each create / update / unchanged / skip / run, with its new content
//   planRemove(d, opts)  the reverse: everything init wrote, and the generated files (--purge: the karyo/ folder too)
//   applyChanges(dir, …) write them (a `run` change is the caller's: it spawns a package manager)
// Pure but for reading the project (and `git`): nothing here writes until applyChanges. Every text Karyo adds to a file
// it doesn't own sits between `# >>> karyo >>>` and `# <<< karyo <<<`, so a second init replaces it in place and
// `--remove` takes exactly it out. Files Karyo owns whole (the launcher, the CI workflow) say so in their first lines.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type HookKind = 'stop' | 'edit' | 'git';
export const HOOK_KINDS: HookKind[] = ['stop', 'edit', 'git'];
export const RECOMMENDED_HOOK: HookKind = 'stop';

export const BEGIN = '# >>> karyo >>>';
export const END = '# <<< karyo <<<';
/** The launcher every recipe and hook runs (committed; no machine paths in it). */
export const LAUNCHER = 'karyo/karyo.sh';
export const CI_FILE = '.github/workflows/karyo.yml';
export const CI_MARK = '# Karyo (written by `karyo init`';
/** Where the SDK comes from when a project needs it as a dev dependency (the public plugin repo, at a release tag). */
export const SDK_GIT = (version: string) => `karyo @ git+https://github.com/adenineio/karyo@v${version}#subdirectory=sdk/python`;
/** What identifies Karyo's refresh hook in .claude/settings.json and in a git hook. */
const HOOK_SIGNATURE = 'karyo/karyo.sh" refresh --hook';

export interface Detection {
  dir: string;
  name: string;
  gitRoot: string | null;
  /** The project dir relative to the git root ('' when it is the root). */
  inRepo: string;
  python: { packages: string[]; directives: boolean; codeForm: string[] };
  go: { modules: string[] };
  testRunner: 'pytest' | 'unittest' | null;
  testCommand: string[] | null;
  packageManager: 'uv' | 'poetry' | 'pipenv' | 'pip' | null;
  ci: { github: boolean; other: string[] };
  justfile: string | null;
  makefile: string | null;
  claudeSettings: boolean;
  gitHookFile: string | null;
  modelTracked: boolean;
  karyoDevDep: boolean;
  installed: { hooks: HookKind[]; ci: boolean; recipes: boolean; gitignore: boolean; launcher: boolean; modelIgnored: boolean };
}

export interface InitOptions {
  /** Refresh hooks to have afterwards; undefined keeps what is installed. */
  hooks?: HookKind[];
  /** The CI workflow: true adds it, false removes it, undefined keeps what is there. */
  ci?: boolean;
  /** karyo-* recipes in an existing justfile or Makefile (default true). */
  recipes?: boolean;
  /** Commit karyo.model.json (default: only when git already tracks it). */
  commitModel?: boolean;
  /** Karyo's version (the plugin's), for the CI checkout and the SDK's git source. */
  version: string;
}

export type Action = 'create' | 'update' | 'unchanged' | 'remove' | 'skip' | 'run';
export interface Change {
  /** Path relative to the project dir (a git hook may sit outside it, under .git). */
  path: string;
  action: Action;
  what: string;
  why?: string;
  /** The file's full new content (create / update). */
  content?: string;
  /** What is added or changed, for the plan shown before applying. */
  preview?: string;
  executable?: boolean;
  /** remove: a whole folder. */
  dir?: boolean;
  /** run: the command (cwd: the project). */
  command?: string[];
}

// ---------------------------------------------------------------- detection

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', 'env', 'dist', 'build', '__pycache__', '.karyo', 'out', 'target',
  'site-packages', '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache']);
/** Folders that hold a package but aren't the app: tests, docs, examples, tooling, and Karyo's own folder. */
const NOT_APP = /^(tests?|testing|docs?|examples?|samples?|scripts?|tools?|benchmarks?|karyo|setup|conftest)$/i;

const read = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const isFile = (f: string) => { try { return statSync(f).isFile(); } catch { return false; } };
const isDir = (f: string) => { try { return statSync(f).isDirectory(); } catch { return false; } };
const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

function pyFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 8) return out;
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (SKIP_DIRS.has(n) || n.startsWith('.')) continue;
    const f = path.join(dir, n);
    if (isDir(f)) pyFiles(f, depth + 1, out);
    else if (n.endsWith('.py')) out.push(f);
  }
  return out;
}

/** The project's Python packages (a folder with __init__.py at the top level or under src/), app code only. */
export function pythonPackages(dir: string): string[] {
  const out: string[] = [];
  for (const base of [dir, path.join(dir, 'src')]) {
    if (!isDir(base)) continue;
    for (const n of readdirSync(base).sort()) {
      if (SKIP_DIRS.has(n) || n.startsWith('.') || NOT_APP.test(n) || n.endsWith('.egg-info')) continue;
      const d = path.join(base, n);
      if (isDir(d) && isFile(path.join(d, '__init__.py'))) out.push(path.relative(dir, d));
    }
  }
  return out;
}

function goModules(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 3) return out;
  if (isFile(path.join(dir, 'go.mod'))) out.push(dir);
  let names: string[] = [];
  try { names = readdirSync(dir); } catch {}
  for (const n of names) {
    if (SKIP_DIRS.has(n) || n.startsWith('.') || n === 'vendor') continue;
    const d = path.join(dir, n);
    if (isDir(d)) goModules(d, depth + 1, out);
  }
  return out;
}

const IMPORTS_KARYO = /^\s*(import\s+karyo\b|from\s+karyo(\.\w+)*\s+import\b)|^\s*@karyo\./m;
const DIRECTIVE = /^\s*#\s*karyo:/m;

export function detect(dirArg: string): Detection {
  const dir = path.resolve(dirArg);
  const gitRoot = git(dir, 'rev-parse', '--show-toplevel');
  const inRepo = gitRoot ? path.relative(gitRoot, dir).split(path.sep).join('/') : '';
  const pyproject = read(path.join(dir, 'pyproject.toml')) ?? '';
  const reqs = ['requirements.txt', 'requirements-dev.txt', 'requirements_dev.txt', 'dev-requirements.txt']
    .map((f) => read(path.join(dir, f)) ?? '').join('\n');

  // Python
  const packages = pythonPackages(dir);
  let directives = false;
  const codeForm: string[] = [];
  for (const p of packages) {
    for (const f of pyFiles(path.join(dir, p))) {
      const t = read(f) ?? '';
      if (DIRECTIVE.test(t)) directives = true;
      if (IMPORTS_KARYO.test(t)) codeForm.push(path.relative(dir, f));
    }
  }

  // package manager
  const packageManager: Detection['packageManager'] =
    isFile(path.join(dir, 'uv.lock')) || /^\[tool\.uv\]/m.test(pyproject) ? 'uv'
    : isFile(path.join(dir, 'poetry.lock')) || /^\[tool\.poetry\]/m.test(pyproject) ? 'poetry'
    : isFile(path.join(dir, 'Pipfile')) ? 'pipenv'
    : pyproject || reqs.trim() || isFile(path.join(dir, 'setup.py')) ? 'pip' : null;

  // tests
  const hasTests = ['tests', 'test'].some((t) => isDir(path.join(dir, t)) && pyFiles(path.join(dir, t)).some((f) => /(^|\/)test_[^/]*\.py$|_test\.py$/.test(f)));
  const pytestSign = /^\[tool\.pytest/m.test(pyproject) || isFile(path.join(dir, 'pytest.ini')) || isFile(path.join(dir, 'conftest.py'))
    || isFile(path.join(dir, 'tests/conftest.py')) || /\[tool:pytest\]/.test(read(path.join(dir, 'setup.cfg')) ?? '')
    || /\[pytest\]/.test(read(path.join(dir, 'tox.ini')) ?? '') || /\bpytest\b/.test(pyproject + reqs + (read(path.join(dir, 'Pipfile')) ?? ''));
  const testRunner: Detection['testRunner'] = packages.length && pytestSign ? 'pytest' : packages.length && hasTests ? 'unittest' : null;
  const py = isFile(path.join(dir, '.venv/bin/python')) ? '.venv/bin/python' : 'python3';
  const testCommand = testRunner === 'pytest'
    ? packageManager === 'uv' ? ['uv', 'run', 'pytest', '-q']
      : packageManager === 'poetry' ? ['poetry', 'run', 'pytest', '-q']
      : packageManager === 'pipenv' ? ['pipenv', 'run', 'pytest', '-q']
      : [py, '-m', 'pytest', '-q']
    : testRunner === 'unittest' ? [py, '-m', 'unittest', 'discover', '-s', isDir(path.join(dir, 'tests')) ? 'tests' : 'test'] : null;

  // CI, task runners, settings
  const wf = path.join(dir, '.github/workflows');
  const github = isDir(wf) && readdirSync(wf).some((f) => /\.ya?ml$/.test(f) && f !== 'karyo.yml');
  const other = [['.gitlab-ci.yml', 'GitLab CI'], ['.circleci', 'CircleCI'], ['azure-pipelines.yml', 'Azure Pipelines'], ['Jenkinsfile', 'Jenkins']]
    .filter(([f]) => existsSync(path.join(dir, f!))).map(([, n]) => n!);
  // by the names in the folder (a case-insensitive file system would find `makefile` for a `Makefile`)
  const here = new Set(readdirSync(dir));
  const justfile = ['justfile', 'Justfile', '.justfile'].find((f) => here.has(f) && isFile(path.join(dir, f))) ?? null;
  const makefile = ['GNUmakefile', 'makefile', 'Makefile'].find((f) => here.has(f) && isFile(path.join(dir, f))) ?? null;
  const settingsText = read(path.join(dir, '.claude/settings.json'));

  // git hook (core.hooksPath respected), and whether the model is already committed
  let gitHookFile: string | null = null;
  if (gitRoot) {
    const p = git(dir, 'rev-parse', '--git-path', 'hooks/post-commit');
    if (p) gitHookFile = path.resolve(dir, p);
  }
  const modelTracked = !!gitRoot && !!git(dir, 'ls-files', '--', 'karyo.model.json');

  // what an earlier init wrote
  const hooks: HookKind[] = [];
  const settingsHooks = claudeHookKinds(settingsText);
  hooks.push(...settingsHooks);
  if (gitHookFile && (read(gitHookFile) ?? '').includes(BEGIN)) hooks.push('git');
  const gi = read(path.join(dir, '.gitignore')) ?? '';
  const giBlock = blockOf(gi) ?? '';
  const taskText = (justfile ? read(path.join(dir, justfile)) : '') + (makefile ? read(path.join(dir, makefile)) ?? '' : '');

  return {
    dir, name: path.basename(dir), gitRoot, inRepo,
    python: { packages, directives, codeForm },
    go: { modules: goModules(dir).map((m) => path.relative(dir, m) || '.') },
    testRunner, testCommand, packageManager,
    ci: { github, other },
    justfile, makefile,
    claudeSettings: settingsText !== null,
    gitHookFile, modelTracked,
    karyoDevDep: /(^|["'\s])karyo(\s|@|\[|["'=<>~!]|$)/m.test(pyproject.replace(/^\s*#.*$/gm, '') + '\n' + reqs),
    installed: {
      hooks, ci: (read(path.join(dir, CI_FILE)) ?? '').startsWith(CI_MARK), recipes: taskText.includes(BEGIN),
      gitignore: !!giBlock, launcher: isFile(path.join(dir, LAUNCHER)), modelIgnored: /^karyo\.model\.json$/m.test(giBlock),
    },
  };
}

// ---------------------------------------------------------------- marked blocks

/** The marked block in a text (markers included), or null. */
export function blockOf(text: string): string | null {
  const a = text.indexOf(BEGIN);
  if (a < 0) return null;
  const b = text.indexOf(END, a);
  if (b < 0) return null;
  return text.slice(a, b + END.length);
}

/** Put a block (markers included) into a text: in place of the one there, else appended after a blank line. */
export function upsertBlock(text: string, block: string): string {
  const old = blockOf(text);
  if (old !== null) return text.replace(old, () => block);
  if (!text) return block + '\n';
  const body = text.endsWith('\n') ? text : text + '\n';
  return body + '\n' + block + '\n';
}

/** Take the block out, with the blank line put before it. */
export function removeBlock(text: string): string {
  const old = blockOf(text);
  if (old === null) return text;
  const i = text.indexOf(old);
  let before = text.slice(0, i), after = text.slice(i + old.length);
  if (after.startsWith('\n')) after = after.slice(1);
  if (!after && before.endsWith('\n\n')) before = before.slice(0, -1);
  return before + after;
}

// ---------------------------------------------------------------- what each file gets

export function gitignoreBlock(commitModel: boolean): string {
  return [BEGIN,
    '# Karyo: generated files (`karyo init`; docs: ADOPT.md in the Karyo plugin). Commit karyo/ (curation, splices,',
    '# kits, the launcher) and karyo.layout.json; these are rebuilt from the code by `karyo/karyo.sh refresh`.',
    '.karyo/',
    ...(commitModel ? [] : ['karyo.model.json']),
    END].join('\n');
}

const shq = (s: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
export const shellCommand = (argv: string[]) => argv.map(shq).join(' ');

/** The recipes: scan (refresh), record the tests once, open the view. */
function recipes(d: Detection): { name: string; doc: string; cmd: string }[] {
  return [
    { name: 'karyo-scan', doc: 'Karyo: re-scan the code into karyo.model.json (applies karyo/curation.json)', cmd: `${LAUNCHER} refresh` },
    { name: 'karyo-record', doc: 'Karyo: run the tests once under the recorder, so the board shows real calls and what never ran',
      cmd: `${LAUNCHER} record${d.testCommand ? ` -- ${shellCommand(d.testCommand)}` : ''}` },
    { name: 'karyo-view', doc: "Karyo: open the project's Karyo view (prints its URL)", cmd: `${LAUNCHER} view` },
  ];
}

/** Recipe names the file already defines outside Karyo's block (they'd clash). */
function recipeClashes(text: string, names: string[]): string[] {
  const outside = removeBlock(text);
  return names.filter((n) => new RegExp(`^${n}(\\s[^:=]*)?:(?!=)`, 'm').test(outside));
}

export function justBlock(d: Detection): string {
  const lines = [BEGIN, '# Karyo recipes (`karyo init`; `karyo init --remove` takes them out)'];
  for (const r of recipes(d)) lines.push('', `# ${r.doc}`, `${r.name}:`, `    ${r.cmd}`);
  return [...lines, END].join('\n');
}

export function makeBlock(d: Detection): string {
  const rs = recipes(d);
  const lines = [BEGIN, '# Karyo targets (`karyo init`; `karyo init --remove` takes them out)', `.PHONY: ${rs.map((r) => r.name).join(' ')}`];
  for (const r of rs) lines.push('', `# ${r.doc}`, `${r.name}:`, `\t${r.cmd}`);
  return [...lines, END].join('\n');
}

/** The launcher: finds the Karyo CLI (never a machine path in the file itself) and runs it in the project. */
export function launcherScript(): string {
  return `#!/bin/sh
# Karyo launcher (written by \`karyo init\`; commit it: it holds no machine paths). The karyo-* recipes and the refresh
# hook run Karyo through it:
#   karyo/karyo.sh refresh          re-scan the code into karyo.model.json (applies karyo/curation.json)
#   karyo/karyo.sh record [-- cmd]  run the tests (or cmd) once under the recorder
#   karyo/karyo.sh view             the project's Karyo view
# It finds Karyo in this order: $KARYO_CLI; the copy that last ran here (.karyo/cli-path, not committed); the newest
# Claude Code plugin install; \`karyo\` on PATH. Without one, a hook exits quietly and anything else says how to get it.
here=$(cd "$(dirname "$0")/.." && pwd -P)
cli=""
if [ -n "$KARYO_CLI" ] && [ -x "$KARYO_CLI" ]; then
  cli=$KARYO_CLI
elif [ -f "$here/.karyo/cli-path" ] && [ -x "$(cat "$here/.karyo/cli-path")" ]; then
  cli=$(cat "$here/.karyo/cli-path")
else
  for c in $(ls -d "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/karyo/*/cli/karyo 2>/dev/null | sort -V); do cli=$c; done
  [ -n "$cli" ] || cli=$(command -v karyo 2>/dev/null)
fi
if [ -z "$cli" ]; then
  [ "$KARYO_HOOK" = 1 ] && exit 0
  echo "karyo: can't find the Karyo CLI: install the Claude Code plugin (claude plugin install karyo@adenine) or set KARYO_CLI" >&2
  exit 127
fi
cd "$here" && exec "$cli" "$@"
`;
}

/** The command a hook runs (from the project dir). Never fails the work it follows. */
export function hookCommand(from: 'claude' | 'git', inRepo = ''): string {
  if (from === 'claude') return `[ -x "$CLAUDE_PROJECT_DIR/${LAUNCHER}" ] && KARYO_HOOK=1 "$CLAUDE_PROJECT_DIR/${LAUNCHER}" refresh --hook || true`;
  const dir = inRepo ? `./${inRepo}/` : './';
  return `[ -x "${dir}${LAUNCHER}" ] && (KARYO_HOOK=1 "${dir}${LAUNCHER}" refresh --hook >/dev/null 2>&1 &)`;
}

function claudeHookKinds(settingsText: string | null): HookKind[] {
  if (!settingsText) return [];
  let s: any;
  try { s = JSON.parse(settingsText); } catch { return []; }
  const has = (ev: string) => Array.isArray(s?.hooks?.[ev]) && s.hooks[ev].some((g: any) => (g?.hooks ?? []).some(isOurs));
  return [...(has('Stop') ? ['stop' as const] : []), ...(has('PostToolUse') ? ['edit' as const] : [])];
}
const isOurs = (h: any) => typeof h?.command === 'string' && h.command.includes(HOOK_SIGNATURE);

/** .claude/settings.json with exactly the wanted Karyo hooks (everything else kept as it was). */
export function settingsWithHooks(text: string | null, kinds: HookKind[]): { text: string | null; problem?: string } {
  let s: any = {};
  if (text !== null && text.trim()) {
    try { s = JSON.parse(text); } catch (e) { return { text, problem: `.claude/settings.json isn't valid JSON (${(e as Error).message}); left alone` }; }
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { text, problem: '.claude/settings.json is not a JSON object; left alone' };
  }
  const hooks: Record<string, any[]> = s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
  // drop ours everywhere, then add what's wanted
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev]!.map((g: any) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h: any) => !isOurs(h)) } : g))
      .filter((g: any) => !Array.isArray(g?.hooks) || g.hooks.length);
    if (!hooks[ev]!.length) delete hooks[ev];
  }
  const handler = { type: 'command', command: hookCommand('claude'), async: true, timeout: 300 };
  if (kinds.includes('stop')) (hooks.Stop ??= []).push({ hooks: [handler] });
  if (kinds.includes('edit')) (hooks.PostToolUse ??= []).push({ matcher: 'Edit|Write|MultiEdit', hooks: [handler] });
  if (Object.keys(hooks).length) s.hooks = hooks; else delete s.hooks;
  if (text === null && !Object.keys(s).length) return { text: null };
  const out = JSON.stringify(s, null, 2) + '\n';
  // unchanged content keeps its formatting
  if (text !== null) { try { if (JSON.stringify(JSON.parse(text)) === JSON.stringify(s)) return { text }; } catch {} }
  return { text: out };
}

/** A post-commit hook with Karyo's block added (or taken out: `want` false). null: the file should not exist. */
export function gitHookText(existing: string | null, want: boolean, inRepo = ''): { text: string | null; problem?: string } {
  if (existing !== null && existing.trim()) {
    const first = existing.split('\n', 1)[0]!;
    if (want && first.startsWith('#!') && !/\b(sh|bash|zsh|dash|ksh)\b/.test(first)) return { text: existing, problem: `the post-commit hook isn't a shell script (${first}); add \`${hookCommand('git', inRepo)}\` to it yourself` };
  }
  const block = [BEGIN, '# Karyo: re-scan the code after each commit, in the background (`karyo init --remove` takes this out)', hookCommand('git', inRepo), END].join('\n');
  if (!want) {
    if (existing === null) return { text: null };
    const rest = removeBlock(existing);
    return { text: rest.replace(/^#!.*\n?/, '').trim() ? rest : null };
  }
  return { text: upsertBlock(existing ?? '#!/bin/sh\n', block) };
}

export function ciWorkflow(d: Detection, version: string): string {
  const pkgs = d.python.packages.join(' ');
  return `${CI_MARK}; \`karyo init --remove\` deletes it). Checks that Karyo stays inert in production code and
# rebuilds the Karyo model, so a change that leaves the curation (karyo/curation.json) behind shows in review.
name: karyo
on:
  push:
    branches: [main]
  pull_request:
jobs:
  karyo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with:
          repository: adenineio/karyo
          ref: v${version}
          path: .karyo-tool
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: oven-sh/setup-bun@v2
      - name: Karyo is inert in production code
        run: PYTHONPATH=.karyo-tool/sdk/python python -m karyo check-prod ${pkgs || '.'}
      - name: Build the Karyo model (fails on curation entries that no longer match the code)
        run: |
          (cd .karyo-tool && bun install --frozen-lockfile --ignore-scripts)
          KARYO_HOME="$RUNNER_TEMP/karyo" .karyo-tool/cli/karyo refresh . --check
      - uses: actions/upload-artifact@v4
        with:
          name: karyo-model
          path: karyo.model.json
`;
}

// ---------------------------------------------------------------- plans

function fileChange(dir: string, rel: string, next: string | null, what: string, why: string, executable = false): Change {
  const abs = path.isAbsolute(rel) ? rel : path.join(dir, rel);
  const cur = read(abs);
  const shown = path.isAbsolute(rel) ? rel : rel;
  if (next === null) return cur === null ? { path: shown, action: 'unchanged', what, why } : { path: shown, action: 'remove', what, why };
  if (cur === next) return { path: shown, action: 'unchanged', what, why };
  return { path: shown, action: cur === null ? 'create' : 'update', what, why, content: next, executable };
}

const gitHookRel = (d: Detection) => (d.gitHookFile ? path.relative(d.dir, d.gitHookFile) : null);

export function planInit(d: Detection, o: InitOptions): Change[] {
  const out: Change[] = [];
  const commitModel = o.commitModel ?? (d.modelTracked || (d.installed.gitignore && !d.installed.modelIgnored));

  // the launcher
  out.push(fileChange(d.dir, LAUNCHER, launcherScript(), 'the Karyo launcher', 'recipes and hooks run Karyo through it; it finds the plugin, no machine paths', true));

  // .gitignore
  if (d.gitRoot) {
    const cur = read(path.join(d.dir, '.gitignore')) ?? '';
    const block = gitignoreBlock(commitModel);
    const c = fileChange(d.dir, '.gitignore', upsertBlock(cur, block), 'ignore generated files',
      commitModel ? '.karyo/ (fragments) is rebuilt from the code; karyo.model.json stays committed' : '.karyo/ (fragments) and karyo.model.json are rebuilt from the code');
    out.push({ ...c, preview: c.action === 'unchanged' ? undefined : block });
  } else out.push({ path: '.gitignore', action: 'skip', what: 'ignore generated files', why: 'not a git repository' });

  // recipes
  const names = recipes(d).map((r) => r.name);
  const wantRecipes = o.recipes ?? true;
  for (const [file, block] of [[d.justfile, d.justfile ? justBlock(d) : ''], [d.makefile, d.makefile ? makeBlock(d) : '']] as const) {
    if (!file) continue;
    const cur = read(path.join(d.dir, file)) ?? '';
    const clash = recipeClashes(cur, names);
    if (wantRecipes && clash.length) { out.push({ path: file, action: 'skip', what: 'karyo-* recipes', why: `it already defines ${clash.join(', ')}` }); continue; }
    const c = fileChange(d.dir, file, wantRecipes ? upsertBlock(cur, block) : removeBlock(cur), wantRecipes ? `recipes ${names.join(', ')}` : 'remove the karyo-* recipes', 'the project\'s task runner is the command menu');
    out.push({ ...c, preview: c.action === 'unchanged' || !wantRecipes ? undefined : block });
  }
  if (!d.justfile && !d.makefile) out.push({ path: 'justfile', action: 'skip', what: 'karyo-* recipes', why: 'no justfile or Makefile (Karyo doesn\'t add one); karyo/karyo.sh does the same' });

  // dependency
  out.push(...devDepChange(d, o.version));

  // CI
  const ciNow = d.installed.ci;
  const wantCi = o.ci ?? ciNow;
  if (wantCi && !d.python.packages.length) out.push({ path: CI_FILE, action: 'skip', what: 'CI workflow', why: 'no Python package to check' });
  else if (wantCi || ciNow) {
    const c = fileChange(d.dir, CI_FILE, wantCi ? ciWorkflow(d, o.version) : null, wantCi ? 'CI: check-prod (inert) and a model build' : 'remove the CI workflow', 'offered, not forced: pass --ci to add it');
    out.push({ ...c, preview: c.action === 'create' || c.action === 'update' ? c.content : undefined });
  }

  if (!wantCi && !ciNow && d.ci.github && d.python.packages.length) out.push({ path: CI_FILE, action: 'skip', what: 'CI workflow (offered)', why: '--ci adds a job: check-prod, the inert check, and a model build' });

  // hooks
  const want = o.hooks ?? d.installed.hooks;
  if (!want.length && !d.installed.hooks.length) out.push({ path: '.claude/settings.json', action: 'skip', what: 'refresh hook (offered)', why: `--hook ${RECOMMENDED_HOOK} (recommended), edit or git keeps the model current` });
  const claudeKinds = want.filter((k): k is 'stop' | 'edit' => k !== 'git');
  const hadClaude = d.installed.hooks.some((k) => k !== 'git');
  if (claudeKinds.length || hadClaude) {
    const cur = read(path.join(d.dir, '.claude/settings.json'));
    const r = settingsWithHooks(cur, claudeKinds);
    // a settings file left holding nothing but {} was Karyo's: it goes
    if (!claudeKinds.length && r.text !== null && r.text.trim() === '{}') r.text = null;
    if (r.problem) out.push({ path: '.claude/settings.json', action: 'skip', what: 'refresh hook', why: r.problem });
    else {
      const c = fileChange(d.dir, '.claude/settings.json', r.text, claudeKinds.length ? `refresh hook: Claude Code ${claudeKinds.map((k) => (k === 'stop' ? 'Stop' : 'PostToolUse on Edit|Write|MultiEdit')).join(' + ')}` : 'remove the refresh hook',
        'project settings only, never user-level; runs async, so it never slows a turn');
      out.push({ ...c, preview: c.action === 'unchanged' || !claudeKinds.length ? undefined : JSON.stringify(settingsWithHooksPreview(claudeKinds), null, 2) });
    }
  }
  const wantGit = want.includes('git'), hadGit = d.installed.hooks.includes('git');
  if (wantGit || hadGit) {
    const rel = gitHookRel(d);
    if (!rel) out.push({ path: '.git/hooks/post-commit', action: 'skip', what: 'refresh hook: git post-commit', why: 'not a git repository' });
    else {
      const r = gitHookText(read(d.gitHookFile!), wantGit, d.inRepo);
      if (r.problem) out.push({ path: rel, action: 'skip', what: 'refresh hook: git post-commit', why: r.problem });
      else {
        const c = fileChange(d.dir, d.gitHookFile!, r.text, wantGit ? 'refresh hook: git post-commit' : 'remove the git refresh hook', 'local to this clone (.git is never committed)', true);
        out.push({ ...c, path: rel, preview: c.action === 'unchanged' || !wantGit ? undefined : blockOf(r.text ?? '') ?? undefined });
      }
    }
  }
  return out;
}

function settingsWithHooksPreview(kinds: ('stop' | 'edit')[]) {
  return JSON.parse(settingsWithHooks(null, kinds).text ?? '{}');
}

/** Karyo as a dev dependency: only for the SDK's code form (the app imports karyo). Automatic mode and directives need
 *  nothing: the plugin scans and records with its own copy of the SDK. */
function devDepChange(d: Detection, version: string): Change[] {
  if (!d.python.packages.length) return [];
  if (!d.python.codeForm.length) return [{ path: 'pyproject.toml', action: 'skip', what: 'no dependency added',
    why: d.python.directives ? 'the code declares itself in `# karyo:` comments, which need no import; the plugin scans with its own SDK' : 'automatic mode needs no dependency: the plugin scans and records with its own SDK' }];
  if (d.karyoDevDep) return [{ path: 'pyproject.toml', action: 'unchanged', what: 'karyo as a dev dependency', why: `the app imports karyo (${d.python.codeForm[0]}); it's already listed` }];
  const spec = SDK_GIT(version);
  const why = `the app imports karyo (${d.python.codeForm.slice(0, 2).join(', ')}${d.python.codeForm.length > 2 ? ', …' : ''})`;
  if (d.packageManager === 'uv') return [{ path: 'pyproject.toml', action: 'run', what: 'karyo as a dev dependency', why, command: ['uv', 'add', '--dev', spec] }];
  if (d.packageManager === 'poetry') return [{ path: 'pyproject.toml', action: 'run', what: 'karyo as a dev dependency', why, command: ['poetry', 'add', '--group', 'dev', spec.replace(/^karyo @ /, '')] }];
  const devReq = ['requirements-dev.txt', 'requirements_dev.txt', 'dev-requirements.txt'].find((f) => isFile(path.join(d.dir, f)));
  if (devReq) {
    const cur = read(path.join(d.dir, devReq)) ?? '';
    return [{ ...fileChange(d.dir, devReq, (cur.endsWith('\n') || !cur ? cur : cur + '\n') + spec + '\n', 'karyo as a dev dependency', why), preview: spec }];
  }
  return [{ path: 'pyproject.toml', action: 'skip', what: 'karyo as a dev dependency', why: `${why}; add it to your dev dependencies: ${spec}` }];
}

export interface RemoveOptions { purge?: boolean }

export function planRemove(d: Detection, o: RemoveOptions = {}): Change[] {
  const out: Change[] = [];
  const why = 'written by karyo init';
  for (const f of ['.gitignore', d.justfile, d.makefile]) {
    if (!f) continue;
    const cur = read(path.join(d.dir, f));
    if (cur !== null && blockOf(cur) !== null) out.push(fileChange(d.dir, f, removeBlock(cur), 'take out Karyo\'s block', why));
  }
  const settings = read(path.join(d.dir, '.claude/settings.json'));
  if (claudeHookKinds(settings).length) {
    const r = settingsWithHooks(settings, []);
    const empty = r.text !== null && JSON.stringify(JSON.parse(r.text)) === '{}';
    out.push(fileChange(d.dir, '.claude/settings.json', empty ? null : r.text, 'remove the refresh hook', why));
  }
  if (d.gitHookFile && (read(d.gitHookFile) ?? '').includes(BEGIN)) {
    const r = gitHookText(read(d.gitHookFile), false, d.inRepo);
    out.push({ ...fileChange(d.dir, d.gitHookFile, r.text, 'remove the git refresh hook', why), path: gitHookRel(d)! });
  }
  if (d.installed.ci) out.push({ path: CI_FILE, action: 'remove', what: 'the CI workflow', why });
  out.push(...(['.karyo', 'karyo.model.json'] as const).filter((f) => existsSync(path.join(d.dir, f)))
    .map((f) => ({ path: f, action: 'remove' as const, what: 'generated', why: 'rebuilt from the code, nothing lost', dir: f === '.karyo' })));
  if (o.purge) {
    for (const f of ['karyo', 'karyo.layout.json']) if (existsSync(path.join(d.dir, f))) out.push({ path: f, action: 'remove', what: 'your Karyo files (curation, splices, kits, layout)', why: '--purge', dir: f === 'karyo' });
  } else {
    if (d.installed.launcher) out.push({ path: LAUNCHER, action: 'remove', what: 'the Karyo launcher', why });
    const kept = ['karyo/curation.json', 'karyo/splices', 'karyo/kits', 'karyo.layout.json'].filter((f) => existsSync(path.join(d.dir, f)));
    for (const f of kept) out.push({ path: f, action: 'skip', what: 'kept: yours', why: 'what you or Claude wrote; --purge removes it too' });
  }
  if (d.karyoDevDep) out.push({ path: 'pyproject.toml', action: 'skip', what: 'karyo is still a dev dependency', why: d.python.codeForm.length ? 'the app imports it; remove those imports first' : `remove it with your package manager${d.packageManager === 'uv' ? ' (uv remove --dev karyo)' : ''}` });
  return out;
}

// ---------------------------------------------------------------- apply

/** Write every create / update / remove (run changes are the caller's). Returns the changes it made. */
export function applyChanges(dir: string, changes: Change[]): Change[] {
  const done: Change[] = [];
  for (const c of changes) {
    const abs = path.resolve(dir, c.path);
    if ((c.action === 'create' || c.action === 'update') && c.content !== undefined) {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, c.content);
      if (c.executable) chmodSync(abs, 0o755);
      done.push(c);
    } else if (c.action === 'remove') {
      rmSync(abs, { recursive: !!c.dir, force: true });
      // folders Karyo made and left empty go too
      for (const p of [path.dirname(abs), path.dirname(path.dirname(abs))]) {
        if (p === dir || !p.startsWith(dir + path.sep)) break;
        try { if (!readdirSync(p).length) rmdirSync(p); else break; } catch { break; }
      }
      done.push(c);
    }
  }
  return done;
}

// ---------------------------------------------------------------- words

export function describeDetection(d: Detection): string[] {
  const l: string[] = [];
  l.push(`project   ${d.dir}${d.gitRoot ? d.inRepo ? ` (in the git repo ${d.gitRoot})` : ' (git repo)' : ' (not a git repo)'}`);
  l.push(`python    ${d.python.packages.length ? d.python.packages.join(', ') : 'no packages'}${d.python.packages.length ? `: ${d.python.codeForm.length ? 'imports karyo (code form)' : d.python.directives ? '`# karyo:` directives' : 'no directives: automatic mode'}` : ''}`);
  if (d.go.modules.length) l.push(`go        ${d.go.modules.join(', ')} (Go has directives only: //karyo:node; no automatic mode yet)`);
  l.push(`tests     ${d.testCommand ? `${d.testRunner}: ${shellCommand(d.testCommand)}` : 'none found'}`);
  l.push(`packages  ${d.packageManager ?? 'no Python package manager'}`);
  l.push(`ci        ${[d.ci.github ? 'GitHub Actions' : '', ...d.ci.other].filter(Boolean).join(', ') || 'none found'}`);
  l.push(`tasks     ${[d.justfile, d.makefile].filter(Boolean).join(', ') || 'no justfile or Makefile'}`);
  l.push(`hooks     ${d.installed.hooks.length ? d.installed.hooks.join(', ') : 'no Karyo refresh hook'}`);
  return l;
}

export function describeChange(c: Change): string {
  const tag = { create: 'create', update: 'update', unchanged: 'ok    ', remove: 'remove', skip: 'skip  ', run: 'run   ' }[c.action];
  return `${tag}  ${c.path}  ${c.what}${c.command ? `: ${shellCommand(c.command)}` : ''}${c.why ? `  (${c.why})` : ''}`;
}
