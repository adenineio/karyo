// Scales and ticks for explainer charts: linear (nice ticks), weighted bands and points (categories
// that can grow in or shrink out during a tween), and UTC time ticks. Pure: no DOM, no locale, no clock.

/** Round away float noise (0.1 + 0.2) at the precision a tick step implies. */
export const fix = (v: number, dec: number) => +v.toFixed(Math.min(12, Math.max(0, dec)));
/** Decimal places a step needs (0.25 → 2, 5 → 0). */
export const stepDecimals = (step: number) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));

/** A "nice" step near (max - min) / count: 1, 2 or 5 × a power of ten. */
export function tickStep(min: number, max: number, count: number): number {
  const span = Math.abs(max - min);
  if (!(span > 0) || !(count > 0)) return 1;
  const raw = span / count, p = Math.pow(10, Math.floor(Math.log10(raw))), e = raw / p;
  return (e >= 7.07 ? 10 : e >= 3.16 ? 5 : e >= 1.41 ? 2 : 1) * p;
}

/** Widen [min, max] to whole steps (twice, as the step can change once widened). Equal ends get room. */
export function niceDomain(min: number, max: number, count = 5): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) { if (min === 0) return [0, 1]; const d = Math.abs(min) / 2; min -= d; max += d; if (min < 0 && max > 0 && min > -d) min = 0; }
  if (min > max) [min, max] = [max, min];
  for (let i = 0; i < 2; i++) {
    const s = tickStep(min, max, count), dec = stepDecimals(s);
    min = fix(Math.floor(min / s + 1e-9) * s, dec); max = fix(Math.ceil(max / s - 1e-9) * s, dec);
  }
  return [min, max];
}

/** Ticks inside [min, max] at a nice step, plus the step. */
export function ticks(min: number, max: number, count = 5): { ticks: number[]; step: number } {
  if (min > max) [min, max] = [max, min];
  const step = tickStep(min, max, count), dec = stepDecimals(step);
  const i0 = Math.ceil(min / step - 1e-9), i1 = Math.floor(max / step + 1e-9), out: number[] = [];
  for (let i = i0; i <= i1 && out.length < 60; i++) out.push(fix(i * step, dec) || 0);
  return { ticks: out, step };
}

/** A linear map from a domain onto a range (a zero-width domain maps to the range's start). */
export function linear(d0: number, d1: number, r0: number, r1: number) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

/** Weighted bands: each key takes `weight` shares of [r0, r1] (weight 0 = no room; tweens grow and shrink
 *  categories). Returns each key's start and width, in order. */
export function bands(weights: number[], r0: number, r1: number): { x: number; w: number }[] {
  const total = weights.reduce((a, w) => a + Math.max(0, w), 0) || 1, k = (r1 - r0) / total;
  let at = r0;
  return weights.map((w) => { const b = { x: at, w: Math.max(0, w) * k }; at += b.w; return b; });
}

/** Weighted points edge to edge: with every weight 1, n points land at r0 … r1 evenly; a point whose weight
 *  shrinks closes the gaps on its sides. One point sits in the middle. */
export function points(weights: number[], r0: number, r1: number): number[] {
  const w = weights.map((x) => Math.max(0, x));
  const gaps = w.slice(1).map((x, i) => (x + w[i]!) / 2), total = gaps.reduce((a, g) => a + g, 0);
  if (!(total > 0)) return w.map(() => (r0 + r1) / 2);
  const out = [r0];
  gaps.forEach((g) => out.push(out[out.length - 1]! + (g / total) * (r1 - r0)));
  return out;
}

// ------------------------------------------------------------------ time (UTC only: no time zones)

/** "2025", "2025-03", "2025-03-14" or a full ISO date → ms (UTC); NaN when it isn't one. */
export function parseDate(v: unknown): number {
  if (typeof v !== 'string') return NaN;
  const m = v.trim().match(/^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?)?)?(?:Z|[+-]00:?00)?$/);
  if (!m) return NaN;
  const [y, mo = 1, d = 1, h = 0, mi = 0, s = 0] = m.slice(1).map((x) => (x === undefined ? undefined : +x)) as number[];
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > 31) return NaN;
  return Date.UTC(y!, mo! - 1, d, h, mi, s);
}

export type TimeUnit = 'year' | 'month' | 'day';
const DAY = 864e5;
const STEPS: [TimeUnit, number][] = [['day', 1], ['day', 2], ['day', 7], ['day', 14], ['month', 1], ['month', 2], ['month', 3], ['month', 6], ['year', 1], ['year', 2], ['year', 5], ['year', 10], ['year', 25], ['year', 50], ['year', 100]];
const approx = (u: TimeUnit, n: number) => n * (u === 'day' ? DAY : u === 'month' ? 30.44 * DAY : 365.25 * DAY);

/** Calendar ticks over [t0, t1] (ms, UTC): the finest of day / month / year steps giving at most `count`. */
export function timeTicks(t0: number, t1: number, count = 6): { ticks: number[]; unit: TimeUnit; n: number } {
  if (t0 > t1) [t0, t1] = [t1, t0];
  const [unit, n] = STEPS.find(([u, k]) => (t1 - t0) / approx(u, k) <= count) ?? STEPS[STEPS.length - 1]!;
  const a = new Date(t0), out: number[] = [];
  let y = a.getUTCFullYear(), mo = a.getUTCMonth(), d = a.getUTCDate();
  if (unit === 'year') { y = Math.ceil((y + (mo || d > 1 ? 1 : 0)) / n) * n; mo = 0; d = 1; }
  else if (unit === 'month') { if (d > 1) { mo++; d = 1; } mo = Math.ceil(mo / n) * n; }
  const day0 = Date.UTC(y, mo, d) + (t0 % DAY ? DAY : 0);
  for (let i = 0; i < 400; i++) {
    const t = unit === 'year' ? Date.UTC(y + i * n, 0, 1) : unit === 'month' ? Date.UTC(y, mo + i * n, 1) : day0 + i * n * DAY;
    if (t > t1) break;
    if (t >= t0) out.push(t);
  }
  return { ticks: out, unit, n };
}
