import { describe, expect, test } from 'bun:test';
import { attributeCall, checksFor, foldEdges, invariants, merge, normalize, pairKey, reconcile, relations, type Fragment, type MEdge, type Model } from '../src/model/model';

const frag = (edges: any[], spans: any[] = [], extra: any[] = []) => ({
  karyo: 1 as const,
  nodes: [
    { id: 'a', kind: 'function', sources: ['declared'] },
    { id: 'b', kind: 'store', sources: ['declared'] },
    ...extra,
  ],
  edges,
  flows: spans.length ? [{ id: 'f', trace: 't', spans }] : [],
}) as Fragment;
const pair = (m: Model, from: string, to: string) => m.edges.filter((e) => e.kind !== 'imports' && e.from === from && e.to === to);
const errors = (m: Model) => (m.checks ?? []).filter((c) => c.level === 'error');
const codes = (m: Model) => (m.checks ?? []).map((c) => c.code);

describe('merge: one relationship per ordered pair', () => {
  const spans = [
    { id: '1', parent: null, node: 'a', start: 1, end: 5 },
    { id: '2', parent: '1', node: 'b', label: 'get', start: 2, end: 3 },
  ];

  test('a recorded call confirms a declared reads edge: one wire, declared kind, now observed', () => {
    const m = merge([frag([{ from: 'a', to: 'b', kind: 'reads', sources: ['declared'] }], spans)]);
    const ab = pair(m, 'a', 'b');
    expect(ab).toHaveLength(1);
    expect(ab[0]!.kind).toBe('reads');
    expect(ab[0]!.sources).toEqual(['declared', 'observed']);
    expect(ab[0]!.count).toBe(1);
    expect(codes(m)).not.toContain('unobserved-call');
    expect(errors(m)).toEqual([]);
  });

  test('without a declaration the recorded call is a calls edge (and undeclared)', () => {
    const m = merge([frag([], spans)]);
    expect(pair(m, 'a', 'b').map((e) => e.kind)).toEqual(['calls']);
    expect(codes(m)).toContain('undeclared-call');
  });

  test('declared reads AND writes on one pair: one edge carrying both kinds, both confirmed by one call', () => {
    const m = merge([frag([{ from: 'a', to: 'b', kind: 'writes', sources: ['declared'] }, { from: 'a', to: 'b', kind: 'reads', sources: ['declared'] }], spans)]);
    const ab = pair(m, 'a', 'b');
    expect(ab).toHaveLength(1);
    expect(ab[0]).toMatchObject({ kind: 'reads', kinds: ['reads', 'writes'], sources: ['declared', 'observed'], count: 1 });
    expect(codes(m)).not.toContain('unobserved-call');
  });

  test('declared calls AND reads on one pair: one edge, kinds [calls, reads]', () => {
    const m = merge([frag([{ from: 'a', to: 'b', kind: 'reads', sources: ['declared'] }, { from: 'a', to: 'b', kind: 'calls', sources: ['declared'] }])]);
    expect(pair(m, 'a', 'b')).toEqual([{ from: 'a', to: 'b', kind: 'calls', kinds: ['calls', 'reads'], sources: ['declared'] }]);
  });

  test('an observed calls record in an earlier fragment joins the declared reads from a later one', () => {
    const early = { karyo: 1, edges: [{ from: 'a', to: 'b', kind: 'calls', sources: ['observed'], count: 3 }] } as Fragment;
    const late = frag([{ from: 'a', to: 'b', kind: 'reads', sources: ['declared'] }]);
    for (const order of [[early, late], [late, early]]) {
      const ab = pair(merge(order), 'a', 'b');
      expect(ab).toEqual([{ from: 'a', to: 'b', kind: 'reads', count: 3, sources: ['declared', 'observed'] }]);
    }
  });

  test('labels of one pair add up (sorted, once each)', () => {
    const m = merge([frag([{ from: 'a', to: 'b', kind: 'writes', label: 'save', sources: ['declared'] }, { from: 'a', to: 'b', kind: 'reads', label: 'load', sources: ['declared'] }, { from: 'a', to: 'b', kind: 'reads', label: 'load', sources: ['declared'] }])]);
    expect(pair(m, 'a', 'b')[0]!.label).toBe('load · save');
  });

  test('imports stay their own layer: a module import never folds into a relationship', () => {
    const f = { karyo: 1, nodes: [{ id: 'm1', kind: 'module', sources: ['extracted'] }, { id: 'm2', kind: 'module', sources: ['extracted'] }], edges: [{ from: 'm1', to: 'm2', kind: 'imports', sources: ['extracted'] }, { from: 'm1', to: 'm2', kind: 'imports', sources: ['declared'] }] } as Fragment;
    const m = merge([f]);
    expect(m.edges).toEqual([{ from: 'm1', to: 'm2', kind: 'imports', sources: ['declared', 'extracted'] }]);
    expect(relations(m)).toEqual([]);
  });

  test('a queue delivering to its subscriber confirms the declared subscribes, against its direction', () => {
    const f = frag([{ from: 'a', to: 'b', kind: 'subscribes', sources: ['declared'] }], [
      { id: '1', parent: null, node: 'b', start: 1, end: 5 },
      { id: '2', parent: '1', node: 'a', start: 2, end: 3 },
    ]);
    const m = merge([f]);
    expect(relations(m)).toEqual([{ from: 'a', to: 'b', kind: 'subscribes', count: 1, sources: ['declared', 'observed'] }]);
    const get = (k: string) => relations(m).find((e) => pairKey(e.from, e.to) === k);
    expect(attributeCall(get, 'b', 'a')).toEqual({ key: 'a->b', from: 'a', to: 'b', reversed: true });
    expect(errors(m)).toEqual([]);
  });

  test('an unknown edge kind is read as calls, with a warning', () => {
    const m = merge([frag([{ from: 'a', to: 'b', kind: 'call', sources: ['declared'] }])]);
    expect(pair(m, 'a', 'b')[0]!.kind).toBe('calls');
    expect(codes(m)).toContain('edge-kind');
  });
});

describe('merge: node identity', () => {
  test('an edge to a node nobody declared makes a stub and an unknown-node warning, never an edge into nothing', () => {
    const m = merge([frag([{ from: 'a', to: 'c', kind: 'calls', sources: ['declared'] }])]);
    expect(m.nodes.find((n) => n.id === 'c')).toMatchObject({ kind: 'external', sources: [] });
    expect(m.checks!.filter((c) => c.code === 'unknown-node').map((c) => c.subject)).toEqual(['c']);
    expect(errors(m)).toEqual([]);
  });

  test("a flow's entry nobody declared is reported (a typo'd actor is not silently a second actor)", () => {
    const f = frag([], [{ id: '1', parent: null, node: 'a', start: 1 }]);
    f.flows![0]!.entry = 'user_typo';
    const m = merge([f]);
    expect(m.checks!.find((c) => c.code === 'unknown-node')?.subject).toBe('user_typo');
  });

  test('ids that differ only in case are an identity conflict (error)', () => {
    const m = merge([frag([{ from: 'a', to: 'B', kind: 'reads', sources: ['declared'] }])]);
    expect(errors(m).map((c) => c.code)).toEqual(['id-conflict']);
  });

  test('a node named like a module is an identity conflict', () => {
    const f = { karyo: 1, nodes: [{ id: 'pkg.z', kind: 'service', sources: ['declared'] }, { id: 'pkg', kind: 'module', sources: ['extracted'] }, { id: 'pkg.z', kind: 'module', sources: ['extracted'] }], edges: [{ from: 'pkg', to: 'pkg.z', kind: 'imports', sources: ['extracted'] }] } as Fragment;
    expect(errors(merge([f])).map((c) => c.code)).toContain('id-conflict');
  });

  test('a relationship to a module (not a node) is an identity conflict', () => {
    const f = { karyo: 1, nodes: [{ id: 'a', kind: 'function', sources: ['declared'] }, { id: 'pkg.m', kind: 'module', sources: ['extracted'] }], edges: [{ from: 'a', to: 'pkg.m', kind: 'calls', sources: ['declared'] }] } as Fragment;
    expect(errors(merge([f])).map((c) => c.code)).toEqual(['id-conflict']);
  });

  test('two spellings of a tag are a name-variant warning', () => {
    const m = merge([frag([], [], [{ id: 'c', kind: 'function', tags: ['Hot-Path'], sources: ['declared'] }, { id: 'd', kind: 'function', tags: ['hot path'], sources: ['declared'] }])]);
    expect(codes(m)).toContain('name-variant');
  });

  test('conflicting categories resolve the same way whatever the fragment order', () => {
    const x = { karyo: 1, nodes: [{ id: 'a', kind: 'function', category: 'tool', sources: ['declared'] }] } as Fragment;
    const y = { karyo: 1, nodes: [{ id: 'a', kind: 'function', category: 'stage', sources: ['declared'] }] } as Fragment;
    const c1 = merge([x, y]).nodes[0]!.category, c2 = merge([y, x]).nodes[0]!.category;
    expect(c1).toBe(c2!);
  });
});

describe('merge: flow identity', () => {
  test('two recordings of one flow are named by start time, not fragment order', () => {
    const rec = (trace: string, start: number) => ({ karyo: 1, flows: [{ id: 'run', trace, spans: [{ id: trace, parent: null, node: 'a', start }] }] }) as Fragment;
    for (const fs of [[rec('t1', 10), rec('t2', 20)], [rec('t2', 20), rec('t1', 10)]]) {
      const m = merge([frag([]), ...fs]);
      expect(m.flows.map((f) => [f.id, f.trace])).toEqual([['run', 't1'], ['run#2', 't2']]);
    }
  });
});

describe('invariants', () => {
  const base = (): Model => ({ karyo: 1, nodes: [{ id: 'a', kind: 'function', sources: ['declared'] }, { id: 'b', kind: 'store', sources: ['declared'] }], edges: [], flows: [] });

  test('two edges on one pair (the pre-fix model) break an invariant; normalize folds them', () => {
    const m = base();
    m.edges = [{ from: 'a', to: 'b', kind: 'reads', sources: ['declared'] }, { from: 'a', to: 'b', kind: 'calls', sources: ['observed'], count: 1 }];
    expect(invariants(m).map((c) => c.code)).toEqual(['invariant']);
    const n = normalize(m);
    expect(n.edges).toEqual([{ from: 'a', to: 'b', kind: 'reads', count: 1, sources: ['declared', 'observed'] }]);
    expect(invariants(n)).toEqual([]);
  });

  test('an edge into nothing, and a span of an unknown node, break invariants', () => {
    const m = base();
    m.edges = [{ from: 'a', to: 'zz', kind: 'calls', sources: ['declared'] }];
    m.flows = [{ id: 'f', trace: 't', spans: [{ id: '1', parent: null, node: 'qq', start: 1 }] }];
    expect(invariants(m).filter((c) => c.code === 'invariant')).toHaveLength(2);
  });

  test('a recorded call without an observed relationship breaks an invariant', () => {
    const m = base();
    m.edges = [{ from: 'a', to: 'b', kind: 'calls', sources: ['declared'] }];
    m.flows = [{ id: 'f', trace: 't', spans: [{ id: '1', parent: null, node: 'a', start: 1 }, { id: '2', parent: '1', node: 'b', start: 2 }] }];
    expect(invariants(m).map((c) => c.message).join()).toContain("isn't an observed relationship");
  });

  test('reconcile reads a model with two edges per pair as one relationship', () => {
    const m = base();
    m.flows = [{ id: 'f', trace: 't', spans: [{ id: '1', parent: null, node: 'a', start: 1 }, { id: '2', parent: '1', node: 'b', start: 2 }] }];
    m.edges = [{ from: 'a', to: 'b', kind: 'reads', sources: ['declared'] }, { from: 'a', to: 'b', kind: 'calls', sources: ['observed'], count: 1 }];
    expect(reconcile(m).map((c) => c.code)).toEqual([]);
  });
});

describe('identity helpers', () => {
  test('foldEdges is idempotent', () => {
    const es: MEdge[] = [{ from: 'a', to: 'b', kind: 'writes', label: 'x', sources: ['declared'] }, { from: 'a', to: 'b', kind: 'reads', label: 'y', sources: ['declared'] }, { from: 'a', to: 'b', kind: 'calls', sources: ['observed'], count: 2 }];
    const once = foldEdges(es);
    expect(foldEdges(once)).toEqual(once);
  });

  test('checksFor matches a node and the pairs it is in, nothing else', () => {
    const m = { ...base(), checks: [
      { level: 'warn', code: 'undeclared-call', subject: 'a->b', message: '' },
      { level: 'warn', code: 'undeclared-call', subject: 'ab->c', message: '' },
      { level: 'warn', code: 'unknown-node', subject: 'a', message: '' },
      { level: 'warn', code: 'tour-unresolved', subject: 'tour:x/s->a', message: '' },
    ] } as Model;
    expect(checksFor(m, 'a').map((c) => c.subject)).toEqual(['a->b', 'a']);
    expect(checksFor(m, 'c').map((c) => c.subject)).toEqual(['ab->c']);
  });
  function base(): Model { return { karyo: 1, nodes: [], edges: [], flows: [] }; }
});
