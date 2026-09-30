// Timing and randomness for scenes. Everything here is a pure function of its arguments, so a
// scene built from these is a pure function of time.
//
// Written for Karyo. Easing curves are built from a handful of shapes (power, exponential,
// overshoot, spring) and three combinators (in / out / in-out) instead of being listed one by one.

// ------------------------------------------------------------------ numbers

export const TAU = Math.PI * 2;

/** Limit x to [lo, hi] (default 0..1). */
export function clamp(x: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, x));
}
/** Linear blend from a to b by u. */
export function lerp(a: number, b: number, u: number): number {
  return a * (1 - u) + b * u;
}
/** Where x sits between a and b (0 at a, 1 at b; not clamped). */
export function invLerp(a: number, b: number, x: number): number {
  return b === a ? 0 : (x - a) / (b - a);
}
/** Map x from [a, b] to [c, d], clamped unless `unclamped`. */
export function remap(x: number, a: number, b: number, c: number, d: number, unclamped = false): number {
  const u = invLerp(a, b, x);
  return lerp(c, d, unclamped ? u : clamp(u));
}
/** Hermite smoothstep between edges a and b. */
export function smoothstep(a: number, b: number, x: number): number {
  const u = clamp(invLerp(a, b, x));
  return u * u * (3 - 2 * u);
}

// ------------------------------------------------------------------ easing

export type Ease = (u: number) => number;

/** Mirror an ease-in into an ease-out. */
const toOut = (f: Ease): Ease => (u) => 1 - f(1 - u);
/** Join an ease-in and its ease-out into an ease-in-out. */
const toInOut = (f: Ease): Ease => (u) => (u < 0.5 ? f(2 * u) / 2 : 1 - f(2 - 2 * u) / 2);

const power = (p: number): Ease => (u) => Math.pow(u, p);
/** Exponential ease-in, exactly 0 at 0 and 1 at 1 (normalised so there's no jump at the ends). */
const expo = (k = 10): Ease => {
  const lo = Math.pow(2, -k);
  return (u) => (Math.pow(2, k * (u - 1)) - lo) / (1 - lo);
};
/** Ease-in that pulls back first by `s` before moving (the classic anticipation curve). */
const anticipate = (s = 1.70158): Ease => (u) => u * u * ((s + 1) * u - s);

/** Step response of a damped spring over time u (unbounded): `freq` Hz, `damping` 0..1 (critical at 1). */
function springResponse(freq: number, damping: number): Ease {
  const w = TAU * freq, z = clamp(damping, 0.001, 0.999), wd = w * Math.sqrt(1 - z * z);
  return (u) => (u <= 0 ? 0 : 1 - Math.exp(-z * w * u) * (Math.cos(wd * u) + ((z * w) / wd) * Math.sin(wd * u)));
}
/** A spring as an ease on 0..1: overshoots and settles, landing exactly on 1 at u = 1. */
export function spring(freq = 3, damping = 0.4): Ease {
  const r = springResponse(freq, damping), miss = 1 - r(1);
  return (u) => r(u) + miss * u * u * u;
}

export const ease = {
  linear: ((u) => u) as Ease,
  inQuad: power(2), outQuad: toOut(power(2)), inOutQuad: toInOut(power(2)),
  inCubic: power(3), outCubic: toOut(power(3)), inOutCubic: toInOut(power(3)),
  inQuart: power(4), outQuart: toOut(power(4)), inOutQuart: toInOut(power(4)),
  outQuint: toOut(power(5)),
  inExpo: expo(), outExpo: toOut(expo()), inOutExpo: toInOut(expo()),
  inBack: anticipate(), outBack: toOut(anticipate()),
  /** Overshoots and rings before settling (a stiff, lightly damped spring). */
  outElastic: spring(3, 0.18),
  /** Builders, for custom curves: ease.power(2.5), ease.out(f), ease.inOut(f), ease.spring(4, 0.5). */
  power, out: toOut, inOut: toInOut, spring,
};

/** Eased progress of t through the window [a, b]: 0 before a, 1 after b. */
export function prog(t: number, a: number, b: number, f: Ease = ease.linear): number {
  return f(clamp(invLerp(a, b, t)));
}

/** A spring's response to a step at time 0 (value 0 → 1, overshooting): `springStep(t - t0)`. */
export function springStep(t: number, freq = 3, damping = 0.4): number {
  return springResponse(freq, damping)(t);
}

/** 1 at t0, halving every `halfLife` seconds after it; 0 before t0. For hits and flashes. */
export function pulse(t: number, t0: number, halfLife = 0.12): number {
  return t < t0 ? 0 : Math.exp((-Math.LN2 * (t - t0)) / halfLife);
}

/** A keyframe: [time, value, ease used on the way into this key]. */
export type Key = [time: number, value: number, easeIn?: Ease];

/** Value at t through keyframes sorted by time; holds the first/last value outside them. */
export function keys(t: number, ks: readonly Key[]): number {
  if (!ks.length) return 0;
  let i = 0;
  while (i < ks.length && ks[i]![0] < t) i++;
  if (i === 0) return ks[0]![1];
  if (i === ks.length) return ks[ks.length - 1]![1];
  const [t0, v0] = ks[i - 1]!, [t1, v1, f] = ks[i]!;
  return lerp(v0, v1, (f ?? ease.inOutCubic)(invLerp(t0, t1, t)));
}

// ------------------------------------------------------------------ deterministic randomness

/**
 * Stateless hash of any numbers to [0, 1). Floats are keyed by their exact bits, so
 * hash(0.1) and hash(0.1000001) are unrelated, and the result never depends on call order.
 */
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
export function hash(...xs: number[]): number {
  let h = 0x9e3779b9 ^ xs.length;
  for (const x of xs) {
    f64[0] = x;
    for (let k = 0; k < 2; k++) {
      let v = u32[k]!;
      v = Math.imul(v ^ (v >>> 16), 0x21f0aaad);
      v = Math.imul(v ^ (v >>> 15), 0x735a2d97);
      h = Math.imul(h ^ v ^ (v >>> 15), 0x85ebca6b) + 0x632be5ab | 0;
    }
  }
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A seeded random generator (SplitMix32): same seed, same sequence. For build-time layout, never per-frame state. */
export function seeded(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return ((z ^ (z >>> 16)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ noise (gradient, -1..1)

const quintic = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);
const grad1 = (i: number, seed: number) => hash(i, seed) * 2 - 1;

/** Smooth 1D gradient noise in [-1, 1]. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x), f = x - i;
  const a = grad1(i, seed) * f, b = grad1(i + 1, seed) * (f - 1);
  return 2 * lerp(a, b, quintic(f));
}

/** Smooth 2D gradient noise in about [-1, 1]. */
export function noise2(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const g = (cx: number, cy: number) => {
    const a = hash(ix + cx, iy + cy, seed) * TAU;
    return Math.cos(a) * (fx - cx) + Math.sin(a) * (fy - cy);
  };
  const ux = quintic(fx), uy = quintic(fy);
  return Math.SQRT2 * lerp(lerp(g(0, 0), g(1, 0), ux), lerp(g(0, 1), g(1, 1), ux), uy);
}

/** Fractal sum of 2D noise octaves, normalised to about [-1, 1]. */
export function fbm(x: number, y = 0, octaves = 4, seed = 0): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(x * freq, y * freq, seed + o * 101);
    norm += amp; amp *= 0.5; freq *= 2.03;
  }
  return sum / norm;
}
