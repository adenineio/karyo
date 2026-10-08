// 2D geometry in stage px (origin top-left, y down): polylines with arc length, wire routing
// between anchors, and shape outlines (rounded rects, circles) as paths the fx layer can draw
// partially, dash, or run a spark along.
import { clamp, lerp } from './util';

export interface P { x: number; y: number }
export interface PA extends P { angle: number }
export type Side = 'left' | 'right' | 'top' | 'bottom' | 'center';

export class Path {
  readonly pts: P[];
  readonly L: Float64Array;
  constructor(pts: P[]) {
    this.pts = pts;
    this.L = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) this.L[i] = this.L[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  }
  get length() { return this.L[this.L.length - 1] ?? 0; }

  /** Point and heading at arc length s (px). */
  atLength(s: number): PA {
    const { pts, L } = this, n = pts.length;
    if (n === 0) return { x: 0, y: 0, angle: 0 };
    if (n === 1) return { ...pts[0]!, angle: 0 };
    s = clamp(s, 0, L[n - 1]!);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L[m]! < s) lo = m; else hi = m; }
    const a = pts[lo]!, b = pts[hi]!, seg = L[hi]! - L[lo]!;
    const u = seg > 0 ? (s - L[lo]!) / seg : 0;
    return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  /** Point and heading at fraction u (0..1) of the length. */
  at(u: number): PA { return this.atLength(u * this.length); }

  /** The part of the path between fractions u0 and u1, as a new Path. */
  slice(u0: number, u1: number): Path {
    const len = this.length, s0 = clamp(Math.min(u0, u1), 0, 1) * len, s1 = clamp(Math.max(u0, u1), 0, 1) * len;
    if (s1 - s0 <= 1e-6) return new Path([]);
    const out: P[] = [this.atLength(s0)];
    for (let i = 0; i < this.pts.length; i++) if (this.L[i]! > s0 && this.L[i]! < s1) out.push(this.pts[i]!);
    out.push(this.atLength(s1));
    return new Path(out);
  }
}

// ------------------------------------------------------------------ wires

export interface WireOpts {
  /** 'straight' line, 'elbow' (orthogonal, rounded corners), or 'curve' (cubic Bézier). */
  kind?: 'straight' | 'elbow' | 'curve';
  /** Direction the wire leaves `a` / enters `b`; inferred from the anchor side when omitted. */
  from?: Side;
  to?: Side;
  /** Corner radius for elbows (px). */
  radius?: number;
  /** Curve tension for Bézier wires: handle length as a fraction of the distance (default 0.5). */
  tension?: number;
  /** Where along the run an elbow turns (0..1, default 0.5). */
  bend?: number;
}

const DIR: Record<Side, P> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, center: { x: 0, y: 0 } };

/** Route a wire from point a to point b. */
export function wire(a: P, b: P, o: WireOpts = {}): Path {
  const kind = o.kind ?? 'curve';
  if (kind === 'straight') return new Path([a, b]);
  const dx = b.x - a.x, dy = b.y - a.y;
  const horiz = Math.abs(dx) >= Math.abs(dy);
  const da = DIR[o.from ?? (horiz ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'bottom' : 'top')];
  const db = DIR[o.to ?? (horiz ? (dx >= 0 ? 'left' : 'right') : dy >= 0 ? 'top' : 'bottom')];
  if (kind === 'curve') {
    const k = (o.tension ?? 0.5) * Math.hypot(dx, dy);
    const c1 = { x: a.x + da.x * k, y: a.y + da.y * k }, c2 = { x: b.x + db.x * k, y: b.y + db.y * k };
    const pts: P[] = [];
    const N = 48;
    for (let i = 0; i <= N; i++) {
      const t = i / N, u = 1 - t;
      pts.push({ x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y });
    }
    return new Path(pts);
  }
  // elbow: leave along da, turn once or twice, enter along db
  const bend = o.bend ?? 0.5;
  let corners: P[];
  const leavesH = da.x !== 0, entersH = db.x !== 0;
  if (leavesH && entersH) { const mx = lerp(a.x, b.x, bend); corners = [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]; }
  else if (!leavesH && !entersH) { const my = lerp(a.y, b.y, bend); corners = [a, { x: a.x, y: my }, { x: b.x, y: my }, b]; }
  else if (leavesH) corners = [a, { x: b.x, y: a.y }, b];
  else corners = [a, { x: a.x, y: b.y }, b];
  return new Path(roundCorners(corners, o.radius ?? 12));
}

/** Replace the interior corners of a polyline with circular arcs of radius r (clamped to fit). */
export function roundCorners(c: P[], r: number): P[] {
  if (c.length < 3 || r <= 0) return c;
  const out: P[] = [c[0]!];
  for (let i = 1; i < c.length - 1; i++) {
    const p = c[i - 1]!, q = c[i]!, n = c[i + 1]!;
    const l1 = Math.hypot(q.x - p.x, q.y - p.y), l2 = Math.hypot(n.x - q.x, n.y - q.y);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const u1 = { x: (q.x - p.x) / l1, y: (q.y - p.y) / l1 }, u2 = { x: (n.x - q.x) / l2, y: (n.y - q.y) / l2 };
    const s = { x: q.x - u1.x * rr, y: q.y - u1.y * rr }, e = { x: q.x + u2.x * rr, y: q.y + u2.y * rr };
    // quadratic through the corner approximates the arc well enough at these sizes
    for (let k = 0; k <= 8; k++) {
      const t = k / 8, u = 1 - t;
      out.push({ x: u * u * s.x + 2 * u * t * q.x + t * t * e.x, y: u * u * s.y + 2 * u * t * q.y + t * t * e.y });
    }
  }
  out.push(c[c.length - 1]!);
  return out;
}

// ------------------------------------------------------------------ shapes

/** Closed rounded rectangle, starting at the top-left corner's end and running clockwise. */
export function rrectPath(x: number, y: number, w: number, h: number, r: number): Path {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const pts: P[] = [];
  const arc = (cx: number, cy: number, a0: number) => {
    for (let k = 0; k <= 8; k++) { const a = a0 + (k / 8) * (Math.PI / 2); pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); }
  };
  // starts at the middle of the top edge (reads better when drawn on) and runs clockwise
  const start = { x: x + w / 2, y };
  pts.push(start);
  arc(x + w - r, y + r, -Math.PI / 2);
  arc(x + w - r, y + h - r, 0);
  arc(x + r, y + h - r, Math.PI / 2);
  arc(x + r, y + r, Math.PI);
  pts.push({ ...start });
  return new Path(pts);
}

export function circlePath(cx: number, cy: number, r: number, a0 = -Math.PI / 2, n = 64): Path {
  const pts: P[] = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (i / n) * Math.PI * 2; pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); }
  return new Path(pts);
}

// ------------------------------------------------------------------ hit testing

export interface Rect { x: number; y: number; w: number; h: number }

/** Distance from point p to the segment a–b. */
export function distToSeg(p: P, a: P, b: P): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const u = l2 > 0 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2) : 0;
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
}
/** Distance from point p to a drawn path (its polyline). Infinity for an empty path. */
export function distToPath(path: Path, p: P): number {
  const pts = path.pts;
  if (pts.length === 1) return Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y);
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSeg(p, pts[i - 1]!, pts[i]!));
  return d;
}
/** The path under point p: within `tol` px, the one drawn last (topmost) wins; ties at the same depth go to the nearest. */
export function pickPath<K>(paths: Iterable<readonly [K, Path]>, p: P, tol = 6): K | null {
  let best: K | null = null, bestD = Infinity;
  for (const [k, path] of paths) {
    const d = distToPath(path, p);
    // later paths are drawn on top: they win unless an earlier one is clearly nearer
    if (d <= tol && d <= bestD + 1.5) { best = k; bestD = Math.min(d, bestD); }
  }
  return best;
}
/** Does the segment a–b pass through the rectangle's interior? */
export function segHitsRect(a: P, b: P, r: Rect): boolean {
  // Liang–Barsky clip against the open box, edge by edge (left, right, top, bottom). Unrolled so it allocates nothing:
  // a board's router runs it for every segment of every candidate route against every card.
  let t0 = 0, t1 = 1, pp: number, q: number, t: number;
  const dx = b.x - a.x, dy = b.y - a.y;
  pp = -dx; q = a.x - r.x;
  if (pp === 0) { if (q <= 0) return false; } else { t = q / pp; if (pp < 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t; if (t0 >= t1) return false; }
  pp = dx; q = r.x + r.w - a.x;
  if (pp === 0) { if (q <= 0) return false; } else { t = q / pp; if (pp < 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t; if (t0 >= t1) return false; }
  pp = -dy; q = a.y - r.y;
  if (pp === 0) { if (q <= 0) return false; } else { t = q / pp; if (pp < 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t; if (t0 >= t1) return false; }
  pp = dy; q = r.y + r.h - a.y;
  if (pp === 0) { if (q <= 0) return false; } else { t = q / pp; if (pp < 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t; if (t0 >= t1) return false; }
  return t1 - t0 > 1e-6;
}
/** Is the box x0..x1 × y0..y1 (closed) clear of the rectangle's open interior? Then no segment inside it passes through
 *  the rectangle: `segHitsRect` clips it to nothing (t ≥ 1 or ≤ 0 on that edge, with rounding on the same side), so the
 *  test can be skipped and the answer is the same. */
const clearOf = (x0: number, x1: number, y0: number, y1: number, r: Rect) => x1 <= r.x || x0 >= r.x + r.w || y1 <= r.y || y0 >= r.y + r.h;
/** How many of the rectangles a path runs through (a wire behind a card). */
export function pathCrossings(path: Path, rects: Rect[]): number {
  const pts = path.pts;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  let n = 0;
  for (const r of rects) {
    // most cards are nowhere near a given wire: one test against the path's bounds, then one per segment's
    if (clearOf(x0, x1, y0, y1, r)) continue;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!, b = pts[i]!;
      if (clearOf(Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.y, b.y), Math.max(a.y, b.y), r)) continue;
      if (segHitsRect(a, b, r)) { n++; break; }
    }
  }
  return n;
}
