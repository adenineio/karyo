// Fitting a plate to its space (src/engine/fit.ts; docs/ENGINE.md "Theater: fitting the window") and the interface size
// (src/engine/uisize.ts; "Chrome floor"): the helpers are pure, and a tall board fits a landscape window with little of
// it left empty.
import { describe, expect, test } from 'bun:test';
import { fitScaleOf, fitWaste, pickFit, settleChrome } from '../src/engine/fit';
import { UI_SIZES, uiSize, setUiSize, stepUiSize } from '../src/engine/uisize';
import { normalize, type Model } from '../src/model/model';
import { layout } from '../src/model/scenes';
import { arrange } from '../src/model/arrange';
import { chromeBoxFor, chromeSpans } from '../src/engine/chrome';

describe('fit helpers', () => {
  test('scale and waste', () => {
    expect(fitScaleOf({ w: 1600, h: 900 }, { w: 800, h: 900 })).toBe(1);
    expect(fitWaste({ w: 1600, h: 900 }, { w: 1600, h: 900 })).toBe(0);
    expect(fitWaste({ w: 1600, h: 900 }, { w: 800, h: 900 })).toBeCloseTo(0.5, 6);
  });
  test('pickFit keeps the first candidate unless another is drawn clearly larger', () => {
    const sp = { w: 1600, h: 900 };
    const a = { w: 900, h: 1200, id: 'a' }, b = { w: 1600, h: 920, id: 'b' }, c = { w: 1600, h: 1000, id: 'c' };
    expect(pickFit(sp, [a, b]).id).toBe('b');
    expect(pickFit(sp, [c, { w: 1620, h: 990, id: 'd' }]).id).toBe('c');   // within the slack: the first holds
    expect(pickFit(sp, [a]).id).toBe('a');
  });
  test('settleChrome leaves room for the boost the plate actually gets', () => {
    // a plate of 2000×1000 content plus chrome bands that are k × 400 wide and k × 200 deep; the floor boosts chrome to
    // 1 CSS px per stage px, so at scale s the chrome is drawn 1 / s times its size
    const sp = { w: 1600, h: 900 };
    const make = (k: number) => ({ w: 2000 + 400 * k, h: 1000 + 200 * k, k });
    const boost = (s: number) => Math.max(1, 1 / s);
    const first = make(boost(fitScaleOf(sp, make(1))));          // the Stage's second pass: room for the first scale's boost
    expect(boost(fitScaleOf(sp, first))).toBeGreaterThan(first.k * 1.01);   // drawn smaller, so boosted past its room
    const r = settleChrome(sp, first.k, make, boost);
    expect(boost(fitScaleOf(sp, r))).toBeLessThanOrEqual(r.k * 1.005);      // settled: the room covers the boost
    expect(settleChrome(sp, 1, (k) => ({ w: 800, h: 450, k }), boost).k).toBe(1);   // no boost: one layout, unchanged
  });
});

describe('interface size', () => {
  test('S, M, L in order; M by default; steps stop at the ends', () => {
    expect(UI_SIZES.map((u) => u.id)).toEqual(['S', 'M', 'L']);
    expect(uiSize().id).toBe('M');
    expect(stepUiSize(1).id).toBe('L');
    expect(stepUiSize(1).id).toBe('L');
    expect(stepUiSize(-1).id).toBe('M');
    setUiSize('S');
    expect(stepUiSize(-1).id).toBe('S');
    setUiSize('nope');
    expect(uiSize().id).toBe('S');
    setUiSize('M');
  });
});

/** A hub calling into `G` groups of `per` cards each: their columns overlap, so the page's layout stacks them. */
function tall(G: number, per: number): Model {
  const nodes: unknown[] = [{ id: 'hub', kind: 'service', label: 'Hub', group: 'core', sources: ['declared'] }];
  const edges: unknown[] = [];
  for (let g = 0; g < G; g++) for (let i = 0; i < per; i++) {
    const id = `g${g}.n${i}`;
    nodes.push({ id, kind: 'function', label: `Part ${g}.${i}`, group: `g${g}`, sources: ['declared'] });
    edges.push({ from: i ? `g${g}.n${i - 1}` : 'hub', to: id, kind: 'calls', sources: ['declared'] });
  }
  return normalize({ karyo: 1, project: 'tall', nodes, edges } as unknown as Model);
}

describe('a tall board in a landscape window', () => {
  for (const [G, per] of [[6, 2], [14, 3], [20, 2]] as const) {
    test(`${G} groups of ${per}: the arrangement leaves a fraction of the default's gutters`, () => {
      const L = layout(tall(G, per));
      const o = { wires: L.wires, padRight: 34, padBottom: 174, minW: 960, minH: 0 };
      const sp = { w: 1888, h: 1048 };
      const d = arrange(L, null, o), a = arrange(L, sp, o);
      const wd = fitWaste(sp, { w: d.W, h: d.H }), wa = fitWaste(sp, { w: a.W, h: a.H });
      expect(wd).toBeGreaterThan(0.5);
      expect(wa).toBeLessThan(wd / 2);
      expect(fitScaleOf(sp, { w: a.W, h: a.H })).toBeGreaterThan(fitScaleOf(sp, { w: d.W, h: d.H }));
    });
  }
});

describe('chromeBoxFor: where to lay out a chrome root so the floor draws it where room was left', () => {
  const W = 1408, H = 868;
  test('k = 1: the box itself', () => {
    expect(chromeBoxFor({ x: 48, y: 272, w: 700, h: 546 }, W, H, 1)).toEqual({ x: 48, y: 272, w: 700, h: 546 });
  });
  test('a spanning panel: its margins are drawn k times larger, so it lands on the drawn box', () => {
    const d = { x: 58, y: 326, w: 650, h: 482 }, k = 1.2, c = chromeBoxFor(d, W, H, k);
    expect(chromeSpans(c, W, H)).toEqual({ x: true, y: true });
    expect(c.x * k).toBeCloseTo(d.x);
    expect(W - (W - c.x - c.w) * k).toBeCloseTo(d.x + d.w);
    expect(c.y * k).toBeCloseTo(d.y);
    expect(H - (H - c.y - c.h) * k).toBeCloseTo(d.y + d.h);
  });
  test('a small root is scaled about the stage edge it sits at', () => {
    const k = 1.2, d = { x: 1100, y: 40, w: 200, h: 40 }, c = chromeBoxFor(d, W, H, k);
    expect(chromeSpans(c, W, H)).toEqual({ x: false, y: false });
    expect(W - (W - c.x) * k).toBeCloseTo(d.x);       // right half: about the right edge
    expect(c.y * k).toBeCloseTo(d.y);                 // top half: about the top edge
    expect(c.w * k).toBeCloseTo(d.w);
  });
});
