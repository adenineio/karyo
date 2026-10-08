// The explainer chart layer (src/explainer/chart/): scales and ticks, number and date formatting, frames and
// tweens, rendering (deterministic, no DOM), the screen-reader twin, part targets and the validator's chart checks.
// Run: `just explainer-test` (or `bun test tests/chart.test.ts`).
import { describe, expect, test } from 'bun:test';
import { niceDomain, ticks, tickStep, linear, bands, points, parseDate, timeTicks } from '../src/explainer/chart/scale';
import { formatNumber, formatValue, formatDate } from '../src/explainer/chart/format';
import { frameOf, chartIssues, partProblem, chartKindOf, type ChartCtx } from '../src/explainer/chart/data';
import { lerpFrame, birthFrame, mergeKeyed } from '../src/explainer/chart/tween';
import { renderChart, dodge, estimate } from '../src/explainer/chart/render';
import { chartSummary, chartTable } from '../src/explainer/chart/a11y';
import { resolveSteps, parsePart } from '../src/explainer/resolve';
import { validateSpec } from '../src/explainer/validate';
import { loadLibrary } from '../src/explainer/library';
import type { ExplainerSpec, Issue } from '../src/explainer/types';

const lib = await loadLibrary({ env: '', adenineDir: '/nonexistent-karyo-adenine' });
const ctx = (parts?: ChartCtx['parts']): ChartCtx => ({ slot: (_k, cat) => (cat === 'b' ? 2 : 1), parts });
const LINE = { x: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ id: 'rain', label: 'Rain', values: [30, 45, 12, 60] }, { id: 'snow', label: 'Snow', values: [10, 0, null, 25] }], unit: 'mm' };
const BARS = { x: ['North', 'South', 'East'], series: [{ id: 'oak', values: [4, 7, 2] }, { id: 'pine', values: [3, 1, 5] }] };

describe('scales and ticks', () => {
  test('tick steps are 1, 2 or 5 × 10^n', () => {
    expect(tickStep(0, 100, 5)).toBe(20);
    expect(tickStep(0, 1, 5)).toBe(0.2);
    expect(tickStep(0, 820, 5)).toBe(200);
    expect(tickStep(0, 7, 5)).toBe(1);
  });
  test('nice domains widen to whole steps without float noise', () => {
    expect(niceDomain(0, 820)).toEqual([0, 1000]);
    expect(niceDomain(0.12, 0.73)).toEqual([0.1, 0.8]);
    expect(niceDomain(0.31, 7.4)).toEqual([0, 8]);
    expect(niceDomain(-22, 31)).toEqual([-30, 40]);
    expect(niceDomain(5, 5)).toEqual([2, 8]);
    expect(niceDomain(0, 0)).toEqual([0, 1]);
  });
  test('ticks are exact decimals', () => {
    expect(ticks(0, 1, 5).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(ticks(0, 0.3, 3).ticks).toEqual([0, 0.1, 0.2, 0.3]);
    expect(ticks(-30, 40, 5).ticks).toEqual([-30, -20, -10, 0, 10, 20, 30, 40]);
  });
  test('linear, weighted bands and points', () => {
    expect(linear(0, 10, 100, 0)(5)).toBe(50);
    expect(linear(3, 3, 0, 10)(3)).toBe(0);
    expect(bands([1, 1, 2], 0, 100)).toEqual([{ x: 0, w: 25 }, { x: 25, w: 25 }, { x: 50, w: 50 }]);
    expect(bands([1, 0, 1], 0, 100)[1]!.w).toBe(0);
    expect(points([1, 1, 1], 0, 100)).toEqual([0, 50, 100]);
    // a point shrinking out closes its gaps: its neighbours meet in the middle
    expect(points([1, 0, 1], 0, 100)).toEqual([0, 50, 100]);
    expect(points([1], 0, 100)).toEqual([50]);
  });
  test('dates parse as UTC and tick on calendar boundaries', () => {
    expect(parseDate('2025-03')).toBe(Date.UTC(2025, 2, 1));
    expect(parseDate('2025-03-14')).toBe(Date.UTC(2025, 2, 14));
    expect(parseDate('2025')).toBe(Date.UTC(2025, 0, 1));
    expect(parseDate('March')).toBeNaN();
    expect(parseDate('2025-13')).toBeNaN();
    const m = timeTicks(Date.UTC(2024, 0, 1), Date.UTC(2025, 2, 1), 6);
    expect(m.unit).toBe('month');
    expect(m.n).toBe(3);
    expect(m.ticks.map((t) => new Date(t).getUTCMonth())).toEqual([0, 3, 6, 9, 0]);
    const y = timeTicks(Date.UTC(2001, 5, 1), Date.UTC(2024, 0, 1), 6);
    expect(y.unit).toBe('year');
    expect(y.ticks.map((t) => new Date(t).getUTCFullYear())).toEqual([2005, 2010, 2015, 2020]);
  });
});

describe('formatting', () => {
  test('numbers: grouping, decimals, a true minus', () => {
    expect(formatValue(1234567)).toBe('1,234,567');
    expect(formatValue(2.5)).toBe('2.5');
    expect(formatValue(2.5, { decimals: 2 })).toBe('2.50');
    expect(formatValue(-8)).toBe('−8');
    expect(formatValue(-0.0001, { decimals: 1 })).toBe('0.0');
    expect(formatValue(2024, { grouping: false })).toBe('2024');
    expect(formatValue(NaN)).toBe('–');
  });
  test('percent and compact', () => {
    expect(formatValue(0.25, { format: 'percent' })).toBe('25%');
    expect(formatValue(0.125, { format: 'percent' })).toBe('12.5%');
    expect(formatValue(12400, { format: 'compact' })).toBe('12.4K');
    expect(formatValue(3_200_000, { format: 'compact' })).toBe('3.2M');
    expect(formatValue(250_000, { format: 'compact' })).toBe('250K');
  });
  test('units: words take a space, symbols attach; prefixes attach', () => {
    expect(formatNumber(420, { unit: 'kWh' })).toBe('420 kWh');
    expect(formatNumber(12, { unit: '%' })).toBe('12%');
    expect(formatNumber(21, { unit: '°C' })).toBe('21°C');
    expect(formatNumber(1200, { prefix: '$' })).toBe('$1,200');
  });
  test('dates', () => {
    expect(formatDate(Date.UTC(2025, 0, 1), 'month')).toBe('Jan 2025');
    expect(formatDate(Date.UTC(2025, 3, 1), 'month')).toBe('Apr');
    expect(formatDate(Date.UTC(2025, 3, 1), 'month', true)).toBe('Apr 2025');
    expect(formatDate(Date.UTC(2025, 3, 9), 'day')).toBe('Apr 9');
    expect(formatDate(Date.UTC(2025, 3, 9), 'year')).toBe('2025');
  });
});

describe('frames', () => {
  test('a line frame: values, presence, a nice domain from zero, ticks', () => {
    const f = frameOf('line', LINE, ctx());
    expect(f.s.map((s) => s.k)).toEqual(['rain', 'snow']);
    expect(f.n['v:rain|Q2']).toBe(45);
    expect(f.n['v:snow|Q3']).toBeNaN();
    expect([f.n.y0, f.n.y1]).toEqual([0, 60]);
    expect(f.ty).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(f.o.xType).toBe('band');
  });
  test('stacked bars size the domain by stack totals; colour slots come from the context', () => {
    const f = frameOf('bars', { ...BARS, stacked: true, series: [{ id: 'oak', category: 'b', values: [4, 7, 2] }, { id: 'pine', values: [3, 1, 5] }] }, ctx());
    expect(f.n.stk).toBe(1);
    expect(f.n.y1).toBe(8);
    expect(f.s.map((s) => s.slot)).toEqual([2, 1]);
  });
  test('ISO dates make a time axis; numbers a linear one (lines)', () => {
    expect(frameOf('line', { x: ['2025-01', '2025-02', '2025-03'], series: [{ label: 'a', values: [1, 2, 3] }] }, ctx()).o.xType).toBe('time');
    expect(frameOf('line', { x: [0, 5, 10], series: [{ label: 'a', values: [1, 2, 3] }] }, ctx()).o.xType).toBe('linear');
    expect(frameOf('bars', { x: [2023, 2024], series: [{ label: 'a', values: [1, 2] }] }, ctx()).o.xType).toBe('band');
  });
  test('parts: series, x and point emphasis set their weights', () => {
    const f = frameOf('line', LINE, ctx({ emph: ['rain', 'Q4', 'snow@Q1'], dim: ['snow'] }));
    expect(f.n['hs:rain']).toBe(1);
    expect(f.n['hx:Q4']).toBe(1);
    expect(f.n['hp:snow|Q1']).toBe(1);
    expect(f.n['ds:snow']).toBe(1);
    expect(f.n.hon).toBe(1);
  });
  test('the value format takes the data\'s precision, so tweens count in its steps', () => {
    expect(frameOf('bars', BARS, ctx()).o.fmt.decimals).toBe(0);
    expect(frameOf('sparkline', { values: [1.5, 2.25] }, ctx()).o.fmt.decimals).toBe(2);
  });
});

describe('tweens', () => {
  const a = frameOf('bars', BARS, ctx());
  const b = frameOf('bars', { ...BARS, series: [{ id: 'oak', values: [8, 7, 2] }, { id: 'birch', values: [1, 1, 1] }] }, ctx());
  test('k = 0 is the start, k = 1 is exactly the target', () => {
    expect(lerpFrame(a, b, 0)).toBe(a);
    expect(lerpFrame(a, b, 1)).toBe(b);
  });
  test('values interpolate; arriving bars grow from 0, leaving ones shrink to 0', () => {
    const m = lerpFrame(a, b, 0.5);
    expect(m.n['v:oak|North']).toBe(6);
    expect(m.n['v:birch|North']).toBe(0.5);
    expect(m.n['p:birch']).toBe(0.5);
    expect(m.n['v:pine|South']).toBe(0.5);
    expect(m.n['p:pine']).toBe(0.5);
    // structure: the target's order, the leaving series kept beside its old neighbour
    expect(m.s.map((s) => s.k)).toEqual(['oak', 'pine', 'birch']);
  });
  test('a pure function of (from, to, k)', () => {
    expect(JSON.stringify(lerpFrame(a, b, 0.3))).toBe(JSON.stringify(lerpFrame(a, b, 0.3)));
  });
  test('the domain glides; ticks of both domains crossfade', () => {
    const m = lerpFrame(a, b, 0.5);
    expect(m.n.y1).toBe((a.n.y1! + b.n.y1!) / 2);
    expect(m.ty).toEqual([...new Set([...a.ty, ...b.ty])].sort((x, y) => x - y));
  });
  test('birth: bars at 0, lines unrevealed, donuts unswept, axes in place', () => {
    const bb = birthFrame(a);
    expect(bb.n['v:oak|North']).toBe(0);
    expect(bb.n['p:oak']).toBe(1);
    expect(bb.n.y1).toBe(a.n.y1);
    const l = birthFrame(frameOf('line', LINE, ctx()));
    expect(l.n['p:rain']).toBe(0);
    expect(l.n['v:rain|Q2']).toBe(45);
    expect(birthFrame(frameOf('donut', { slices: [{ label: 'a', value: 1 }] }, ctx())).n.sw).toBe(0);
  });
  test('mergeKeyed keeps leaving items where they were', () => {
    expect(mergeKeyed([{ k: 'a' }, { k: 'b' }, { k: 'c' }], [{ k: 'a' }, { k: 'c' }, { k: 'd' }]).map((x) => x.k)).toEqual(['a', 'b', 'c', 'd']);
    expect(mergeKeyed([{ k: 'z' }, { k: 'a' }], [{ k: 'a' }]).map((x) => x.k)).toEqual(['z', 'a']);
  });
});

describe('rendering', () => {
  test('deterministic, theme classes only, real text, aria-hidden', () => {
    const f = frameOf('line', { ...LINE, annotations: [{ type: 'line', y: 40, label: 'Normal' }, { type: 'callout', series: 'rain', x: 'Q4', label: 'Wettest' }] }, ctx());
    const r1 = renderChart(f, 520, 300), r2 = renderChart(f, 520, 300);
    expect(r1.svg).toBe(r2.svg);
    expect(r1.svg).toContain('aria-hidden="true"');
    expect(r1.svg).toContain('>Normal</text>');
    expect(r1.svg).toContain('>Wettest</text>');
    expect(r1.svg).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
    expect(r1.hit.xs).toHaveLength(4);
  });
  test('every kind renders at small and large sizes without throwing', () => {
    const frames = [
      frameOf('line', LINE, ctx()), frameOf('bars', BARS, ctx()), frameOf('bars', { ...BARS, orient: 'horizontal', stacked: true }, ctx()),
      frameOf('donut', { slices: [{ label: 'a', value: 1 }, { label: 'b', value: 3 }] }, ctx()), frameOf('sparkline', { values: [1, 4, 2, 6] }, ctx()),
    ];
    for (const f of frames) for (const [w, h] of [[120, 60], [480, 300], [900, 500]] as const) expect(renderChart(f, w, h).svg.startsWith('<svg')).toBe(true);
    expect(renderChart(frames[0]!, 0, 0).svg).toBe('');
  });
  test('values escape; a label like <b> stays text', () => {
    const f = frameOf('bars', { x: ['<b>'], series: [{ label: 'x & y', values: [1] }, { label: 'z', values: [2] }] }, ctx());
    const svg = renderChart(f, 400, 240).svg;
    expect(svg).toContain('&lt;b&gt;');
    expect(svg).toContain('x &amp; y');
  });
  test('dodge spreads labels apart inside the bounds and keeps their order', () => {
    const out = dodge([50, 52, 51, 200], 15, 0, 300);
    const sorted = [...out].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(14.99);
    expect(out[3]).toBe(200);
    expect(dodge([5, 6], 15, 0, 100).every((y) => y >= 0)).toBe(true);
  });
  test('the estimate measures without a DOM', () => {
    expect(estimate('1,000', 12)).toBeGreaterThan(estimate('10', 12));
  });
});

describe('screen-reader twin', () => {
  test('summary names the series, range and extremes; a table carries every value', () => {
    const f = frameOf('line', { ...LINE, title: 'Rainfall' }, ctx({ emph: ['rain'], dim: [] }));
    const s = chartSummary(f);
    expect(s).toContain('Line chart: Rainfall.');
    expect(s).toContain('Rain: from 30 mm to 60 mm, highest 60 mm (Q4), lowest 12 mm (Q3)');
    expect(s).toContain('Highlighted: Rain.');
    const t = chartTable(f);
    expect(t).toContain('<caption>Rainfall</caption>');
    expect(t).toContain('<th scope="row">Q3</th><td>12 mm</td><td>–</td>');
    expect(chartSummary(f, 'Own words.')).toBe('Own words.');
  });
  test('donut summary gives shares', () => {
    expect(chartSummary(frameOf('donut', { slices: [{ label: 'A', value: 1 }, { label: 'B', value: 3 }] }, ctx()))).toContain('A 1 (25%), B 3 (75%)');
  });
});

describe('parts and validation', () => {
  test('parsePart splits at the first slash', () => {
    expect(parsePart('chart/heating')).toEqual(['chart', 'heating']);
    expect(parsePart('chart/a/b')).toEqual(['chart', 'a/b']);
    expect(parsePart('chart')).toBeNull();
    expect(parsePart('chart/')).toBeNull();
  });
  test('partProblem explains what a chart has', () => {
    expect(partProblem('line', LINE, 'rain')).toBeNull();
    expect(partProblem('line', LINE, 'Q2')).toBeNull();
    expect(partProblem('line', LINE, 'rain@Q2')).toBeNull();
    expect(partProblem('line', LINE, 'hail')).toMatch(/series: rain, snow/);
    expect(partProblem('line', LINE, 'hail@Q2')).toMatch(/no series "hail"/);
    expect(partProblem('donut', { slices: [{ label: 'A', value: 1 }] }, 'B')).toMatch(/slices: A/);
  });
  test('chartIssues: counts, duplicates, mixed x, annotations, categories', () => {
    const iss = chartIssues('line', { x: [1, 'b'], series: [{ id: 's', values: [1] }, { id: 's', category: 'nope', values: [1, 2] }], annotations: [{ type: 'callout', x: 'zz' }, { type: 'band', y: 3 }, { type: 'line' }] }, ['heat']);
    const msgs = iss.map((i) => `${i.path} ${i.message}`);
    expect(msgs).toContain('/series/0/values series "s" has 1 value but x has 2');
    expect(msgs.some((m) => m.startsWith('/series/1 ') && m.includes('appears twice'))).toBe(true);
    expect(msgs).toContain('/series/1/category unknown category "nope"');
    expect(msgs).toContain('/x x mixes numbers and text');
    expect(msgs).toContain('/annotations/0/x callout at x "zz", which isn\'t in x');
    expect(msgs).toContain('/annotations/1 a band needs two ends: "y": [from, to] or "x": [from, to]');
    expect(msgs.some((m) => m.startsWith('/annotations/2 ') && m.includes('neither'))).toBe(true);
    expect(chartIssues('donut', { slices: [{ label: 'a', value: -1 }] })[0]!.message).toMatch(/negative/);
  });
  test('chartKindOf reads the hook from a template', () => {
    expect(chartKindOf('<div data-k-chart="bars"></div>')).toBe('bars');
    expect(chartKindOf('<div data-k-chart="pie"></div>')).toBeNull();
    expect(chartKindOf(undefined)).toBeNull();
  });

  const spec = (over: Partial<ExplainerSpec> = {}): ExplainerSpec => ({
    karyo: 'explainer/1', id: 'c', title: 'C',
    categories: [{ id: 'wet', label: 'Wet' }],
    elements: [{ id: 'rain', type: 'line', props: { x: ['Q1', 'Q2'], series: [{ id: 'a', category: 'wet', values: [1, 2] }, { id: 'b', values: [2, 1] }] } }, { id: 'note', type: 'card', props: { title: 'N' } }],
    ...over,
  });
  const find = (issues: Issue[], path: string, re: RegExp) => issues.find((i) => i.path === path && re.test(i.message));
  test('the built-in chart examples validate', () => {
    for (const name of ['line', 'bars', 'donut', 'sparkline']) {
      const c = lib.components[name]!;
      expect(c).toBeDefined();
      const issues = validateSpec({ karyo: 'explainer/1', id: 'x', title: 'X', elements: [{ id: 'e', type: name, props: c.meta.example }] }, lib).filter((i) => i.level === 'error');
      expect(issues).toEqual([]);
    }
  });
  test('a valid chart spec with part targets has no errors, and categories used by series count as used', () => {
    const issues = validateSpec(spec({ steps: [{ title: 'one', emphasize: ['rain/a', 'rain/Q2', 'rain/b@Q1'], dim: ['rain/b'] }] }), lib);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(issues.find((i) => /category "wet" has no elements/.test(i.message))).toBeUndefined();
  });
  test('unknown parts, parts of non-charts and data errors after a set are errors with hints', () => {
    const issues = validateSpec(spec({ steps: [
      { title: 'one', emphasize: ['rain/c'] },
      { title: 'two', emphasize: ['note/x'] },
      { title: 'three', set: { rain: { x: ['Q1', 'Q2', 'Q3'] } } },
      { title: 'four', emphasize: ['nope/a'] },
    ] }), lib);
    expect(find(issues, '/steps/0/emphasize/0', /no part "c"/)).toBeDefined();
    expect(find(issues, '/steps/1/emphasize/0', /only charts have parts/)).toBeDefined();
    expect(find(issues, '/steps/2/set/rain/series/0/values', /has 2 values but x has 3/)).toBeDefined();
    expect(find(issues, '/steps/3/emphasize/0', /unknown element "nope"/)).toBeDefined();
  });
  test('an element-level data error points into its props', () => {
    const issues = validateSpec(spec({ elements: [{ id: 'rain', type: 'bars', props: { x: ['a'], series: [{ id: 'a', category: 'dry', values: [1] }] } }] }), lib);
    expect(find(issues, '/elements/0/props/series/0/category', /unknown category "dry"/)).toBeDefined();
  });
  test('resolve: a part emphasis keeps the chart out of "dim others" and its outline', () => {
    const r = resolveSteps(spec({ steps: [{ emphasize: ['rain/a'], dim: 'others' }] }));
    expect(r.steps[0]!.parts.rain).toEqual({ emph: ['a'], dim: [] });
    expect(r.steps[0]!.emph.has('rain')).toBe(false);
    expect(r.steps[0]!.dim.has('rain')).toBe(false);
    expect(r.steps[0]!.dim.has('note')).toBe(true);
  });
});
