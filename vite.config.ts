import { defineConfig, type Plugin } from 'vite';
import { resolve, relative, dirname, sep, isAbsolute } from 'node:path';
import { writeFile, realpath, stat, readdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { bundleSpec } from './src/explainer/bundle';
import { spliceMiddleware } from './src/model/splice-store';
import { indexProject, projectJson } from './src/project/files';
import { loadKits, bundleKits } from './src/kits/library';
import { guardMiddleware, newToken, trustMiddleware, type KnownKits } from './src/kits/devserver';
import { realDir, trustFile } from './src/kits/trust';

const ROOT = import.meta.dirname;
/** Project mode (`karyo view`, docs/PACKAGING.md): the folder whose Karyo files project.html draws. Splices and the
 *  team layout are then saved in that project (its karyo/ folder), not in this checkout. */
const PROJECT = process.env.KARYO_PROJECT ? resolve(process.env.KARYO_PROJECT) : null;

/** This server's key (docs/KITS.md "The local server"): made fresh at every start and put in every page it serves.
 *  Writes (splices, the layout, trust) and trust questions must carry it and come from this server's own origin. */
const TOKEN = newToken();
/** Kit folders with code this server has served (by real path): only those can be trusted from a page. */
const KNOWN: KnownKits = new Map();

/** Dev only, first: the guard in front of every `/__karyo/…` endpoint (src/kits/devserver.ts: a loopback host, this
 *  server's own origin, and the token for writes), the page's token (`<meta name="karyo-token">` in every page served),
 *  and `/__karyo/trust`: `GET ?dir=&hash=` (is this version of a kit's code trusted?), `POST {dir, hash}` (the user
 *  pressed "Trust this version") and `DELETE ?dir=` (take it back), kept in $KARYO_HOME/trust.json (src/kits/trust.ts). */
function karyoGuard(): Plugin {
  return {
    name: 'karyo-guard',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(guardMiddleware(TOKEN));
      server.middlewares.use(trustMiddleware({ file: () => trustFile(), known: KNOWN }));
    },
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { name: 'karyo-token', content: TOKEN }, injectTo: 'head-prepend' }];
    },
  };
}

/** Dev only: `GET /__karyo/bundle?spec=<absolute or repo-relative path to a .json explainer spec>` returns
 *  `{ spec, components, issues }` (src/explainer/bundle.ts) for explain.html. Read-only; .json files only. */
function explainerBundle(): Plugin {
  return {
    name: 'karyo-explainer-bundle',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__karyo/bundle', async (req, res) => {
        const reply = (code: number, body: object) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)); };
        if (req.method !== 'GET') return reply(405, { error: 'GET only' });
        const spec = new URL(req.url ?? '/', 'http://localhost').searchParams.get('spec') ?? '';
        if (!spec) return reply(400, { error: 'add ?spec=<path to a .json explainer spec>' });
        const abs = isAbsolute(spec) ? spec : resolve(ROOT, spec);
        if (!abs.toLowerCase().endsWith('.json')) return reply(403, { error: 'only .json specs' });
        try { if (!(await stat(abs)).isFile()) return reply(404, { error: `not a file: ${abs}` }); }
        catch { return reply(404, { error: `no such file: ${abs}` }); }
        try { reply(200, await bundleSpec(abs)); }
        catch (e) { reply(500, { error: String(e instanceof Error ? e.stack ?? e.message : e) }); }
      });
    },
  };
}

/** Dev only: `POST /__karyo/layout?file=<…>/karyo.layout.json` writes a structure board's team layout: positions
 *  and legend tags (the board's "Save as team layout" button). Any other path is refused. */
function layoutSaver(): Plugin {
  // project mode: any karyo.layout.json inside the project; otherwise one beside a karyo.model.json in this checkout
  const ALLOWED = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*karyo\.layout\.json$/;
  const ROOT = PROJECT ?? import.meta.dirname;
  return {
    name: 'karyo-layout-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__karyo/layout', (req, res) => {
        const reply = (code: number, body: object) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
        if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
        const file = new URL(req.url ?? '/', 'http://localhost').searchParams.get('file') ?? '';
        if (!ALLOWED.test(file) || file.split('/').some((s) => s === '..' || s === '.')) return reply(403, { ok: false, error: PROJECT ? 'only karyo.layout.json files in the project' : 'only a karyo.layout.json beside a karyo.model.json' });
        const abs = resolve(ROOT, file), rel = relative(ROOT, abs);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) return reply(403, { ok: false, error: 'outside the repo' });
        if (!PROJECT && !existsSync(resolve(dirname(abs), 'karyo.model.json'))) return reply(403, { ok: false, error: 'only a karyo.layout.json beside a karyo.model.json' });
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
        req.on('end', async () => {
          try {
            // the folder must really be inside the repo (no symlinked escape)
            const [dir, root] = await Promise.all([realpath(dirname(abs)), realpath(ROOT)]);
            if (!(dir + sep).startsWith(root + sep)) return reply(403, { ok: false, error: 'outside the repo' });
            const j = JSON.parse(body);
            // `tags` (legend tags); `bins`, the same list under another name, is also accepted
            const tags = Array.isArray(j?.tags) ? j.tags : Array.isArray(j?.bins) ? j.bins : null;
            const ok = j && typeof j.positions === 'object' && !Array.isArray(j.positions) && tags
              && Object.values(j.positions).every((p: any) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
              && tags.every((b: any) => b && typeof b.id === 'string' && typeof b.name === 'string' && Array.isArray(b.members) && b.members.every((m: unknown) => typeof m === 'string'));
            if (!ok) return reply(400, { ok: false, error: 'expected { positions: {id: {x, y}}, tags: [{id, name, members}] }' });
            await writeFile(abs, JSON.stringify({ positions: j.positions, tags }, null, 2) + '\n');
            reply(200, { ok: true, file });
          } catch (e) { reply(400, { ok: false, error: String(e) }); }
        });
      });
    },
  };
}

/** Dev only: splices (docs/MODEL.md "Splices"). `GET /__karyo/splices?dir=<project dir>` lists a project's
 *  splices; `GET|POST|DELETE /__karyo/splice?file=<…/karyo/splices/<id>.splice.json>` reads, writes (validated,
 *  atomic) and deletes one. Only karyo/splices/*.splice.json files (in any folder) inside the repo (src/model/splice-store.ts). */
function spliceStore(): Plugin {
  return {
    name: 'karyo-splice-store',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(spliceMiddleware(PROJECT ?? ROOT));
    },
  };
}

/** Dev only, project mode: `GET /__karyo/project` indexes $KARYO_PROJECT (src/project/files.ts);
 *  `GET /__karyo/project/json?rel=<a model or layout file in it>` returns that file. Read-only. */
function projectFiles(): Plugin {
  return {
    name: 'karyo-project-files',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__karyo/project', async (req, res) => {
        const reply = (code: number, body: unknown) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)); };
        if (req.method !== 'GET') return reply(405, { error: 'GET only' });
        if (!PROJECT) return reply(404, { error: 'no project: start the server with `karyo view` (it sets KARYO_PROJECT)' });
        const url = new URL(req.url ?? '/', 'http://localhost');
        try {
          if (url.pathname === '/' || url.pathname === '') return reply(200, await indexProject(PROJECT));
          if (url.pathname === '/json') {
            const j = await projectJson(PROJECT, url.searchParams.get('rel') ?? '');
            return j === null ? reply(404, { error: 'not a model or layout file of this project' }) : reply(200, j);
          }
          reply(404, { error: 'unknown route' });
        } catch (e) { reply(500, { error: String(e instanceof Error ? e.message : e) }); }
      });
    },
  };
}

/** Kits (docs/KITS.md): `import kits from 'virtual:karyo-kits'` is the page's kits: $KARYO_KITS, the shared library
 *  ($KARYO_HOME/kits, else ~/.adenine/karyo/kits) and the built-ins, plus the project's in project mode (`karyo view`);
 *  `virtual:karyo-kits/<repo-relative folder>` puts that folder's project kits (its karyo/kits, found upwards) first,
 *  e.g. `virtual:karyo-kits/apps/notes`. Every kit file is watched: an edit reloads the page (a new kit
 *  folder needs a server restart). Kits are data and templates, except a `script` plate's file, which the page runs
 *  only once the user trusted that version of the kit (src/kits/script-plate.ts). */
function kitModules(): Plugin {
  const ID = 'virtual:karyo-kits';
  const files = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.')) continue;
      const p = resolve(dir, e.name);
      if (e.isDirectory()) out.push(...(await files(p))); else out.push(p);
    }
    return out;
  };
  // every kit folder a bundle was built from: a change in one rebuilds the bundles (even with HMR off, as render.ts
  // runs it), so a page reloaded after a kit changed gets the kit as it is now: new code asks again
  // (and every page load reads them afresh, however quick the edit before it was)
  const kitDirs = new Set<string>();
  let dev: import('vite').ViteDevServer | null = null;
  const invalidate = () => {
    for (const env of Object.values(dev?.environments ?? {})) {
      for (const [id, mod] of env.moduleGraph.idToModuleMap) if (id.startsWith(`\0${ID}`)) env.moduleGraph.invalidateModule(mod);
    }
  };
  return {
    name: 'karyo-kits',
    configureServer(server) {
      dev = server;
      const stale = (file: string) => { if ([...kitDirs].some((d) => file === d || file.startsWith(d + sep))) invalidate(); };
      server.watcher.on('change', stale);
      server.watcher.on('add', stale);
      server.watcher.on('unlink', stale);
    },
    transformIndexHtml() { invalidate(); },
    resolveId(id) { return id === ID || id.startsWith(`${ID}/`) ? `\0${id}` : undefined; },
    async load(id) {
      if (!id.startsWith(`\0${ID}`)) return;
      const rest = id.slice(ID.length + 2);
      const projectDir = rest && rest !== '@project' ? resolve(ROOT, rest) : PROJECT ?? undefined;
      const lib = await loadKits({ projectDir });
      for (const k of lib.kits) { kitDirs.add(k.dir); for (const f of await files(k.dir)) this.addWatchFile(f); }
      // kits with code: the ones a page served by this server may ask to trust
      for (const k of lib.kits) if (k.code) KNOWN.set(realDir(k.dir), { name: k.name, source: k.source });
      return `export default ${JSON.stringify(bundleKits(lib))};`;
    },
  };
}

/** Pages in an optional local dev/ folder (dev/*.html), when it exists. */
function devPages(): Record<string, string> {
  const dir = resolve(import.meta.dirname, 'dev');
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => [`dev-${f.slice(0, -5)}`, resolve(dir, f)]));
}

// base './' so the built site works from any folder (docs site, S3, an artifact).
export default defineConfig({
  base: './',
  plugins: [karyoGuard(), layoutSaver(), explainerBundle(), spliceStore(), projectFiles(), kitModules()],
  server: { port: 5180, strictPort: false, hmr: process.env.KARYO_NO_HMR ? false : undefined },
  // the plugin keeps vite's cache in its data dir (scripts/karyo-runtime.ts), not in its install folder
  ...(process.env.KARYO_VITE_CACHE ? { cacheDir: process.env.KARYO_VITE_CACHE } : {}),
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      // the gallery, the explainer host, Jarvis mode (voice control), plus any local dev/*.html pages
      input: { index: resolve(import.meta.dirname, 'index.html'), explain: resolve(import.meta.dirname, 'explain.html'), jarvis: resolve(import.meta.dirname, 'jarvis.html'), ...devPages() },
    },
  },
});
