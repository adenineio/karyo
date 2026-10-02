// Board layout details (docs/ENGINE.md "Group navigation", "Theater"): a model with no recorded run draws plain wires, a
// group card's inlet / outlet line never cuts a count, a count badge keeps clear of cards, a back edge stays above the
// legend, and a single wide band can wrap into two rows for the window.
import { describe, expect, test } from 'bun:test';
import { hasRuns, wiresOf, wireWords, type Model, type MNode, type MEdge } from '../src/model/model';
import { modelLegend } from '../src/model/legend';
import { legendHTML, layout } from '../src/model/scenes';
import { ioFit, aggregateWire } from '../src/model/board-groups';
import { badgeAt } from '../src/model/board';
import { boardRoute } from '../src/model/board-route';
import { arrange, wrapped, crossings } from '../src/model/arrange';
import { Path } from '../src/engine';

const node = (id: string, group?: string): MNode => ({ id, kind: 'service', label: id, ...(group ? { group } : {}), sources: ['declared'] });
const decl = (from: string, to: string): MEdge => ({ from, to, kind: 'calls', sources: ['declared'] });
const seen = (from: string, to: string): MEdge => ({ from, to, kind: 'calls', sources: ['declared', 'observed'] });

describe('a model with no recorded run', () => {
  const quiet: Model = { karyo: 1, flows: [], nodes: [node('a'), node('b'), node('c')], edges: [decl('a', 'b'), decl('b', 'c')] };
  const ran: Model = { ...quiet, edges: [seen('a', 'b'), decl('b', 'c')] };
  test('hasRuns: an observed relationship or node, a flow with spans, coverage', () => {
    expect(hasRuns(quiet)).toBe(false);
    expect(hasRuns(ran)).toBe(true);
    expect(hasRuns({ ...quiet, flows: [{ id: 'f', trace: 't', spans: [] }] })).toBe(false);
    expect(hasRuns({ ...quiet, flows: [{ id: 'f', trace: 't', spans: [{ id: 's', parent: null, node: 'a', start: 0 }] }] })).toBe(true);
    expect(hasRuns({ ...quiet, coverage: [{ package: 'x' } as never] })).toBe(true);
    expect(hasRuns({ ...quiet, nodes: [...quiet.nodes, { ...node('d'), sources: ['observed'] }] })).toBe(true);
  });
  test('wires are solid with no runs, dashed "not seen" with runs (unchanged)', () => {
    expect(wiresOf(quiet).map((w) => [w.verdict, w.style])).toEqual([['unseen', 'solid'], ['unseen', 'solid']]);
    expect(wiresOf(ran).map((w) => [w.verdict, w.style])).toEqual([['confirmed', 'solid'], ['unseen', 'dashed']]);
  });
  test('the line key has one row, no "not seen"; with runs it is as before', () => {
    expect(wireWords(quiet)).toEqual({ solid: 'declared in the code', dashed: null, warn: null, idle: null });
    expect(legendHTML(quiet)).not.toContain('not seen');
    expect(legendHTML(quiet).match(/<span>/g)!.length).toBe(1);
    expect(wireWords(ran)).toEqual({ solid: 'declared and seen running', dashed: 'declared, not seen', warn: 'seen, not declared', idle: null });
  });
  test('no "declared, not seen" tag without runs', () => {
    const tags = (m: Model, runs: boolean) => modelLegend({ nodes: m.nodes, wires: wiresOf(m), warned: new Set(), groupOf: () => 'other', groupName: (g) => g, groups: [], runs }).derived.map((e) => e.id);
    expect(tags(quiet, false)).not.toContain('unseen');
    expect(tags(ran, true)).toContain('unseen');
  });
  test("a group's wire takes its relationships' style", () => {
    expect(aggregateWire('x', 'y', wiresOf(quiet)).style).toBe('solid');
    expect(aggregateWire('x', 'y', wiresOf({ ...ran, edges: [decl('a', 'b'), decl('b', 'c')] })).style).toBe('solid');
    expect(aggregateWire('x', 'y', wiresOf(ran).filter((w) => w.verdict === 'unseen')).style).toBe('dashed');
  });
});

describe("a group card's inlet / outlet line", () => {
  test('names as many neighbours as fit whole, the rest as +n', () => {
    expect(ioFit([['Circulation', 14], ['Storage', 12], ['Catalogue', 3], ['Notices', 1]])).toEqual({ shown: [['Circulation', 14], ['Storage', 12]], more: 2 });
    expect(ioFit([['Storage', 3], ['Circulation', 1]])).toEqual({ shown: [['Storage', 3], ['Circulation', 1]], more: 0 });
    expect(ioFit([['A', 1], ['B', 2], ['C', 3], ['D', 4]]).more).toBe(1);   // at most three names
  });
  test('always names the first (its name ellipsizes in CSS, never its count)', () => {
    expect(ioFit([['A very long group name that cannot fit', 120], ['B', 1]])).toEqual({ shown: [['A very long group name that cannot fit', 120]], more: 1 });
  });
});

describe('count badges', () => {
  const line = new Path([{ x: 0, y: 100 }, { x: 400, y: 100 }]);
  test('at the middle of the wire when that is clear', () => {
    const b = badgeAt(line, 1, [], [], 1000, 1000);
    expect(b.x + b.w / 2).toBeCloseTo(200, -1);
  });
  test('moves along the wire off a card, a label or another badge', () => {
    const card = { x: 170, y: 80, w: 60, h: 40 };
    const b = badgeAt(line, 1, [card], [], 1000, 1000);
    expect(b.x + b.w <= card.x || b.x >= card.x + card.w).toBe(true);
    const other = badgeAt(line, 1, [], [b], 1000, 1000);
    expect(other.x + other.w + 4 <= b.x || other.x >= b.x + b.w + 4).toBe(true);
  });
});

describe('a back edge above the legend', () => {
  const A = { x: 400, y: 100, w: 248, h: 140 }, B = { x: 80, y: 100, w: 248, h: 140 };
  const grid = { a: { x: A.x, y: A.y, layer: 1 }, b: { x: B.x, y: B.y, layer: 0 } };
  const lowest = (p: Path) => Math.max(...p.pts.map((q) => q.y));
  test('the map curve where there is room (unchanged)', () => {
    expect(boardRoute(A, B, grid, [], 2000).pts).toEqual(boardRoute(A, B, grid).pts);
  });
  test('a bracket under the cards, above the floor, where the curve would dip into the legend', () => {
    const p = boardRoute(A, B, grid, [A, B], 300);
    expect(lowest(boardRoute(A, B, grid))).toBeGreaterThan(300);
    expect(lowest(p)).toBeLessThanOrEqual(300);
    expect(lowest(p)).toBeGreaterThan(A.y + A.h);
  });
});

describe('a single wide band wraps for the window', () => {
  // a chain a → b → c → d → e in one group: five columns
  const chain: Model = { karyo: 1, flows: [], nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => node(id, 'g')), edges: [seen('a', 'b'), seen('b', 'c'), seen('c', 'd'), seen('d', 'e')] };
  const L = layout(chain);
  const o = { wires: L.wires, padRight: 34, padBottom: 174, minW: 400, minH: 300 };
  test('wrapped: the last columns move under the first, as a second row', () => {
    const a = wrapped(L, 3);
    expect(a.key).toBe('wrap:2');
    expect(a.pos.get('d')!.x).toBe(L.pos.get('a')!.x);
    expect(a.pos.get('d')!.y).toBeGreaterThan(L.pos.get('a')!.y);
    expect(crossings(L, a, L.wires)).toBe(0);
  });
  test('a window shaped like the page keeps the row; a squarer one may wrap', () => {
    expect(arrange(L, { w: 4000, h: 600 }, o).a.key).toBe('default');
    expect(arrange(L, { w: 1000, h: 1000 }, o).a.key).toMatch(/^wrap:/);
    expect(arrange(L, null, o).a.key).toBe('default');
  });
});
