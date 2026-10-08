// Explainers in Claude artifacts (src/cli/artifact.ts, docs/ARTIFACTS.md): the link record's round trip, stale
// detection (content, runtime, a missing spec, a broken one), the hooks (silent with nothing linked, blocking once and
// not twice), the artifact build target's title, and the CLI end to end (build, link, status, the hook wrapper).
//
// Every file this writes is under $KARYO_TEST_SANDBOX (else the system's temp folder); KARYO_DATA points there too.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ArtifactError, artifactFile, contentHash, reviewCopy, isArtifactUrl, lastTurn, link, readRecord, recordPath, sessionStartHook, sha256,
  status, stopHook, unlink, type Render,
} from '../src/cli/artifact';
import { ensureRuntime, renderHtml, shortTitle } from '../src/explainer/build';

const ROOT = path.resolve(import.meta.dir, '..');
const BASE = process.env.KARYO_TEST_SANDBOX ?? tmpdir();
let box = '';
beforeAll(() => { mkdirSync(BASE, { recursive: true }); box = realpathSync(mkdtempSync(path.join(BASE, 'artifact-test-'))); });
afterAll(() => rmSync(box, { recursive: true, force: true }));

const URL1 = 'https://claude.ai/artifact/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const URL2 = 'https://claude.ai/artifact/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

/** A small made-up explainer. */
const spec = (id: string, title = 'How a kettle boils', body = 'Heat moves into the water.') => ({
  karyo: 'explainer/1', id, title, summary: 'From cold water to steam.',
  elements: [{ id: 'heat', type: 'card', props: { title: 'Heat', body } }, { id: 'steam', type: 'chip', props: { text: 'Steam' } }],
  links: [{ id: 'l', from: 'heat', to: 'steam' }],
  steps: [{ title: 'Heat goes in', show: ['heat'] }, { title: 'Steam comes out', show: '*' }],
});
let n = 0;
/** A fresh project with explainers at docs/<id>/<id>.explainer.json. */
function project(ids: string[] = ['kettle']): string {
  const dir = path.join(box, `p${++n}`);
  for (const id of ids) { mkdirSync(path.join(dir, 'docs', id), { recursive: true }); writeFileSync(path.join(dir, 'docs', id, `${id}.explainer.json`), JSON.stringify(spec(id), null, 2)); }
  return dir;
}
const specOf = (p: string, id = 'kettle') => path.join(p, 'docs', id, `${id}.explainer.json`);

/** A stand-in renderer: a page made of the spec's text and a runtime tag, as cheap as a string. */
let RUNTIME = 'rt-1';
const fakeRender: Render = async (file) => {
  const text = readFileSync(file, 'utf8');
  const j = JSON.parse(text);
  if (j.broken) return { html: '', errors: ['/elements/0 unknown component'] };
  return { html: `<!doctype html><meta name="generator" content="${RUNTIME}"><script type="application/json" id="karyo-bundle">${text}</script>`, errors: [] };
};
const published = async (file: string) => { const { html } = await fakeRender(file); return { hash: sha256(html), content: contentHash(html) }; };

describe('the link record', () => {
  test('link, read back, re-link, unlink', async () => {
    const p = project(['kettle', 'tides']);
    expect(readRecord(p).artifacts).toEqual([]);
    const h = await published(specOf(p));
    const e = link(p, specOf(p), { url: URL1, ...h, title: 'How a kettle boils', at: new Date('2026-10-05T10:00:00Z') });
    expect(e).toEqual({ spec: 'docs/kettle/kettle.explainer.json', url: URL1, hash: h.hash, content: h.content!, title: 'How a kettle boils', publishedAt: '2026-10-05T10:00:00.000Z' });
    link(p, specOf(p, 'tides'), { url: URL2, hash: (await published(specOf(p, 'tides'))).hash });
    const rec = JSON.parse(readFileSync(recordPath(p), 'utf8'));
    expect(rec.karyo).toBe('artifacts/1');
    expect(rec.artifacts.map((a: any) => a.spec)).toEqual(['docs/kettle/kettle.explainer.json', 'docs/tides/tides.explainer.json']);
    expect(readRecord(p).artifacts[0]).toEqual(e);
    // re-linking replaces the entry, never duplicates it
    link(p, specOf(p), { url: URL1, hash: 'a'.repeat(64) });
    expect(readRecord(p).artifacts.filter((a) => a.spec === e.spec).map((a) => a.hash)).toEqual(['a'.repeat(64)]);
    expect(unlink(p, specOf(p))?.url).toBe(URL1);
    expect(unlink(p, specOf(p))).toBeNull();
    expect(readRecord(p).artifacts.map((a) => a.spec)).toEqual(['docs/tides/tides.explainer.json']);
  });

  test('refuses what it can\'t record', () => {
    const p = project();
    expect(() => link(p, specOf(p), { url: 'https://example.com/x', hash: 'a'.repeat(64) })).toThrow(ArtifactError);
    expect(() => link(p, specOf(p), { url: URL1, hash: 'nope' })).toThrow(ArtifactError);
    expect(() => link(p, path.join(box, 'elsewhere.explainer.json'), { url: URL1, hash: 'a'.repeat(64) })).toThrow(/outside the project/);
    expect([URL1, URL2, 'https://claude.ai/artifact/abc123', URL1.replace('/artifact/', '/code/artifact/')].every(isArtifactUrl)).toBe(true);
    expect(['http://claude.ai/artifact/x', 'https://claude.ai.evil.example/artifact/x', 'https://claude.ai/chat/x', 'not a url'].some(isArtifactUrl)).toBe(false);
    mkdirSync(path.join(p, 'karyo'), { recursive: true });
    writeFileSync(recordPath(p), '{ nope');
    expect(() => readRecord(p)).toThrow(/not valid JSON/);
  });

  test('the build lands in .karyo/artifacts/<id>.html', () => {
    const p = project();
    expect(artifactFile(p, specOf(p))).toBe(path.join(p, '.karyo', 'artifacts', 'kettle.html'));
  });
  test('the review copy keeps everything but the runtime, verified byte for byte', async () => {
    const p = project();
    const runtimeDir = path.join(box, 'runtime');
    const rt = await ensureRuntime(runtimeDir);
    const { html } = await renderHtml(specOf(p), { target: 'artifact', runtimeDir });
    const r = reviewCopy(html, rt);
    expect(r.verified).toBe(true);
    expect(r.text.length).toBeLessThan(html.length / 10);
    expect(r.text).toContain(`Karyo runtime ${rt.hash}`);
    expect(r.text).toContain('id="karyo-bundle"');
    expect(r.text).toContain('KaryoExplainer.mount');
    const bad = reviewCopy(html.replace('<script>', '<script>/* tampered */'), rt);
    expect(bad.verified).toBe(false);
  });
});

describe('stale detection', () => {
  test('up to date, then content, runtime, missing and broken', async () => {
    RUNTIME = 'rt-1';
    const p = project(['kettle', 'tides', 'gone']);
    for (const id of ['kettle', 'tides', 'gone']) link(p, specOf(p, id), { url: URL1, ...(await published(specOf(p, id))) });
    let st = await status(p, fakeRender);
    expect(st.linked.map((l) => l.state)).toEqual(['up-to-date', 'up-to-date', 'up-to-date']);

    writeFileSync(specOf(p, 'kettle'), JSON.stringify(spec('kettle', 'How a kettle boils', 'Heat moves in fast.')));
    rmSync(path.join(p, 'docs', 'gone'), { recursive: true });
    st = await status(p, fakeRender);
    const by = Object.fromEntries(st.linked.map((l) => [l.spec.split('/')[1], l]));
    expect([by.kettle!.state, by.kettle!.kind]).toEqual(['stale', 'content']);
    expect([by.tides!.state, by.gone!.kind]).toEqual(['up-to-date', 'missing']);

    RUNTIME = 'rt-2';   // only Karyo changed
    st = await status(p, fakeRender);
    expect(st.linked.find((l) => l.spec.includes('tides'))!.kind).toBe('runtime');

    writeFileSync(specOf(p, 'tides'), JSON.stringify({ ...spec('tides'), broken: true }));
    st = await status(p, fakeRender);
    expect(st.linked.find((l) => l.spec.includes('tides'))!.kind).toBe('broken');
    RUNTIME = 'rt-1';
  });

  test('lists the explainers that aren\'t linked', async () => {
    const p = project(['kettle', 'tides']);
    link(p, specOf(p), { url: URL1, ...(await published(specOf(p))) });
    expect((await status(p, fakeRender, { unlinked: true })).unlinked).toEqual(['docs/tides/tides.explainer.json']);
  });

  test('a real artifact build hashes the same twice and differently after an edit', async () => {
    const p = project();
    const runtimeDir = path.join(box, 'runtime');
    const a = await renderHtml(specOf(p), { target: 'artifact', runtimeDir });
    const b = await renderHtml(specOf(p), { target: 'artifact', runtimeDir });
    expect(sha256(a.html)).toBe(sha256(b.html));
    expect(a.title).toBe('How a kettle boils');
    expect(a.html).toContain('<meta name="karyo-target" content="artifact">');
    writeFileSync(specOf(p), JSON.stringify(spec('kettle', 'How a kettle boils', 'Changed.')));
    const c = await renderHtml(specOf(p), { target: 'artifact', runtimeDir });
    expect(sha256(c.html)).not.toBe(sha256(a.html));
    expect(contentHash(c.html)).not.toBe(contentHash(a.html));
    // a plain build keeps the full title and the adenine default
    const f = await renderHtml(specOf(p), { runtimeDir });
    expect(f.html).not.toContain('karyo-target');
    expect(f.html).not.toContain('followScheme');
  }, 120000);
});

test('artifact titles are two to four words', () => {
  expect(shortTitle('How a kettle boils')).toBe('How a kettle boils');
  expect(shortTitle('How the tides follow the moon')).toBe('How the tides follow');
  expect(shortTitle('The life of a star in the sky')).toBe('The life');
  expect(shortTitle('Photosynthesis')).toBe('Photosynthesis explained');
  expect(shortTitle('Rivers: where they start')).toBe('Rivers: where they start');
  expect(shortTitle('  ')).toBe('Karyo explainer');
});

// ---------------------------------------------------------------- hooks

/** A transcript: an earlier turn, then the current prompt at `at` and the tool uses after it. */
function transcript(dir: string, at: string, tools: unknown[], earlier: unknown[] = []): string {
  const f = path.join(dir, `t${++n}.jsonl`);
  const line = (o: unknown) => JSON.stringify(o);
  const lines = [
    line({ type: 'user', timestamp: '2026-10-05T09:00:00.000Z', message: { role: 'user', content: 'earlier' } }),
    ...earlier.map((input) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input }] } })),
    line({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: 'now' }] } }),
    ...tools.map((input) => line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Edit', input }] } })),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] } }),
  ];
  writeFileSync(f, lines.join('\n') + '\n');
  return f;
}
const opts = { render: fakeRender, karyo: '/plugin/cli/karyo', skill: '/karyo:artifact' };

describe('hooks', () => {
  test('silent with nothing linked', async () => {
    const p = project();
    const t = transcript(p, new Date().toISOString(), [{ file_path: specOf(p) }]);
    expect(await stopHook(p, { session_id: 's', transcript_path: t }, opts)).toBeNull();
    expect(await sessionStartHook(p, opts)).toBeNull();
    // the wrapper exits before bun when there is no record: no output, exit 0
    const r = Bun.spawnSync(['sh', path.join(ROOT, 'scripts/plugin/artifact-hook.sh'), 'stop'], { stdin: Buffer.from('{}'), env: { ...process.env, CLAUDE_PROJECT_DIR: p } });
    expect([r.exitCode, r.stdout.toString(), r.stderr.toString()]).toEqual([0, '', '']);
  });

  test('silent when everything linked is up to date, or the turn touched no explainer', async () => {
    const p = project();
    link(p, specOf(p), { url: URL1, ...(await published(specOf(p))) });
    const t = transcript(p, new Date().toISOString(), [{ file_path: specOf(p) }]);
    expect(await stopHook(p, { session_id: 's', transcript_path: t }, opts)).toBeNull();
    expect(await sessionStartHook(p, opts)).toBeNull();
    // stale, but this turn only touched other files (and the spec is older than the prompt)
    writeFileSync(specOf(p), JSON.stringify(spec('kettle', 'How a kettle boils', 'Edited by hand.')));
    const old = new Date(Date.now() - 3600_000);
    utimesSync(specOf(p), old, old);
    const t2 = transcript(p, new Date().toISOString(), [{ file_path: path.join(p, 'README.md') }], [{ file_path: specOf(p) }]);
    expect(await stopHook(p, { session_id: 's', transcript_path: t2 }, opts)).toBeNull();
    // the session start notices it: one line
    const s = await sessionStartHook(p, opts) as any;
    expect(s.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(s.hookSpecificOutput.additionalContext.split('\n')).toHaveLength(1);
    expect(s.hookSpecificOutput.additionalContext).toContain('docs/kettle/kettle.explainer.json (changed)');
  });

  test('blocks once, and not twice', async () => {
    const p = project();
    link(p, specOf(p), { url: URL1, ...(await published(specOf(p))) });
    writeFileSync(specOf(p), JSON.stringify(spec('kettle', 'How a kettle boils', 'Edited this turn.')));
    const t = transcript(p, new Date(Date.now() - 60_000).toISOString(), [{ file_path: specOf(p) }]);
    const first = await stopHook(p, { session_id: 's1', transcript_path: t, stop_hook_active: false }, opts) as any;
    expect(first.decision).toBe('block');
    expect(first.reason).toContain(`/plugin/cli/karyo" artifact build "docs/kettle/kettle.explainer.json"`);
    expect(first.reason).toContain(`to the SAME url ${URL1}`);
    expect(first.reason).toContain('/karyo:artifact');
    // Claude kept going because of the block, and stops again: never a second block
    expect(await stopHook(p, { session_id: 's1', transcript_path: t, stop_hook_active: true }, opts)).toBeNull();
    // a later stop in the same session, same stale state (Claude couldn't republish): still not again
    expect(await stopHook(p, { session_id: 's1', transcript_path: t, stop_hook_active: false }, opts)).toBeNull();
    // a new change is a new state: it blocks once more
    writeFileSync(specOf(p), JSON.stringify(spec('kettle', 'How a kettle boils', 'Edited again.')));
    expect(((await stopHook(p, { session_id: 's1', transcript_path: t }, opts)) as any)?.decision).toBe('block');
  });

  test('a turn touches an explainer by a tool input or by a linked file changed since its prompt', async () => {
    const p = project();
    link(p, specOf(p), { url: URL1, ...(await published(specOf(p))) });
    writeFileSync(specOf(p), JSON.stringify(spec('kettle', 'How a kettle boils', 'Changed by a shell command.')));
    // no tool names the spec (a sed in Bash, say), but it changed after the prompt
    const t = transcript(p, new Date(Date.now() - 60_000).toISOString(), [{ command: 'make docs' }]);
    expect(((await stopHook(p, { session_id: 'm', transcript_path: t }, opts)) as any)?.decision).toBe('block');
  });

  test('lastTurn reads only the current turn', () => {
    const p = project();
    const t = transcript(p, '2026-10-05T10:00:00.000Z', [{ file_path: 'b.txt' }], [{ file_path: 'a.explainer.json' }]);
    const turn = lastTurn(t);
    expect(turn.start).toBe(Date.parse('2026-10-05T10:00:00.000Z'));
    expect(turn.inputs).toEqual([{ file_path: 'b.txt' }]);
    expect(lastTurn(path.join(p, 'no-such.jsonl'))).toEqual({ start: null, inputs: [] });
  });
});

// ---------------------------------------------------------------- the CLI, end to end

describe('karyo artifact (CLI)', () => {
  const karyo = (cwd: string, args: string[], stdin?: string) => {
    const r = Bun.spawnSync([process.execPath, '--no-env-file', '--config=/dev/null', path.join(ROOT, 'cli/karyo.ts'), ...args], {
      cwd, stdin: stdin === undefined ? undefined : Buffer.from(stdin), env: { ...process.env, KARYO_DATA: path.join(box, 'data'), KARYO_HOME: path.join(box, 'home') },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test('build, link, status, then a stale edit through the hook wrapper', () => {
    const p = project();
    Bun.spawnSync(['git', 'init', '-q'], { cwd: p });
    const b = karyo(p, ['artifact', 'build', 'docs/kettle', '--json']);
    expect(b.code).toBe(0);
    const built = JSON.parse(b.out);
    expect(built.html).toBe(path.join(p, '.karyo', 'artifacts', 'kettle.html'));
    expect(built.hash).toBe(sha256(readFileSync(built.html)));
    expect(built.bytes).toBeLessThan(16 * 1024 * 1024);
    expect(built.title).toBe('How a kettle boils');
    expect(readFileSync(path.join(p, '.karyo', 'artifacts', '.gitignore'), 'utf8')).toContain('*');

    expect(karyo(p, ['artifact', 'link', 'docs/kettle', URL1]).code).toBe(0);
    expect(readRecord(p).artifacts[0]!.hash).toBe(built.hash);
    let st = JSON.parse(karyo(p, ['artifact', 'status', '--json']).out);
    expect(st.linked.map((l: any) => l.state)).toEqual(['up-to-date']);

    writeFileSync(specOf(p), JSON.stringify(spec('kettle', 'How a kettle boils', 'Edited.')));
    st = JSON.parse(karyo(p, ['artifact', 'status', '--json']).out);
    expect([st.linked[0].state, st.linked[0].kind]).toEqual(['stale', 'content']);

    const t = transcript(p, new Date(Date.now() - 60_000).toISOString(), [{ file_path: specOf(p) }]);
    const hook = Bun.spawnSync(['sh', path.join(ROOT, 'scripts/plugin/artifact-hook.sh'), 'stop'], {
      stdin: Buffer.from(JSON.stringify({ session_id: 'cli', transcript_path: t, stop_hook_active: false })),
      env: { ...process.env, CLAUDE_PROJECT_DIR: p, KARYO_DATA: path.join(box, 'data'), KARYO_HOME: path.join(box, 'home') },
    });
    expect(hook.exitCode).toBe(0);
    expect(JSON.parse(hook.stdout.toString()).decision).toBe('block');

    expect(karyo(p, ['artifact', 'unlink', 'docs/kettle']).code).toBe(0);
    expect(readRecord(p).artifacts).toEqual([]);
    expect(existsSync(recordPath(p))).toBe(true);
  }, 120000);

  test('link without a build says to build first', () => {
    const p = project();
    const r = karyo(p, ['artifact', 'link', 'docs/kettle', URL1]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('karyo artifact build');
  });
});
