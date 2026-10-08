// The network stack as real HTML cards in 3D (three.js CSS3DRenderer). A flat diagram tilts
// into an exploded view, then a request travels down the layers; each layer wraps it in its
// header. Guide lines and the comet are drawn on the fx canvas from the cards' projected corners.
import { Scene, Space3D, Path, type Frame, type Fx, keys, prog, ease, stagger, comet, pulseRing, lerp } from '../engine';

const LAYERS = [
  { id: 'l7', name: 'Application', proto: 'HTTP', hdr: 'GET /index.html', note: 'what the app asked for' },
  { id: 'l4', name: 'Transport', proto: 'TCP', hdr: 'TCP :443', note: 'ports, ordering, retries' },
  { id: 'l3', name: 'Network', proto: 'IP', hdr: 'IP 93.184.216.34', note: 'addresses, routing' },
  { id: 'l2', name: 'Link', proto: 'Ethernet', hdr: 'ETH', note: 'the next hop on the wire' },
];
const CARD_W = 380, CARD_H = 72;
const FLAT_Y = [126, 42, -42, -126];
const OPEN_Y = [132, 44, -44, -132];
const T = { explode: [1.3, 3.0], drop: 3.4, per: 1.15 } as const; // packet lands on layer i at drop + i*per

export default class NetworkStack extends Scene {
  static title = 'A request going down the stack';
  static duration = 10;
  static poster = 9.4;
  space!: Space3D;

  build(dom: HTMLElement) {
    dom.innerHTML = `
      <style>
        .ns-head { position: absolute; left: 48px; top: 36px; display: grid; gap: 6px; z-index: 2; }
        .ns-layer { width: ${CARD_W}px; height: ${CARD_H}px; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 16px; padding: 12px 18px; box-sizing: border-box; }
        .ns-layer h3 { margin: 0; font: 650 18px/1.1 var(--pl-font-display); }
        .ns-layer p { margin: 0; grid-column: 1; font-size: 12.5px; color: var(--pl-muted); }
        .ns-layer .pl-chip { grid-row: 1 / span 2; grid-column: 2; }
        .ns-packet { display: flex; gap: 4px; padding: 6px; border-radius: min(var(--pl-radius), 8px); background: var(--pl-card); border: 1px solid var(--pl-accent); box-shadow: var(--pl-shadow); white-space: nowrap; }
        .ns-packet span { font: 500 11px/1 var(--pl-font-mono); padding: 5px 7px; border-radius: min(var(--pl-radius), 5px); background: color-mix(in srgb, var(--pl-accent) 14%, transparent); color: var(--pl-fg); }
        .ns-packet span.is-off { display: none; }
        .ns-packet span.is-payload { background: var(--pl-accent); color: var(--pl-card); }
        .ns-foot { position: absolute; left: 48px; bottom: 32px; max-width: 520px; z-index: 2; }
      </style>
      <header class="ns-head"><div class="pl-label">Networking · encapsulation</div><h1 class="pl-title">A request going down the stack</h1></header>
      ${LAYERS.map((l) => `<section class="pl-card ns-layer" id="${l.id}"><h3>${l.name}</h3><p>${l.note}</p><span class="pl-chip">${l.proto}</span></section>`).join('')}
      <div class="ns-packet" id="packet">${[...LAYERS].reverse().map((l, i) => `<span id="h-${l.id}" class="${i === 3 ? 'is-payload' : ''}">${l.hdr}</span>`).join('')}</div>
      <p class="pl-body pl-muted ns-foot" id="foot">Each layer adds its own header in front; the receiver peels them off in reverse.</p>`;
    this.space = new Space3D(this.stage, { fov: 32 });
    LAYERS.forEach((l, i) => this.space.add(dom.querySelector<HTMLElement>(`#${l.id}`)!, { y: FLAT_Y[i] }));
    this.space.add(dom.querySelector<HTMLElement>('#packet')!, { y: 260, z: 0 });
  }

  /** 0..1 how exploded the stack is. */
  open(t: number) { return prog(t, T.explode[0], T.explode[1], ease.inOutCubic); }
  /** Layer the packet is on (fractional while falling), -1 before it enters. */
  packetPos(t: number) {
    const k = (t - T.drop) / T.per; // lands on layer i when k = i
    if (k < -0.6) return -1;
    const i = Math.floor(k), fr = k - i;
    // fall quickly in the first 35% of each interval, then rest on the layer
    return Math.min(LAYERS.length - 1, i + ease.inOutCubic(Math.min(1, Math.max(0, fr / 0.35))));
  }
  packetXYZ(t: number, pos: number) {
    const o = this.open(t);
    const yOf = (i: number) => (i < 0 ? 250 : lerp(FLAT_Y[i]!, OPEN_Y[i]!, o) + 30);
    const i0 = Math.floor(pos), fr = pos - i0;
    const y = i0 < 0 ? lerp(250, yOf(0), (pos + 1)) : lerp(yOf(i0), yOf(Math.min(i0 + 1, 3)), fr);
    return { x: 40, y, z: 28 };
  }

  update(f: Frame) {
    const t = f.t, s = this.space, o = this.open(t);
    const h = prog(t, 0, 0.6, ease.outExpo);
    this.$('.ns-head').set({ opacity: h, y: 12 * (1 - h) });
    // camera: straight-on diagram → three-quarter view from above
    s.cam.pitch = 26 * o;
    s.cam.yaw = -30 * o;
    s.cam.dolly = keys(t, [[0, 0], [T.explode[1], -330], [10, -260, ease.inOutQuad]]);
    s.cam.panY = 10 * o;
    LAYERS.forEach((l, i) => {
      const k = stagger(t, i, 0.25, 0.1, 0.5, ease.outExpo);
      s.pose(this.$(`#${l.id}`).el, { y: lerp(FLAT_Y[i]!, OPEN_Y[i]!, o), rx: -70 * o, opacity: k, z: 10 * (1 - k) });
    });
    // packet: enters above the top layer, drops layer by layer, gains a header at each
    const pos = this.packetPos(t);
    const p = this.packetXYZ(t, pos);
    const shown = prog(t, T.drop - 0.7, T.drop - 0.3);
    s.pose(this.$('#packet').el, { ...p, rx: -70 * o, opacity: shown });
    LAYERS.forEach((l, i) => {
      // layer i's header appears as the packet lands on it (the payload is layer 0's)
      const on = i === 0 ? 1 : prog(t, T.drop + i * T.per + 0.05, T.drop + i * T.per + 0.35, ease.outBack);
      const hn = this.$(`#h-${l.id}`);
      hn.classes['is-off'] = on <= 0;
      hn.set({ scale: 0.6 + 0.4 * on, opacity: on });
      this.$(`#${l.id}`).classes['is-lit'] = pos >= 0 && Math.round(pos) === i && Math.abs(pos - i) < 0.05;
    });
    this.$('#foot').opacity = prog(t, 8.2, 8.9);
  }

  draw(f: Frame, fx: Fx) {
    const t = f.t, L = fx.under.lines, s = this.space, o = this.open(t);
    fx.under.bg.pattern = 'grid'; fx.under.bg.patternAlpha = 0.12; fx.under.bg.spacing = 32;
    const quads = LAYERS.map((l) => s.quad(this.$(`#${l.id}`).el));
    // exploded-view guide lines between matching corners of neighbouring layers
    if (o > 0.02) for (let i = 0; i < quads.length - 1; i++) for (let c = 0; c < 4; c++) {
      const a = quads[i]![c]!, b = quads[i + 1]![c]!;
      L.dashes(new Path([a, b]), { dash: 4, gap: 4, width: 1, color: 'line', alpha: 0.8 * o });
    }
    // the packet's path: spark from where it was to where it is
    const pos = this.packetPos(t);
    if (pos < 0) return;
    const at = (tt: number) => { const pp = this.packetPos(tt); if (pp < 0) return null; const q = this.packetXYZ(tt, pp); return s.project(q.x - this.$('#packet').el.offsetWidth / 2 - 8, q.y, q.z); };
    // the comet shows only while the packet is moving between layers
    const moving = (tb: number) => { const pp = this.packetPos(tb); return pp >= 0 && pp < LAYERS.length - 1 + 1e-3 && pp % 1 > 0.001 && pp % 1 < 0.999 ? at(tb) : null; };
    comet(L, t, moving, { scale: 0.9 });
    // a ring on each layer as the packet lands
    LAYERS.forEach((_, i) => { const tl = T.drop + i * T.per + 0.4; const p0 = at(tl); if (p0) pulseRing(L, p0, t, tl, { r1: 40 }); });
    // trail through the layers so far
    const trail = [] as { x: number; y: number }[];
    for (let tt = T.drop - 0.6; tt <= t; tt += 0.04) { const p1 = at(tt); if (p1) trail.push(p1); }
    if (trail.length > 1) L.polyline(trail, { color: 'accent', width: 1.6, alpha: 0.8, glow: 1.5 });
  }
}
