// Group navigation (docs/ENGINE.md "Group navigation", src/model/board-groups.ts): the hierarchy, what each level draws,
// the wires that stand for several relationships, the move between levels, and where a board starts.
import { describe, expect, test } from 'bun:test';
import { hierarchy, repOf, levelView, aggregateSentence, planLevel, startView, clampRect, GPRE, GROUPS_AT, IN_BAND, OUT_BAND } from '../src/model/board-groups';
import { layout } from '../src/model/scenes';
import { kitsFor } from '../src/kits/registry';
import { applyCuration, validateCuration } from '../src/model/curation';
import type { Model, MNode, MEdge } from '../src/model/model';

const node = (id: string, group?: string, kind: MNode['kind'] = 'service'): MNode => ({ id, kind, label: id.toUpperCase(), ...(group ? { group } : {}), sources: ['declared'] });
const edge = (from: string, to: string, kind: MEdge['kind'] = 'calls'): MEdge => ({ from, to, kind, sources: ['declared', 'observed'] });
// web (outside) → api (in "front") → orders, billing (in "core", orders nested in "core/store") ; api → audit (ungrouped)
const model: Model = {
  karyo: 1, flows: [],
  nodes: [node('user', undefined, 'actor'), node('api', 'front'), node('page', 'front'), node('svc', 'core'), node('orders', 'store'), node('ledger', 'store'), node('audit')],
  edges: [edge('user', 'api'), edge('api', 'svc'), edge('api', 'orders'), edge('page', 'api'), edge('svc', 'orders'), edge('svc', 'ledger', 'writes'), edge('api', 'audit'), edge('orders', 'audit')],
  groups: [{ id: 'front', label: 'Front' }, { id: 'core', label: 'Core' }, { id: 'store', label: 'Store', parent: 'core' }],
};
const kits = kitsFor(model);
const Lc = layout(model, undefined, 0, 480, kits);
const h = hierarchy(Lc.nodes, model.groups);

describe('the hierarchy', () => {
  test('groups, nesting and what sits where', () => {
    expect([...h.all].sort()).toEqual(['core', 'front', 'other', 'store']);
    expect(h.children(null).sort()).toEqual(['core', 'front', 'other']);
    expect(h.children('core')).toEqual(['store']);
    expect(h.parent('store')).toBe('core');
    expect(h.under('core').sort()).toEqual(['ledger', 'orders', 'svc']);
    expect(h.directs(null)).toEqual(['user']);
    expect(h.path('store')).toEqual(['Core', 'Store']);
    expect(h.levelOf('orders')).toBe('store');
    expect(h.levelOf('user')).toBeNull();
    expect(h.available).toBe(true);
  });
  test('one group with nothing below it has no overview to show', () => {
    const one = hierarchy([node('a', 'g'), node('b', 'g')], []);
    expect(one.available).toBe(false);
  });
});

describe('what a real card is drawn as on a level', () => {
  test('the top: its top-level group card; actors as themselves', () => {
    expect(repOf(h, 'orders', null)).toEqual({ item: `${GPRE}core`, stub: false });
    expect(repOf(h, 'user', null)).toEqual({ item: 'user', stub: false });
  });
  test('inside a group: itself, its subgroup card, or a stub from the closest common level', () => {
    expect(repOf(h, 'svc', 'core')).toEqual({ item: 'svc', stub: false });
    expect(repOf(h, 'orders', 'core')).toEqual({ item: `${GPRE}store`, stub: false });
    expect(repOf(h, 'api', 'core')).toEqual({ item: `${GPRE}front`, stub: true });
    expect(repOf(h, 'svc', 'store')).toEqual({ item: 'svc', stub: true });           // a direct card of the level above
    expect(repOf(h, 'user', 'store')).toEqual({ item: 'user', stub: true });
  });
});

describe('a level', () => {
  test('the overview: group cards and actors, one wire per pair with its relationships under it', () => {
    const v = levelView({ Lc, hier: h, at: null, kits });
    expect([...v.items.keys()].sort()).toEqual([`${GPRE}core`, `${GPRE}front`, `${GPRE}other`, 'user'].sort());
    const fc = v.L.wires.find((w) => w.from === `${GPRE}front` && w.to === `${GPRE}core`)!;
    expect(v.under.get(fc.key)!.map((w) => w.key).sort()).toEqual(['api->orders', 'api->svc']);
    // inside core, svc → orders/ledger is not a wire of the overview
    expect(v.L.wires.some((w) => w.from === w.to)).toBe(false);
    expect(v.bare.has('·top')).toBe(true);
  });
  test('inside a group: its cards, subgroups as group cards, neighbours as stubs on the edges', () => {
    const v = levelView({ Lc, hier: h, at: 'core', kits });
    const it = (id: string) => v.items.get(id)!;
    expect(it('svc').role).toBe('node');
    expect(it(`${GPRE}store`).role).toBe('group');
    expect(it(`${GPRE}front`).role).toBe('stub-group');
    expect(it(`${GPRE}front`).side).toBe('in');
    expect(it(`${GPRE}other`).side).toBe('out');
    // inlets left of everything, outlets right of it
    const x = (id: string) => v.L.pos.get(id)!.x;
    expect(x(`${GPRE}front`)).toBeLessThan(x('svc'));
    expect(x(`${GPRE}other`)).toBeGreaterThan(x(`${GPRE}store`));
    expect(v.L.groups.map((g) => g.id).sort()).toEqual([IN_BAND, OUT_BAND, 'core'].sort());
    // a pair of real cards keeps its own wire
    expect(v.L.wire.has('svc->orders')).toBe(false);
    expect(v.L.wire.has(`svc->${GPRE}store`)).toBe(true);
    // stubs never wire to each other
    expect(v.L.wires.some((w) => v.items.get(w.from)!.role.startsWith('stub') && v.items.get(w.to)!.role.startsWith('stub'))).toBe(false);
  });
  test('a nested group: the level above\'s cards come in as node stubs', () => {
    const v = levelView({ Lc, hier: h, at: 'store', kits });
    expect(v.items.get('svc')!.role).toBe('stub-node');
    expect(v.L.wire.has('svc->orders')).toBe(true);
  });
});

test('the words of a wire that stands for several relationships', () => {
  const v = levelView({ Lc, hier: h, at: null, kits });
  const k = v.L.wires.find((w) => w.from === `${GPRE}front` && w.to === `${GPRE}core`)!.key;
  expect(aggregateSentence('Front', 'Core', v.under.get(k)!)).toBe('2 calls from Front into Core.');
  const ws = Lc.wires.filter((w) => w.from === 'svc');
  expect(aggregateSentence('Core', 'Store', ws)).toBe('2 relationships from Core into Store: 1 calls and 1 writes.');
});

describe('the move between levels', () => {
  const bounds = { x: 0, y: 0, w: 2000, h: 2000 };
  test('entering: members grow out of the card entered, the rest rides the camera, nothing is stretched or lost', () => {
    const before = new Map([
      ['G', { r: { x: 100, y: 100, w: 200, h: 100 }, o: 1, members: ['a', 'b'] }],
      ['H', { r: { x: 400, y: 100, w: 200, h: 100 }, o: 1, members: ['c'] }],
    ]);
    const after = new Map([
      ['a', { r: { x: 100, y: 100, w: 180, h: 70 }, members: ['a'] }],
      ['b', { r: { x: 600, y: 400, w: 180, h: 70 }, members: ['b'] }],
      ['H', { r: { x: 50, y: 600, w: 170, h: 50 }, members: ['c'] }],
    ]);
    const p = planLevel({ before, after, focus: { from: before.get('G')!.r, to: { x: 100, y: 100, w: 680, h: 370 } }, bounds });
    // a and b start inside G, faded
    for (const id of ['a', 'b']) { const s = p.start.get(id)!; expect(s.o).toBe(0); expect(s.r.x).toBeGreaterThanOrEqual(99); expect(s.r.x + s.r.w).toBeLessThanOrEqual(301); }
    // H is on both levels: it glides, from where it was, at its new shape
    const hs = p.start.get('H')!;
    expect(hs.o).toBe(1);
    expect(hs.r.x + hs.r.w / 2).toBeCloseTo(500);
    expect(hs.r.w / hs.r.h).toBeCloseTo(170 / 50);
    // G grows toward its members as it goes
    expect(p.gone.get('G')!.w).toBeGreaterThan(200);
  });
  test('going up: cards shrink into the group card they belong to', () => {
    const before = new Map([['a', { r: { x: 0, y: 0, w: 100, h: 50 }, o: 1, members: ['a'] }], ['b', { r: { x: 300, y: 0, w: 100, h: 50 }, o: 1, members: ['b'] }]]);
    const after = new Map([['G', { r: { x: 500, y: 500, w: 200, h: 100 }, members: ['a', 'b'] }]]);
    const p = planLevel({ before, after, focus: null, bounds });
    for (const id of ['a', 'b']) { const g = p.gone.get(id)!; expect(g.x).toBeGreaterThanOrEqual(499); expect(g.x + g.w).toBeLessThanOrEqual(701); }
    expect(p.start.get('G')!.o).toBe(0);
  });
  test('nothing leaves the stage', () => {
    const r = clampRect({ x: -500, y: 10, w: 3000, h: 100 }, bounds);
    expect(r.x).toBe(0); expect(r.w).toBe(2000);
    expect(r.h).toBeCloseTo(100 * 2000 / 3000); expect(r.y + r.h / 2).toBeCloseTo(60);
  });
});

describe('where a board starts', () => {
  test('auto: the groups when the board is big, every card when it is small', () => {
    expect(startView('auto', {}, h, GROUPS_AT)).toBe('groups');
    expect(startView('auto', {}, h, GROUPS_AT - 1)).toBe('cards');
    expect(startView(undefined, {}, h, 5)).toBe('cards');
  });
  test('forced by the plate, else by the model (a curation file)', () => {
    expect(startView('groups', {}, h, 3)).toBe('groups');
    expect(startView('cards', { start: 'groups' }, h, 100)).toBe('cards');
    expect(startView('auto', { start: 'groups' }, h, 3)).toBe('groups');
    expect(startView('auto', { start: 'cards' }, h, 100)).toBe('cards');
  });
  test('never the groups when there are none to show', () => {
    const one = hierarchy([node('a', 'g')], []);
    expect(startView('groups', {}, one, 100)).toBe('cards');
  });
  test('a curation file says it', () => {
    const m: Model = { ...model, nodes: model.nodes.map((n) => ({ ...n })) };
    expect(applyCuration(m, { karyo: 'curation/1', start: 'groups' })).toEqual([]);
    expect(m.start).toBe('groups');
    expect(validateCuration({ karyo: 'curation/1', start: 'maybe' })).toEqual([{ path: 'start', message: '"groups" or "cards"' }]);
  });
});
