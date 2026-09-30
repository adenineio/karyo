// Code in kits (docs/KITS.md "Code in kits"): a kit's code and its hash (any byte changed asks again), the trust store
// (in a sandboxed Karyo home, never the user's, never the project), reading scripts safely, the dev server's guard and
// trust endpoint (a foreign origin, a sandboxed frame's null origin and a missing token are refused), and, in Chrome,
// that a page never runs an untrusted kit's script.
//
// Every file this writes is under $KARYO_TEST_SANDBOX (else the system's temp folder); HOME and KARYO_HOME point there
// too, so nothing here can touch the real ~/.adenine.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = resolve(import.meta.dir, '..');
const FIXTURE = join(ROOT, 'tests/fixtures/code-kit-project');
const BASE = process.env.KARYO_TEST_SANDBOX ?? tmpdir();
let box = '', home = '', karyoHome = '';
const realHome = process.env.HOME;
const realKaryoHome = process.env.KARYO_HOME;

beforeAll(async () => {
  await mkdir(BASE, { recursive: true });
  box = await mkdtemp(join(BASE, 'kit-scripts-test-'));
  home = join(box, 'home');
  karyoHome = join(home, '.adenine', 'karyo');
  await mkdir(karyoHome, { recursive: true });
  process.env.HOME = home;
  process.env.KARYO_HOME = karyoHome;
});
afterAll(async () => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realKaryoHome === undefined) delete process.env.KARYO_HOME; else process.env.KARYO_HOME = realKaryoHome;
  await rm(box, { recursive: true, force: true });
});

const { readKit, loadKits, bundleKits, BUILTIN_KITS_DIR } = await import('../src/kits/library');
const { kitHash, sha256, readKitCode } = await import('../src/kits/code');
const { trustFile, trustState, grantTrust, revokeTrust, readTrust } = await import('../src/kits/trust');
const { kitHashInput, KIT_CODE_WARNING, whereWords, noticeWords } = await import('../src/kits/warning');
const { guardMiddleware, trustMiddleware, checkRequest, TOKEN_HEADER } = await import('../src/kits/devserver');
const { spliceMiddleware } = await import('../src/model/splice-store');
const { highlight } = await import('../src/kits/script-plate');
const { checkKit } = await import('../src/kits/check');

/** A fresh copy of the fixture project (a project with the `probe` code kit). */
async function project(name: string) {
  const dir = join(box, name);
  await cp(FIXTURE, dir, { recursive: true });
  return { dir, kit: join(dir, 'karyo', 'kits', 'probe') };
}
const codeOf = async (kitDir: string) => {
  const problems: { dir: string; message: string }[] = [];
  const r = await readKit(kitDir, 'project', problems);
  return { code: r?.kit.code, problems, plates: r?.plates.map((p) => p.id) ?? [] };
};

describe('a kit\'s code and its hash', () => {
  test('kit.json and the scripts its plate types name, each with its sha256, and one hash over them', async () => {
    const { kit } = await project('hash-a');
    const { code, problems } = await codeOf(kit);
    expect(problems).toEqual([]);
    expect(code!.files.map((f) => f.path)).toEqual(['kit.json', 'plates/leave.js', 'plates/probe.js']);
    for (const f of code!.files) expect(f.sha256).toBe(createHash('sha256').update(await readFile(join(kit, f.path))).digest('hex'));
    expect(code!.hash).toBe(kitHash(code!.files));
    expect(code!.hash).toBe(sha256(kitHashInput(code!.files)));
    // the order files are listed in doesn't change the hash
    expect(sha256(kitHashInput([...code!.files].reverse()))).toBe(code!.hash);
    expect(code!.sources['plates/probe.js']).toContain('PROBE RAN');
  });
  test('one byte changed in a script, or in kit.json, is a new version; a file that runs nothing is not', async () => {
    const { kit } = await project('hash-b');
    const h0 = (await codeOf(kit)).code!.hash;
    await writeFile(join(kit, 'README.md'), 'notes: not code\n');
    expect((await codeOf(kit)).code!.hash).toBe(h0);
    await appendFile(join(kit, 'plates', 'probe.js'), ' ');
    const h1 = (await codeOf(kit)).code!.hash;
    expect(h1).not.toBe(h0);
    const j = await readFile(join(kit, 'kit.json'), 'utf8');
    await writeFile(join(kit, 'kit.json'), j.replace('0.1.0', '0.1.1'));
    expect((await codeOf(kit)).code!.hash).not.toBe(h1);
  });
  test('a kit with no script plate has no code; the built-in radial kit has', async () => {
    const lib = await loadKits({ projectDir: box, env: '', homeDir: join(box, 'none'), builtinDir: BUILTIN_KITS_DIR });
    expect(lib.kits.find((k) => k.name === 'sequence')!.code).toBeUndefined();
    const radial = lib.kits.find((k) => k.name === 'radial')!;
    expect(radial.source).toBe('builtin');
    expect(radial.code!.files.map((f) => f.path)).toEqual(['kit.json', 'plates/radial.js']);
    const b = bundleKits(lib).kits.find((k) => k.name === 'radial')!;
    expect(b.code!.where).toBe('built into Karyo');
    expect(b.code!.sources['plates/radial.js']).toContain('export function render');
    expect((await checkKit(join(BUILTIN_KITS_DIR, 'radial'))).ok).toBe(true);
  });
});

describe('reading scripts safely', () => {
  const kitWith = async (name: string, script: string) => {
    const dir = join(box, 'unsafe', name);
    await mkdir(join(dir, 'plates'), { recursive: true });
    await writeFile(join(dir, 'kit.json'), JSON.stringify({ karyo: 'kit/1', name, description: 'x', version: '0.1.0', kinds: [], plates: [{ id: 'p', title: 'P', description: 'p', view: 'script', from: 'model', script }] }));
    return dir;
  };
  test('a path out of the folder, a missing file, a symlink out of the kit, bytes that are not UTF-8: refused, plate left out', async () => {
    const outside = join(box, 'unsafe', 'secret.js');
    await mkdir(join(box, 'unsafe'), { recursive: true });
    await writeFile(outside, 'export function render() {}');
    const cases: [string, string, RegExp, ((d: string) => Promise<void>)?][] = [
      ['up', '../secret.js', /inside the kit's folder/],
      ['abs', '/etc/passwd.js', /inside the kit's folder/],
      ['missing', 'plates/none.js', /missing/],
      ['link', 'plates/link.js', /outside the kit's folder/, (d) => symlink(outside, join(d, 'plates', 'link.js'))],
      ['bytes', 'plates/bad.js', /not UTF-8/, (d) => writeFile(join(d, 'plates', 'bad.js'), Buffer.from([0x65, 0x78, 0xff, 0xfe]))],
    ];
    for (const [name, script, why, setup] of cases) {
      const d = await kitWith(name, script);
      await setup?.(d);
      const { code, problems, plates } = await codeOf(d);
      expect(problems.some((p) => why.test(p.message))).toBe(true);
      expect(plates).toEqual([]);
      expect(code).toBeUndefined();
    }
  });
  test('karyo kit check parses a script as the frame will: it must export render and import nothing', async () => {
    const { kit } = await project('check');
    expect((await checkKit(kit)).ok).toBe(true);
    await writeFile(join(kit, 'plates', 'leave.js'), "import x from './other.js';\nexport function render() {}\n");
    await writeFile(join(kit, 'plates', 'probe.js'), 'export function draw() {}\n');
    let c = await checkKit(kit);
    expect(c.issues.filter((i) => i.level === 'error').map((i) => `${i.path}: ${i.message}`)).toEqual([
      'plates/probe.js: the script exports no render(host, ctx) function',
      "plates/leave.js: the script imports ./other.js: a kit script runs alone in a sealed frame and can't load other files",
    ]);
    await writeFile(join(kit, 'plates', 'probe.js'), 'export function render( {\n');
    c = await checkKit(kit);
    expect(c.issues.some((i) => i.path === 'plates/probe.js' && /doesn't parse/.test(i.message))).toBe(true);
  });
  test('a node kind with a script is refused by the check (only plate types run code)', async () => {
    const { scaffoldKit } = await import('../src/kits/library');
    const d = await scaffoldKit(join(box, 'kinds'), 'k', { kind: 'thing' });
    const f = join(d, 'kinds', 'thing', 'component.json');
    await writeFile(f, JSON.stringify({ ...JSON.parse(await readFile(f, 'utf8')), script: 'card.js' }));
    const c = await checkKit(d);
    expect(c.ok).toBe(false);
    expect(c.issues.some((i) => /a node kind can't run a script/.test(i.message))).toBe(true);
    expect((await codeOf(d)).code).toBeUndefined();
  });
  test('kit.json must be a plain file inside the kit (not a FIFO, not a link out of it)', async () => {
    const outside = join(box, 'unsafe', 'outside-kit.json');
    await mkdir(join(box, 'unsafe'), { recursive: true });
    await writeFile(outside, JSON.stringify({ karyo: 'kit/1', name: 'linked', description: 'x', version: '0.1.0' }));
    const d = join(box, 'unsafe', 'linked');
    await mkdir(d, { recursive: true });
    await symlink(outside, join(d, 'kit.json'));
    const problems: { dir: string; message: string }[] = [];
    expect(await readKit(d, 'project', problems)).toBeNull();
    expect(problems[0]!.message).toMatch(/outside the kit's folder/);
    const f = join(box, 'unsafe', 'fifo');
    await mkdir(f, { recursive: true });
    Bun.spawnSync(['mkfifo', join(f, 'kit.json')]);
    const p2: { dir: string; message: string }[] = [];
    expect(await readKit(f, 'project', p2)).toBeNull();
    expect(p2[0]!.message).toMatch(/not a plain file/);
  });
  test('invisible and direction-changing characters are shown, in the page and the terminal', async () => {
    const { termSafe, hiddenCount } = await import('../src/kits/warning');
    const src = 'const ok = "admin\u202E \u2066";\u200B // \u202Dx';
    expect(hiddenCount(src)).toBe(4);
    const h = highlight(src);
    expect(h).not.toMatch(/[\u202E\u2066\u200B\u202D]/);
    expect(h).toContain('⟦U+202E⟧');
    expect(termSafe('kit \u001b[2K\u001b[1Aevil\u202E')).toBe('kit ⟦U+001B⟧[2K⟦U+001B⟧[1Aevil⟦U+202E⟧');
    expect(termSafe('two\nlines\tok')).toBe('two\nlines\tok');
  });
  test('the source viewer shows code as text, never as markup', () => {
    const h = highlight('const x = "</pre><script>alert(1)</script>"; // <img src=x onerror=alert(1)>\n<b>');
    expect(h).not.toMatch(/<script|<img|<b>|<\/pre>/);
    expect(h).toContain('&lt;script&gt;');
    expect(h).toContain('<span class="k">const</span>');
  });
});

describe('the trust store', () => {
  test('lives in $KARYO_HOME (here: the sandbox), never the real home', () => {
    expect(trustFile()).toBe(join(karyoHome, 'trust.json'));
    expect(trustFile({ KARYO_HOME: join(box, 'elsewhere') })).toBe(join(box, 'elsewhere', 'trust.json'));
    expect(trustFile().startsWith(box)).toBe(true);
  });
  test('trust this version; a one-byte change asks again; take it back', async () => {
    const { kit } = await project('trust-a');
    const file = trustFile();
    const c0 = (await codeOf(kit)).code!;
    expect(trustState(file, kit, c0.hash)).toEqual({ trusted: false });
    const e = grantTrust(file, { dir: kit, name: 'probe', source: 'project' }, c0, 'cli', new Date('2030-04-29T10:00:00Z'));
    expect(e.trusted).toBe('2030-04-29T10:00:00.000Z');
    expect(trustState(file, kit, c0.hash)).toEqual({ trusted: true, at: '2030-04-29T10:00:00.000Z' });
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600');
    // one byte: a new version, not trusted, and the page says it changed
    await appendFile(join(kit, 'plates', 'leave.js'), '\n');
    const c1 = (await codeOf(kit)).code!;
    expect(trustState(file, kit, c1.hash)).toEqual({ trusted: false, changed: true });
    expect(trustState(file, kit, c1.hash, 'project', c1.files)).toEqual({ trusted: false, changed: true, changedFiles: ['plates/leave.js'] });
    // trusting the new version replaces the old one (one entry per kit)
    grantTrust(file, { dir: kit, name: 'probe', source: 'project' }, c1, 'page');
    expect(readTrust(file).kits.filter((k) => k.name === 'probe' && k.dir.endsWith('trust-a/karyo/kits/probe'))).toHaveLength(1);
    expect(trustState(file, kit, c0.hash).trusted).toBe(false);
    expect(revokeTrust(file, kit)).toBe(true);
    expect(trustState(file, kit, c1.hash)).toEqual({ trusted: false });
    expect(revokeTrust(file, kit)).toBe(false);
  });
  test('keyed by the real folder: a symlink to it is the same kit; a copy elsewhere is not', async () => {
    const { kit } = await project('trust-b');
    const file = trustFile();
    const c = (await codeOf(kit)).code!;
    grantTrust(file, { dir: kit, name: 'probe', source: 'project' }, c, 'cli');
    const link = join(box, 'trust-b-link');
    await symlink(kit, link);
    expect(trustState(file, link, c.hash).trusted).toBe(true);
    const { kit: copy } = await project('trust-b-copy');
    expect(trustState(file, copy, c.hash).trusted).toBe(false);
  });
  test('a project can\'t trust itself: trust files in the project are never read', async () => {
    const { dir, kit } = await project('trust-c');
    const c = (await codeOf(kit)).code!;
    const forged = JSON.stringify({ karyo: 'trust/1', kits: [{ dir: kit, name: 'probe', source: 'project', hash: c.hash, files: [], trusted: '2026-01-01T00:00:00Z', via: 'cli' }] });
    for (const f of [join(dir, 'trust.json'), join(dir, 'karyo', 'trust.json'), join(kit, 'trust.json'), join(dir, '.adenine', 'karyo', 'trust.json')]) { await mkdir(join(f, '..'), { recursive: true }); await writeFile(f, forged); }
    const now = (await codeOf(kit)).code!;   // (trust.json in the kit's folder is not code: the hash is the same)
    expect(now.hash).toBe(c.hash);
    expect(trustState(trustFile(), kit, c.hash).trusted).toBe(false);
  });
  test('built-in kits are trusted automatically', () => {
    expect(trustState(trustFile(), join(BUILTIN_KITS_DIR, 'radial'), 'any', 'builtin')).toEqual({ trusted: true, builtin: true });
  });
  test('the warning\'s words', () => {
    expect(KIT_CODE_WARNING).toBe("This kit runs its own JavaScript in this page. It can read the diagram's data and, because Karyo's local server is running, could try to change files in this project. Only trust kits whose code you have read or whose author you trust.");
    expect(whereWords('project', '~/src/app/karyo/kits/x')).toBe('this project (~/src/app/karyo/kits/x)');
    expect(whereWords('adenine', '~/.adenine/karyo/kits/x')).toBe('your kits (~/.adenine/karyo/kits/x)');
    expect(whereWords('builtin', '/opt/karyo/kits/radial')).toBe('built into Karyo');
    expect(noticeWords('x', 'project', 'this project (p)', '2030-04-29T10:00:00Z')).toMatch(/^⚠ runs code from kit x · trusted 2030-04-2\d · this project \(p\)$/);
    expect(noticeWords('radial', 'builtin', 'built into Karyo', null)).toBe('⚠ runs code from kit radial · trusted automatically · built into Karyo');
  });
});

describe('the dev server\'s guard and trust endpoint', () => {
  const TOKEN = 'a'.repeat(64);
  let server: Server, base = '', port = 0, proj = { dir: '', kit: '' };
  const known = new Map<string, { name: string; source: 'project' }>();
  beforeAll(async () => {
    proj = await project('server');
    const { realDir } = await import('../src/kits/trust');
    known.set(realDir(proj.kit), { name: 'probe', source: 'project' });
    const guard = guardMiddleware(TOKEN), trust = trustMiddleware({ file: () => trustFile(), known }), splice = spliceMiddleware(proj.dir);
    server = createServer((req, res) => guard(req, res, () => trust(req, res, () => splice(req, res, () => { res.statusCode = 404; res.end(); }))));
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    port = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => { server?.close(); });

  const splice = { karyo: 'splice/1', id: 'pwned', title: 'pwned', base: { model: 'karyo.model.json', commit: null }, created: '2030-04-29T00:00:00.000Z', updated: '2030-04-29T00:00:00.000Z', ops: [] };
  const file = () => join(proj.dir, 'karyo', 'splices', 'pwned.splice.json');
  const post = (h: Record<string, string>) => fetch(`${base}/__karyo/splice?file=karyo/splices/pwned.splice.json`, { method: 'POST', headers: h, body: JSON.stringify(splice) });
  const self = () => base;

  test('a write from another origin is refused, even with the token', async () => {
    for (const origin of ['http://evil.example', 'http://127.0.0.1:1', `http://localhost:${port}`, 'null']) {
      const r = await post({ origin, [TOKEN_HEADER]: TOKEN });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toMatch(/another origin/);
    }
    expect(existsSync(file())).toBe(false);
  });
  test('a write without the token (or with a wrong one) is refused, even from the server\'s own origin', async () => {
    for (const h of [{ origin: self() }, { origin: self(), [TOKEN_HEADER]: 'b'.repeat(64) }, { origin: self(), [TOKEN_HEADER]: '' }, {}]) {
      const r = await post(h);
      expect(r.status).toBe(403);
      expect((await r.json()).error).toMatch(/key to Karyo's local server/);
    }
    for (const m of ['DELETE', 'PUT']) expect((await fetch(`${base}/__karyo/splice?file=karyo/splices/pwned.splice.json`, { method: m, headers: { origin: self() } })).status).toBe(403);
    expect((await fetch(`${base}/__karyo/layout?file=karyo.layout.json`, { method: 'POST', headers: { origin: self() }, body: '{}' })).status).toBe(403);
    // an absolute-form request target is parsed as the endpoints parse it
    const { connect } = await import('node:net');
    const raw = await new Promise<string>((ok) => { let out = ''; const c = connect(port, '127.0.0.1', () => c.write(`POST http://127.0.0.1:${port}/__karyo/splice?file=karyo/splices/pwned.splice.json HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`)); c.on('data', (d) => (out += d)); c.on('end', () => ok(out)); });
    expect(raw.split('\r\n')[0]).toContain('403');
    // dot segments: URL resolves them, connect's router doesn't, so they're refused outright
    for (const t of ['/__karyo/layout/../../x?file=karyo.layout.json', '/__karyo/layout/%2e%2e/%2E%2E/x?file=karyo.layout.json', '/x/../__karyo/layout?file=karyo.layout.json', '/__karyo/./layout?file=karyo.layout.json']) {
      const r = await new Promise<string>((ok) => { let out = ''; const c = connect(port, '127.0.0.1', () => c.write(`POST ${t} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://evil.example\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`)); c.on('data', (d) => (out += d)); c.on('end', () => ok(out)); });
      expect(r.split('\r\n')[0]).toMatch(/ 40[03] /);
    }
    // any case: connect matches its routes (the layout saver's) without regard to case, so the guard does too
    for (const p of ['/__KARYO/layout', '/__Karyo/splice', '/__karyo/Splice']) expect((await fetch(`${base}${p}?file=karyo/splices/pwned.splice.json`, { method: 'POST', headers: { origin: 'http://evil.example' }, body: '{}' })).status).toBe(403);
    expect(existsSync(file())).toBe(false);
  });
  test('a cross-site read and a non-loopback host are refused; plain reads (the CLI\'s) pass', async () => {
    expect((await fetch(`${base}/__karyo/splices?dir=.`, { headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await fetch(`${base}/__karyo/splices?dir=.`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await fetch(`${base}/__karyo/splices?dir=.`, { headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403);
    expect((await fetch(`${base}/__karyo/splices?dir=.`, { headers: { host: `evil.example:${port}` } })).status).toBe(403);
    expect((await fetch(`${base}/__karyo/splices?dir=.`)).status).toBe(200);
    expect((await fetch(`${base}/__karyo/splices?dir=.`, { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    expect((await fetch(`${base}/other`, { headers: { origin: 'http://evil.example' } })).status).toBe(404);   // not ours: untouched
  });
  test('the page itself (its origin and its token) may write', async () => {
    const r = await post({ origin: self(), [TOKEN_HEADER]: TOKEN, 'sec-fetch-site': 'same-origin' });
    expect(r.status).toBe(200);
    expect(existsSync(file())).toBe(true);
    await rm(file());
  });
  test('checkRequest: the rules in one place', () => {
    const req = (h: Record<string, string>) => ({ headers: h }) as never;
    expect(checkRequest(req({ host: 'localhost:1' }), TOKEN, false).ok).toBe(true);
    expect(checkRequest(req({ host: '[::1]:1', origin: 'http://[::1]:1', [TOKEN_HEADER]: TOKEN }), TOKEN, true).ok).toBe(true);
    expect(checkRequest(req({ host: 'localhost:1', origin: 'null', [TOKEN_HEADER]: TOKEN }), TOKEN, true).ok).toBe(false);
    expect(checkRequest(req({ host: 'karyo.example:1' }), TOKEN, false).ok).toBe(false);
  });

  test('trust: asking needs the token; granting needs the right version of a kit this server served', async () => {
    const c = (await codeOf(proj.kit)).code!;
    const h = { origin: self(), [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' };
    const q = `${base}/__karyo/trust?dir=${encodeURIComponent(proj.kit)}&hash=${c.hash}`;
    expect((await fetch(q)).status).toBe(403);
    expect((await fetch(q, { headers: { origin: 'null', [TOKEN_HEADER]: TOKEN } })).status).toBe(403);
    expect(await (await fetch(q, { headers: h })).json()).toEqual({ trusted: false, known: true });
    // a page can't trust what it wasn't served, nor a version it wasn't shown, nor without the token
    expect((await fetch(`${base}/__karyo/trust`, { method: 'POST', headers: h, body: JSON.stringify({ dir: join(box, 'nowhere'), hash: c.hash }) })).status).toBe(404);
    expect((await fetch(`${base}/__karyo/trust`, { method: 'POST', headers: h, body: JSON.stringify({ dir: proj.kit, hash: 'f'.repeat(64) }) })).status).toBe(409);
    expect((await fetch(`${base}/__karyo/trust`, { method: 'POST', headers: { origin: self() }, body: JSON.stringify({ dir: proj.kit, hash: c.hash }) })).status).toBe(403);
    expect((await fetch(`${base}/__karyo/trust`, { method: 'POST', headers: { origin: 'null', [TOKEN_HEADER]: TOKEN }, body: JSON.stringify({ dir: proj.kit, hash: c.hash }) })).status).toBe(403);
    expect(trustState(trustFile(), proj.kit, c.hash).trusted).toBe(false);
    const ok = await fetch(`${base}/__karyo/trust`, { method: 'POST', headers: h, body: JSON.stringify({ dir: proj.kit, hash: c.hash }) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
    expect(trustState(trustFile(), proj.kit, c.hash).trusted).toBe(true);
    expect((await (await fetch(q, { headers: h })).json()).trusted).toBe(true);
    // changed on disk since: the page's version is no longer what is there
    await appendFile(join(proj.kit, 'plates', 'probe.js'), '\n');
    const c2 = (await codeOf(proj.kit)).code!;
    expect(await (await fetch(`${base}/__karyo/trust?dir=${encodeURIComponent(proj.kit)}&hash=${c2.hash}`, { headers: h })).json()).toEqual({ trusted: false, changed: true, changedFiles: ['plates/probe.js'], known: true });
    expect((await fetch(`${base}/__karyo/trust`, { method: 'POST', headers: h, body: JSON.stringify({ dir: proj.kit, hash: c.hash }) })).status).toBe(409);
    // a page still holding the old (trusted) version is told it is stale, not that it may run
    expect(await (await fetch(q, { headers: h })).json()).toEqual({ trusted: false, stale: true, known: true });
    // and so is one whose kit has no code on disk any more (its script gone)
    const moved = join(proj.kit, 'plates', 'probe.js.off');
    await (await import('node:fs/promises')).rename(join(proj.kit, 'plates', 'probe.js'), moved);
    expect(await (await fetch(`${base}/__karyo/trust?dir=${encodeURIComponent(proj.kit)}&hash=${c2.hash}`, { headers: h })).json()).toEqual({ trusted: false, stale: true, known: true });
    await (await import('node:fs/promises')).rename(moved, join(proj.kit, 'plates', 'probe.js'));
    // take it back
    expect((await fetch(`${base}/__karyo/trust?dir=${encodeURIComponent(proj.kit)}`, { method: 'DELETE', headers: { origin: self() } })).status).toBe(403);
    const del = await fetch(`${base}/__karyo/trust?dir=${encodeURIComponent(proj.kit)}`, { method: 'DELETE', headers: h });
    expect(await del.json()).toEqual({ ok: true, removed: true });
  });
});

// ---------------------------------------------------------------- in Chrome: an untrusted script never runs
const chromeOk = await (async () => {
  if (process.env.KARYO_SKIP_BROWSER) return false;
  try { const { chromium } = await import('playwright-core'); const b = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }); await b.close(); return true; } catch { return false; }
})();

describe.skipIf(!chromeOk)('in the browser', () => {
  const PORT = +(process.env.KARYO_TEST_PORT ?? 6491);
  let vite: ReturnType<typeof Bun.spawn> | null = null, proj = { dir: '', kit: '' };
  beforeAll(async () => {
    proj = await project('browser');
    vite = Bun.spawn(['bunx', 'vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, KARYO_PROJECT: proj.dir, KARYO_NO_HMR: '1', HOME: home, KARYO_HOME: karyoHome } });
    for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://localhost:${PORT}/__karyo/project`)).ok) break; } catch {} await Bun.sleep(100); }
  }, 30_000);
  afterAll(() => { vite?.kill(); });

  test('the warning shows, and the untrusted script has no effect at all; trusted, the same script runs', async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
    try {
      const page = await browser.newPage();
      // every message any frame posts to the page, from the first moment
      await page.addInitScript(() => { (window as any).__msgs = []; addEventListener('message', (e) => (window as any).__msgs.push(e.data), true); });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://localhost:${PORT}/project.html#plate=karyo.model.json::probe::`);
      await page.evaluate(() => (window as any).__karyoProject);
      await page.waitForSelector('.ks-panel [data-act="trust"]', { timeout: 15_000 });
      await page.waitForTimeout(1500);   // time enough for a script to have done something, had it run
      const seen = async () => ({
        iframes: await page.locator('#plate iframe').count(),
        frames: page.frames().length,
        ran: (await Promise.all(page.frames().map((f) => f.locator('#probe-ran').count().catch(() => 0)))).reduce((a, b) => a + b, 0),
        msgs: await page.evaluate(() => (window as any).__msgs.filter((m: any) => m && m.k === 'karyo-kit').length),
        status: await page.locator('.ks-status').textContent(),
        splices: existsSync(join(proj.dir, 'karyo', 'splices')),
      });
      expect(await seen()).toEqual({ iframes: 0, frames: 1, ran: 0, msgs: 0, status: '', splices: false });
      const panel = await page.locator('.ks-panel').textContent();
      expect(panel).toContain('Kit “probe” wants to run its own code here');
      expect(panel).toContain(KIT_CODE_WARNING);
      expect(panel).toContain('plates/probe.js');
      expect((panel!.match(/sha256 [0-9a-f]{64}/g) ?? []).length).toBe(3);
      // "Not now": still nothing runs
      await page.locator('.ks-panel [data-act="later"]').click();
      await page.waitForTimeout(500);
      expect(await page.locator('.ks-later').count()).toBe(1);
      expect((await seen()).ran + (await seen()).iframes).toBe(0);
      // the positive control: trusted, the very same script runs and says so
      await page.locator('.ks-later [data-act="review"]').click();
      await page.locator('.ks-panel [data-act="trust"]').click();
      await page.waitForFunction(() => document.querySelector('.ks-status')?.textContent?.includes('attempts done') || document.querySelector('.ks-err, .ks-later'), null, { timeout: 15_000 });
      expect(await page.locator('.ks-err, .ks-later').allTextContents()).toEqual([]);
      await page.waitForFunction(() => document.querySelector('.ks-status')?.textContent?.includes('attempts done'), null, { timeout: 15_000 });
      const after = await seen();
      expect(after.iframes).toBe(1);
      expect(after.ran).toBe(1);
      expect(after.msgs).toBeGreaterThan(0);
      expect(after.splices).toBe(false);   // and its tries at the local server got nowhere
      expect(await page.locator('.ks-notice').textContent()).toMatch(/runs code from kit probe · trusted \d{4}-\d\d-\d\d · this project \(/);
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  }, 60_000);
});
