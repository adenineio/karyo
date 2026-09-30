// A CI run as a live graph of HTML job cards: jobs pop in, elbow wires route between them,
// work flows as packets, each card's status text and progress bar update, and the three
// parallel jobs have to finish before deploy starts.
import { Scene, type Frame, type Fx, wire, prog, ease, springStep, clamp, packets, pulseRing, lightUnder, comet, type Path } from '../engine';

interface Job { id: string; name: string; detail: string; x: number; y: number; depth: number; run: [number, number]; after: string[] }

const JOBS: Job[] = [
  { id: 'push', name: 'push', detail: 'main · 3f9c2e1', x: 48, y: 232, depth: 0, run: [1.2, 1.8], after: [] },
  { id: 'install', name: 'install', detail: 'bun install', x: 277, y: 232, depth: 1, run: [2.3, 3.2], after: ['push'] },
  { id: 'lint', name: 'lint', detail: 'eslint · 212 files', x: 506, y: 112, depth: 2, run: [3.8, 4.7], after: ['install'] },
  { id: 'test', name: 'test', detail: '418 tests', x: 506, y: 232, depth: 2, run: [3.8, 6.1], after: ['install'] },
  { id: 'build', name: 'build', detail: 'vite build', x: 506, y: 352, depth: 2, run: [3.8, 5.3], after: ['install'] },
  { id: 'deploy', name: 'deploy', detail: 'preview → prod', x: 735, y: 232, depth: 3, run: [6.6, 7.6], after: ['lint', 'test', 'build'] },
];
const HOP = 0.5; // seconds a packet takes along a wire

export default class CiPipeline extends Scene {
  static title = 'A CI run, job by job';
  static duration = 9.5;
  static poster = 9;

  build(dom: HTMLElement) {
    dom.innerHTML = `
      <style>
        .ci-head { position: absolute; left: 48px; top: 36px; display: grid; gap: 6px; }
        .ci-job { position: absolute; width: 176px; padding: 12px 14px 14px; display: grid; gap: 6px; }
        .ci-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
        .ci-name { font: 600 16px/1.2 var(--pl-font-display); }
        .ci-status { font: 500 11px/1 var(--pl-font-mono); letter-spacing: 0.04em; color: var(--pl-muted); }
        .ci-job.is-run .ci-status { color: var(--pl-accent); }
        .ci-job.is-ok .ci-status { color: var(--pl-ok); }
        .ci-detail { font: 12px/1.3 var(--pl-font-mono); color: var(--pl-muted); }
        .ci-bar { height: 3px; border-radius: 2px; background: var(--pl-card-border); overflow: hidden; }
        .ci-bar > i { display: block; height: 100%; background: var(--pl-accent); transform-origin: 0 50%; transform: scaleX(var(--k, 0)); }
        .ci-job.is-ok .ci-bar > i { background: var(--pl-ok); }
        .ci-sum { position: absolute; left: 48px; bottom: 36px; }
      </style>
      <header class="ci-head">
        <div class="pl-label">Pipeline · run #1284</div>
        <h1 class="pl-title" id="headline">Checks running…</h1>
      </header>
      ${JOBS.map((j) => `
        <article class="pl-card ci-job" id="${j.id}" style="left:${j.x}px; top:${j.y}px">
          <div class="ci-row"><span class="ci-name">${j.name}</span><span class="ci-status" id="${j.id}-st">queued</span></div>
          <div class="ci-detail">${j.detail}</div>
          <div class="ci-bar"><i id="${j.id}-bar"></i></div>
        </article>`).join('')}
      <p class="pl-body pl-muted ci-sum" id="sum">lint, test and build run in parallel; deploy waits for all three.</p>`;
  }

  appear(t: number, j: Job) { return 0.2 + j.depth * 0.22; }

  update(f: Frame) {
    const t = f.t;
    const h = prog(t, 0, 0.6, ease.outExpo);
    this.$('.ci-head').set({ opacity: h, y: 16 * (1 - h) });
    for (const j of JOBS) {
      const n = this.$(`#${j.id}`), t0 = this.appear(t, j);
      const s = springStep(t - t0, 2.2, 0.45);
      n.set({ opacity: clamp((t - t0) / 0.25), scale: 0.85 + 0.15 * s, y: 10 * (1 - s) });
      const k = prog(t, j.run[0], j.run[1], ease.inOutQuad);
      const running = t >= j.run[0] && t < j.run[1], done = t >= j.run[1];
      n.classes['is-run'] = running;
      n.classes['is-ok'] = done;
      n.classes['is-lit'] = running;
      this.$(`#${j.id}-st`).text = done ? 'passed ✓' : running ? `${Math.round(k * 100)}%` : 'queued';
      this.$(`#${j.id}-bar`).vars['--k'] = k.toFixed(4);
    }
    const allDone = t >= JOBS.at(-1)!.run[1];
    this.$('#headline').text = allDone ? 'All checks passed' : 'Checks running…';
    this.$('#sum').opacity = prog(t, 0.8, 1.4);
  }

  draw(f: Frame, fx: Fx) {
    const t = f.t, L = fx.under.lines, bg = fx.under.bg;
    bg.pattern = 'grid'; bg.spacing = 24; bg.patternAlpha = 0.18;
    for (const j of JOBS) {
      const to = this.$(`#${j.id}`);
      for (const a of j.after) {
        const from = this.$(`#${a}`), J = JOBS.find((x) => x.id === a)!;
        const w = wire(from.at('right', 0.5, 2), to.at('left', 0.5, 2), { kind: 'elbow', radius: 14 });
        // wire draws on once both ends are in
        const shown = Math.max(this.appear(t, j), this.appear(t, J)) + 0.15;
        L.path(w, { to: prog(t, shown, shown + 0.4, ease.inOutCubic), color: 'line', width: 1.5 });
        // after the upstream job passes, a comet carries its result to this job
        this.carry(L, w, t, J.run[1], j.id + a);
        // while this job runs, packets keep flowing into it
        if (t > j.run[0] && t < j.run[1]) packets(L, w, t, { spacing: 28, speed: 90, size: 3.5, glow: 2, to: 1 });
      }
      if (t >= j.run[0]) pulseRing(L, to.at('left'), t, j.run[0], { r1: 34 });
      const run = prog(t, j.run[0], j.run[0] + 0.3) * (1 - prog(t, j.run[1], j.run[1] + 0.6));
      lightUnder(bg, to, 0.28 * run, f.theme.accent, 0.55);
    }
    // finish: a wash of light behind deploy
    const fin = prog(t, 7.6, 8.2) * (1 - prog(t, 8.8, 9.5));
    lightUnder(bg, this.$('#deploy'), 0.4 * fin, f.theme.ok, 0.9);
  }

  private carry(L: Fx['under']['lines'], w: Path, t: number, t0: number, seed: string) {
    const k = prog(t, t0, t0 + HOP, ease.inOutCubic);
    if (k <= 0) return;
    L.path(w, { to: k, color: 'accent', width: 1.8, alpha: 1 - 0.55 * prog(t, t0 + HOP, t0 + HOP + 0.6) });
    const headAt = (tb: number) => (tb >= t0 && tb <= t0 + HOP ? w.at(prog(tb, t0, t0 + HOP, ease.inOutCubic)) : null);
    comet(L, t, headAt, { scale: 0.8, embers: 35, seed: seed.length * 7 + seed.charCodeAt(0) });
  }
}
