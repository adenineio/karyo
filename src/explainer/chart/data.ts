// A chart's props (validated by its component schema) → a Frame: the structure in order (series or slices,
// x keys, annotations, ticks) plus one flat map of numbers (values, domains, presence, highlight weights).
// Frames are size-free, so a tween is a plain interpolation of two frames (tween.ts) and render.ts lays
// the result out in pixels. Also: part addressing for step verbs (`chart/series`, `chart/x`, `chart/series@x`)
// and the semantic checks the validator adds on top of the schema. Pure.
import { niceDomain, parseDate, ticks, timeTicks, type TimeUnit } from './scale';
import { decimalsOf, formatDay, type FormatOpts, type NumberFormat } from './format';

export type ChartKind = 'line' | 'bars' | 'donut' | 'sparkline';
export const CHART_KINDS: readonly ChartKind[] = ['line', 'bars', 'donut', 'sparkline'];

/** A series (line, bars) or a slice (donut): its key, label and colour slot (1–8, 0 = "other"). */
export interface Item { k: string; label: string; slot: number }
/** An x position: its key (the value as written), label and, on a time or linear axis, its number. */
export interface XItem { k: string; label: string; t: number }
export interface Annot { k: string; type: 'line' | 'band' | 'callout'; axis: 'x' | 'y'; label: string; x?: string; x2?: string; series?: string }
export interface Opts {
  kind: ChartKind;
  xType: 'band' | 'time' | 'linear';
  unit: TimeUnit;
  horizontal: boolean;
  labels: 'auto' | 'none' | 'end' | 'tip';
  fmt: FormatOpts;
  /** x labels: no thousands separators (years and other plain integers). */
  xPlain: boolean;
  total: string;
  title: string;
}
export interface Frame { o: Opts; s: Item[]; x: XItem[]; a: Annot[]; ty: number[]; tx: number[]; n: Record<string, number> }

/** What a step does to the chart's parts, from `emphasize: ["el/part"]` and `dim: ["el/part"]`. */
export interface Parts { emph: string[]; dim: string[] }
export interface ChartCtx {
  /** The colour slot of a series or slice: its category's slot, else its place in the element's series. */
  slot(key: string, category?: string): number;
  /** A category's label (series without a label take it). */
  catLabel?(id: string): string | undefined;
  parts?: Parts;
}

type Num = number | null;
interface SeriesP { id?: string; label?: string; category?: string; values: Num[] }
interface SliceP { id?: string; label?: string; category?: string; value: number }
interface AnnotP { id?: string; type: 'line' | 'band' | 'callout'; y?: number | [number, number]; x?: string | number | [string | number, string | number]; series?: string; label?: string }
export type ChartProps = Record<string, unknown>;

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const seriesKey = (s: { id?: string; label?: string }, i: number) => s.id ?? s.label ?? `s${i + 1}`;

/** Value formatting. Without `decimals`, the data's own precision (at most 2), so tweened values count in whole
 *  steps of it instead of showing every fraction on the way. */
function fmtOf(p: ChartProps, values: number[]): FormatOpts {
  const format = (p.format as NumberFormat) ?? 'number';
  const dec = fin(p.decimals) ? p.decimals : format === 'number' ? Math.max(0, ...values.filter(fin).map((v) => decimalsOf(v, 2))) : undefined;
  return { format, ...(dec === undefined ? {} : { decimals: dec }), prefix: str(p.prefix), unit: str(p.unit), grouping: p.grouping !== false };
}

/** Series of a line / bars / sparkline chart, normalised (a sparkline's `values` is one series). */
export function seriesOf(kind: ChartKind, p: ChartProps): SeriesP[] {
  if (kind === 'sparkline') return [{ id: 'value', label: str(p.label) || 'value', category: p.category as string | undefined, values: (p.values as Num[]) ?? [] }];
  if (kind === 'donut') return ((p.slices as SliceP[]) ?? []).map((s) => ({ id: s.id, label: s.label, category: s.category, values: [s.value] }));
  return (p.series as SeriesP[]) ?? [];
}
/** The x keys as written. */
export function xKeys(kind: ChartKind, p: ChartProps): string[] {
  if (kind === 'sparkline') return ((p.values as unknown[]) ?? []).map((_, i) => String(i));
  if (kind === 'donut') return [''];
  return ((p.x as unknown[]) ?? []).map(str);
}

/** The x axis: band (categories), time (ISO dates) or linear (numbers; lines only). */
function xAxis(kind: ChartKind, p: ChartProps): { type: Opts['xType']; t: number[]; unit: TimeUnit } {
  const xs = (p.x as unknown[]) ?? [];
  if (kind === 'line' && xs.length > 1) {
    const ds = xs.map(parseDate);
    if (ds.every(Number.isFinite)) {
      const raw = xs.map(str), unit: TimeUnit = raw.every((r) => r.length === 4) ? 'year' : raw.every((r) => r.length === 7) ? 'month' : 'day';
      return { type: 'time', t: ds, unit };
    }
    if (xs.every(fin)) return { type: 'linear', t: xs as number[], unit: 'day' };
  }
  return { type: 'band', t: xs.map((_, i) => i), unit: 'day' };
}

/** Is `part` one of this chart's parts? series (or slice) key, x key, or "series@x". */
export function partKinds(kind: ChartKind, p: ChartProps): { series: string[]; x: string[]; annots: string[] } {
  return { series: seriesOf(kind, p).map(seriesKey), x: kind === 'donut' ? [] : xKeys(kind, p), annots: ((p.annotations as AnnotP[]) ?? []).map(annotKey) };
}
const annotKey = (a: AnnotP, i: number) => a.id ?? `${a.type}-${i + 1}`;

/** Build a chart's frame for a step. */
export function frameOf(kind: ChartKind, p: ChartProps, ctx: ChartCtx): Frame {
  const sp = seriesOf(kind, p), xk = xKeys(kind, p);
  const fmt = fmtOf(p, sp.flatMap((x) => x.values.filter(fin)));
  const ax = kind === 'line' ? xAxis(kind, p) : { type: 'band' as const, t: xk.map((_, i) => i), unit: 'day' as TimeUnit };
  const n: Record<string, number> = { sw: 1 };
  const s: Item[] = sp.map((x, i) => {
    const k = seriesKey(x, i);
    n[`p:${k}`] = 1;
    return { k, label: x.label ?? (x.category && ctx.catLabel?.(x.category)) ?? k, slot: ctx.slot(k, x.category) };
  });
  const xRaw = (p.x as unknown[]) ?? [];
  const xPlain = xRaw.every((v) => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < 1e4) || kind === 'sparkline';
  const x: XItem[] = xk.map((k, i) => { n[`q:${k}`] = 1; return { k, label: ax.type === 'time' ? formatDay(ax.t[i]!, ax.unit) : k, t: ax.t[i]! }; });
  // values
  sp.forEach((ser, si) => xk.forEach((xx, xi) => { const v = ser.values[xi]; n[`v:${s[si]!.k}|${xx}`] = fin(v) ? v : NaN; }));
  const horizontal = kind === 'bars' && p.orient === 'horizontal';
  const stacked = kind === 'bars' && p.stacked === true;
  n.stk = stacked ? 1 : 0;
  n.ar = kind === 'sparkline' ? (p.area === false ? 0 : 1) : p.area === true ? 1 : 0;
  // the value domain: data extent (stack totals when stacked), zero included unless the spec says otherwise
  let lo = Infinity, hi = -Infinity;
  const look = (v: number) => { if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } };
  if (stacked) xk.forEach((xx) => { let pos = 0, neg = 0; s.forEach((it) => { const v = n[`v:${it.k}|${xx}`]!; if (v > 0) pos += v; else if (v < 0) neg += v; }); look(pos); look(neg); });
  else for (const k in n) if (k.startsWith('v:')) look(n[k]!);
  const annots = (p.annotations as AnnotP[]) ?? [];
  for (const a of annots) if (a.y !== undefined) for (const v of [a.y].flat()) look(v);
  if (!(lo <= hi)) { lo = 0; hi = 1; }
  const zero = kind === 'bars' || (kind === 'line' && p.zero !== false) || (kind === 'sparkline' && p.zero === true);
  if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const yCount = kind === 'sparkline' ? 2 : 5;
  let [y0, y1] = kind === 'sparkline' && !zero ? [lo, hi === lo ? lo + 1 : hi] : niceDomain(lo, hi, yCount);
  if (fin(p.min)) y0 = p.min; if (fin(p.max)) y1 = p.max;
  n.y0 = y0; n.y1 = y1;
  const ty = kind === 'line' || kind === 'bars' ? ticks(y0, y1, yCount).ticks : [];
  ty.forEach((v) => (n[`ty:${v}`] = 1));
  let tx: number[] = [];
  if (ax.type !== 'band') {
    const t0 = Math.min(...ax.t), t1 = Math.max(...ax.t);
    n.x0 = t0; n.x1 = t1;
    tx = ax.type === 'time' ? timeTicks(t0, t1, 6).ticks : ticks(t0, t1, 6).ticks;
    tx.forEach((v) => (n[`tx:${v}`] = 1));
  }
  // annotations: positions as numbers (tweened), or as x keys on a band axis
  const a: Annot[] = annots.map((an, i) => {
    const k = annotKey(an, i);
    n[`a:${k}`] = 1;
    const out: Annot = { k, type: an.type, axis: an.y !== undefined ? 'y' : 'x', label: str(an.label) };
    if (an.type === 'callout') { out.axis = 'x'; out.series = an.series ?? s[0]?.k; out.x = str(an.x); return out; }
    if (an.y !== undefined) { const [a0, a1] = [an.y].flat() as number[]; n[`a0:${k}`] = a0!; n[`a1:${k}`] = a1 ?? a0!; }
    else {
      const [x0, x1] = [an.x].flat() as (string | number)[];
      out.x = str(x0); out.x2 = str(x1 ?? x0);
      if (ax.type !== 'band') { const tt = (v: unknown) => (ax.type === 'time' ? parseDate(v) : Number(v)); n[`a0:${k}`] = tt(x0); n[`a1:${k}`] = tt(x1 ?? x0); }
    }
    return out;
  });
  // the step's highlight: series / x / point weights, and explicit dims
  const parts = ctx.parts ?? { emph: [], dim: [] };
  const sKeys = new Set(s.map((i) => i.k)), xSet = new Set(xk);
  const mark = (part: string, pre: 'h' | 'd') => {
    const at = part.lastIndexOf('@');
    if (sKeys.has(part)) n[`${pre}s:${part}`] = 1;
    else if (xSet.has(part) && kind !== 'donut') n[`${pre}x:${part}`] = 1;
    else if (at > 0 && sKeys.has(part.slice(0, at)) && xSet.has(part.slice(at + 1))) { n[`${pre}p:${part.slice(0, at)}|${part.slice(at + 1)}`] = 1; if (pre === 'h') n[`hs:${part.slice(0, at)}`] = 1; }
    else return;
    if (pre === 'h') n.hon = 1;
  };
  parts.emph.forEach((x) => mark(x, 'h'));
  parts.dim.forEach((x) => mark(x, 'd'));
  const labels = (['none', 'end', 'tip'] as const).find((l) => l === p.labels) ?? 'auto';
  return {
    o: { kind, xType: ax.type, unit: ax.unit, horizontal, labels, fmt, xPlain, total: str(p.total) || 'total', title: str(p.title) },
    s, x, a, ty, tx, n,
  };
}

// ------------------------------------------------------------------ validation (beyond the schema)

export interface ChartIssue { path: string; message: string; hint?: string }

/** Data problems the props schema can't express: value counts that don't match x, duplicate keys, x values of
 *  mixed kinds, annotations that point at nothing, unknown categories. Paths are relative to the props. */
export function chartIssues(kind: ChartKind, p: ChartProps, categories: string[] = []): ChartIssue[] {
  const out: ChartIssue[] = [];
  const sp = seriesOf(kind, p), xk = xKeys(kind, p);
  const cats = new Set(categories);
  const listKey = kind === 'donut' ? 'slices' : 'series';
  const seen = new Map<string, number>();
  sp.forEach((s, i) => {
    if (kind === 'sparkline') return;
    const k = seriesKey(s, i);
    if (seen.has(k)) out.push({ path: `/${listKey}/${i}`, message: `${kind === 'donut' ? 'slice' : 'series'} "${k}" appears twice (also ${listKey}[${seen.get(k)}])`, hint: 'give each one its own "id"' });
    else seen.set(k, i);
    if (s.category !== undefined && !cats.has(s.category)) out.push({ path: `/${listKey}/${i}/category`, message: `unknown category "${s.category}"`, hint: cats.size ? `categories: ${[...cats].join(', ')}` : 'declare it in the spec\'s "categories", or drop it (series take colours in order)' });
    if (kind !== 'donut' && s.values.length !== xk.length) out.push({ path: `/series/${i}/values`, message: `series "${k}" has ${s.values.length} value${s.values.length === 1 ? '' : 's'} but x has ${xk.length}`, hint: 'one value per x (null for a gap)' });
  });
  if (kind === 'line' || kind === 'bars') {
    const xs = (p.x as unknown[]) ?? [];
    const dup = xk.find((k, i) => xk.indexOf(k) !== i);
    if (dup !== undefined) out.push({ path: '/x', message: `x value "${dup}" appears twice`, hint: 'x values name the positions; each must be different' });
    if (kind === 'line' && xs.some((v) => typeof v === 'number') && xs.some((v) => typeof v === 'string')) out.push({ path: '/x', message: 'x mixes numbers and text', hint: 'use all numbers, all ISO dates ("2025-03"), or all labels' });
  }
  if (kind === 'donut') {
    sp.forEach((s, i) => { if ((s.values[0] ?? 0) < 0) out.push({ path: `/slices/${i}/value`, message: `slice "${seriesKey(s, i)}" is negative`, hint: 'a donut shows parts of a whole: every value must be 0 or more' }); });
    if (sp.length > 8) out.push({ path: '/slices', message: `${sp.length} slices: a donut reads at 6 or fewer, and colours stop at 8`, hint: 'fold the small ones into one "Other" slice, or use bars' });
  } else if (sp.length > 8) out.push({ path: '/series', message: `${sp.length} series: colours stop at 8`, hint: 'show fewer series, or split the chart' });
  const sKeys = sp.map(seriesKey), xSet = new Set(xk);
  ((p.annotations as AnnotP[]) ?? []).forEach((a, i) => {
    const at = `/annotations/${i}`;
    if (a.type === 'callout') {
      if (kind === 'donut' || kind === 'sparkline') { out.push({ path: at, message: `a ${kind} has no callouts`, hint: 'emphasize the part instead: "emphasize": ["<element>/<part>"]' }); return; }
      if (a.x === undefined) out.push({ path: at, message: 'a callout needs "x" (the point it marks)' });
      else if (!xSet.has(str(a.x))) out.push({ path: `${at}/x`, message: `callout at x "${str(a.x)}", which isn't in x`, hint: `x: ${xk.slice(0, 8).join(', ')}${xk.length > 8 ? ', …' : ''}` });
      if (a.series !== undefined && !sKeys.includes(a.series)) out.push({ path: `${at}/series`, message: `callout on unknown series "${a.series}"`, hint: `series: ${sKeys.join(', ')}` });
      return;
    }
    if (kind === 'donut') { out.push({ path: at, message: 'a donut has no axes for a reference line or band' }); return; }
    if ((a.y === undefined) === (a.x === undefined)) { out.push({ path: at, message: `a ${a.type} needs "y" (a value) or "x" (a position), not ${a.y === undefined ? 'neither' : 'both'}` }); return; }
    if (a.type === 'band' && !Array.isArray(a.y ?? a.x)) out.push({ path: at, message: 'a band needs two ends: "y": [from, to] or "x": [from, to]' });
    if (a.type === 'line' && Array.isArray(a.y ?? a.x)) out.push({ path: at, message: 'a line sits at one value; for a range use "type": "band"' });
    if (a.x !== undefined && xAxis(kind, p).type === 'band') for (const v of [a.x].flat()) if (!xSet.has(str(v))) out.push({ path: `${at}/x`, message: `x "${str(v)}" isn't in x`, hint: `x: ${xk.slice(0, 8).join(', ')}${xk.length > 8 ? ', …' : ''}` });
  });
  return out;
}

/** Why `part` names nothing in this chart (null when it names a series, slice, x position or point). */
export function partProblem(kind: ChartKind, p: ChartProps, part: string): string | null {
  const { series, x } = partKinds(kind, p);
  if (series.includes(part) || x.includes(part)) return null;
  const at = part.lastIndexOf('@');
  if (at > 0 && kind !== 'donut') {
    if (!series.includes(part.slice(0, at))) return `no series "${part.slice(0, at)}" (series: ${series.join(', ')})`;
    if (!x.includes(part.slice(at + 1))) return `no x "${part.slice(at + 1)}"`;
    return null;
  }
  const what = kind === 'donut' ? `slices: ${series.join(', ')}` : `series: ${series.join(', ')}; x: ${x.slice(0, 6).join(', ')}${x.length > 6 ? ', …' : ''}; a point: "<series>@<x>"`;
  return `no part "${part}" (${what})`;
}

/** The chart kind a component template hosts (`data-k-chart="<kind>"`), or null. */
export function chartKindOf(template: string | undefined): ChartKind | null {
  const m = template?.match(/data-k-chart\s*=\s*"([a-z]+)"/);
  return m && (CHART_KINDS as readonly string[]).includes(m[1]!) ? (m[1] as ChartKind) : null;
}
