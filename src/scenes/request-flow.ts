// A prompt is typed into a real text box, a comet carries it to the model, candidate tokens
// light up with their probabilities, and the answer streams into the third card word by word.
import { Scene, type Frame, type Fx, wire, prog, ease, stagger, typed, splitText, comet, pulseRing, packets, outline, lightUnder, countTo, type Path } from '../engine';

const PROMPT = 'Why is the sky blue?';
const TOKENS: [string, number][] = [['Sunlight', 0.62], ['Because', 0.21], ['The', 0.11]];

// cue sheet (s)
const T = { title: 0, cards: 0.3, type: [0.9, 2.1], wire1: [2.2, 2.8], hop1: [2.35, 3.1], think: 3.1, chips: 3.3, wire2: [4.3, 4.9], hop2: [4.4, 5.0], stream: 5.0 } as const;

export default class RequestFlow extends Scene {
  static title = 'How a request flows';
  static duration = 8;
  static poster = 7.5;

  words: HTMLElement[] = [];

  build(dom: HTMLElement) {
    dom.innerHTML = `
      <style>
        .rf-head { position: absolute; left: 56px; top: 44px; display: grid; gap: 8px; }
        .rf-card { position: absolute; top: 216px; width: 224px; display: grid; gap: 10px; }
        #prompt { left: 56px; } #model { left: 368px; } #answer { left: 680px; }
        .rf-text { margin: 0; min-height: 44px; }
        .rf-chips { display: grid; gap: 6px; }
        .rf-chip { display: flex; justify-content: space-between; gap: 12px; }
        .rf-note { position: absolute; left: 56px; bottom: 44px; max-width: 560px; }
      </style>
      <header class="rf-head">
        <div class="pl-label">Fig. 1 · Inference</div>
        <h1 class="pl-h1">How a request flows</h1>
      </header>
      <section class="pl-card rf-card" id="prompt">
        <div class="pl-label">Prompt</div>
        <p class="pl-body rf-text"><span id="ptext">${PROMPT}</span><span class="pl-caret" id="caret"></span></p>
      </section>
      <section class="pl-card rf-card" id="model">
        <div class="pl-label">Model · next token</div>
        <div class="rf-chips">
          ${TOKENS.map(([w], i) => `<span class="pl-chip rf-chip" id="chip${i}"><span>${w}</span><span class="pl-muted" id="pct${i}">0%</span></span>`).join('')}
        </div>
      </section>
      <section class="pl-card rf-card" id="answer">
        <div class="pl-label">Answer</div>
        <p class="pl-body rf-text" id="atext">Sunlight scatters off air molecules, and short blue wavelengths scatter the most.</p>
      </section>
      <p class="pl-body pl-muted rf-note">The model never sees the whole answer at once: it picks one token, appends it, and runs again.</p>`;
    this.words = splitText(dom.querySelector('#atext')!, 'words');
  }

  update(f: Frame) {
    const t = f.t;
    const intro = prog(t, T.title, T.title + 0.7, ease.outExpo);
    this.$('.rf-head').set({ opacity: intro, y: 24 * (1 - intro) });
    ['#prompt', '#model', '#answer'].forEach((id, i) => {
      const k = stagger(t, i, T.cards, 0.12, 0.6, ease.outExpo);
      this.$(id).set({ opacity: k, y: 28 * (1 - k), scale: 0.96 + 0.04 * k });
    });
    // typing
    const typing = prog(t, T.type[0], T.type[1]);
    this.$('#ptext').text = typed(PROMPT, typing);
    this.$('#caret').opacity = t > T.hop1[0] ? 0 : Math.floor(t * 2.5) % 2 === 0 || (typing > 0 && typing < 1) ? 1 : 0;
    // the model: lit while thinking, chips count up in turn
    this.$('#model').classes['is-lit'] = t >= T.think && t < T.stream + 0.4;
    TOKENS.forEach(([, p], i) => {
      const k = stagger(t, i, T.chips, 0.25, 0.5);
      const chip = this.$(`#chip${i}`);
      chip.opacity = 0.35 + 0.65 * k;
      chip.classes['is-lit'] = i === 0 && t > T.chips + 0.9;
      this.$(`#pct${i}`).text = `${countTo(0, p * 100, k)}%`;
    });
    // streaming answer
    this.$('#answer').classes['is-lit'] = t >= T.hop2[1] && t < T.stream + this.words.length * 0.11 + 0.3;
    this.words.forEach((w, i) => {
      const k = stagger(t, i, T.stream, 0.11, 0.35);
      this.$(w).set({ opacity: k, y: 6 * (1 - k), blur: 3 * (1 - k) });
    });
    this.$('.rf-note').opacity = prog(t, 6.2, 6.9);
  }

  draw(f: Frame, fx: Fx) {
    const t = f.t, L = fx.under.lines, bg = fx.under.bg;
    bg.pattern = 'dots'; bg.patternAlpha = 0.35;
    const P = this.$('#prompt'), M = this.$('#model'), A = this.$('#answer');
    const w1 = wire(P.at('right', 0.5, 4), M.at('left', 0.5, 4), { kind: 'curve' });
    const w2 = wire(M.at('right', 0.5, 4), A.at('left', 0.5, 4), { kind: 'curve' });
    this.hop(L, w1, t, T.wire1, T.hop1);
    this.hop(L, w2, t, T.wire2, T.hop2);
    // tokens flowing while the answer streams
    const streamEnd = T.stream + this.words.length * 0.11;
    if (t > T.stream && t < streamEnd + 0.4) packets(L, w2, t, { speed: 160, spacing: 36, size: 4, from: 0, to: prog(t, streamEnd, streamEnd + 0.4) > 0 ? 1 - prog(t, streamEnd, streamEnd + 0.4) : 1 });
    // arrivals
    pulseRing(L, M.at('left'), t, T.hop1[1], { r1: 46 });
    pulseRing(L, A.at('left'), t, T.hop2[1], { r1: 46 });
    // the model is outlined while it thinks, and lit from below
    const think = prog(t, T.think, T.think + 0.6, ease.inOutCubic) * (1 - prog(t, T.stream + 0.2, T.stream + 0.8));
    outline(L, M, { progress: think > 0 ? prog(t, T.think, T.think + 0.6, ease.inOutCubic) : 0, alpha: think, pad: 8, radius: 16, glow: 1.5, width: 1.2 });
    lightUnder(bg, M, 0.35 * think, f.theme.accent);
    lightUnder(bg, A, 0.3 * prog(t, T.hop2[1], T.hop2[1] + 0.5) * (1 - prog(t, streamEnd, streamEnd + 1)), f.theme.accent);
  }

  /** A wire that draws itself on, then a comet that runs along it leaving a hot trail. */
  private hop(L: Fx['under']['lines'], w: Path, t: number, drawOn: readonly number[], run: readonly number[]) {
    L.path(w, { to: prog(t, drawOn[0]!, drawOn[1]!, ease.inOutCubic), color: 'line', width: 1.5 });
    const k = prog(t, run[0]!, run[1]!, ease.inOutCubic);
    if (k <= 0) return;
    L.path(w, { to: k, color: 'accent', width: 2, glow: 2, alpha: 1 - prog(t, run[1]! + 0.4, run[1]! + 1.2) * 0.6 });
    const headAt = (tb: number) => (tb >= run[0]! && tb <= run[1]! ? w.at(prog(tb, run[0]!, run[1]!, ease.inOutCubic)) : null);
    comet(L, t, headAt);
  }
}
