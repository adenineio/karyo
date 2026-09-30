// Kits (docs/KITS.md): resolution order and collisions, the schema and `karyo kit check`, kind rendering (cards,
// sections, sizes in the layout).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKits, bundleKits, scaffoldKit, findProjectKits, BUILTIN_KITS_DIR } from '../src/kits/library';
import { checkKit } from '../src/kits/check';
import { KitSet, modelStats, useKits, kitsFor } from '../src/kits/registry';
import { filterNodes, plateInstances, subModel } from '../src/kits/plates';
import { layout, cardHTML, cardKits, route, CARD_W, CARD_H, COL_GAP } from '../src/model/scenes';
import { merge, type Model } from '../src/model/model';
import { loadLibrary } from '../src/explainer/library';
import { validateSpec } from '../src/explainer/validate';

let root = '';
const dirs = { project: '', env: '', home: '', builtin: '' };
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'karyo-kits-'));
  for (const k of Object.keys(dirs) as (keyof typeof dirs)[]) { dirs[k] = join(root, k); await mkdir(dirs[k], { recursive: true }); }
  // the project is a repo: its kits in karyo/kits, found from a subfolder
  await mkdir(join(dirs.project, '.git'));
  await mkdir(join(dirs.project, 'karyo', 'kits'), { recursive: true });
  await mkdir(join(dirs.project, 'app', 'deep'), { recursive: true });
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const at = (level: keyof typeof dirs) => (level === 'project' ? join(dirs.project, 'karyo', 'kits') : dirs[level]);
const load = () => loadKits({ projectDir: join(dirs.project, 'app', 'deep'), env: dirs.env, homeDir: dirs.home, builtinDir: dirs.builtin });

describe('resolution', () => {
  test('project, then $KARYO_KITS, then the shared library, then the built-ins; the nearer one wins, with a warning', async () => {
    await scaffoldKit(at('builtin'), 'base', { kind: 'queue' });
    await scaffoldKit(at('home'), 'shared', { kind: 'queue' });       // hides the built-in kit's queue
    await scaffoldKit(at('home'), 'base', { kind: 'topic' });         // a kit of the same name: hides the built-in kit whole
    await scaffoldKit(at('env'), 'extra', { kind: 'lane' });
    await scaffoldKit(at('project'), 'mine', { kind: 'queue' });      // hides every other queue
    expect(findProjectKits(join(dirs.project, 'app', 'deep'))).toBe(join(dirs.project, 'karyo', 'kits'));
    const lib = await load();
    expect(lib.searched.map((s) => s.source)).toEqual(['project', 'env', 'adenine', 'builtin']);
    expect(lib.kinds.queue!.kit).toBe('mine');
    expect(lib.kinds.queue!.source).toBe('project');
    expect(lib.kinds.lane!.source).toBe('env');
    expect(lib.kinds.topic!.source).toBe('adenine');
    const kitBase = lib.kits.filter((k) => k.name === 'base');
    expect(kitBase).toHaveLength(1);
    expect(kitBase[0]!.source).toBe('adenine');
    const sh = (what: string, name: string) => lib.shadowed.find((s) => s.what === what && s.name === name)!;
    expect(sh('kind', 'queue').used.source).toBe('project');
    expect(sh('kind', 'queue').hidden.map((h) => h.source)).toEqual(['adenine']);   // the built-in kit "base" is hidden whole
    expect(sh('kit', 'base').hidden[0]!.source).toBe('builtin');
    const b = bundleKits(lib);
    expect(b.warnings.some((w) => w.startsWith('kind "queue": kit mine (project'))).toBe(true);
    expect(b.kits.find((k) => k.name === 'shared')!.kinds).toEqual([]);             // its queue lost to the project's
  });
  test('the plugin ships the sequence kit; a project with no kits folder finds none', async () => {
    const lib = await loadKits({ projectDir: root, env: '', homeDir: join(root, 'none'), builtinDir: BUILTIN_KITS_DIR });
    expect(lib.plates.sequence).toMatchObject({ view: 'sequence', from: 'flow', source: 'builtin' });
    expect(lib.problems).toEqual([]);
    expect(findProjectKits(join(dirs.project, '..'))).toBe(null);
  });
});

describe('kit check', () => {
  test('a scaffolded kit and the shipped kits check clean', async () => {
    const r = await checkKit(join(at('project'), 'mine'));
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(r.issues.map((i) => i.message).every((m) => m.includes('TODO'))).toBe(true);
    expect((await checkKit(join(BUILTIN_KITS_DIR, 'sequence'))).issues).toEqual([]);
    expect((await checkKit(join(BUILTIN_KITS_DIR, 'radial'))).issues.filter((i) => i.level === 'error')).toEqual([]);   // only its runs-code warning
  });
  test('schema, required fields, templates against the example, theme tokens, sections, plate types', async () => {
    const dir = await scaffoldKit(root, 'broken', { kind: 'bad' });
    const kind = join(dir, 'kinds', 'bad');
    const kit = JSON.parse(await readFile(join(dir, 'kit.json'), 'utf8'));
    await writeFile(join(dir, 'kit.json'), JSON.stringify({ ...kit, karyo: 'kit/2', colour: 'red', plates: [{ id: 'seq', title: 'S', description: 'd', view: 'sequence', from: 'model' }] }));
    const meta = JSON.parse(await readFile(join(kind, 'component.json'), 'utf8'));
    delete meta.size;
    meta.example = { note: 42 };
    meta.node.sections.push({ id: 'summary', title: 'mine', template: 'items.html' });
    await writeFile(join(kind, 'component.json'), JSON.stringify(meta));
    await writeFile(join(kind, 'template.html'), '<div class="mm-name">{{node.label}}</div>{{#if note}}');
    await writeFile(join(kind, 'style.css'), '.x { color: #ff0000; transition: color 1s; }');
    const r = await checkKit(dir);
    expect(r.ok).toBe(false);
    const has = (path: string, re: RegExp) => expect(r.issues.some((i) => i.path.startsWith(path) && re.test(i.message))).toBe(true);
    has('kit.json#/karyo', /must be "kit\/1"/);
    has('kit.json#/colour', /unknown property/);
    has('kit.json#/plates/0/from', /drawn from a flow/);
    has('kinds/bad', /size/);
    has('kinds/bad/component.json#/example/note', /must be string/);
    has('kinds/bad/component.json#/node/sections/1/id', /board's own/);
    has('kinds/bad/template.html', /broken template/);
    expect(r.issues.find((i) => /hard-codes colours/.test(i.message))!.level).toBe('error');
    expect(r.issues.find((i) => /transition/.test(i.message))!.level).toBe('warn');
  });
});

// a model with a kit kind: a queue (fields, a recorded call), a service that publishes to it, and a store
const M = (): Model => merge([{ karyo: 1, nodes: [
  { id: 'a.api', kind: 'service', label: 'API', group: 'a', sources: ['declared'], ref: { file: 'a/api.py', line: 3 } },
  { id: 'a.jobs', kind: 'queue', label: 'Jobs', group: 'a', sources: ['declared'], fields: { depth: 7 } } as never,
  { id: 'a.db', kind: 'store', label: 'DB', group: 'a', sources: ['declared'] },
], edges: [{ from: 'a.api', to: 'a.jobs', kind: 'publishes', sources: ['declared'] }, { from: 'a.api', to: 'a.db', kind: 'writes', sources: ['declared'] }],
flows: [{ id: 'f', trace: 't', spans: [{ id: '1', parent: null, node: 'a.api', label: 'post', start: 0, end: 5 }, { id: '2', parent: '1', node: 'a.jobs', label: 'enqueue', start: 1, end: 2 }] }] }]);
const kitsWithQueue = async () => {
  const dir = join(root, 'render', 'q');
  if (!(await Bun.file(join(dir, 'kit.json')).exists())) {
    await scaffoldKit(join(root, 'render'), 'q', { kind: 'queue' });
    const kind = join(dir, 'kinds', 'queue'), meta = JSON.parse(await readFile(join(kind, 'component.json'), 'utf8'));
    meta.props = { type: 'object', properties: { depth: { type: 'number' }, unit: { type: 'string', default: 'jobs' } } };
    meta.size = { w: 240, h: 120 };
    meta.node.category = 'async';
    meta.node.sections = [{ id: 'ops', title: 'operations', noun: 'operations', template: 'items.html' }];
    await writeFile(join(kind, 'component.json'), JSON.stringify(meta));
    await writeFile(join(kind, 'template.html'), '<div class="mm-top"><span class="mm-kind">{{node.kindLabel}}</span></div><div class="mm-name">{{node.label}}</div><div class="d">{{depth}} {{unit}} · {{stats.calls}} calls · {{stats.callers}}</div><div class="mm-ref">{{node.where}}</div>');
    await writeFile(join(kind, 'items.html'), '{{#each stats.ops}}<div data-item="{{label}}">{{label}} ×{{count}}</div>{{/each}}');
  }
  const lib = await loadKits({ extra: [join(root, 'render')], env: '', homeDir: join(root, 'none'), builtinDir: BUILTIN_KITS_DIR });
  return new KitSet(bundleKits(lib));
};

describe('node kinds on the model views', () => {
  test('a kit kind renders its template with its fields (and the schema defaults), node.* and stats.*; other kinds keep the default card', async () => {
    const kits = await kitsWithQueue(), m = M();
    const kx = cardKits(m, kits);
    const q = m.nodes.find((n) => n.id === 'a.jobs')!;
    const html = cardHTML(q, kx);
    expect(html).toContain('class="pl-card mm-card is-kit kc-queue is-ext"');
    expect(html).toContain('id="n-a_jobs"');
    expect(html).toContain('7 jobs · 1 calls · API');
    expect(html).toContain('<span class="mm-kind">queue</span>');
    expect(html.endsWith('</div>')).toBe(true);
    const api = cardHTML(m.nodes.find((n) => n.id === 'a.api')!, kx);
    expect(api).not.toContain('is-kit');
    expect(api).toContain('<span class="mm-kind">service</span>');
    expect(kits.sections(q, modelStats(m).get('a.jobs'))[0]).toMatchObject({ id: 'ops', html: '<div class="ks-queue"><div data-item="enqueue">enqueue ×1</div></div>' });
    expect(kits.css()).toContain('.mm-card.kc-queue { width: 240px; height: 120px; }');
    expect(kits.css()).toContain('.ks-queue .items');
    // a kind's default category, at view time only
    expect(kits.decorate(m).nodes.find((n) => n.id === 'a.jobs')!.category).toBe('async');
    expect(m.nodes.find((n) => n.id === 'a.jobs')!.category).toBeUndefined();
  });
  test('the layout places and routes by a kit card\'s size: columns as wide as their widest card, cards stacked at their heights', async () => {
    const kits = await kitsWithQueue(), m = M();
    const L = layout(m, undefined, 0, 480, kits);
    expect(L.size.get('a.jobs')).toEqual({ w: 240, h: 120 });
    expect(L.size.get('a.db')).toEqual({ w: CARD_W, h: CARD_H });
    const jobs = L.pos.get('a.jobs')!, db = L.pos.get('a.db')!;
    expect(jobs.layer).toBe(db.layer);
    expect(L.colW[jobs.layer]).toBe(240);
    expect(jobs.right).toBe(jobs.x + 240);
    // the next card down starts below the taller card
    const [top, bottom] = [jobs, db].sort((a, b) => a.y - b.y);
    expect(bottom!.y - top!.y).toBe((top === jobs ? 120 : CARD_H) + 16);
    const g = L.groups.find((x) => x.id === 'a')!;
    expect(g.w).toBe(L.colX[jobs.layer]! + 240 - L.colX[0]! + 28);
    // a forward wire from a narrow card turns in the gutter past its column's widest card
    const p = route({ ...L.pos.get('a.api')!, right: L.pos.get('a.api')!.x + 400 }, jobs, { x: 100, y: 10 }, { x: 900, y: 80 });
    expect(p.pts.some((q) => Math.abs(q.x - (L.pos.get('a.api')!.x + 403 + COL_GAP / 2 - 3)) < 12)).toBe(true);
    // without kits nothing changes: the default card everywhere
    const L0 = layout(m, undefined, 0, 480, new KitSet({ kits: [], kinds: {}, plates: {}, warnings: [] }));
    expect([...L0.size.values()].every((s) => s.w === CARD_W && s.h === CARD_H)).toBe(true);
  });
  test('a model is drawn with the kits bound to it, else the page\'s', async () => {
    const kits = await kitsWithQueue(), m = M();
    expect(kitsFor(m).kind('queue')).toBeUndefined();
    useKits(m, kits);
    expect(kitsFor(m).kind('queue')!.kit).toBe('q');
    expect(layout(m).size.get('a.jobs')).toEqual({ w: 240, h: 120 });
  });
});
