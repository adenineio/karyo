#!/usr/bin/env bun
// Interaction smoke test for a built explainer (the single-file HTML that ships):
//   bun scripts/smoke-explainer.ts <file.explainer.json | file.html>
// A spec is built first (buildHtml, into a temp dir); an .html file is opened as is, from file://.
// Checks: every step lands with no page / scene errors and a clean at-rest lint; keys (→ j Enter ← End
// Home digits), a station click, play and its interruption (key, click), the theater (f, arrows, Esc),
// the page API (go, prev), and motion 0 (a step lands at once). Exit 1 if any check fails.
import { chromium, type Page } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = process.argv[2];
if (!arg) { console.error('usage: bun scripts/smoke-explainer.ts <file.explainer.json | file.html>'); process.exit(2); }
let file = path.resolve(arg);
if (!file.endsWith('.html')) {
  const { buildHtml } = await import('../src/explainer/build');
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'karyo-smoke-')), 'explainer.html');
  const r = await buildHtml(file, out);
  const errs = r.issues.filter((i) => i.level === 'error');
  for (const i of r.issues) console.log(`${i.level === 'error' ? 'FAIL' : 'warn'} spec ${i.path || '/'}: ${i.message}`);
  if (errs.length) process.exit(1);
  file = r.file;
}

let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.goto(pathToFileURL(file).href);
await page.waitForFunction(() => (window as any).__karyo?.ready, null, { timeout: 30000 });
await page.evaluate(() => (window as any).__karyo.ready);

const S = 'window.__karyo.stages.explainer';
const ev = <T>(js: string) => page.evaluate(js) as Promise<T>;
const step = () => ev<number>(`${S}.scene.step`);
const N = await ev<number>(`${S}.scene.stepCount`);
const landed = (p: Page = page) => p.waitForFunction(() => { const s = (window as any).__karyo.stages.explainer; return !s.playing && s.t >= s.duration; }, null, { timeout: 5000 });
const text = (sel: string) => ev<string | null>(`${S}.dom.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const focus = () => page.locator('.plate-viewport').first().focus();
const press = async (k: string) => { await page.keyboard.press(k); await landed(); };
const title = await page.title();
console.log(`${title}: ${N} step(s), ${path.relative(process.cwd(), file) || file}`);

// ---- every step at rest: no errors, a clean lint, only its own narration shown
for (let i = 0; i < N; i++) {
  await ev(`${S}.scene.go(${i})`); await landed();
  const lint = await ev<string[]>(`window.__karyo.lint('explainer', ${S}.duration)`);
  const panes = await ev<string[]>(`[...${S}.dom.querySelectorAll('.kx-tx')].filter((e) => !e.hidden && +getComputedStyle(e).opacity > 0.5).map((e) => e.id)`);
  const ok = lint.length === 0 && (panes.length === 0 || (panes.length === 1 && panes[0] === `t${i}`));
  check(ok, `step ${i + 1} at rest${lint.length ? `: ${lint.join('; ')}` : ''}${panes.length > 1 ? ` (panes shown: ${panes.join(', ')})` : ''}`);
}
check(errors.length === 0, `no page errors stepping through all ${N} steps${errors.length ? ': ' + errors.join('; ') : ''}`);

if (N > 1) {
  // ---- keys
  await ev(`${S}.scene.go(0)`); await landed();
  await focus();
  check((await text('#kx-mode'))?.startsWith(`step 1 of ${N}`) ?? false, `mode line: "${await text('#kx-mode')}"`);
  await press('ArrowRight'); check((await step()) === 1, 'ArrowRight → step 2');
  if (N > 2) { await press('j'); check((await step()) === 2, 'j → step 3'); }
  await press('ArrowLeft'); check((await step()) === (N > 2 ? 1 : 0), 'ArrowLeft → back one');
  await press('Enter'); check((await step()) === (N > 2 ? 2 : 1), 'Enter → forward one');
  await press('End'); check((await step()) === N - 1, 'End → last step');
  await press('Home'); check((await step()) === 0, 'Home → step 1');
  const d = Math.min(N, 9);
  await press(String(d)); check((await step()) === d - 1, `${d} → step ${d}`);
  await press('k'); check((await step()) === d - 2, 'k → back one');

  // ---- a station
  const hasStations = await ev<boolean>(`!!${S}.dom.querySelector('#st1')`);
  if (hasStations) {
    const si = Math.min(2, N - 1);
    await page.locator(`#st${si}`).click(); await landed();
    check((await step()) === si, `clicking station ${si + 1} → step ${si + 1}`);
    check((await text('#kx-mode'))?.startsWith(`step ${si + 1} of ${N}`) ?? false, 'mode line follows the step');
  }

  // ---- play: chains steps; any key stops it and it stays
  await ev(`${S}.scene.go(0)`); await landed();
  await focus();
  await page.keyboard.press('p');
  check((await text('#kx-play')) === 'Stop', 'p → playing (button reads "Stop")');
  const advanced = await page.waitForFunction(() => (window as any).__karyo.stages.explainer.scene.step >= 1, null, { timeout: 12000 }).then(() => true, () => false);
  check(advanced, 'play advanced a step on its own');
  await page.keyboard.press('x');
  const stopAt = await step();
  await Bun.sleep(2200);
  check((await step()) === stopAt && (await text('#kx-play')) === 'Play', `a key stops play and it stays (on step ${stopAt + 1})`);

  // ---- play from the button, stopped by a click elsewhere on the plate
  await page.locator('#kx-play').click();
  check((await text('#kx-play')) === 'Stop', 'Play button → playing');
  await page.locator('#kx-next').click(); await landed();
  const afterClick = await step();
  await Bun.sleep(1500);
  check((await step()) === afterClick && (await text('#kx-play')) === 'Play', 'a click stops play and does what it was aimed at');

  // ---- theater: f opens, arrows step, Esc closes and keeps the step
  const hasTheater = await ev<boolean>(`!!${S}.theaterBtn`);
  if (hasTheater) {
    await ev(`${S}.scene.go(0)`); await landed();
    await focus();
    await page.keyboard.press('f');
    check(await ev<boolean>(`${S}.inTheater`), 'f → theater');
    check((await text('#kx-mode'))?.includes('Esc leave theater') ?? false, 'mode line offers Esc in the theater');
    await press('ArrowRight');
    check((await step()) === 1, 'arrows step in the theater');
    await page.keyboard.press('Escape');
    check(!(await ev<boolean>(`${S}.inTheater`)) && (await step()) === 1, 'Esc → leaves the theater, step kept');
  } else console.log('skip theater (no theater button on this page)');

  // ---- page API
  await ev(`${S}.scene.go(${N - 1})`); await landed();
  check((await step()) === N - 1, `scene.go(${N - 1}) → last step`);
  await ev(`${S}.scene.prev()`); await landed();
  check((await step()) === N - 2, 'scene.prev() → one back');

  // ---- motion 0: a step lands at once, on the same end state
  const hasDial = await ev<boolean>(`typeof window.KaryoExplainer?.setMotion === 'function'`);
  if (hasDial) {
    await ev(`${S}.scene.go(0)`); await landed();
    await ev(`KaryoExplainer.setMotion(0)`);
    await focus();
    await page.keyboard.press('ArrowRight');
    const st = await ev<{ step: number; t: number; d: number; playing: boolean }>(`({ step: ${S}.scene.step, t: ${S}.t, d: ${S}.duration, playing: ${S}.playing })`);
    check(st.step === 1 && st.t >= st.d && !st.playing, `motion 0 → step 2 lands at once (t=${st.t}, playing=${st.playing})`);
    const lint = await ev<string[]>(`window.__karyo.lint('explainer', ${S}.duration)`);
    check(lint.length === 0, `motion 0 end state lints clean${lint.length ? ': ' + lint.join('; ') : ''}`);
    await ev(`KaryoExplainer.setMotion(1)`);
  } else console.log('skip motion 0 (no KaryoExplainer.setMotion on this page)');
}

// ---- the legend (when the spec has categories / tags): hover lights, click pins, Esc clears
const hasLegend = await ev<boolean>(`!!${S}.dom.querySelector('.kx-legend')`);
if (hasLegend) {
  await ev(`${S}.scene.go(${N - 1})`); await landed();
  const tag = page.locator('.kx-legend .lg-e').last();
  const tagId = (await tag.getAttribute('data-lg'))!;
  const shown = () => ev<{ id: string; o: number }[]>(`[...${S}.dom.querySelectorAll('.kx-el')].filter((e) => getComputedStyle(e).visibility !== 'hidden' && +getComputedStyle(e).opacity > 0.05).map((e) => ({ id: e.dataset.id, o: +getComputedStyle(e).opacity }))`);
  const before = await shown();
  await tag.hover();
  const during = await shown();
  const dimmed = during.filter((x) => x.o < 0.5).length, full = during.filter((x) => x.o > 0.95).length;
  check(dimmed > 0 && full > 0 && full < before.length, `hovering legend entry "${tagId}" lights its elements (${full} lit, ${dimmed} dimmed)`);
  await tag.click(); await landed();
  await page.mouse.move(2, 2);
  check(JSON.stringify((await ev<{ pins: string[] }>(`${S}.scene.getState()`)).pins) === JSON.stringify([tagId]), 'click pins it');
  check((await shown()).filter((x) => x.o < 0.5).length === dimmed, 'the pin keeps the same elements lit after the pointer leaves');
  await focus();
  await page.keyboard.press('Escape'); await landed();
  check((await ev<{ pins: string[] }>(`${S}.scene.getState()`)).pins.length === 0, 'Esc clears the pins');
} else console.log('skip legend (the spec has no categories or tags)');

// ---- Bench: b toggles; an element dragged in Bench keeps its place on other steps until Reset layout
const benchBtn = await ev<boolean>(`!!${S}.root.querySelector('.plate-bench-btn')`);
if (benchBtn) {
  await ev(`${S}.scene.go(${N - 1})`); await landed();
  const vis = await ev<string>(`[...${S}.dom.querySelectorAll('.kx-el')].find((e) => getComputedStyle(e).visibility !== 'hidden' && +getComputedStyle(e).opacity > 0.5)?.id ?? ''`);
  const el = page.locator(`#${vis}`);
  const dragBy = async (dx: number, dy: number) => { const b = (await el.boundingBox())!; const sx = b.x + 20, sy = b.y + 20; await page.mouse.move(sx, sy); await page.mouse.down(); for (let i = 1; i <= 10; i++) await page.mouse.move(sx + (dx * i) / 10, sy + (dy * i) / 10); await page.mouse.up(); };
  const id = await ev<string>(`${S}.dom.querySelector('#${vis}').dataset.id`);
  const planned = (i: number) => ev<{ x: number; y: number } | null>(`(${S}.scene.pos[${i}].get(${JSON.stringify(id)}) ?? null)`);
  const p0 = await planned(N - 1);
  await dragBy(60, 40); await landed();
  check(JSON.stringify(await planned(N - 1)) === JSON.stringify(p0), 'outside Bench an element does not drag');
  await focus();
  await page.keyboard.press('b');
  check(await ev<boolean>(`${S}.inBench`), 'b enters Bench');
  await dragBy(60, 40); await landed();
  const p1 = await planned(N - 1);
  check(!!p1 && !!p0 && Math.hypot(p1.x - p0.x, p1.y - p0.y) > 20, `in Bench the element drags (${p0 && p1 ? Math.round(Math.hypot(p1.x - p0.x, p1.y - p0.y)) : 0} board px)`);
  const every = await ev<boolean>(`${S}.scene.pos.every((m) => { const q = m.get(${JSON.stringify(id)}); return q && Math.abs(q.x - ${p1?.x ?? 0}) < 1 && Math.abs(q.y - ${p1?.y ?? 0}) < 1; })`);
  check(every, 'the moved element keeps its place on every step');
  await page.locator('#kx-reset').click(); await landed();
  check(JSON.stringify(await planned(N - 1)) === JSON.stringify(p0), 'Reset layout puts it back');
  await page.keyboard.press('b');
  check(!(await ev<boolean>(`${S}.inBench`)), 'b leaves Bench');
} else console.log('skip bench (no Bench button on this page)');

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
const sceneErr = await ev<string[]>(`window.__karyo.errors().explainer`);
check(sceneErr.length === 0, `no scene errors${sceneErr.length ? ': ' + sceneErr.join('; ') : ''}`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
