// The trace board's request names (src/model/flowboard.ts `requestName`): shape-neutral, from the model only.
import { describe, expect, test } from 'bun:test';
import { requestName } from '../src/model/flowboard';
import type { MNode, MSpan } from '../src/model/model';

const node = (id: string, o: Partial<MNode> = {}): MNode => ({ id, kind: 'function', sources: ['extracted'], ...o });
const span = (id: string, n: string, label?: string, parent: string | null = null): MSpan => ({ id, parent, node: n, start: 0, ...(label ? { label } : {}) });
const nodes = (...ns: MNode[]) => new Map(ns.map((n) => [n.id, n]));

describe('request names', () => {
  test('a label the recording gave the root wins', () => {
    const m = nodes(node('svc.dispatch', { label: 'Dispatcher', category: 'core' }), node('svc.work', { label: 'Worker', category: 'job' }));
    expect(requestName(m, span('r', 'svc.dispatch', 'resize_images'), [{ s: span('a', 'svc.work', 'run()', 'r') }])).toEqual({ name: 'resize_images', via: null });
  });
  test('under an undeclared root, the first declared card the request reached, in call order', () => {
    const m = nodes(node('app.entry', { label: 'App.handle' }), node('app.route', { label: 'route()' }), node('app.orders.create', { label: 'Create order', category: 'entry' }), node('app.store', { label: 'Store', category: 'store' }));
    const rows = [{ s: span('b', 'app.route', 'route()', 'r') }, { s: span('c', 'app.orders.create', 'create()', 'b') }, { s: span('d', 'app.store', 'save', 'c') }];
    expect(requestName(m, span('r', 'app.entry', 'handle()'), rows)).toEqual({ name: 'Create order', via: 'App.handle' });
    // what the recording said that card did is kept
    rows[1] = { s: span('c', 'app.orders.create', 'bulk', 'b') };
    expect(requestName(m, span('r', 'app.entry', 'handle()'), rows).name).toBe('Create order · bulk');
  });
  test('a declared root, or nothing declared below it: the root card itself', () => {
    const m = nodes(node('p.step', { label: 'Mix', category: 'stage' }), node('p.helper', { label: 'helper()' }), node('q.fn', { label: 'q.fn' }));
    expect(requestName(m, span('r', 'p.step', 'mix()'), [{ s: span('a', 'p.helper', 'helper()', 'r') }])).toEqual({ name: 'Mix', via: null });
    expect(requestName(m, span('r', 'q.fn', 'fn()'), [])).toEqual({ name: 'q.fn', via: null });
    expect(requestName(new Map(), span('r', 'x.y'), [])).toEqual({ name: 'x.y', via: null });
  });
});
