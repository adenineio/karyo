// The wire router's hit tests (src/engine/geom.ts): segHitsRect is unrolled and pathCrossings skips what its bounds rule
// out, for speed. Both must answer exactly as the plain versions below do, on random input and on the edge cases (segments
// along a card's edge, touching a corner, axis-aligned, zero length), or a board would route a wire differently.
import { describe, expect, test } from 'bun:test';
import { Path, pathCrossings, segHitsRect, type P, type Rect } from '../src/engine/geom';

/** The plain Liang–Barsky clip against the open box, as it was written first. */
function segHitsRectRef(a: P, b: P, r: Rect): boolean {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const edges: [number, number][] = [[-dx, a.x - r.x], [dx, r.x + r.w - a.x], [-dy, a.y - r.y], [dy, r.y + r.h - a.y]];
  for (const [pp, q] of edges) {
    if (pp === 0) { if (q <= 0) return false; continue; }
    const t = q / pp;
    if (pp < 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t;
    if (t0 >= t1) return false;
  }
  return t1 - t0 > 1e-6;
}
function pathCrossingsRef(path: Path, rects: Rect[]): number {
  let n = 0;
  for (const r of rects) {
    const pts = path.pts;
    for (let i = 1; i < pts.length; i++) if (segHitsRectRef(pts[i - 1]!, pts[i]!, r)) { n++; break; }
  }
  return n;
}

/** A deterministic generator (mulberry32). */
function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe('wire hit tests', () => {
  test('segHitsRect answers as the plain clip does', () => {
    const r = rng(7);
    // coordinates on a coarse grid (so segments run along edges and through corners) and off it
    const c = (grid: boolean) => (grid ? Math.round(r() * 12) * 10 : r() * 120 - 10 + (r() < 0.1 ? 1e-9 : 0));
    let hits = 0;
    for (let i = 0; i < 200000; i++) {
      const g = r() < 0.6;
      const a = { x: c(g), y: c(g) }, b = r() < 0.05 ? { ...a } : r() < 0.3 ? { x: a.x, y: c(g) } : r() < 0.3 ? { x: c(g), y: a.y } : { x: c(g), y: c(g) };
      const rect = { x: c(g), y: c(g), w: r() < 0.05 ? 0 : 10 + Math.round(r() * 6) * 10, h: r() < 0.05 ? 0 : 10 + Math.round(r() * 6) * 10 };
      const want = segHitsRectRef(a, b, rect);
      if (want) hits++;
      if (segHitsRect(a, b, rect) !== want) throw new Error(`segHitsRect differs for ${JSON.stringify({ a, b, rect })}`);
    }
    expect(hits).toBeGreaterThan(10000);
  });
  test('pathCrossings counts as the plain loop does', () => {
    const r = rng(11);
    const c = (grid: boolean) => (grid ? Math.round(r() * 40) * 10 : r() * 400);
    let total = 0;
    for (let i = 0; i < 4000; i++) {
      const g = r() < 0.5, pts: P[] = [];
      const n = Math.floor(r() * 8);
      for (let k = 0; k < n; k++) pts.push(k && r() < 0.5 ? (r() < 0.5 ? { x: pts[k - 1]!.x, y: c(g) } : { x: c(g), y: pts[k - 1]!.y }) : { x: c(g), y: c(g) });
      const rects = Array.from({ length: Math.floor(r() * 30) }, () => ({ x: c(g), y: c(g), w: 20 + Math.round(r() * 8) * 10, h: 20 + Math.round(r() * 4) * 10 }));
      const p = new Path(pts), want = pathCrossingsRef(p, rects);
      total += want;
      expect(pathCrossings(p, rects)).toBe(want);
    }
    expect(total).toBeGreaterThan(1000);
  });
  test('the edge cases', () => {
    const box = { x: 10, y: 10, w: 20, h: 20 };
    const cases: [P, P][] = [
      [{ x: 10, y: 0 }, { x: 10, y: 40 }],   // along the left edge
      [{ x: 30, y: 0 }, { x: 30, y: 40 }],   // along the right edge
      [{ x: 0, y: 10 }, { x: 40, y: 10 }],   // along the top edge
      [{ x: 0, y: 0 }, { x: 10, y: 10 }],    // to a corner
      [{ x: 0, y: 0 }, { x: 40, y: 40 }],    // through the diagonal
      [{ x: 20, y: 20 }, { x: 20, y: 20 }],  // a point inside
      [{ x: 10, y: 10 }, { x: 10, y: 10 }],  // a point on the corner
      [{ x: 11, y: 0 }, { x: 11, y: 40 }],   // just inside the left edge
    ];
    for (const [a, b] of cases) {
      expect(segHitsRect(a, b, box)).toBe(segHitsRectRef(a, b, box));
      expect(pathCrossings(new Path([a, b]), [box])).toBe(pathCrossingsRef(new Path([a, b]), [box]));
    }
    expect(pathCrossings(new Path([]), [box])).toBe(0);
    expect(pathCrossings(new Path([{ x: 20, y: 20 }]), [box])).toBe(0);
  });
});
