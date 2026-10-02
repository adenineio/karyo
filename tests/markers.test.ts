// Comment markers (src/cli/markers.ts): the `// karyo:` grammar shared with the Go and Python SDKs (parity cases from
// their tests), declarations found below markers, what a whole project's scan emits and warns about, and `karyo init` /
// `karyo refresh` on a small Swift package (Karyo's home and HOME sandboxed).
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LANGS, SWIFT, parseKV, readMarkers, scanMarkers, sourceFiles, validate, type MarkerLang } from '../src/cli/markers';
import { detect, describeDetection, planInit } from '../src/cli/init';

const ROOT = path.resolve(import.meta.dir, '..');
const BASE = process.env.KARYO_TEST_SANDBOX?.trim() || os.tmpdir();
mkdirSync(BASE, { recursive: true });
const SANDBOX = mkdtempSync(path.join(BASE, 'karyo-markers-'));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));
const ENV = { ...process.env, HOME: path.join(SANDBOX, 'home'), KARYO_HOME: path.join(SANDBOX, 'karyo-home'), CLAUDE_CONFIG_DIR: path.join(SANDBOX, 'claude'),
  GIT_CONFIG_GLOBAL: path.join(SANDBOX, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', KARYO_CLI: '' };
writeFileSync(ENV.GIT_CONFIG_GLOBAL, '[user]\n\tname = Sample Dev\n\temail = dev@example.invalid\n[init]\n\tdefaultBranch = main\n');

const read = (src: string, L: MarkerLang = SWIFT) => readMarkers(src, 'm.swift', L);
const problems = (src: string) => read(src).problems.map((p) => p.message);
let n = 0;
function write(files: Record<string, string>): string {
  const dir = path.join(SANDBOX, `p-${++n}`);
  for (const [rel, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); }
  return dir;
}

describe('the grammar (parity with the Go and Python SDKs)', () => {
  test('list keys add up, any other key given twice is reported (Go: TestParseKVListKeysAddUpOtherRepeatsAreReported)', () => {
    const { kv, errors } = parseKV('id=a calls=b calls=c,d label="A b" label=x');
    expect(kv.calls).toBe('b,c,d');
    expect(kv.id).toBe('a');
    expect(errors).toEqual(['label given twice']);
  });

  test('both spellings are markers; prose and `///` are not (Go: TestDirectiveTextAcceptsBothSpellings)', () => {
    for (const s of ['//karyo:node id=a\nfunc f() {}\n', '// karyo:node id=a\nfunc f() {}\n']) expect(read(s).directives.map((d) => d.kv.id)).toEqual(['a']);
    expect(read('// see karyo: docs\n/// karyo:node id=a\nfunc f() {}\n').directives).toEqual([]);
  });

  test('continuation lines are `//` and three or more spaces', () => {
    const p = read('// karyo:node id=a.b tags=x\n//   tags=y calls=c\n// calls=d\nfunc f() {}\n');
    expect(p.problems).toEqual([]);
    expect(p.directives[0]!.kv.tags).toBe('x,y');
    expect(p.directives[0]!.kv.calls).toBe('c');
  });

  test('ids (Go: TestIDs)', () => {
    for (const [id, ok] of [['payments.charge', true], ['acme.example/payments', true], ['a b', false], ['a->b', false]] as const) {
      expect(validate('edge', { from: 'x', to: id }).length === 0).toBe(ok);
    }
  });

  test.each([
    ['// karyo:node id=x kind=servce\nfunc f() {}\n', "did you mean 'service'"],
    ['// karyo:node id=x lable=X\nfunc f() {}\n', "no key 'lable'"],
    ['// karyo:nod id=x\nfunc f() {}\n', 'unknown directive karyo:nod'],
    ['// karyo:node kind=service\nfunc f() {}\n', 'needs id='],
    ['let x = 1  // karyo:node id=x\n', 'on its own line'],
    ['// karyo:node id=x label="open\nfunc f() {}\n', 'unterminated'],
    ['// karyo:edge from=a to=b kind=cals\n', 'not an edge kind'],
    ['// karyo:edge from=a kind=calls\n', 'needs from= and to='],
    ['// karyo:external id=x calls=y\n', "has no key 'calls'"],
    ['// karyo:node id=x calls=a,b->c\nfunc f() {}\n', "'b->c' is not a valid node id"],
    ['// karyo:span node=x\nfunc f() {}\n', 'unknown directive karyo:span'],
  ])('a typo is a problem, never a node: %p', (src, needle) => {
    const p = read(src);
    expect(p.problems.some((x) => x.message.includes(needle))).toBe(true);
    expect(p.directives).toEqual([]);
  });

  test('a kit kind is accepted, a near miss of a built-in kind is not, edge kinds stay strict (Python: test_kit_kinds)', () => {
    expect(problems('// karyo:node id=pkg.jobs kind=worker label=Jobs\nclass Jobs {}\n')).toEqual([]);
    expect(problems('// karyo:node id=pkg.x kind=servce\nfunc f() {}\n').join()).toContain("did you mean 'service'");
    expect(problems('// karyo:edge from=a to=b kind=worker\n').join()).toContain('not an edge kind');
  });

  test('text in strings and block comments is not a marker (Python: test_directive_text_in_a_string_is_not_a_directive)', () => {
    expect(read('let doc = """\n// karyo:node id=x kind=nope\n"""\n').directives).toEqual([]);
    expect(problems('let doc = """\n// karyo:node id=x kind=nope\n"""\n')).toEqual([]);
    expect(problems('/* outer /* nested */\n// karyo:node id=x kind=nope\n*/\nlet s = "// karyo:node kind=nope"\n')).toEqual([]);
  });
});

describe('declarations below markers', () => {
  const SRC = `import Foundation

/// Keeps every habit and its check-ins.
// karyo:node id=data.store kind=store label="Habit store" category=store
//   calls=data.disk
@MainActor
final class HabitStore {
    // karyo:node id=data.store.save
    func save(_ h: Habit) async throws {
        if h.name.isEmpty { return }
        try await disk.write(h)
    }

    // karyo:node id=data.store.count
    var count: Int { items.count }
}

// karyo:node id=data.gone

func later() {}

// karyo:external id=disk label="The disk"
`;
  test('name, qualified symbol, line, source; attributes may sit between, a blank line may not', () => {
    const p = read(SRC);
    expect(p.problems).toEqual([]);
    const by = Object.fromEntries(p.directives.map((d) => [d.kv.id, d]));
    expect(by['data.store']!.decl).toEqual({ line: 7, name: 'HabitStore', symbol: 'HabitStore', start: 3, end: 16 });
    expect(by['data.store']!.summary).toBe('Keeps every habit and its check-ins.');
    expect(by['data.store.save']!.decl).toMatchObject({ line: 9, name: 'save', symbol: 'HabitStore.save', start: 8, end: 12 });
    expect(by['data.store.count']!.decl).toMatchObject({ symbol: 'HabitStore.count', end: 15 });
    expect(by['data.gone']!.decl).toBeUndefined();
    expect(by.disk!.decl).toBeUndefined();
  });

  test('a body-less requirement does not borrow the next declaration\'s body', () => {
    const p = read('protocol Store {\n    // karyo:node id=s.load\n    func load() -> [Int]\n    func save() { }\n}\n');
    expect(p.directives[0]!.decl).toMatchObject({ symbol: 'Store.load', line: 3, end: 3 });
  });
});

describe('scanning a project', () => {
  test('one fragment: declared nodes with refs and code, edges, externals; build folders skipped', () => {
    const dir = write({
      'Package.swift': '// swift-tools-version: 6.0\n',
      'Sources/Core/Store.swift': '// karyo:node id=core.store kind=store calls=core.disk\nstruct Store {\n  func f() {}\n}\n// karyo:external id=core.disk label=Disk\n// karyo:edge from=core.store to=core.disk kind=writes label=save\n',
      'Sources/App/App.swift': '// karyo:node id=app.main kind=service category=entry tags=ui calls=core.store\n@main\nstruct App {}\n',
      '.build/checkouts/Dep/X.swift': '// karyo:node id=dep.x\nfunc x() {}\n',
      'Pods/P/Y.swift': '// karyo:node id=pod.y\nfunc y() {}\n',
    });
    expect(sourceFiles(dir)).toEqual(['Package.swift', 'Sources/App/App.swift', 'Sources/Core/Store.swift']);
    const s = scanMarkers(dir, { version: '0.0.1' });
    expect(s.files).toBe(3);
    expect(s.markers).toBe(4);
    const f = s.fragment;
    expect(f.karyo).toBe(1);
    expect(f.producers).toEqual([{ name: 'karyo markers', lang: 'swift', version: '0.0.1' }]);
    expect(f.checks).toBeUndefined();
    const by = Object.fromEntries(f.nodes.map((x) => [x.id, x]));
    expect(by['app.main']).toMatchObject({ kind: 'service', label: 'App', group: 'app', category: 'entry', tags: ['ui'], module: 'App', lang: 'swift',
      ref: { file: 'Sources/App/App.swift', line: 3, symbol: 'App' }, sources: ['declared'] });
    expect((by['app.main']!.code as any).text).toBe('// karyo:node id=app.main kind=service category=entry tags=ui calls=core.store\n@main\nstruct App {}');
    expect(by['core.disk']).toEqual({ id: 'core.disk', kind: 'external', label: 'Disk', group: 'core', sources: ['declared'] });
    expect(f.edges).toEqual([
      { from: 'app.main', to: 'core.store', kind: 'calls', sources: ['declared'] },
      { from: 'core.store', to: 'core.disk', kind: 'calls', sources: ['declared'] },
      { from: 'core.store', to: 'core.disk', kind: 'writes', label: 'save', sources: ['declared'] },
    ]);
  });

  test('warnings: invalid markers, targets no marker declares (with a did-you-mean), an id declared twice', () => {
    const dir = write({
      'A.swift': '// karyo:node id=a.one calls=a.tow,b.three\nfunc one() {}\n// karyo:node id=a.two\nfunc two() {}\n// karyo:node id=a.one\nfunc again() {}\n// karyo:node id=a.bad kind=servce\nfunc bad() {}\n',
    });
    const s = scanMarkers(dir);
    const msgs = (s.fragment.checks ?? []).map((c) => `${c.code} ${c.message}`);
    expect(msgs).toContainEqual(expect.stringMatching(/^directive-invalid A\.swift:7: kind: 'servce'/));
    expect(msgs).toContainEqual(expect.stringMatching(/^directive-invalid A\.swift:5: node a\.one is declared twice \(also at A\.swift:1\)/));
    expect(msgs).toContainEqual(expect.stringMatching(/^directive-unknown-target A\.swift:1: calls=a\.tow names a node no marker declares \(did you mean 'a\.two'\?\)/));
    expect(msgs).toContainEqual(expect.stringMatching(/^directive-unknown-target A\.swift:1: calls=b\.three/));
    expect(s.fragment.nodes.map((x) => x.id)).toEqual(['a.one', 'a.two']);
  });

  test('no language is special: another `//` language is one more table entry', () => {
    const KT: MarkerLang = { lang: 'kotlin', exts: ['.kt'], quotes: ['"'], multiline: '"""',
      decl: (c) => { const m = /^\s*(?:\w+\s+)*(class|object|interface|fun)\s+(\w+)/.exec(c); return m ? { name: m[2]!, container: m[1] !== 'fun' } : null; } };
    const dir = write({ 'src/Main.kt': 'class Till {\n  // karyo:node id=till.pay kind=service\n  fun pay() {\n  }\n}\n', 'x.swift': '// karyo:node id=s\nfunc s() {}\n' });
    const s = scanMarkers(dir, { langs: [KT] });
    expect(s.fragment.nodes).toMatchObject([{ id: 'till.pay', lang: 'kotlin', module: 'src', ref: { symbol: 'Till.pay', line: 3 } }]);
    expect(LANGS.map((l) => l.lang)).toEqual(['swift']);
  });
});

// ---------------------------------------------------------------- init and refresh on a Swift package

const PACKAGE = `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Tally",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "TallyKit"),
        .executableTarget(name: "TallyApp", dependencies: ["TallyKit"]),
        .testTarget(name: "TallyKitTests", dependencies: ["TallyKit"]),
    ]
)
`;
function karyo(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(ROOT, 'cli/karyo.ts'), ...args], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}
function swiftProject(): string {
  const dir = write({
    'Package.swift': PACKAGE,
    'Sources/TallyKit/Counter.swift': 'public struct Counter {\n    public func add() {}\n}\n',
    'Sources/TallyApp/main.swift': 'import TallyKit\nprint(Counter())\n',
    'justfile': 'build:\n    swift build\n',
  });
  for (const a of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'tally']]) spawnSync('git', a, { cwd: dir, env: ENV });
  return dir;
}

describe('karyo init and refresh on a Swift package', () => {
  test('detect: the manifest, its targets, the sources and their markers', () => {
    const d = detect(swiftProject());
    expect(d.swift).toEqual({ manifest: 'Package.swift', targets: ['TallyKit', 'TallyApp'], testTargets: ['TallyKitTests'], files: 3, markers: 0, filesWithMarkers: 0 });
    expect(d.python.packages).toEqual([]);
    const words = describeDetection(d).join('\n');
    expect(words).toContain('swift     Package.swift: 2 targets (TallyKit, TallyApp), 1 test target');
    expect(words).toContain('markers   0 yet in 3 .swift files');
    expect(words).not.toContain('python');
    const plan = planInit(d, { version: '0.2.0' });
    const just = plan.find((c) => c.path === 'justfile')!;
    expect(just.content).toContain('karyo-scan:');
    expect(just.content).not.toContain('karyo-record');
    expect(plan.some((c) => c.path === 'pyproject.toml')).toBe(false);
  });

  test('an Xcode project is detected by its .xcodeproj (its targets are not read)', () => {
    const d = detect(write({ 'Tally.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n', 'Tally/App.swift': '// karyo:node id=app\n@main struct App {}\n' }));
    expect(d.swift).toMatchObject({ manifest: 'Tally.xcodeproj', targets: null, files: 1, markers: 1 });
  });

  test('init, then markers, then refresh: the model holds the declared parts; init is idempotent', () => {
    const dir = swiftProject();
    const first = karyo(dir, 'init', '--yes');
    expect(first.code).toBe(0);
    expect(first.out).toContain('swift     Package.swift');
    expect(existsSync(path.join(dir, 'karyo/karyo.sh'))).toBe(true);
    expect(karyo(dir, 'init', '--yes').out).toContain('nothing to change');

    // no markers yet: an empty model, and a hint
    const empty = karyo(dir, 'refresh');
    expect(empty.code).toBe(0);
    expect(empty.out).toContain('0 node(s)');
    expect(empty.out).toContain('no markers yet');

    writeFileSync(path.join(dir, 'Sources/TallyKit/Counter.swift'),
      '// karyo:node id=kit.counter kind=type calls=kit.clock\npublic struct Counter {\n    public func add() {}\n}\n// karyo:external id=kit.clock label="System clock"\n');
    writeFileSync(path.join(dir, 'Sources/TallyApp/main.swift'), 'import TallyKit\n// karyo:node id=app.main kind=service calls=kit.counter,kit.missing\nfunc main() {}\n');
    const r = karyo(dir, 'refresh', '--json');
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out);
    expect(s.nodes).toBe(4); // three declared, one stub for the unknown target
    expect(s.checks['directive-unknown-target']).toBe(1);
    const m = JSON.parse(readFileSync(path.join(dir, 'karyo.model.json'), 'utf8'));
    expect(m.nodes.find((x: any) => x.id === 'kit.counter')).toMatchObject({ lang: 'swift', module: 'TallyKit', ref: { file: 'Sources/TallyKit/Counter.swift', symbol: 'Counter' } });
    expect(existsSync(path.join(dir, '.karyo/markers.static.karyo.json'))).toBe(true);
    // --if-stale: current until a source changes
    expect(karyo(dir, 'refresh', '--if-stale', '--json').code).toBe(0);
  });
});
