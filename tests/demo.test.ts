// Demos (src/explainer/demo.ts, `karyo demo`): the demo.json manifest and its checks, the build cache (kept while
// Karyo's version and the demo's files are unchanged, rebuilt when either changes, older builds pruned,
// $KARYO_COMPONENTS restored), and the shipped demo built for real through the CLI (--no-open) with every page opened
// from file:// in a headless browser: no errors on any step, and every link on the map names a page that was built.
//
// Every file this writes is under $KARYO_TEST_SANDBOX (else the system's temp folder); HOME, KARYO_HOME and KARYO_DATA
// point there too, so nothing touches the real home or the plugin's data dir.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDemo, demoHash, demoKey, DemoError, listDemos, readDemo } from '../src/explainer/demo';

const ROOT = path.resolve(import.meta.dir, '..');
const DEMOS = path.join(ROOT, 'demos');
const BASE = process.env.KARYO_TEST_SANDBOX ?? tmpdir();
let box = '', runtimeDir = '';

beforeAll(() => {
  mkdirSync(BASE, { recursive: true });
  box = mkdtempSync(path.join(BASE, 'demo-test-'));
  runtimeDir = path.join(box, 'runtime');
});
afterAll(() => rmSync(box, { recursive: true, force: true }));

const spec = (id: string, extra: Record<string, unknown> = {}) => ({
  karyo: 'explainer/1', id, title: `Page ${id}`,
  elements: [{ id: 'c', type: 'card', props: { title: id, body: 'A card.' } }],
  steps: [{ title: 'One', text: 'The only step.' }], ...extra,
});
/** A small demo folder: a landing page and two more, with demo.json `m` merged over the defaults. */
function tinyDemo(name: string, m: Record<string, unknown> = {}): string {
  const dir = path.join(box, 'demos', name);
  mkdirSync(path.join(dir, 'pages'), { recursive: true });
  mkdirSync(path.join(dir, 'shared'), { recursive: true });
  for (const id of ['home', 'one', 'two']) writeFileSync(path.join(dir, 'pages', `${id}.explainer.json`), JSON.stringify(spec(id)));
  writeFileSync(path.join(dir, 'demo.json'), JSON.stringify({ title: 'Tiny', landing: 'pages/home.explainer.json', components: 'shared', specs: ['pages/one.explainer.json', 'pages/two.explainer.json'], ...m }));
  return dir;
}

describe('manifest', () => {
  test('the shipped claude-code demo: a landing page and 21 explainers, one page each', () => {
    const d = readDemo(path.join(DEMOS, 'claude-code'));
    expect(d.manifest.title).toBe('Claude Code, explained');
    expect(d.pages.length).toBe(22);
    expect(d.pages[0]!.file).toBe('index.html');
    expect(new Set(d.pages.map((p) => p.file)).size).toBe(22);
    for (const p of d.pages.slice(1)) expect(p.file).toBe(`${p.id}.html`);
    expect(d.components && existsSync(path.join(d.components, 'terminal/component.json'))).toBe(true);
    const listed = listDemos(DEMOS).find((x) => x.name === 'claude-code');
    expect(listed).toMatchObject({ title: 'Claude Code, explained', pages: 22 });
    expect(listed!.problem).toBeUndefined();
  });

  test('the shipped sources are only the shippable set', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(path.relative(path.join(DEMOS, 'claude-code'), p)); } };
    walk(path.join(DEMOS, 'claude-code'));
    const ok = /^(README\.md|demo\.json|explainers\/[^/]+\/[^/]+\.explainer\.json|(explainers\/[^/]+\/|index\/)?components\/[^/]+\/(component\.json|template\.html|style\.css)|index\/index\.explainer\.json)$/;
    expect(files.filter((f) => !ok.test(f.split(path.sep).join('/')))).toEqual([]);
    const m = JSON.parse(readFileSync(path.join(DEMOS, 'claude-code/demo.json'), 'utf8'));
    const onDisk = files.filter((f) => f.startsWith('explainers') && f.endsWith('.explainer.json')).map((f) => f.split(path.sep).join('/')).sort();
    expect([...m.specs].sort()).toEqual(onDisk);
  });

  test('broken manifests are clear errors', () => {
    const bad = (m: Record<string, unknown>, re: RegExp) => {
      const dir = tinyDemo(`bad-${Math.random().toString(36).slice(2, 8)}`, m);
      expect(() => readDemo(dir)).toThrow(DemoError);
      expect(() => readDemo(dir)).toThrow(re);
    };
    bad({ title: '' }, /needs a "title"/);
    bad({ landing: undefined }, /needs a "landing"/);
    bad({ specs: 'pages/one.explainer.json' }, /needs "specs"/);
    bad({ specs: ['pages/missing.explainer.json'] }, /doesn't exist/);
    bad({ specs: ['../elsewhere.explainer.json'] }, /outside the demo's folder/);
    bad({ components: 'nowhere' }, /components folder "nowhere"/);
    bad({ specs: ['pages/one.explainer.json', 'pages/../pages/one.explainer.json'] }, /two pages named one\.html/);
    const dir = tinyDemo('bad-json');
    writeFileSync(path.join(dir, 'demo.json'), '{ "title": ');
    expect(() => readDemo(dir)).toThrow(/not valid JSON/);
    expect(listDemos(path.join(box, 'demos')).find((d) => d.name === 'bad-json')?.problem).toMatch(/not valid JSON/);
  });
});

describe('cache', () => {
  test('kept while unchanged; rebuilt when a source or the version changes; older builds pruned', async () => {
    const dir = tinyDemo('cache');
    const cacheRoot = path.join(box, 'cache');
    const prev = process.env.KARYO_COMPONENTS;
    process.env.KARYO_COMPONENTS = '/somewhere/else';
    const a = await buildDemo(readDemo(dir), { version: '1.0.0', cacheRoot, runtimeDir });
    expect(process.env.KARYO_COMPONENTS).toBe('/somewhere/else');   // restored after the build
    if (prev === undefined) delete process.env.KARYO_COMPONENTS; else process.env.KARYO_COMPONENTS = prev;
    expect(a.built).toBe(true);
    expect(a.dir).toBe(path.join(cacheRoot, 'cache', a.key));
    expect(a.key).toBe(`1.0.0-${demoHash(dir)}`);
    expect(readdirSync(a.dir).filter((f) => f.endsWith('.html')).sort()).toEqual(['index.html', 'one.html', 'two.html']);
    expect(readFileSync(a.index, 'utf8')).toContain('<title>Page home</title>');

    const b = await buildDemo(readDemo(dir), { version: '1.0.0', cacheRoot, runtimeDir });
    expect(b.built).toBe(false);
    expect(b.dir).toBe(a.dir);
    expect(b.pages.length).toBe(3);

    // a dotfile (.DS_Store) is not a source
    writeFileSync(path.join(dir, 'pages', '.DS_Store'), 'x');
    expect(demoKey(dir, '1.0.0')).toBe(a.key);

    writeFileSync(path.join(dir, 'pages', 'two.explainer.json'), JSON.stringify(spec('two', { title: 'Page two, edited' })));
    const c = await buildDemo(readDemo(dir), { version: '1.0.0', cacheRoot, runtimeDir });
    expect(c.built).toBe(true);
    expect(c.key).not.toBe(a.key);
    expect(readFileSync(path.join(c.dir, 'two.html'), 'utf8')).toContain('Page two, edited');
    expect(existsSync(a.dir)).toBe(false);   // the older build is gone

    const d = await buildDemo(readDemo(dir), { version: '1.0.1', cacheRoot, runtimeDir });
    expect(d.built).toBe(true);
    expect(d.key.startsWith('1.0.1-')).toBe(true);
    expect(readdirSync(path.join(cacheRoot, 'cache'))).toEqual([d.key]);

    // a page deleted from the cache is noticed; --force rebuilds regardless
    rmSync(path.join(d.dir, 'one.html'));
    expect((await buildDemo(readDemo(dir), { version: '1.0.1', cacheRoot, runtimeDir })).built).toBe(true);
    expect((await buildDemo(readDemo(dir), { version: '1.0.1', cacheRoot, runtimeDir, force: true })).built).toBe(true);
  }, 120_000);

  test('--out builds into that folder, stamped; a broken spec fails with the file and the problem', async () => {
    const dir = tinyDemo('out');
    const out = path.join(box, 'out-here');
    const r = await buildDemo(readDemo(dir), { version: '1.0.0', cacheRoot: path.join(box, 'unused'), runtimeDir, out });
    expect(r.dir).toBe(out);
    expect(existsSync(path.join(out, 'index.html'))).toBe(true);
    expect(existsSync(path.join(box, 'unused'))).toBe(false);
    expect((await buildDemo(readDemo(dir), { version: '1.0.0', cacheRoot: path.join(box, 'unused'), runtimeDir, out })).built).toBe(false);

    writeFileSync(path.join(dir, 'pages', 'one.explainer.json'), JSON.stringify({ ...spec('one'), elements: [{ id: 'c', type: 'no-such-component', props: {} }] }));
    const cacheRoot = path.join(box, 'cache-broken');
    const err = await buildDemo(readDemo(dir), { version: '1.0.0', cacheRoot, runtimeDir }).catch((e) => e);
    expect(err).toBeInstanceOf(DemoError);
    expect(err.message).toContain('pages/one.explainer.json');
    expect(err.message).toContain('no-such-component');
    expect(readdirSync(path.join(cacheRoot, 'out'))).toEqual([]);   // no half-built folder left behind
  }, 120_000);
});

// ---------------------------------------------------------------- the real demo, through the CLI

const chromeOk = await (async () => {
  try { const { chromium } = await import('playwright-core'); const b = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }); await b.close(); return true; } catch { return false; }
})();

describe('karyo demo claude-code', () => {
  let env: Record<string, string> = {};
  let result: any;
  const cli = async (...argv: string[]) => {
    const p = Bun.spawn([process.execPath, '--no-env-file', '--config=/dev/null', path.join(ROOT, 'cli/karyo.ts'), ...argv], { cwd: box, env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };

  beforeAll(() => {
    const home = path.join(box, 'home');
    mkdirSync(home, { recursive: true });
    env = { ...(process.env as Record<string, string>), HOME: home, KARYO_HOME: path.join(home, '.adenine/karyo'), KARYO_DATA: path.join(box, 'data') };
    delete env.CLAUDE_PLUGIN_DATA;
    delete env.KARYO_COMPONENTS;
  });

  test('lists the demos', async () => {
    const r = await cli('demo', '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).demos.map((d: any) => d.name)).toContain('claude-code');
    const t = await cli('demo');
    expect(t.out).toContain('claude-code');
    expect(t.out).toContain('Claude Code, explained (22 pages)');
  });

  test('an unknown demo is a one-line error', async () => {
    const r = await cli('demo', 'nope');
    expect(r.code).toBe(2);
    expect(r.err.trim()).toBe('karyo: no demo "nope" (have: claude-code)');
  });

  test('builds every page into the data dir, then reuses it', async () => {
    const r = await cli('demo', 'claude-code', '--no-open');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/building 22 pages…[\s\S]*done in [\d.]+ s/);
    expect(r.out).not.toContain('opened');
    const j = await cli('demo', 'claude-code', '--no-open', '--json');
    result = JSON.parse(j.out);
    expect(result.built).toBe(false);
    expect(result.index.startsWith(path.join(box, 'data', 'demos', 'claude-code') + path.sep)).toBe(true);
    expect(result.index.endsWith(`${path.sep}index.html`)).toBe(true);
    expect(r.out).toContain(result.index);
    expect(result.pages.length).toBe(22);
    expect(result.warnings).toEqual([]);
    for (const p of result.pages) expect(existsSync(p.file)).toBe(true);
    expect(existsSync(path.join(box, 'home', '.adenine'))).toBe(false);   // nothing in Karyo's home
  }, 180_000);

  test('every link on the map names a page that was built', () => {
    const files = new Set(readdirSync(result.dir));
    const links = [...readFileSync(path.join(DEMOS, 'claude-code/index/index.explainer.json'), 'utf8').matchAll(/"([^"/]+\.html)"/g)].map((m) => m[1]!);
    expect(new Set(links).size).toBe(21);
    expect(links.filter((l) => !files.has(l))).toEqual([]);
  });

  test.skipIf(!chromeOk)('every page opens from file:// and steps through without errors; the map\'s links resolve', async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
    const problems: string[] = [];
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const check = async (p: { file: string }) => {
        const page = await ctx.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
        page.on('requestfailed', (q) => errors.push(`request failed: ${q.url()}`));
        await page.goto(pathToFileURL(p.file).href);
        await page.waitForFunction(() => (window as any).__karyo?.ready, null, { timeout: 30_000 });
        await page.evaluate(() => (window as any).__karyo.ready);
        // motion 0: each step lands at once (the same end state), so 22 pages take seconds, not minutes
        await page.evaluate(() => (window as any).KaryoExplainer?.setMotion?.(0));
        const n = await page.evaluate(() => (window as any).__karyo.stages.explainer.scene.stepCount as number);
        const hrefs = new Set<string>();
        for (let i = 0; i < n; i++) {
          await page.evaluate((k) => (window as any).__karyo.stages.explainer.scene.go(k), i);
          await page.waitForFunction(() => { const s = (window as any).__karyo.stages.explainer; return !s.playing && s.t >= s.duration; }, null, { timeout: 10_000 });
          for (const h of await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => (a as HTMLAnchorElement).href))) hrefs.add(h);
        }
        for (const h of hrefs) if (h.startsWith('file:') && !existsSync(decodeURIComponent(new URL(h).pathname))) errors.push(`link to a missing file: ${h}`);
        if (path.basename(p.file) === 'index.html' && new Set([...hrefs].filter((h) => h.endsWith('.html'))).size !== 21) errors.push(`the map links ${hrefs.size} pages, expected 21`);
        if (errors.length) problems.push(`${path.basename(p.file)} (${n} steps): ${errors.join('; ')}`);
        await page.close();
      };
      const queue = [...result.pages];
      await Promise.all(Array.from({ length: 4 }, async () => { for (let p = queue.shift(); p; p = queue.shift()) await check(p); }));
    } finally { await browser.close(); }
    expect(problems).toEqual([]);
  }, 300_000);
});
