#!/usr/bin/env bun
// Offline renderer: drives the gallery page in headless Chrome and screenshots the stage, so
// stills and videos show the real HTML (fonts, CSS, text) together with the fx canvases.
//
//   stills  bun scripts/render.ts stills --scene request-flow --t 0.5,2,4.2 [--out out/stills]
//   sheet   bun scripts/render.ts sheet  --scene request-flow [--n 12] [--cols 4] [--out out/sheet.png]
//   video   bun scripts/render.ts video  --scene request-flow [--fps 30] [--from 0] [--to <dur>] [--out out/clip.mp4|.gif|.webm]
//   lint    bun scripts/render.ts lint   [--scene id] [--t 1,2]   (scene errors; elements outside the stage; clipped text)
//   list    bun scripts/render.ts list
// Explainers: --spec <file.explainer.json> renders that spec through explain.html (scene id `explainer`;
// states step-1 … step-N), e.g. `bun scripts/render.ts stills --spec my.explainer.json --state step-3 --t 0.35,0.7`.
// Interactive plates: --state <name|json> applies a view state first (names come from the scene's
// states(); `list` shows them). lint checks every named state, mid-transition and at rest.
// Theater: --fit 1440x900 lays the plate out for that space first, as the theater does (scene.fit: an
// aspect-aware relayout), so stills and lint show the arrangement a window of that size gets.
// Common: --theme <id> (src/engine/theme-pick.ts, e.g. adenine-jade)   --mode light|dark   --dpr 2 (pixel density of the output)
//         --url http://localhost:5180 (else a private no-HMR Vite server is started)
// Browser: CHROME_PATH=/path/to/chrome, or the installed Google Chrome channel.
import { chromium, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const mode = argv[0] ?? 'stills';
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(import.meta.dir, '..');
const OUT = path.join(ROOT, 'out');
const SPEC = opt('spec') ? path.resolve(opt('spec')!) : null;
const specName = SPEC ? path.basename(SPEC).replace(/(\.explainer)?\.json$/i, '') : '';

async function reachable(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}
async function server() {
  const url = opt('url', 'http://localhost:5180')!;
  if (await reachable(url)) return { url, stop: () => {} };
  const port = 5400 + Math.floor(Math.random() * 400);
  const proc = Bun.spawn(['bunx', 'vite', '--port', String(port), '--strictPort'], { cwd: ROOT, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, KARYO_NO_HMR: '1' } });
  const u = `http://localhost:${port}`;
  for (let i = 0; i < 150 && !(await reachable(u)); i++) await Bun.sleep(100);
  return { url: u, stop: () => proc.kill() };
}

async function open(url: string, scene?: string) {
  const exe = process.env.CHROME_PATH;
  const browser = await chromium.launch({
    ...(exe ? { executablePath: exe } : { channel: 'chrome' }),
    args: process.platform === 'darwin' ? ['--use-angle=metal', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const dpr = +opt('dpr', '2')!;
  // probe the stage width first so the stage renders at its native size
  const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: dpr });
  const logs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  const qs = new URLSearchParams({ export: '1' });
  if (SPEC) qs.set('spec', SPEC);
  else if (scene) qs.set('scene', scene);
  if (opt('theme')) qs.set('theme', opt('theme')!);
  if (opt('mode')) qs.set('mode', opt('mode')!);
  await page.goto(`${url}/${SPEC ? 'explain.html' : ''}?${qs}`);
  await page.waitForFunction(() => (window as any).__karyo?.ready, null, { timeout: 60000 });
  await page.evaluate(() => (window as any).__karyo.ready);
  if (scene) {
    const ids: string[] = await page.evaluate(() => (window as any).__karyo.ids);
    if (!ids.includes(scene)) throw new Error(`no scene "${scene}" (have: ${ids.join(', ')}). New scene files need a server restart when HMR is off.`);
    let info = await page.evaluate((id) => (window as any).__karyo.info(id), scene);
    if (opt('fit')) {
      const [fw, fh] = opt('fit')!.split('x').map(Number);
      info = { ...info, ...(await page.evaluate(([id, w, h]) => (window as any).__karyo.fit(id, w, h), [scene, fw, fh] as const)) };
    }
    await page.setViewportSize({ width: info.W, height: Math.ceil(info.H) + 4 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  const errs: Record<string, string[]> = await page.evaluate(() => (window as any).__karyo.errors());
  for (const [id, e] of Object.entries(errs)) if (e.length) console.error(`SCENE ERRORS in ${id}:\n${e.join('\n')}`);
  return { browser, page, logs };
}

async function applyState(page: Page, scene: string, st: string) {
  let v: unknown = st;
  try { v = JSON.parse(st); } catch { /* a state name */ }
  await page.evaluate(([id, v]) => (window as any).__karyo.setState(id, v), [scene, v] as const);
}

async function shot(page: Page, scene: string, t: number): Promise<Buffer> {
  await page.evaluate(([id, t]) => (window as any).__karyo.still(id, t), [scene, t] as const);
  return page.locator(`[data-scene="${scene}"] > .plate-viewport`).screenshot({ animations: 'disabled' });
}

const need = (k: string) => { const v = opt(k); if (!v) { console.error(`--${k} is required`); process.exit(1); } return v; };

const { url, stop } = await server();
const scene = SPEC ? 'explainer' : ['stills', 'sheet', 'video'].includes(mode) ? need('scene') : opt('scene');
const { browser, page, logs } = await open(url, scene);
const stateTag = (opt('state') ? `_${opt('state')!.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40)}` : '') + (opt('fit') ? `_fit${opt('fit')}` : '');
try {
  if (scene && opt('state')) await applyState(page, scene, opt('state')!);
  if (mode === 'list') {
    const ids: string[] = await page.evaluate(() => (window as any).__karyo.ids);
    for (const id of ids) { const i = await page.evaluate((id) => (window as any).__karyo.info(id), id); console.log(`${id.padEnd(24)} ${String(i.duration).padStart(5)} s  ${i.W}×${i.H}  ${i.title}${i.interactive ? `  [interactive; states: ${i.states.join(', ') || '—'}]` : ''}`); }
  } else if (mode === 'stills') {
    const dir = opt('out', path.join(OUT, 'stills', SPEC ? `explainer-${specName}` : scene!))!;
    mkdirSync(dir, { recursive: true });
    const themeTag = SPEC ? [opt('theme'), opt('mode')].filter(Boolean).map((x) => `_${x}`).join('') : '';
    for (const t of need('t').split(',').map(Number)) {
      const f = path.join(dir, `${SPEC ? specName : scene}${stateTag}${themeTag}_${t.toFixed(2).padStart(6, '0')}.png`);
      await Bun.write(f, await shot(page, scene!, t));
      console.log(f);
    }
  } else if (mode === 'sheet') {
    const info = await page.evaluate((id) => (window as any).__karyo.info(id), scene);
    const n = +opt('n', '12')!, cols = +opt('cols', '4')!;
    const from = +opt('from', '0')!, to = +opt('to', String(info.duration))!;
    const times = opt('times') ? opt('times')!.split(',').map(Number) : Array.from({ length: n }, (_, i) => from + ((to - from) * i) / Math.max(1, n - 1));
    const out = opt('out', path.join(OUT, `${scene}_sheet.png`))!;
    mkdirSync(path.dirname(out), { recursive: true });
    const tw = 480, th = Math.round((480 * info.H) / info.W), rows = Math.ceil(times.length / cols);
    const ff = Bun.spawn(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'png', '-i', 'pipe:0', '-vf', `scale=${tw}:${th},pad=${tw + 8}:${th + 8}:4:4:0x222222,tile=${cols}x${rows}`, '-frames:v', '1', out], { stdin: 'pipe' });
    for (const t of times) ff.stdin.write(await shot(page, scene!, t));
    ff.stdin.end(); await ff.exited;
    console.log(out);
    console.log(`times (row-major): ${times.map((t) => t.toFixed(2)).join(', ')}`);
  } else if (mode === 'video') {
    const info = await page.evaluate((id) => (window as any).__karyo.info(id), scene);
    const fps = +opt('fps', '30')!, from = +opt('from', '0')!, to = +opt('to', String(info.duration))!;
    const out = opt('out', path.join(OUT, `${scene}.mp4`))!;
    mkdirSync(path.dirname(out), { recursive: true });
    const ext = path.extname(out).toLowerCase();
    const enc = ext === '.gif'
      ? ['-filter_complex', `fps=${Math.min(fps, 25)},scale=${opt('gif-width', '720')}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=sierra2_4a`]
      : ext === '.webm'
        ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', opt('crf', '32')!, '-pix_fmt', 'yuv420p']
        : ['-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', opt('preset', 'medium')!, '-crf', opt('crf', '18')!, '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    const ff = Bun.spawn(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', 'pipe:0', ...enc, out], { stdin: 'pipe' });
    const n = Math.round((to - from) * fps), t0 = performance.now();
    for (let i = 0; i < n; i++) {
      ff.stdin.write(await shot(page, scene!, from + i / fps));
      if (i % 15 === 0) process.stdout.write(`\r${i + 1}/${n} frames  ${((i + 1) / ((performance.now() - t0) / 1000)).toFixed(1)} fps  `);
    }
    ff.stdin.end(); await ff.exited;
    console.log(`\nwrote ${out}`);
  } else if (mode === 'lint') {
    const ids: string[] = scene ? [scene] : await page.evaluate(() => (window as any).__karyo.ids);
    let issues = 0;
    for (const id of ids) {
      const info = await page.evaluate((id) => (window as any).__karyo.info(id), id);
      const times = opt('t') ? opt('t')!.split(',').map(Number) : [info.duration * 0.25, info.duration * 0.5, info.duration * 0.75, info.duration];
      // interactive plates: every named state (or just --state), each mid-transition and at rest
      const states: (string | null)[] = info.interactive && !opt('state') && info.states.length ? info.states : [null];
      for (const st of states) {
        if (st) await applyState(page, id, st);
        for (const t of times) {
          const found: string[] = await page.evaluate(([id, t]) => (window as any).__karyo.lint(id, t), [id, t] as const);
          for (const f of found) { console.log(`${id}${st ? ` [${st}]` : ''} @${t.toFixed(2)}s: ${f}`); issues++; }
        }
      }
    }
    console.log(issues ? `${issues} issue(s)` : 'no issues');
  } else {
    console.error(`unknown mode ${mode}`);
  }
} finally {
  if (logs.length) console.error('BROWSER LOG:\n' + [...new Set(logs)].slice(0, 20).join('\n'));
  await browser.close();
  stop();
}
