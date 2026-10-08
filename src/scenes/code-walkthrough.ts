// A real code block (selectable text) is stepped through line by line like a debugger. When
// execution reaches an interesting expression, the token is outlined where it sits in the text
// and a leader wire runs from it to a callout card. A trace strip shows the live values.
import { Scene, Path, type Frame, type Fx, wire, prog, ease, stagger, outline, pulseRing, lightUnder, type Node } from '../engine';

const CODE = [
  `<span class="tok-k">async function</span> fetchWithRetry(url) {`,
  `  <span class="tok-k">for</span> (<span class="tok-k">let</span> attempt = 0; <span id="tk-cond">attempt &lt; 3</span>; attempt++) {`,
  `    <span class="tok-k">const</span> res = <span class="tok-k">await</span> fetch(url);`,
  `    <span class="tok-k">if</span> (<span id="tk-ok">res.ok</span>) <span class="tok-k">return</span> res.json();`,
  `    <span class="tok-k">await</span> sleep(<span id="tk-wait">2 ** attempt * 200</span>);`,
  `  }`,
  `  <span class="tok-k">throw new</span> Error(<span class="tok-s">'gave up after 3 tries'</span>);`,
  `}`,
];

/** The execution trace: which line runs when, and the values it produces. */
const STEPS: { t: number; line: number; attempt: number; status?: string; wait?: string }[] = [
  { t: 1.1, line: 0, attempt: -1 },
  { t: 1.5, line: 1, attempt: 0 },
  { t: 2.3, line: 2, attempt: 0, status: '503' },
  { t: 2.9, line: 3, attempt: 0, status: '503' },
  { t: 3.3, line: 4, attempt: 0, status: '503', wait: '200 ms' },
  { t: 4.5, line: 1, attempt: 1 },
  { t: 4.9, line: 2, attempt: 1, status: '503' },
  { t: 5.3, line: 3, attempt: 1, status: '503' },
  { t: 5.6, line: 4, attempt: 1, status: '503', wait: '400 ms' },
  { t: 6.4, line: 1, attempt: 2 },
  { t: 6.8, line: 2, attempt: 2, status: '200' },
  { t: 7.2, line: 3, attempt: 2, status: '200' },
];
const CALLOUTS = [
  { id: 'c-cond', token: 'tk-cond', at: 1.5, title: 'At most three tries', body: 'The loop gives up after attempts 0, 1 and 2.' },
  { id: 'c-wait', token: 'tk-wait', at: 3.3, title: 'Exponential backoff', body: 'Waits 200, then 400, then 800 ms between tries.' },
  { id: 'c-ok', token: 'tk-ok', at: 7.2, title: 'Success returns early', body: 'The first 2xx response ends the loop.' },
];

export default class CodeWalkthrough extends Scene {
  static title = 'Retry with backoff, step by step';
  static duration = 9.5;
  static poster = 9;
  static fx = 'both' as const;

  build(dom: HTMLElement) {
    dom.innerHTML = `
      <style>
        .cw-head { position: absolute; left: 48px; top: 36px; display: grid; gap: 6px; }
        .cw-code { position: absolute; left: 48px; top: 124px; width: 552px; box-sizing: border-box; font-size: 15px; line-height: 1.75; padding: 16px 20px; }
        .cw-code [id^="tk-"] { border-radius: 3px; }
        .cw-callout { position: absolute; left: 648px; width: 264px; display: grid; gap: 4px; padding: 12px 14px; }
        .cw-callout h3 { margin: 0; font: 600 15px/1.25 var(--pl-font-display); }
        .cw-callout p { margin: 0; font-size: 13px; line-height: 1.4; color: var(--pl-muted); }
        #c-cond { top: 124px; } #c-wait { top: 254px; } #c-ok { top: 384px; }
        .cw-trace { position: absolute; left: 48px; top: 420px; display: flex; gap: 8px; flex-wrap: wrap; }
        .cw-trace .pl-chip b { font-weight: 600; }
      </style>
      <header class="cw-head">
        <div class="pl-label">Pattern · resilient requests</div>
        <h1 class="pl-title">Retry with backoff, step by step</h1>
      </header>
      <pre class="pl-code cw-code">${CODE.map((l, i) => `<span class="ln" id="ln${i}">${l}</span>`).join('')}</pre>
      <div class="cw-trace">
        <span class="pl-chip" id="tr-attempt">attempt <b>–</b></span>
        <span class="pl-chip" id="tr-status">status <b>–</b></span>
        <span class="pl-chip" id="tr-wait">sleep <b>–</b></span>
      </div>
      ${CALLOUTS.map((c) => `<aside class="pl-card cw-callout" id="${c.id}"><h3>${c.title}</h3><p>${c.body}</p></aside>`).join('')}`;
  }

  step(t: number) { let s = null; for (const x of STEPS) if (x.t <= t) s = x; return s; }

  update(f: Frame) {
    const t = f.t, s = this.step(t);
    const h = prog(t, 0, 0.6, ease.outExpo);
    this.$('.cw-head').set({ opacity: h, y: 14 * (1 - h) });
    const c = prog(t, 0.3, 0.9, ease.outExpo);
    this.$('.cw-code').set({ opacity: c, y: 16 * (1 - c) });
    CODE.forEach((_, i) => {
      const k = stagger(t, i, 0.4, 0.05, 0.4);
      const ln = this.$(`#ln${i}`);
      ln.set({ opacity: k, x: -8 * (1 - k) });
      ln.classes['is-lit'] = !!s && s.line === i && t < 8.4;
    });
    const tr = prog(t, 0.9, 1.3);
    this.$('.cw-trace').set({ opacity: tr, y: 8 * (1 - tr) });
    // trace values (write into the <b> inside each chip via text on the chip's child)
    this.value('#tr-attempt', s && s.attempt >= 0 ? String(s.attempt) : '–');
    this.value('#tr-status', s?.status ?? '–');
    this.value('#tr-wait', s?.wait ?? '–');
    this.$('#tr-status').classes['is-lit'] = s?.status === '200';
    this.$('#tr-wait').classes['is-lit'] = !!s?.wait && s.line === 4;
    for (const co of CALLOUTS) {
      const k = prog(t, co.at + 0.25, co.at + 0.75, ease.outExpo);
      const n = this.$(`#${co.id}`);
      n.set({ opacity: k, x: 18 * (1 - k) });
      n.classes['is-lit'] = this.activeCallout(t) === co.id;
    }
  }

  private value(chip: string, v: string) {
    this.$(`${chip} b`).text = v;
  }
  private activeCallout(t: number) {
    const s = this.step(t);
    if (!s || t > 8.4) return null;
    if (s.line === 1) return 'c-cond';
    if (s.line === 4) return 'c-wait';
    if (s.line === 3 && s.status === '200') return 'c-ok';
    return null;
  }

  draw(f: Frame, fx: Fx) {
    const t = f.t, over = fx.over!.lines, under = fx.under.lines, bg = fx.under.bg;
    bg.pattern = 'dots'; bg.patternAlpha = 0.3;
    const code = this.$('.cw-code');
    const edge = code.bounds().x + code.bounds().w;
    const active = this.activeCallout(t);
    for (const co of CALLOUTS) {
      const tok: Node = this.$(`#${co.token}`), card = this.$(`#${co.id}`);
      const on = active === co.id;
      const draw = prog(t, co.at, co.at + 0.5, ease.inOutCubic);
      if (draw <= 0) continue;
      // outline the token where it sits in the text (over the code block)
      outline(over, tok, { progress: draw, pad: 3, radius: 5, width: on ? 1.6 : 1, alpha: on ? 1 : 0.45, glow: on ? 1.5 : 0 });
      // dashed leader from the token to the block's edge, then a wire to the callout
      const a = tok.at('right', 0.5, 4), b = { x: edge + 2, y: a.y };
      over.dashes(new Path([a, b]), { dash: 3, gap: 3, width: 1, color: 'accent', alpha: (on ? 0.8 : 0.35) * draw, to: draw });
      const w = wire(b, card.at('left', 0.5, 2), { kind: 'curve', tension: 0.45 });
      under.path(w, { to: draw, color: on ? 'accent' : 'line', width: on ? 1.8 : 1.3, glow: on ? 2 : 0 });
      if (t >= co.at) pulseRing(over, tok.at('left'), t, co.at, { r1: 26 });
      if (on) lightUnder(bg, card, 0.22, f.theme.accent, 0.55);
    }
  }
}
