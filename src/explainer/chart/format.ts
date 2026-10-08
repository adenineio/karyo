// Number and date formatting for charts: no Intl and no locale, so a value prints the same in bun, in any
// browser and on any machine (stills stay byte-identical). English month names, UTC dates.
import type { TimeUnit } from './scale';

export type NumberFormat = 'number' | 'percent' | 'compact';
export interface FormatOpts {
  /** number (default), percent (0.25 → 25%) or compact (12,400 → 12.4K). */
  format?: NumberFormat;
  /** Fixed decimals (default: what the value needs, at most 2; compact: 1 below 100). */
  decimals?: number;
  /** Before the number, e.g. "$". */
  prefix?: string;
  /** After the number: "%" and symbols attach ("12%", "21°C"), words take a space ("420 kWh"). */
  unit?: string;
  /** Thousands separators (default true). */
  grouping?: boolean;
}

const MINUS = '−';
const group = (i: string) => i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** Decimals a value needs (at most `max`). */
export const decimalsOf = (v: number, max = 2) => { const m = Number.isFinite(v) ? String(+v.toFixed(max)).match(/\.(\d+)$/) : null; return m ? m[1]!.length : 0; };

function plain(v: number, dec: number, grouping: boolean): string {
  const s = Math.abs(v).toFixed(dec);
  const neg = v < 0 && +s !== 0;
  const [i, f] = s.split('.') as [string, string | undefined];
  return (neg ? MINUS : '') + (grouping ? group(i) : i) + (f ? '.' + f : '');
}

/** The number alone (no prefix or unit). */
export function formatValue(v: number, o: FormatOpts = {}): string {
  if (!Number.isFinite(v)) return '–';
  const fmt = o.format ?? 'number', grouping = o.grouping !== false;
  if (fmt === 'percent') { const p = v * 100; return plain(p, o.decimals ?? decimalsOf(p, 1), grouping) + '%'; }
  if (fmt === 'compact') {
    const a = Math.abs(v), [d, s] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
    const x = v / d, dec = o.decimals ?? (Math.abs(x) < 100 ? decimalsOf(x, 1) : 0);
    return plain(x, dec, false) + s;
  }
  return plain(v, o.decimals ?? decimalsOf(v), grouping);
}

/** "420 kWh", "$1,200", "12%", "21°C": the number with its prefix and unit. */
export function formatNumber(v: number, o: FormatOpts = {}): string {
  const u = o.unit ?? '';
  const sep = u && /^[A-Za-z]/.test(u) ? ' ' : '';
  return (o.prefix ?? '') + formatValue(v, o) + (u ? sep + u : '');
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A date tick at a step of `unit`: "2025", "Mar" ("Jan 2025" on a year's first month, or `withYear`), "Mar 14". */
export function formatDate(t: number, unit: TimeUnit, withYear = false): string {
  const d = new Date(t), y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (unit === 'year') return String(y);
  if (unit === 'month') return m === 0 || withYear ? `${MONTHS[m]} ${y}` : MONTHS[m]!;
  return `${MONTHS[m]} ${d.getUTCDate()}${withYear ? `, ${y}` : ''}`;
}

/** A full date for tooltips and tables, at the precision the data was written in. */
export function formatDay(t: number, unit: TimeUnit): string {
  const d = new Date(t);
  return unit === 'year' ? String(d.getUTCFullYear()) : unit === 'month' ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
