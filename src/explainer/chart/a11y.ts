// Every chart carries its data for screen readers: a one-paragraph summary (what is plotted, the range, the
// extremes, what the step highlights or marks) and the numbers as a table. Both render into a visually hidden
// block beside the SVG (which is aria-hidden). Built from the step's resting frame. Pure.
import { esc } from '../template';
import { formatDay, formatNumber } from './format';
import type { Frame } from './data';

const KIND: Record<Frame['o']['kind'], string> = { line: 'Line chart', bars: 'Bar chart', donut: 'Donut chart', sparkline: 'Sparkline' };

function xLabel(fr: Frame, i: number): string {
  const x = fr.x[i]!;
  return fr.o.xType === 'time' ? formatDay(x.t, fr.o.unit) : x.label;
}

/** A plain-language summary of a resting frame (an author's `summary` prop replaces the generated one). */
export function chartSummary(fr: Frame, own?: string): string {
  if (own) return own;
  const { o, n } = fr, f = (v: number) => formatNumber(v, o.fmt);
  const s = fr.s.filter((x) => (n[`p:${x.k}`] ?? 0) > 0.5), xs = fr.x.map((_, i) => i).filter((i) => (n[`q:${fr.x[i]!.k}`] ?? 0) > 0.5);
  const parts: string[] = [];
  const head = o.title ? `${KIND[o.kind]}: ${o.title}.` : `${KIND[o.kind]}.`;
  if (o.kind === 'donut') {
    const total = s.reduce((a, x) => a + (n[`v:${x.k}|`] ?? 0), 0);
    parts.push(`${head} ${s.length} part${s.length === 1 ? '' : 's'}, ${o.total} ${f(total)}:`);
    parts.push(s.map((x) => { const v = n[`v:${x.k}|`] ?? 0; return `${x.label} ${f(v)} (${total ? Math.round((v / total) * 100) : 0}%)`; }).join(', ') + '.');
  } else {
    const range = xs.length ? `${xLabel(fr, xs[0]!)} to ${xLabel(fr, xs[xs.length - 1]!)}` : '';
    parts.push(o.kind === 'sparkline' ? `${head} ${xs.length} values.` : `${head} ${s.length} series over ${xs.length} ${o.xType === 'band' ? 'categories' : 'points'}${range ? `, ${range}` : ''}${(n.stk ?? 0) > 0.5 ? ', stacked' : ''}.`);
    for (const x of s) {
      const vals = xs.map((i) => ({ i, v: n[`v:${x.k}|${fr.x[i]!.k}`]! })).filter((q) => Number.isFinite(q.v));
      if (!vals.length) continue;
      const hi = vals.reduce((a, b) => (b.v > a.v ? b : a)), lo = vals.reduce((a, b) => (b.v < a.v ? b : a));
      const name = o.kind === 'sparkline' ? '' : `${x.label}: `;
      parts.push(`${name}from ${f(vals[0]!.v)} to ${f(vals[vals.length - 1]!.v)}, highest ${f(hi.v)} (${xLabel(fr, hi.i)}), lowest ${f(lo.v)} (${xLabel(fr, lo.i)}).`);
    }
  }
  const lit = [...fr.s.filter((x) => (n[`hs:${x.k}`] ?? 0) > 0.5).map((x) => x.label), ...fr.x.filter((x) => (n[`hx:${x.k}`] ?? 0) > 0.5).map((x) => x.label)];
  if (lit.length) parts.push(`Highlighted: ${lit.join(', ')}.`);
  for (const a of fr.a) {
    if ((n[`a:${a.k}`] ?? 0) < 0.5) continue;
    if (a.type === 'callout') parts.push(`Note at ${a.x}: ${a.label || 'marked'}.`);
    else if (a.axis === 'y') parts.push(`${a.type === 'band' ? 'Band' : 'Reference line'}${a.label ? ` "${a.label}"` : ''} at ${a.type === 'band' ? `${f(n[`a0:${a.k}`]!)} to ${f(n[`a1:${a.k}`]!)}` : f(n[`a0:${a.k}`]!)}.`);
    else parts.push(`${a.type === 'band' ? 'Band' : 'Marker'}${a.label ? ` "${a.label}"` : ''} at ${a.x}${a.x2 && a.x2 !== a.x ? ` to ${a.x2}` : ''}.`);
  }
  return parts.join(' ');
}

/** The data as an HTML table: one row per x (or slice), one column per series. */
export function chartTable(fr: Frame): string {
  const { o, n } = fr, f = (v: number) => (Number.isFinite(v) ? formatNumber(v, o.fmt) : '–');
  const s = fr.s.filter((x) => (n[`p:${x.k}`] ?? 0) > 0.5);
  const cap = o.title ? `<caption>${esc(o.title)}</caption>` : '';
  if (o.kind === 'donut') return `<table>${cap}<thead><tr><th scope="col">Part</th><th scope="col">Value</th></tr></thead><tbody>${s.map((x) => `<tr><th scope="row">${esc(x.label)}</th><td>${esc(f(n[`v:${x.k}|`]!))}</td></tr>`).join('')}</tbody></table>`;
  const xs = fr.x.map((_, i) => i).filter((i) => (n[`q:${fr.x[i]!.k}`] ?? 0) > 0.5);
  const xh = o.kind === 'sparkline' ? '#' : o.xType === 'time' ? 'Date' : 'x';
  return `<table>${cap}<thead><tr><th scope="col">${xh}</th>${s.map((x) => `<th scope="col">${esc(x.label)}</th>`).join('')}</tr></thead><tbody>${xs.map((i) => `<tr><th scope="row">${esc(o.kind === 'sparkline' ? String(i + 1) : xLabel(fr, i))}</th>${s.map((x) => `<td>${esc(f(n[`v:${x.k}|${fr.x[i]!.k}`]!))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
