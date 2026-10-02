/// <reference types="node" />
// Build ONE self-contained HTML file from an explainer spec (bun / node): the prebuilt runtime
// (src/explainer/standalone.ts + engine + three.js + CSS as one IIFE, cached under dist/runtime/ and
// rebuilt when its sources change), the bundle JSON inline, and a mount script with the theater
// button. No network needed. Opens from file://.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleSpec } from './bundle';
import type { LoadOpts } from './library';
import type { Issue } from './types';
import { THEMES, DEFAULT_THEME, THEME_KEY, THEME_ALIASES } from '../engine/theme-pick';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
export const RUNTIME_DIR = join(REPO, 'dist', 'runtime');
const SOURCES = ['src/engine', 'src/explainer', 'src/model/tour.ts', 'src/model/legend.ts', 'src/model/scenes.ts', 'src/model/model.ts', 'package.json', 'node_modules/three/package.json'];

async function files(p: string): Promise<string[]> {
  const s = await stat(p).catch(() => null);
  if (!s) return [];
  if (s.isFile()) return [p];
  const out: string[] = [];
  for (const e of (await readdir(p, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) out.push(...(await files(join(p, e.name))));
  return out;
}
async function sourceHash() {
  const h = createHash('sha256');
  for (const rel of SOURCES) for (const f of await files(join(REPO, rel))) { h.update(f.slice(REPO.length)); h.update(await readFile(f)); }
  return h.digest('hex').slice(0, 16);
}

/** The runtime's JS and CSS, rebuilt with Vite when src/engine, src/explainer or the tour helpers change. `dir`: where
 *  it is cached (default dist/runtime in the checkout; an installed plugin passes its data dir instead). */
export async function ensureRuntime(dir = RUNTIME_DIR): Promise<{ js: string; css: string; hash: string; rebuilt: boolean }> {
  const hash = await sourceHash();
  const stampFile = join(dir, 'stamp.json');
  const stamp = await readFile(stampFile, 'utf8').then((s) => JSON.parse(s).hash as string).catch(() => '');
  let rebuilt = false;
  if (stamp !== hash) {
    const { build } = await import('vite');
    await build({
      configFile: false, root: REPO, logLevel: 'warn', publicDir: false,
      build: {
        outDir: dir, emptyOutDir: true, target: 'es2022', minify: true, copyPublicDir: false,
        lib: { entry: join(REPO, 'src/explainer/standalone.ts'), formats: ['iife'], name: 'KaryoExplainer', fileName: () => 'karyo-explainer.js', cssFileName: 'karyo-explainer' },
      },
    });
    await writeFile(stampFile, JSON.stringify({ hash, built: new Date().toISOString() }) + '\n');
    rebuilt = true;
  }
  const out = await readdir(dir);
  const js = await readFile(join(dir, 'karyo-explainer.js'), 'utf8');
  const cssName = out.find((f) => f.endsWith('.css'));
  const css = cssName ? await readFile(join(dir, cssName), 'utf8') : '';
  return { js, css, hash, rebuilt };
}

const escText = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function buildHtml(specPath: string, outFile: string, opts: Omit<LoadOpts, 'specDir'> & { runtimeDir?: string } = {}): Promise<{ file: string; bytes: number; issues: Issue[] }> {
  const { runtimeDir, ...load } = opts;
  const b = await bundleSpec(specPath, load);
  const { spec, components, issues } = b;
  const rt = await ensureRuntime(runtimeDir);
  const title = typeof spec.title === 'string' ? spec.title : 'Explainer';
  const data = JSON.stringify({ spec, components }).replace(/</g, '\\u003c');
  const js = rt.js.replace(/<\/script/gi, '<\\/script');
  // the page has no module imports, so the theme list (src/engine/theme-pick.ts) goes in inline: [id, label, plate, mode]
  const themeList = JSON.stringify(THEMES.map((t) => [t.id, t.label, t.plate, t.mode]));
  const themeOptions = [0, 1, 2].map((g) => THEMES.filter((t) => t.group === g).map((t) => `<option value="${t.id}">${escText(t.label)}</option>`).join('')).join('<option disabled>──────</option>');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="karyo explainer runtime ${rt.hash}">
<title>${escText(title)}</title>
<style>
:root { --page-bg: #eceef1; --page-fg: #14171c; --page-muted: #5a6371; --page-rule: #d4d9df; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --page-bg: #0a0c10; --page-fg: #e7eaee; --page-muted: #8c96a4; --page-rule: #232932; color-scheme: dark; } }
:root[data-theme="dark"] { --page-bg: #0a0c10; --page-fg: #e7eaee; --page-muted: #8c96a4; --page-rule: #232932; color-scheme: dark; }
:root[data-plate-theme^="adenine"] { --page-bg: #070c0e; --page-fg: #e3eeeb; --page-muted: #8a9d9a; --page-rule: #1a2527; color-scheme: dark; }
body { margin: 0; background: var(--page-bg); color: var(--page-fg); font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
main { max-width: 1320px; margin: 0 auto; padding: 20px 16px 48px; display: grid; gap: 12px; }
.bar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px 16px; color: var(--page-muted); font-size: 13px; }
.themes { display: flex; align-items: center; gap: 8px; }
.themes select { font: 500 12px/1 ui-monospace, Menlo, monospace; height: 28px; padding: 0 6px; background: var(--page-bg); color: var(--page-fg); border: 1px solid var(--page-rule); border-radius: 6px; cursor: pointer; }
html.export body { background: #000; } html.export main { padding: 0; max-width: none; } html.export .bar { display: none; }
</style>
<style>${rt.css}</style>
</head>
<body>
<main>
  <div class="bar"><span>Karyo explainer · ←/→ to step · f for theater</span>
    <label class="themes">Theme <select id="karyo-theme" aria-label="Theme">${themeOptions}</select></label>
  </div>
  <div id="karyo-plate"></div>
</main>
<script>${js}</script>
<script type="application/json" id="karyo-bundle">${data}</script>
<script>
(function () {
  var q = new URLSearchParams(location.search), html = document.documentElement;
  // theme: URL theme (with mode), else URL mode (neutral), else the stored choice, else ${DEFAULT_THEME}; the list is src/engine/theme-pick.ts
  var T = ${themeList}, KEY = '${THEME_KEY}', ALIAS = ${JSON.stringify(THEME_ALIASES)}, sel = document.getElementById('karyo-theme');
  function find(id) { id = ALIAS[id] || id; for (var i = 0; i < T.length; i++) if (T[i][0] === id) return T[i]; return null; }
  function apply(id) { var t = find(id); if (!t) return false; if (t[2]) html.dataset.plateTheme = t[2]; else delete html.dataset.plateTheme; if (t[3] === 'auto') delete html.dataset.theme; else html.dataset.theme = t[3]; return true; }
  function current() { var p = html.dataset.plateTheme && html.dataset.plateTheme !== 'neutral' ? html.dataset.plateTheme : null, m = html.dataset.theme === 'light' || html.dataset.theme === 'dark' ? html.dataset.theme : 'auto'; for (var i = 0; i < T.length; i++) if (T[i][2] === p && (p || T[i][3] === m)) return T[i][0]; return ''; }
  var qt = q.get('theme'), qm = q.get('mode'), stored = null;
  if (qt) { var qf = find(qt); if (qf && !qf[2]) { delete html.dataset.plateTheme; if (qm || qf[3] !== 'auto') html.dataset.theme = qm || qf[3]; } else { html.dataset.plateTheme = qf ? qf[2] : qt; if (qm) html.dataset.theme = qm; } }
  else if (qm) html.dataset.theme = qm;
  else { if (!q.has('export')) { try { stored = localStorage.getItem(KEY); } catch (e) {} } if (!stored || !apply(stored)) apply('${DEFAULT_THEME}'); }
  sel.value = current();
  sel.addEventListener('change', function () { if (apply(sel.value)) { try { localStorage.setItem(KEY, sel.value); } catch (e) {} } });
  var bundle = JSON.parse(document.getElementById('karyo-bundle').textContent);
  var stage = KaryoExplainer.mount(document.getElementById('karyo-plate'), bundle, { preserve: q.has('export') });
  var step = +q.get('step');
  if (step) stage.ready.then(function () { KaryoExplainer.api(stage).go(step - 1); });
})();
</script>
</body>
</html>
`;
  const file = resolve(outFile);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html);
  return { file, bytes: Buffer.byteLength(html), issues };
}
