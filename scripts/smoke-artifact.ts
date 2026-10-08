#!/usr/bin/env bun
// Smoke test of an explainer built for a hosted artifact frame (docs/ARTIFACTS.md):
//   bun scripts/smoke-artifact.ts <file.explainer.json | file.html> [--shots <dir>]
// A spec is built first with the artifact target (into a temp dir); an .html file is checked as is.
// The page is loaded inside a sandboxed iframe (srcdoc), the way a host frames it, in the invisible headless shell
// ($CHROME_PATH):
//   - the file: under 16 MB, a <title> of 2-4 words, no external script or stylesheet, no network request at all
//   - strict frame (allow-scripts only: storage and fullscreen throw or are refused), at phone width (390) and desktop
//     (1280), light and dark: no errors, every step lands and lints clean, no horizontal scroll, a 16 px gutter at
//     phone width, an explicit body background, adenine whatever the colour scheme, a Theme select of exactly Adenine
//     and Fresh, and a pick that works without storage (each drawn, nothing fetched, steps lint clean),
//     the theater opening and closing with fullscreen blocked
//   - a frame that allows fullscreen: the theater asks for it and leaves it again on Esc
// Exit 1 if any check fails.
import { chromium, type Frame, type Page } from 'playwright-core';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = argv.find((a) => !a.startsWith('--'));
const shotsAt = argv.indexOf('--shots');
const shots = shotsAt >= 0 ? path.resolve(argv[shotsAt + 1] ?? 'shots') : null;
if (!arg) { console.error('usage: bun scripts/smoke-artifact.ts <file.explainer.json | file.html> [--shots <dir>]'); process.exit(2); }
let file = path.resolve(arg);
if (!file.endsWith('.html')) {
  const { buildHtml } = await import('../src/explainer/build');
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'karyo-artifact-smoke-')), 'artifact.html');
  const r = await buildHtml(file, out, { target: 'artifact' });
  for (const i of r.issues) console.log(`${i.level === 'error' ? 'FAIL' : 'warn'} spec ${i.path || '/'}: ${i.message}`);
  if (r.issues.some((i) => i.level === 'error')) process.exit(1);
  file = r.file;
}
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// ---- the file itself
const html = readFileSync(file, 'utf8');
const bytes = Buffer.byteLength(html);
check(bytes < 16 * 1024 * 1024, `size ${(bytes / 1e6).toFixed(2)} MB (limit 16 MB)`);
const title = (html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '').trim();
const words = title.split(/\s+/).filter(Boolean).length;
check(words >= 2 && words <= 4, `<title> "${title}" has ${words} word(s) (2-4)`);
const ALLOWED_SCRIPT = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net\/npm|unpkg\.com)\//;
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g)].map((m) => m[1]!);
const sheets = [...html.matchAll(/<link\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1]!);
check(scripts.every((s) => ALLOWED_SCRIPT.test(s)), `external scripts only from cdnjs / jsdelivr / unpkg (${scripts.length})`);
check(sheets.every((s) => s.startsWith('https://fonts.googleapis.com/')), `stylesheets only from Google Fonts (${sheets.length})`);

// ---- in a frame
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const host = (sandbox: string, allow: string) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style></head>`
  + `<body><iframe id="f" sandbox="${sandbox}"${allow ? ` allow="${allow}"` : ''} srcdoc="${attr(html)}"></iframe></body></html>`;

async function open(viewport: { width: number; height: number }, scheme: 'light' | 'dark', sandbox: string, allow = ''): Promise<{ page: Page; frame: Frame; errors: string[]; requests: string[] }> {
  const page = await browser.newPage({ viewport, colorScheme: scheme });
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.route('**/*', (r) => { const u = r.request().url(); if (!/^(data|about|blob):/.test(u)) requests.push(u); return r.abort(); });
  page.on('request', (r) => { const u = r.url(); if (!/^(data|about|blob):/.test(u) && !requests.includes(u)) requests.push(u); });
  await page.setContent(host(sandbox, allow));
  const frame = await (await page.$('#f'))!.contentFrame();
  if (!frame) throw new Error('no frame');
  await frame.waitForFunction(() => (window as any).__karyo?.ready, null, { timeout: 30000 });
  await frame.evaluate(() => (window as any).__karyo.ready);
  return { page, frame, errors, requests };
}

const S = 'window.__karyo.stages.explainer';
const landed = (f: Frame) => f.waitForFunction(() => { const s = (window as any).__karyo.stages.explainer; return !s.playing && s.t >= s.duration; }, null, { timeout: 15000 });
const lum = (rgb: string) => { const m = rgb.match(/\d+(\.\d+)?/g)?.map(Number) ?? [0, 0, 0]; return (0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!) / 255; };

for (const [vw, vh, label] of [[390, 844, 'phone'], [1280, 860, 'desktop']] as const) {
  for (const scheme of ['dark', 'light'] as const) {
    const tag = `${label} ${scheme}, strict frame`;
    const { page, frame, errors, requests } = await open({ width: vw, height: vh }, scheme, 'allow-scripts');
    const N = await frame.evaluate(`${S}.scene.stepCount`) as number;
    const lints: string[] = [];
    for (let i = 0; i < N; i++) {
      await frame.evaluate(`${S}.scene.go(${i})`); await landed(frame);
      const l = await frame.evaluate(`window.__karyo.lint('explainer', ${S}.duration)`) as string[];
      if (l.length) lints.push(`step ${i + 1}: ${l.join('; ')}`);
      if (shots && (i === 0 || i === N - 1)) await page.screenshot({ path: path.join(shots, `${label}-${scheme}-step${i + 1}.png`) });
    }
    check(lints.length === 0, `${tag}: all ${N} steps land and lint clean${lints.length ? ': ' + lints.join(' | ') : ''}`);
    const m = await frame.evaluate(() => {
      const de = document.documentElement, main = document.querySelector('main')!, plate = document.querySelector('.plate') as HTMLElement;
      const r = plate.getBoundingClientRect();
      return {
        sw: de.scrollWidth, cw: de.clientWidth, pad: parseFloat(getComputedStyle(main).paddingLeft), left: r.left, right: innerWidth - r.right,
        bodyBg: getComputedStyle(document.body).backgroundColor, plateTheme: de.dataset.plateTheme ?? null, sel: (document.getElementById('karyo-theme') as HTMLSelectElement).value,
      };
    });
    check(m.sw <= m.cw, `${tag}: no horizontal scroll (scrollWidth ${m.sw}, width ${m.cw})`);
    if (label === 'phone') check(m.pad === 16 && m.left >= 15.5 && m.right >= 15.5, `${tag}: 16 px gutter (padding ${m.pad}, plate ${m.left.toFixed(1)} / ${m.right.toFixed(1)} from the edges)`);
    check(!/rgba\(0, 0, 0, 0\)|transparent/.test(m.bodyBg), `${tag}: body has its own background (${m.bodyBg})`);
    check(m.plateTheme === 'adenine' && m.sel === 'adenine' && lum(m.bodyBg) < 0.1, `${tag}: adenine whatever the colour scheme (plate theme ${m.plateTheme ?? 'none'}, picker "${m.sel}", body ${m.bodyBg})`);
    // the theater with fullscreen refused by the frame
    await frame.evaluate(`${S}.scene.go(0)`); await landed(frame);
    await frame.locator('.plate-theater-btn').click();
    const inT = await frame.evaluate(`${S}.inTheater`) as boolean;
    const fs = await frame.evaluate(() => !!document.fullscreenElement);
    check(inT && !fs, `${tag}: theater opens with fullscreen blocked (in theater ${inT}, fullscreen ${fs})`);
    if (shots && label === 'phone') await page.screenshot({ path: path.join(shots, `${label}-${scheme}-theater.png`) });
    await frame.locator('.plate-viewport').first().focus();
    await page.keyboard.press('Escape');
    check(!(await frame.evaluate(`${S}.inTheater`)), `${tag}: Esc leaves the theater`);
    // a theme pick with no storage
    const opts = await frame.locator('#karyo-theme option').allTextContents();
    check(JSON.stringify(opts) === '["Adenine","Fresh"]', `${tag}: the Theme select offers exactly Adenine, Fresh (${opts.join(', ')})`);
    // the themes in a frame: nothing fetched (their web fonts fall back along the stacks), the glass chrome
    // drawn (blurred where the browser can, opaque fills where it can't), steps still lint clean
    for (const g of ['fresh', 'adenine']) {
      await frame.selectOption('#karyo-theme', g);
      await frame.waitForTimeout(500);   // the plate measures its elements again in the new theme's type
      await frame.evaluate(`${S}.scene.go(${Math.min(2, N - 1)})`); await landed(frame);
      const gl = await frame.evaluate(`window.__karyo.lint('explainer', ${S}.duration)`) as string[];
      const gm = await frame.evaluate(() => {
        const pl = document.querySelector('.plate') as HTMLElement, btn = document.querySelector('#kx-play') as HTMLElement | null;
        const cs = btn ? getComputedStyle(btn) : null;
        return { theme: document.documentElement.dataset.plateTheme, bg: getComputedStyle(pl).getPropertyValue('--pl-bg').trim(), body: getComputedStyle(document.body).backgroundColor,
          btn: cs ? { fill: cs.backgroundImage !== 'none' || !/rgba\(0, 0, 0, 0\)/.test(cs.backgroundColor), blur: cs.backdropFilter || (cs as any).webkitBackdropFilter || 'none' } : null };
      });
      check(gm.theme === g && lum(gm.body) < 0.1 && (!gm.btn || gm.btn.fill) && gl.length === 0, `${tag}: ${g} applies in the frame (theme ${gm.theme}, lint ${gl.length}, plate bg ${gm.bg}, body ${gm.body}, Play ${gm.btn ? `${gm.btn.fill ? 'filled' : 'NOT filled'}, backdrop ${gm.btn.blur}` : 'absent'})${gl.length ? ': ' + gl.join('; ') : ''}`);
      if (shots && label === 'desktop') await page.screenshot({ path: path.join(shots, `${label}-${scheme}-${g}.png`) });
    }
    check(errors.length === 0, `${tag}: no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
    check(requests.length === 0, `${tag}: no network requests${requests.length ? ': ' + requests.slice(0, 5).join(', ') : ''}`);
    await page.close();
  }
}

// ---- a frame that allows fullscreen: the theater goes fullscreen and comes back
{
  const { page, frame, errors } = await open({ width: 1280, height: 860 }, 'dark', 'allow-scripts allow-same-origin', 'fullscreen');
  await frame.locator('.plate-theater-btn').click();
  const fs = await frame.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 3000 }).then(() => true, () => false);
  check(fs && (await frame.evaluate(`${S}.inTheater`)) as boolean, `fullscreen-allowed frame: the theater asks for fullscreen and gets it (${fs})`);
  await frame.locator('.plate-theater-btn').click();
  const out = await frame.waitForFunction(() => !document.fullscreenElement, null, { timeout: 3000 }).then(() => true, () => false);
  check(out && !(await frame.evaluate(`${S}.inTheater`)), 'fullscreen-allowed frame: closing the theater leaves fullscreen');
  check(errors.length === 0, `fullscreen-allowed frame: no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
  await page.close();
}

await browser.close();
console.log(failed ? `${failed} check(s) failed` : `all checks passed (${path.basename(file)}, ${(bytes / 1e6).toFixed(2)} MB)`);
process.exit(failed ? 1 : 0);
