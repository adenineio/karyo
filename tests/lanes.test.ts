// Separate lanes (src/model/lanes.ts): every wire on its own track, deterministically; and the line key's rows
// (src/model/legend.ts lineKey).
import { describe, expect, test } from 'bun:test';
import { separateLanes, sharedRuns, crossingsOf, lerpPath, type Rect, type LaneWire } from '../src/model/lanes';
import { lineKey } from '../src/model/legend';
import { Path } from '../src/engine';

const R = (x: number, y: number, w = 248, h = 140): Rect => ({ x, y, w, h });
const W = (p: string): LaneWire => { const [from, to] = p.split('>') as [string, string]; return { key: p, from, to }; };
const BOUNDS = { x0: 8, x1: 1296, y0: 112, y1: 655 };

// a groups map like the folio example's (four columns, a second row under the first and the last), plus a wire
// between the two boxes stacked in the last column
const FOLIO = new Map(Object.entries({ E: R(48, 157), M: R(368, 157), C: R(688, 157), K: R(1008, 157), N: R(1008, 313), S: R(48, 493) }));
const FOLIO_WIRES = ['E>M', 'E>C', 'E>K', 'E>N', 'E>S', 'M>C', 'M>S', 'C>M', 'C>S', 'C>K', 'C>N', 'K>N', 'K>S', 'N>S'].map(W);

/** A seeded grid of boxes in columns and rows, with wires between random pairs (forward, back and in-column). */
function grid(seed: number) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const boxes = new Map<string, Rect>();
  const cols = 3 + Math.floor(rnd() * 3), rows = 1 + Math.floor(rnd() * 3);
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) if (r === 0 || rnd() < 0.7) boxes.set(`b${c}${r}`, R(40 + c * 300, 130 + r * 170, 220, 120));
  const ids = [...boxes.keys()];
  const wires: LaneWire[] = [];
  const n = 4 + Math.floor(rnd() * 10);
  for (let i = 0; i < n; i++) {
    const a = ids[Math.floor(rnd() * ids.length)]!, b = ids[Math.floor(rnd() * ids.length)]!;
    if (a !== b && !wires.some((w) => w.key === `${a}>${b}`)) wires.push(W(`${a}>${b}`));
  }
  return { boxes, wires, bounds: { x0: 8, x1: 40 + cols * 300 + 40, y0: 100, y1: 130 + rows * 170 + 40 } };
}

/** Segments of a route that run through a box (not counting the stubs at the wire's own two ends). */
function throughBoxes(corners: { x: number; y: number }[], boxes: Map<string, Rect>, ends: [string, string]) {
  const hits: string[] = [];
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1]!, b = corners[i]!;
    for (const [id, r] of boxes) {
      if (ends.includes(id) && (i === 1 || i === corners.length - 1)) continue;
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      if (x1 > r.x + 1 && x0 < r.x + r.w - 1 && y1 > r.y + 1 && y0 < r.y + r.h - 1) hits.push(id);
    }
  }
  return hits;
}

describe('separate lanes', () => {
  test('the groups map: every wire routed, no two sharing a run, none through a box', () => {
    const r = separateLanes(FOLIO, FOLIO_WIRES, { bounds: BOUNDS });
    expect([...r.keys()].sort()).toEqual(FOLIO_WIRES.map((w) => w.key).sort());
    expect(sharedRuns(r)).toEqual([]);
    for (const w of FOLIO_WIRES) expect(throughBoxes(r.get(w.key)!.corners, FOLIO, [w.from, w.to])).toEqual([]);
    // parallel runs keep a few px apart, not just off one line
    expect(sharedRuns(r, 1, 3)).toEqual([]);
    expect(crossingsOf(r)).toBeLessThanOrEqual(10);
  });

  test('calls back to the left are marked; forward ones are not', () => {
    const r = separateLanes(FOLIO, FOLIO_WIRES, { bounds: BOUNDS });
    expect(r.get('C>M')!.back).not.toBeNull();
    expect(r.get('N>S')!.back).not.toBeNull();
    expect(r.get('E>C')!.back).toBeNull();
    expect(r.get('E>S')!.back).toBeNull();   // the same column, below
  });

  test('routes run axis-aligned from a card side to a card side', () => {
    const r = separateLanes(FOLIO, FOLIO_WIRES, { bounds: BOUNDS });
    for (const [, v] of r) for (let i = 1; i < v.corners.length; i++) {
      const a = v.corners[i - 1]!, b = v.corners[i]!;
      expect(Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01).toBe(true);
    }
  });

  test('deterministic: the same routes whatever order the wires come in, and run to run', () => {
    const a = separateLanes(FOLIO, FOLIO_WIRES, { bounds: BOUNDS });
    const b = separateLanes(FOLIO, [...FOLIO_WIRES].reverse(), { bounds: BOUNDS });
    const c = separateLanes(new Map([...FOLIO].reverse()), [...FOLIO_WIRES].sort(() => 0), { bounds: BOUNDS });
    const flat = (m: typeof a) => [...m.entries()].sort((p, q) => (p[0] < q[0] ? -1 : 1)).map(([k, v]) => [k, v.back, v.corners]);
    expect(flat(b)).toEqual(flat(a));
    expect(flat(c)).toEqual(flat(a));
  });

  test('seeded grids: no shared runs and no run through a box', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const g = grid(seed);
      const r = separateLanes(g.boxes, g.wires, { bounds: g.bounds });
      expect({ seed, shared: sharedRuns(r) }).toEqual({ seed, shared: [] });
      for (const w of g.wires) expect({ seed, w: w.key, hits: throughBoxes(r.get(w.key)!.corners, g.boxes, [w.from, w.to]) }).toEqual({ seed, w: w.key, hits: [] });
    }
  });

  test('nothing to route: an empty map; wires to unknown boxes are skipped', () => {
    expect(separateLanes(FOLIO, [], { bounds: BOUNDS }).size).toBe(0);
    expect(separateLanes(FOLIO, [W('E>Z'), W('E>E')], { bounds: BOUNDS }).size).toBe(0);
  });

  test('lerpPath glides from one route to the other', () => {
    const a = new Path([{ x: 0, y: 0 }, { x: 100, y: 0 }]), b = new Path([{ x: 0, y: 40 }, { x: 100, y: 40 }]);
    expect(lerpPath(a, b, 0)).toBe(a);
    expect(lerpPath(a, b, 1)).toBe(b);
    const m = lerpPath(a, b, 0.5);
    expect(m.at(0.5).y).toBeCloseTo(20, 5);
  });
});

describe('line key', () => {
  const calls = { one: 'call', many: 'calls' };
  test('a row only for what the level has', () => {
    expect(lineKey({ counted: false, back: null, lanes: 'shared', noun: calls })).toEqual([]);
    expect(lineKey({ counted: true, back: null, lanes: 'shared', noun: calls }).map((r) => r.text)).toEqual(['on a line = how many calls it stands for']);
    expect(lineKey({ counted: false, back: 'group', lanes: 'shared', noun: calls }).map((r) => r.text)).toEqual(['curved = a call back to a group on its left']);
  });
  test('worded by how a call back is drawn in each mode', () => {
    const shared = lineKey({ counted: true, back: 'group', lanes: 'shared', noun: calls });
    const sep = lineKey({ counted: true, back: 'group', lanes: 'separate', noun: calls });
    expect(shared.map((r) => r.glyph)).toEqual(['count', 'curve']);
    expect(sep.map((r) => r.glyph)).toEqual(['count', 'left']);
    expect(sep[1]!.text).toBe('heading left = a call back to a group on its left');
  });
  test('the noun comes from the board', () => {
    const rows = lineKey({ counted: true, back: 'card', lanes: 'shared', noun: { one: 'message', many: 'messages' } });
    expect(rows.map((r) => r.text)).toEqual(['on a line = how many messages it stands for', 'curved = a message back to a card on its left']);
  });
});
