/// <reference types="node" />
// Build ONE self-contained HTML file from an explainer spec (bun / node): the prebuilt runtime
// (src/explainer/standalone.ts + engine + three.js + CSS as one IIFE, cached under dist/runtime/ and
// rebuilt when its sources change), the bundle JSON inline, and a mount script with the theater
// button. No network needed. Opens from file://.
//
// `target: 'artifact'` builds the same page for a hosted, sandboxed frame (a Claude artifact, docs/ARTIFACTS.md): a
// short <title> (2-4 words) and a theater that asks for real fullscreen and falls back to filling the frame when the
// Fullscreen API is blocked. Both targets open in adenine (whatever the system's colour scheme) unless the address says
// `?theme=` or `?mode=`. Everything stays inline: no script, style or font is fetched (the web fonts of the
// themes the page offers are inlined as base64 woff2, about 0.26 MB).
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleSpec } from './bundle';
import type { LoadOpts } from './library';
import type { Issue } from './types';
import { THEMES, DEFAULT_THEME, THEME_KEY, THEME_ALIASES } from '../engine/theme-pick';
import { FONT_FILES, fontFaceCss, type FontKey } from '../engine/theme-fonts';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
export const RUNTIME_DIR = join(REPO, 'dist', 'runtime');
const SOURCES = ['src/engine', 'src/explainer', 'src/model/tour.ts', 'src/model/legend.ts', 'src/model/scenes.ts', 'src/model/model.ts', 'src/model/glass.css', 'package.json', 'node_modules/three/package.json'];

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
export async function ensureRuntime(dir = RUNTIME_DIR): Promise<{ js: string; css: string; fonts: string; hash: string; rebuilt: boolean }> {
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
  return { js, css, fonts: (await inlineFonts()).css, hash, rebuilt };
}

/** The web fonts a page needs for the themes it offers (its Theme select: THEMES), inlined as base64 woff2 so the page
 *  still fetches nothing; a theme it never offers costs nothing. Returns the CSS and the font bytes it carries. */
export async function inlineFonts(offered = THEMES): Promise<{ css: string; bytes: number }> {
  const keys = [...new Set(offered.flatMap((t) => t.fonts?.families ?? []))] as FontKey[];
  const data = new Map<FontKey, Buffer>();
  for (const k of keys) data.set(k, await readFile(join(REPO, 'src/engine/fonts', FONT_FILES[k].dir, FONT_FILES[k].file)));
  const byFile = new Map([...data].map(([k, b]) => [FONT_FILES[k].file, b]));
  const css = fontFaceCss(keys, (f) => `data:font/woff2;base64,${byFile.get(f.file)!.toString('base64')}`);
  return { css, bytes: [...data.values()].reduce((n, b) => n + b.length, 0) };
}

/** The largest page a hosted artifact may be (bytes). */
export const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
export type BuildTarget = 'file' | 'artifact';

const SMALL = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'from', 'as', 'is', 'are', 'its', 'your', 'our', 'into']);
/** A page title of two to four words, from the explainer's title: longer titles are cut at the fourth word (dropping a
 *  trailing small word such as "of"), a one-word title gets "explained" after it. Punctuation at the cut is trimmed. */
export function shortTitle(title: string): string {
  const words = title.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return 'Karyo explainer';
  let w = words.slice(0, 4);
  while (w.length > 2 && SMALL.has(w[w.length - 1]!.toLowerCase().replace(/[^a-z]/g, ''))) w = w.slice(0, -1);
  if (w.length === 1) w = [w[0]!, 'explained'];
  return w.join(' ').replace(/[\s:;,.·—–-]+$/u, '');
}

const escText = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface BuildOpts extends Omit<LoadOpts, 'specDir'> {
  runtimeDir?: string;
  /** 'file' (default): a file to open or send. 'artifact': for a hosted, sandboxed frame (see the top of this file). */
  target?: BuildTarget;
}
export interface BuildResult { file: string; bytes: number; issues: Issue[]; title: string; target: BuildTarget }

/** The page as a string, without writing it (`karyo artifact status` hashes it). */
export async function renderHtml(specPath: string, opts: BuildOpts = {}): Promise<{ html: string; issues: Issue[]; title: string; target: BuildTarget }> {
  const { runtimeDir, target = 'file', ...load } = opts;
  const b = await bundleSpec(specPath, load);
  const { spec, components, issues } = b;
  const rt = await ensureRuntime(runtimeDir);
  const artifact = target === 'artifact';
  const full = typeof spec.title === 'string' && spec.title.trim() ? spec.title : 'Explainer';
  const title = artifact ? shortTitle(full) : full;
  const data = JSON.stringify({ spec, components }).replace(/</g, '\\u003c');
  const js = rt.js.replace(/<\/script/gi, '<\\/script');
  // the page has no module imports, so the theme list (src/engine/theme-pick.ts) goes in inline: [id, label, plate]
  const themeList = JSON.stringify(THEMES.map((t) => [t.id, t.label, t.plate]));
  const themeOptions = THEMES.map((t) => `<option value="${t.id}">${escText(t.label)}</option>`).join('');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="karyo explainer runtime ${rt.hash}">${artifact ? `
<meta name="karyo-target" content="artifact">${typeof spec.summary === 'string' && spec.summary.trim() ? `
<meta name="description" content="${escText(spec.summary.trim())}">` : ''}` : ''}
<title>${escText(title)}</title>
<style>
:root { --page-bg: #eceef1; --page-fg: #14171c; --page-muted: #5a6371; --page-rule: #d4d9df; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --page-bg: #0a0c10; --page-fg: #e7eaee; --page-muted: #8c96a4; --page-rule: #232932; color-scheme: dark; } }
:root[data-theme="dark"] { --page-bg: #0a0c10; --page-fg: #e7eaee; --page-muted: #8c96a4; --page-rule: #232932; color-scheme: dark; }
:root[data-plate-theme="adenine"] { --page-bg: #000000; --page-fg: #f0f0f0; --page-muted: #a1a4a5; --page-rule: #191b1e; color-scheme: dark; }
:root[data-plate-theme="fresh"] { --page-bg: #07080a; --page-fg: #ffffff; --page-muted: #9c9c9d; --page-rule: #1b1c1e; color-scheme: dark; }
html { background: var(--page-bg); }
body { margin: 0; min-height: 100vh; background: var(--page-bg); color: var(--page-fg); font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
main { max-width: 1320px; margin: 0 auto; padding: 20px 16px 48px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.bar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px 16px; color: var(--page-muted); font-size: 13px; }
.themes { display: flex; align-items: center; gap: 8px; }
.themes select { font: 500 12px/1 ui-monospace, Menlo, monospace; height: 28px; padding: 0 6px; background: var(--page-bg); color: var(--page-fg); border: 1px solid var(--page-rule); border-radius: 6px; cursor: pointer; }
html.export body { background: #000; } html.export main { padding: 0; max-width: none; } html.export .bar { display: none; }
</style>
<style>${rt.css}</style>
<style>${rt.fonts}</style>
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
  // theme: URL theme (an unknown id: ${DEFAULT_THEME}; with mode), else URL mode (the neutral tokens, no plate theme), else the
  // stored choice, else ${DEFAULT_THEME}; the list and the retired ids are src/engine/theme-pick.ts
  var T = ${themeList}, KEY = '${THEME_KEY}', ALIAS = ${JSON.stringify(THEME_ALIASES)}, sel = document.getElementById('karyo-theme');
  function find(id) { id = ALIAS[id] || id; for (var i = 0; i < T.length; i++) if (T[i][0] === id) return T[i]; return null; }
  function apply(id) { var t = find(id); if (!t) return false; html.dataset.plateTheme = t[2]; delete html.dataset.theme; return true; }
  function current() { for (var i = 0; i < T.length; i++) if (T[i][2] === html.dataset.plateTheme) return T[i][0]; return ''; }
  var qt = q.get('theme'), qm = q.get('mode'), stored = null;
  if (qt) { html.dataset.plateTheme = (find(qt) || find('${DEFAULT_THEME}'))[2]; if (qm) html.dataset.theme = qm; }
  else if (qm) html.dataset.theme = qm;
  else { if (!q.has('export')) { try { stored = localStorage.getItem(KEY); } catch (e) {} } if (!stored || !apply(stored)) apply('${DEFAULT_THEME}'); }
  sel.value = current();
  sel.addEventListener('change', function () { if (apply(sel.value)) { try { localStorage.setItem(KEY, sel.value); } catch (e) {} } });
  var bundle = JSON.parse(document.getElementById('karyo-bundle').textContent);
  var stage = KaryoExplainer.mount(document.getElementById('karyo-plate'), bundle, { preserve: q.has('export') });
  var step = +q.get('step');
  if (step) stage.ready.then(function () { KaryoExplainer.api(stage).go(step - 1); });${artifact ? `
  // theater in a frame: ask for real fullscreen too; when the frame doesn't allow it, the theater fills the frame
  var fsOurs = false, d = document;
  function fsEl() { return d.fullscreenElement || d.webkitFullscreenElement || null; }
  function fsOk() { try { return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled); } catch (e) { return false; } }
  function enterFs() {
    if (!fsOk() || fsEl()) return;
    var el = d.documentElement, req = el.requestFullscreen || el.webkitRequestFullscreen;
    try { var p = req && req.call(el); fsOurs = true; if (p && p.catch) p.catch(function () { fsOurs = false; }); } catch (e) { fsOurs = false; }
  }
  function leaveFs() {
    if (!fsOurs || !fsEl()) { fsOurs = false; return; }
    fsOurs = false; var ex = d.exitFullscreen || d.webkitExitFullscreen;
    try { var p = ex && ex.call(d); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }
  try {
    new MutationObserver(function () { if (html.classList.contains('plate-theater-open')) enterFs(); else leaveFs(); }).observe(html, { attributes: true, attributeFilter: ['class'] });
    var onFs = function () { if (!fsEl() && fsOurs) { fsOurs = false; if (stage.inTheater) stage.theater(false); } };
    d.addEventListener('fullscreenchange', onFs); d.addEventListener('webkitfullscreenchange', onFs);
  } catch (e) {}` : ''}
})();
</script>
</body>
</html>
`;
  return { html, issues, title, target };
}

export async function buildHtml(specPath: string, outFile: string, opts: BuildOpts = {}): Promise<BuildResult> {
  const { html, issues, title, target } = await renderHtml(specPath, opts);
  const file = resolve(outFile);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html);
  return { file, bytes: Buffer.byteLength(html), issues, title, target };
}
