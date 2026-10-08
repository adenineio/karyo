// Name resolution for spoken or typed targets: "orders stor", "Charge Card", "needs review",
// "oders store" all find their thing. Case, punctuation and id separators don't matter; small typos
// and a missing plural don't either. Pure (tests/jarvis.test.ts).

export interface Candidate<K extends string = string> { kind: K; id: string; label: string }
export interface Match<K extends string = string> extends Candidate<K> { score: number }

/** Lowercase words: `orders.store` → `orders store`, `tag:needs-review` → `needs review` (prefix dropped). */
export function norm(s: string): string {
  return s.toLowerCase().replace(/^(tag|cat|group|lang|diff):/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function lev(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
const sim = (a: string, b: string) => (a === b ? 1 : 1 - lev(a, b) / Math.max(a.length, b.length, 1));
const stem = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** How well a query names a string, 0..1. */
export function score(query: string, target: string): number {
  const q = norm(query), t = norm(target);
  if (!q || !t) return 0;
  if (q === t) return 1;
  const qs = q.split(' ').map(stem), ts = t.split(' ').map(stem);
  if (qs.join(' ') === ts.join(' ')) return 0.98;
  const qj = qs.join(''), tj = ts.join('');
  if (qj === tj) return 0.97;                           // "ordersstore" / "orders store"
  // every query word finds its best word in the target (typos allowed), and target words left unnamed cost a little
  const per = qs.map((w) => Math.max(...ts.map((x) => (x.startsWith(w) && w.length >= 3 ? 0.92 : sim(w, x)))));
  const covered = ts.map((x) => Math.max(...qs.map((w) => sim(w, x))));
  const words = (per.reduce((a, b) => a + b, 0) / per.length) * 0.8 + (covered.reduce((a, b) => a + b, 0) / covered.length) * 0.2;
  const whole = sim(qj, tj);
  // a query inside the target ("store" in "orders store") is a fair match, better the more of it it names
  const inside = tj.includes(qj) && qj.length >= 3 ? 0.7 + 0.25 * (qj.length / tj.length) : 0;
  return Math.max(words * 0.97, whole * 0.95, inside);
}

/** Candidates ranked by how well `query` names them (by label or id), best first; ties keep the given order. */
export function rank<K extends string>(query: string, cands: Candidate<K>[]): Match<K>[] {
  return cands
    .map((c, i) => ({ ...c, score: Math.max(score(query, c.label), score(query, c.id)), i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ i: _i, ...m }) => m);
}

/** The best candidate at or above `min` (default 0.62), or null. */
export function best<K extends string>(query: string, cands: Candidate<K>[], min = 0.62): Match<K> | null {
  const r = rank(query, cands)[0];
  return r && r.score >= min ? r : null;
}
