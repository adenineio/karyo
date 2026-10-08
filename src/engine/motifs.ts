// Reusable fx motifs, all pure functions of time: the comet (a hot point with a tail and embers),
// expanding pulse rings, packets flowing along a wire, and an outline that draws itself around a
// real HTML element.
import type { LineBatch, Col } from './fx';
import type { Background } from './fx';
import type { Path, P } from './geom';
import type { Node } from './node';
import { mix, type RGB } from './theme';
import { hash, clamp, ease, lerp, noise1 } from './util';

const WHITE: RGB = [1, 1, 1];

export interface CometOpts {
  color?: Col;
  /** Overall size multiplier. */
  scale?: number;
  /** Seconds of travel the tail remembers. */
  tail?: number;
  /** Embers shed per second (0 = none). */
  embers?: number;
  seed?: number;
}

/**
 * A comet riding a path: a hot head, a tapered tail that retraces exactly where the head has
 * been over the last `tail` seconds, and embers that peel off sideways and slow to a stop.
 * `headAt(tb)` must say where the head was at any earlier time tb (null when there was no head);
 * everything is placed from those times alone, so a frame never depends on render order.
 */
export function comet(lb: LineBatch, t: number, headAt: (t: number) => P | null, o: CometOpts = {}) {
  const s = o.scale ?? 1, th = lb.theme, c = lb.rgb(o.color ?? 'accent');
  const hot = mix(c, WHITE, th.dark ? 0.8 : 0.45);
  const seed = o.seed ?? 7;

  // tail: sampled history of the head, thick and hot near it, thin and cool at the end
  const T = o.tail ?? 0.18, N = 20;
  let prev = headAt(t);
  for (let k = 1; k <= N && prev; k++) {
    const q = headAt(t - (k / N) * T);
    if (!q) break;
    const u = k / N;
    lb.seg(prev.x, prev.y, q.x, q.y, { width: s * lerp(3.4, 0.6, u), color: mix(hot, c, Math.min(1, u * 1.6)), alpha: (1 - u) ** 1.6, glow: s * 2 * (1 - u) });
    prev = q;
  }

  // embers: shed from the side of the head, drag slows them, a slight drift carries them off
  const rate = o.embers ?? 45, life = 0.55;
  if (rate > 0) {
    for (let n = Math.floor((t - life) * rate); n <= Math.floor(t * rate); n++) {
      const tb = n / rate, age = t - tb;
      if (age < 0 || age > life) continue;
      const a = headAt(tb), b = headAt(tb - 0.02);
      if (!a || !b) continue;
      const dx = a.x - b.x, dy = a.y - b.y, len = Math.hypot(dx, dy) || 1;
      const side = hash(n, seed) < 0.5 ? -1 : 1;
      const ang = Math.atan2(dy, dx) + side * (Math.PI / 2 + (hash(n, seed + 1) - 0.5) * 1.2) + Math.PI * 0.15 * side;
      const speed = s * (40 + 110 * hash(n, seed + 2)), drag = 5.5;
      const travel = (speed * (1 - Math.exp(-drag * age))) / drag;
      const x = a.x + Math.cos(ang) * travel - (dx / len) * age * 12 * s;
      const y = a.y + Math.sin(ang) * travel - age * 18 * s;
      const k = 1 - age / (life * (0.5 + 0.5 * hash(n, seed + 3)));
      if (k <= 0) continue;
      const twinkle = 0.65 + 0.35 * noise1(age * 24, n + seed);
      lb.dot(x, y, s * (1 + 2.2 * k), { color: mix(c, hot, k), alpha: Math.min(1, k * 1.3) * twinkle });
    }
  }

  // head: halo, body, white-hot core; it breathes slightly instead of flickering
  const h = headAt(t);
  if (!h) return;
  const breathe = 1 + 0.12 * noise1(t * 7, seed);
  lb.dot(h.x, h.y, 20 * s * breathe, { color: c, alpha: 0.16, glow: 9 * s });
  lb.dot(h.x, h.y, 8.5 * s, { color: c, alpha: 0.95, glow: 4 * s });
  lb.dot(h.x, h.y, 3.8 * s, { color: hot, alpha: 1 });
}

/** A ring that expands and fades after time t0 (an arrival, a click, a hit). */
export function pulseRing(lb: LineBatch, at: P, t: number, t0: number, o: { r0?: number; r1?: number; dur?: number; color?: Col; width?: number } = {}) {
  const dur = o.dur ?? 0.6, u = (t - t0) / dur;
  if (u < 0 || u > 1) return;
  const r = (o.r0 ?? 6) + ((o.r1 ?? 40) - (o.r0 ?? 6)) * ease.outCubic(u);
  lb.ring(at.x, at.y, r, { color: o.color ?? 'accent', width: (o.width ?? 1.5) * (1 - u * 0.5), alpha: (1 - u) ** 1.5 });
}

/** Dots travelling along a path: `speed` px/s, one every `spacing` px, only over [from, to]. */
export function packets(lb: LineBatch, path: Path, t: number, o: { speed?: number; spacing?: number; size?: number; color?: Col; glow?: number; from?: number; to?: number } = {}) {
  const len = path.length, sp = o.spacing ?? 60, off = (t * (o.speed ?? 120)) % sp;
  const s0 = (o.from ?? 0) * len, s1 = (o.to ?? 1) * len;
  for (let s = off; s <= len; s += sp) {
    if (s < s0 || s > s1) continue;
    const p = path.atLength(s);
    const edge = clamp(Math.min(s - s0, s1 - s) / 20); // fade in/out at the ends
    lb.dot(p.x, p.y, o.size ?? 5, { color: o.color ?? 'accent', alpha: edge, glow: o.glow ?? 3 });
  }
}

/** Outline a real HTML element as it appears now, drawn on from 0 to `progress`. */
export function outline(lb: LineBatch, n: Node, o: { progress?: number; pad?: number; radius?: number; color?: Col; width?: number; alpha?: number; glow?: number } = {}) {
  if ((o.progress ?? 1) <= 0) return;
  const b = n.bounds(o.pad ?? 6);
  lb.rrect(b.x, b.y, b.w, b.h, o.radius ?? 10, { progress: o.progress ?? 1, color: o.color ?? 'accent', width: o.width ?? 1.5, alpha: o.alpha ?? 1, glow: o.glow ?? 0 });
}

/** A soft light under an element (reads through translucent cards). */
export function lightUnder(bg: Background, n: Node, k: number, color: RGB, spread = 0.6) {
  const b = n.bounds();
  bg.light(b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w, b.h) * spread, k, color);
}
