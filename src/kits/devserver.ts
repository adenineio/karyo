/// <reference types="node" />
// The dev server's guard and trust endpoint (vite.config.ts; docs/KITS.md "Code in kits", "The local server"). Bun /
// node only, and plain connect-style middleware so tests can mount it on a bare http server.
//
// The guard. Karyo's dev server can write files (splices, the team layout, the trust store). Every `/__karyo/…` request
//   - must name a loopback host (localhost, 127.0.0.1, [::1]): a DNS-rebinding page has some other name;
//   - must not come from another origin: a browser sends `Origin` (and `Sec-Fetch-Site`) and anything but this server's
//     own origin is refused, whatever the method, preflights included, and so is `null` (a sandboxed frame's, such as
//     a kit script's);
//   - and when it changes something (any method but GET / HEAD), or asks about trust, it must carry the per-server
//     token (`x-karyo-token`), a random value made when the server starts and put in the pages it serves
//     (`<meta name="karyo-token">`, sent by src/kits/devtoken.ts). A kit script in its sandbox never sees it.
// Tools that aren't browsers (the CLI's reads, curl) send no Origin; they can still read, and a write needs the token.
//
// The trust endpoint (src/kits/trust.ts is the store):
//   GET    /__karyo/trust?dir=<kit folder>&hash=<its code's hash>  → { trusted, builtin?, at?, changed?, changedFiles?, stale?, known }
//          (stale: the kit on disk is no longer that version; the page runs nothing and asks for a reload)
//   POST   /__karyo/trust   body { dir, hash }                      → { ok, at }   the user pressed "Trust this version"
//   DELETE /__karyo/trust?dir=<kit folder>                          → { ok, removed }
// A POST must name a kit this server has served (`known`), and `hash` must be the hash of what is on disk now: the user
// trusts exactly the code the page showed them, and a kit changed since the page loaded is refused (reload first).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readKit } from './library';
import { grantTrust, realDir, revokeTrust, trustState } from './trust';
import type { KitSource } from './types';

export const TOKEN_HEADER = 'x-karyo-token';
export const newToken = () => randomBytes(32).toString('hex');

type Next = (err?: unknown) => void;
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

function reply(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}
const header = (req: IncomingMessage, h: string) => { const v = req.headers[h]; return Array.isArray(v) ? v[0] : v; };
const sameToken = (a: string | undefined, b: string) => { if (!a) return false; const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Whether a request may reach a `/__karyo/…` endpoint. `needToken`: it writes, or asks about trust. */
export function checkRequest(req: IncomingMessage, token: string, needToken: boolean): { ok: true } | { ok: false; code: number; error: string } {
  const host = header(req, 'host') ?? '';
  if (!LOOPBACK.test(host)) return { ok: false, code: 403, error: `refused: Karyo's local server only answers to localhost, not "${host}"` };
  const origin = header(req, 'origin');
  const self = [`http://${host}`, `https://${host}`];
  if (origin !== undefined && !self.includes(origin)) return { ok: false, code: 403, error: `refused: a request from another origin (${origin}); only Karyo's own pages may use this server` };
  const site = header(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return { ok: false, code: 403, error: `refused: a ${site} request; only Karyo's own pages may use this server` };
  if (needToken && !sameToken(header(req, TOKEN_HEADER), token)) return { ok: false, code: 403, error: 'refused: this request lacks the page\'s key to Karyo\'s local server (reload the page if the server restarted)' };
  return { ok: true };
}

/** The guard, for every `/__karyo/…` route: mount it before the endpoints. Other paths pass through untouched. */
export function guardMiddleware(token: string) {
  return (req: IncomingMessage, res: ServerResponse, next: Next) => {
    // parsed as the endpoints parse it (an absolute-form target too), and lower case: connect matches routes (the layout
    // saver's, the project index's) without regard to case
    let path: string;
    try { path = new URL(req.url ?? '/', 'http://localhost').pathname.toLowerCase(); } catch { return reply(res, 400, { ok: false, error: 'bad request target' }); }
    // dot segments (/./, /../, %2e) are resolved by URL but not by connect's router: a target that names our endpoints
    // either way, and isn't already in its plain form, is refused (browsers always send the plain form)
    const raw = (req.url ?? '/').split('?')[0]!.toLowerCase();
    const plainRaw = /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? (() => { try { return new URL(raw).pathname; } catch { return raw; } })() : raw;
    if ((raw.includes('__karyo') || path.includes('__karyo')) && (/(^|\/)(\.|%2e){1,2}(\/|$)/.test(plainRaw) || /%2e|%2f|%5c|\\/.test(plainRaw))) return reply(res, 400, { ok: false, error: 'refused: a request target with dot segments or encoded separators' });
    if (!path.startsWith('/__karyo/') && path !== '/__karyo') return next();
    const m = (req.method ?? 'GET').toUpperCase();
    const write = m !== 'GET' && m !== 'HEAD';
    const c = checkRequest(req, token, write || path.replace(/\/+$/, '') === '/__karyo/trust');
    if (!c.ok) return reply(res, c.code, { ok: false, error: c.error });
    next();
  };
}

function readBody(req: IncomingMessage, max = 64_000): Promise<string> {
  return new Promise((ok, fail) => {
    let body = '', size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { fail(new Error('body too large')); req.destroy(); return; } body += c; });
    req.on('end', () => ok(body));
    req.on('error', fail);
  });
}

/** Kit folders this server has served with code, by real path: only those can be trusted from a page. */
export type KnownKits = Map<string, { name: string; source: KitSource }>;

/** `/__karyo/trust` (behind the guard). `file` is the trust store ($KARYO_HOME/trust.json). */
export function trustMiddleware(o: { file: () => string; known: KnownKits }) {
  return async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.replace(/\/+$/, '') !== '/__karyo/trust') return next();
    try {
      if (req.method === 'GET') {
        const dir = url.searchParams.get('dir') ?? '', hash = url.searchParams.get('hash') ?? '';
        if (!dir || !hash) return reply(res, 400, { ok: false, error: 'add ?dir=<kit folder>&hash=<its code hash>' });
        const k = o.known.get(realDir(dir));
        if (!k) return reply(res, 200, { trusted: false, known: false });
        // which files changed since the version that was trusted: read from disk (the page's bundle has the same files
        // when its hash is the one on disk; otherwise the page is stale and a reload shows the kit as it is now)
        // the kit as it is on disk now: a page holding another version (the kit changed after it loaded) runs nothing
        // and is told to reload; otherwise, which files changed since the version that was trusted
        const disk = k.source === 'builtin' ? null : (await readKit(realDir(dir), k.source, []))?.kit.code;
        if (k.source !== 'builtin' && (!disk || disk.hash !== hash)) return reply(res, 200, { trusted: false, stale: true, known: true });
        return reply(res, 200, { ...trustState(o.file(), dir, hash, k.source, disk?.files), known: true });
      }
      if (req.method === 'POST') {
        let j: any;
        try { j = JSON.parse(await readBody(req)); } catch (e) { return reply(res, 400, { ok: false, error: `body is not JSON: ${(e as Error).message}` }); }
        if (!j || typeof j.dir !== 'string' || typeof j.hash !== 'string') return reply(res, 400, { ok: false, error: 'expected { dir, hash }' });
        const d = realDir(j.dir), k = o.known.get(d);
        if (!k) return reply(res, 404, { ok: false, error: 'not a kit this server has served' });
        if (k.source === 'builtin') return reply(res, 200, { ok: true, builtin: true });
        const problems: { dir: string; message: string }[] = [];
        const r = await readKit(d, k.source, problems);
        if (!r?.kit.code) return reply(res, 409, { ok: false, error: 'the kit has no code on disk any more; reload the page' });
        if (r.kit.code.hash !== j.hash) return reply(res, 409, { ok: false, changed: true, error: 'the kit changed since this page loaded, so this is not the version you reviewed; reload the page and review it again' });
        const e = grantTrust(o.file(), { dir: d, name: r.kit.name, source: k.source }, r.kit.code, 'page');
        return reply(res, 200, { ok: true, at: e.trusted });
      }
      if (req.method === 'DELETE') {
        const dir = url.searchParams.get('dir') ?? '';
        if (!dir) return reply(res, 400, { ok: false, error: 'add ?dir=<kit folder>' });
        return reply(res, 200, { ok: true, removed: revokeTrust(o.file(), dir) });
      }
      return reply(res, 405, { ok: false, error: 'GET, POST or DELETE' });
    } catch (e) { return reply(res, 500, { ok: false, error: String(e instanceof Error ? e.message : e) }); }
  };
}
