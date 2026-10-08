// The import check (docs/MODEL.md "Three kinds of truth": `no-import`, `wired`): a relationship across modules whose
// module never imports the other's is a warning, unless something explains it. A composition root that imports both
// ends, a module the caller imports that imports the callee's (a typed container: handlers given a `Services` whose
// attributes are typed with the parts' classes), or static analysis having resolved the call through the types the
// code names: a note. The fixture (tests/fixtures/typed-container) is a project shaped that way, scanned for real.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { merge, reconcile, type Fragment, type MEdge, type Model } from '../src/model/model';

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/typed-container');
const hasPython = spawnSync('python3', ['-c', 'import sys; assert sys.version_info >= (3, 9)']).status === 0;

const checks = (m: Model, code: string) => reconcile(m).filter((c) => c.code === code);
const mod = (id: string) => ({ id, kind: 'module' as const, module: id, lang: 'python', sources: ['extracted' as const] });
const fn = (id: string, module: string) => ({ id, kind: 'function' as const, module, lang: 'python', sources: ['extracted' as const] });
const imp = (from: string, to: string): MEdge => ({ from, to, kind: 'imports', sources: ['extracted'] });

/** handlers → services → parts; `call` is handlers.h → parts.Part.go, with the given sources. */
function model(call: MEdge['sources'], imports: MEdge[]): Model {
  const nodes = [mod('a.handlers'), mod('a.services'), mod('a.parts'), mod('a.mid'), fn('a.handlers.h', 'a.handlers'), fn('a.parts.Part.go', 'a.parts')];
  return { karyo: 1, nodes, edges: [...imports, { from: 'a.handlers.h', to: 'a.parts.Part.go', kind: 'calls', sources: call }], flows: [] } as Model;
}

describe('the import check', () => {
  test('a call with no import anywhere near it is a warning', () => {
    const m = model(['observed'], [imp('a.handlers', 'a.services')]);
    expect(checks(m, 'no-import').map((c) => c.subject)).toEqual(['a.handlers.h->a.parts.Part.go']);
  });

  test('through a module the caller imports that imports the callee\'s (a typed container): a note', () => {
    for (const sources of [['observed'], ['declared'], ['extracted']] as MEdge['sources'][]) {
      const m = model(sources, [imp('a.handlers', 'a.services'), imp('a.services', 'a.parts')]);
      expect(checks(m, 'no-import')).toEqual([]);
      const [w] = checks(m, 'wired');
      expect(w!.level).toBe('info');
      expect(w!.message).toContain('it reaches it through a.services');
    }
  });

  test('extracted through a longer chain of imports: a note naming the chain; recorded only: still a warning', () => {
    const chain = [imp('a.handlers', 'a.services'), imp('a.services', 'a.mid'), imp('a.mid', 'a.parts')];
    const ex = model(['extracted', 'observed'], chain);
    expect(checks(ex, 'no-import')).toEqual([]);
    expect(checks(ex, 'wired')[0]!.message).toContain('static analysis resolved the call through the types its code names (imports a.handlers → a.services → a.mid → a.parts)');
    expect(checks(model(['observed'], chain), 'no-import').length).toBe(1);
  });

  test('a composition root that imports both ends is still the first explanation', () => {
    const m = model(['observed'], [imp('a.services', 'a.handlers'), imp('a.services', 'a.parts')]);
    expect(checks(m, 'wired')[0]!.message).toContain('a.services wires them together');
  });

  test.skipIf(!hasPython)('the fixture, scanned: handlers that call through a typed Services get notes, not warnings', () => {
    const r = spawnSync('python3', ['-m', 'karyo', 'scan', 'shop', '--root', '.'], { cwd: FIXTURE, encoding: 'utf8', env: { ...process.env, PYTHONPATH: path.join(ROOT, 'sdk/python') } });
    expect(r.status).toBe(0);
    const m = merge([JSON.parse(r.stdout) as Fragment], 'shop');
    const calls = m.edges.filter((e) => e.kind === 'calls').map((e) => `${e.from}->${e.to}`);
    expect(calls).toContain('shop.handlers.place_order->shop.orders.OrderBook.place');
    expect(calls).toContain('shop.handlers.place_order->shop.stock.Stock.reserve');
    expect(m.checks!.filter((c) => c.code === 'no-import')).toEqual([]);
    const wired = m.checks!.filter((c) => c.code === 'wired');
    expect(wired.map((c) => c.subject).sort()).toEqual(['shop.handlers.cancel_order->shop.orders.OrderBook.cancel', 'shop.handlers.place_order->shop.stock.Stock.reserve']);
    expect(wired.every((c) => c.message.includes('through shop.services'))).toBe(true);
  });
});
