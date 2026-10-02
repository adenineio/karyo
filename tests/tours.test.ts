// Tour resolution (src/model/tours.ts): symbol lookup, strict code/span binding, expansion, drift warnings.
// Run: `just test`.
import { expect, test } from 'bun:test';
import type { Model } from '../src/model/model';
import { findSymbol, resolveTours, stepWires, type AuthoredTour } from '../src/model/tours';

const PY = `"""Module doc.

    def fake(self): ...   <- inside a docstring: never a match
"""
import x


@deco(
    "a",
    b=1)
class Store:
    """A store."""

    def __init__(self):
        self.s = {}

    @tool(title="Create",
          flag=True)
    def create(self, title: str,
               other: int = 1) -> str:
        """Make one."""
        text = """
not code
"""
        return title

    def get(self, k): return self.s[k]


def create(x):
    return x
`;

const GO = `package p

import "fmt"

// Charge takes payment.
//
//karyo:node id=p.charge
func (s *Server) Charge(ctx context.Context, amount int) error {
	if amount < 0 {
		return fmt.Errorf("negative: %s", "}")
	}
	return nil
}

// ID names a thing.
type ID string

type Config struct {
	Name string
}
`;

test('python: dotted method with multi-line decorator, signature and a string body', () => {
  expect(findSymbol(PY, 'Store.create', 'python')).toEqual({ start: 17, end: 25 });
  expect(findSymbol(PY, 'Store', 'python')).toEqual({ start: 8, end: 27 });
  expect(findSymbol(PY, 'Store.get', 'python')).toEqual({ start: 27, end: 27 });
  expect(findSymbol(PY, 'create', 'python')).toEqual({ start: 30, end: 31 }); // top level beats the method
  expect(findSymbol(PY, 'fake', 'python')).toBeUndefined();
  expect(findSymbol(PY, 'Store.nope', 'python')).toBeUndefined();
});

test('go: method with doc comment, one-line type, struct', () => {
  expect(findSymbol(GO, 'Server.Charge', 'go')).toEqual({ start: 5, end: 13 });
  expect(findSymbol(GO, 'Charge', 'go')).toEqual({ start: 5, end: 13 });
  expect(findSymbol(GO, 'ID', 'go')).toEqual({ start: 15, end: 16 });
  expect(findSymbol(GO, 'Config', 'go')).toEqual({ start: 18, end: 20 });
  expect(findSymbol(GO, 'Other.Charge', 'go')).toBeUndefined();
});

const ns = (ms: number) => ms * 1e6;
const model: Model = {
  karyo: 1,
  nodes: [
    { id: 'api', kind: 'service', label: 'API', sources: ['declared'], code: { file: 'app.py', start: 8, end: 27, lang: 'python', text: PY.split('\n').slice(7, 27).join('\n') }, ref: { file: 'app.py', line: 8, symbol: 'Store' } },
    { id: 'engine', kind: 'function', label: 'Engine', sources: ['declared'], ref: { file: 'app.py', line: 30, symbol: 'create' } },
    { id: 'a', kind: 'function', label: 'Stage A', summary: 'Does A.', sources: ['declared'] },
    { id: 'b', kind: 'function', label: 'Stage B', sources: ['declared'] },
  ],
  edges: [
    { from: 'engine', to: 'a', kind: 'calls', sources: ['declared'] },
    { from: 'engine', to: 'b', kind: 'calls', sources: ['declared', 'observed'] },
    { from: 'engine', to: 'x', kind: 'calls', sources: ['observed'] },
  ],
  flows: [{
    id: 'f', trace: 't', spans: [
      { id: 'r1', parent: null, node: 'api', label: 'go', start: ns(0), end: ns(10) },
      { id: 'c1', parent: 'r1', node: 'engine', label: 'go', start: ns(1), end: ns(9) },
      { id: 'a1', parent: 'c1', node: 'a', start: ns(2), end: ns(4) },
      { id: 'b1', parent: 'c1', node: 'b', start: ns(4), end: ns(8.5), status: 'error', attrs: { error: 'boom' } },
      { id: 'r2', parent: null, node: 'api', label: 'go', start: ns(20), end: ns(23) },
    ],
  }],
};
const files: Record<string, string> = { 'app.py': PY };
const read = (f: string) => files[f];

test('authored steps: code by symbol, focus, span preference, request scope', () => {
  const tour: AuthoredTour = {
    id: 't', title: 'T', flow: 'f', steps: [
      { id: 's1', title: 'One', node: 'api', code: { symbol: 'Store.create' }, focus: ['return title'], show: ['engine'], span: { label: 'go' } },
      { id: 's2', title: 'Two', node: 'engine', span: { label: 'go' } },
      { id: 's3', title: 'Three', node: 'api', code: { file: 'app.py', lines: [30, 31] }, span: { request: 2 } },
    ],
  };
  const { tours, checks } = resolveTours(model, [tour], read);
  expect(checks).toEqual([]);
  const [s1, s2, s3] = tours[0]!.steps;
  expect(s1!.code).toMatchObject({ file: 'app.py', start: 17, end: 25, lang: 'python', symbol: 'Store.create', focus: [25] });
  expect(s1!.show).toEqual(['api', 'engine']);
  expect(s1!.timing).toEqual({ ms: 13, label: 'go', status: 'ok', spans: 2 }); // both requests, the api spans only
  expect(s2!.code).toMatchObject({ start: 30, end: 31, symbol: 'create' });     // no captured code: looked up from the ref
  expect(s2!.timing).toMatchObject({ ms: 8, spans: 1 });
  expect(s3!.timing).toMatchObject({ ms: 3, spans: 1 });
  expect(s3!.code!.text).toBe('def create(x):\n    return x');
});

test('expand: one step per declared callee, in order, timed under the parent', () => {
  const { tours, checks } = resolveTours(model, [{ id: 't', title: 'T', flow: 'f', steps: [{ expand: 'engine', group: 'g' }] }], read);
  expect(checks).toEqual([]);
  const steps = tours[0]!.steps;
  expect(steps.map((s) => [s.id, s.title, s.group, s.source])).toEqual([['a', 'Stage A', 'g', 'expanded'], ['b', 'Stage B', 'g', 'expanded']]);
  expect(steps[0]!.text).toBe('Does A.');
  expect(steps[0]!.show).toEqual(['engine', 'a']);
  expect(steps[1]!.timing).toEqual({ ms: 4.5, label: 'b', status: 'error', spans: 1, attrs: { error: 'boom' } });
});

test('drift: every unresolvable reference is a tour-unresolved warning, never a throw', () => {
  const tour: AuthoredTour = {
    id: 't', title: 'T', flow: 'f', steps: [
      { id: 'n', title: 'N', node: 'ghost' },
      { id: 's', title: 'S', node: 'api', code: { symbol: 'Store.delete' } },
      { id: 'f', title: 'F', node: 'api', focus: ['no such text'] },
      { id: 'p', title: 'P', node: 'api', span: { label: 'nope' } },
      { id: 'r', title: 'R', node: 'api', span: { request: 9 } },
      { id: 'l', title: 'L', code: { file: 'missing.py', lines: [1, 2] } },
      { expand: 'nobody' },
    ],
  };
  const stale: Model = { ...model, nodes: model.nodes.map((n) => (n.id === 'api' ? { ...n, code: { ...n.code!, text: 'old' } } : n)) };
  const { checks } = resolveTours(stale, [tour, { id: 'bad' } as unknown as AuthoredTour], read);
  expect(checks.filter((c) => c.code === 'tour-invalid')).toHaveLength(1);
  const msgs = checks.filter((c) => c.code === 'tour-unresolved').map((c) => c.message);
  for (const m of ['node "ghost"', 'Store.delete not found', 'focus "no such text"', 'matches {"label":"nope"}', 'no request 9', 'missing.py', 'node "nobody"', 'no longer matches the file'])
    expect(msgs.some((x) => x.includes(m))).toBe(true);
  expect(checks.every((c) => c.level === 'warn')).toBe(true);
});

// ---- type cards (a type with its methods folded into it, as automatic mode draws code)

const CARDS: Model = {
  karyo: 1,
  nodes: [
    { id: 'p.Alloc', kind: 'type', label: 'Alloc', sources: ['extracted'] },
    { id: 'p.Alloc.allocate', kind: 'function', label: 'Alloc.allocate', parent: 'p.Alloc', fold: true, sources: ['extracted', 'observed'] },
    { id: 'p.Notifier', kind: 'type', label: 'Notifier', sources: ['extracted'] },
    { id: 'p.Notifier.ready', kind: 'function', label: 'Notifier.ready', parent: 'p.Notifier', fold: true, sources: ['extracted', 'observed'] },
    { id: 'p.Queue', kind: 'type', label: 'Queue', sources: ['extracted'] },
    { id: 'p.Queue.next', kind: 'function', label: 'Queue.next', parent: 'p.Queue', fold: true, sources: ['extracted', 'observed'] },
  ],
  edges: [
    { from: 'p.Alloc.allocate', to: 'p.Notifier.ready', kind: 'calls', sources: ['extracted', 'observed'], count: 1 },
    { from: 'p.Alloc.allocate', to: 'p.Queue.next', kind: 'calls', sources: ['extracted', 'observed'], count: 1 },
  ],
  flows: [{ id: 'f', trace: 't', spans: [
    { id: 'a', parent: null, node: 'p.Alloc.allocate', label: 'allocate()', start: 0, end: 4_000_000 },
    { id: 'b', parent: 'a', node: 'p.Queue.next', label: 'next()', start: 1_000_000, end: 2_000_000 },
    { id: 'c', parent: 'a', node: 'p.Notifier.ready', label: 'ready()', start: 2_000_000, end: 3_000_000 },
  ] }],
};

test("a step over type cards draws their methods' relationships, rolled up onto the cards", () => {
  expect(stepWires(CARDS, ['p.Alloc', 'p.Notifier', 'p.Queue']).map((w) => w.key).sort()).toEqual(['p.Alloc->p.Notifier', 'p.Alloc->p.Queue']);
  // a method shown beside the other type's card keeps its own end
  expect(stepWires(CARDS, ['p.Alloc.allocate', 'p.Notifier']).map((w) => w.key)).toEqual(['p.Alloc.allocate->p.Notifier']);
  // nothing between cards whose parts aren't related
  expect(stepWires(CARDS, ['p.Notifier', 'p.Queue'])).toEqual([]);
});

test('a step naming a type card is timed by its methods\' spans', () => {
  const tour: AuthoredTour = { id: 't', title: 'T', flow: 'f', steps: [
    { id: 'alloc', title: 'Allocate', node: 'p.Alloc', show: ['p.Queue', 'p.Notifier'], span: { label: 'allocate()' } },
    { id: 'notify', title: 'Notify', node: 'p.Notifier', span: { node: 'p.Notifier' } },
  ] };
  const r = resolveTours(CARDS, [tour], () => undefined);
  expect(r.checks).toEqual([]);
  expect(r.tours[0]!.steps.map((s) => s.timing?.ms)).toEqual([4, 1]);
});

test('a bare construction at the root (a type\'s span with nothing under it) is no request', () => {
  const m: Model = { ...CARDS, flows: [{ id: 'f', trace: 't', spans: [
    { id: 'z', parent: null, node: 'p.Alloc', label: 'Alloc()', start: 0, end: 0 },                  // the test builds the object first
    ...CARDS.flows[0]!.spans.map((s) => ({ ...s, start: s.start + 10, end: (s.end ?? 0) + 10 })),
  ] }] };
  const tour: AuthoredTour = { id: 't', title: 'T', flow: 'f', request: 1, steps: [{ id: 'q', title: 'Q', node: 'p.Queue', span: { node: 'p.Queue.next' } }] };
  const r = resolveTours(m, [tour], () => undefined);
  expect(r.checks).toEqual([]);
  expect(r.tours[0]!.steps[0]!.timing?.ms).toBe(1);
});
