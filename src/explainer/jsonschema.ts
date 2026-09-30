// A small JSON Schema (2020-12) checker: the subset the explainer spec and component props use.
// type, enum, const, properties, required, additionalProperties, patternProperties, items,
// prefixItems, minItems, maxItems, uniqueItems, minimum, maximum, exclusiveMinimum/Maximum,
// minLength, maxLength, pattern, anyOf, oneOf, allOf, not, $ref (local "#/…" pointers), $defs.
// Formats and annotations are ignored. Errors carry JSON pointers. Pure (no DOM, no deps).

export interface SchemaError { path: string; message: string; hint?: string }
type S = Record<string, any> | boolean;

const ptr = (base: string, key: string | number) => `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
const isType = (v: unknown, t: string) => { const k = typeOf(v); return t === k || (t === 'number' && k === 'integer'); };
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Closest candidate by edit distance (for "did you mean" hints). */
export function nearest(word: string, candidates: Iterable<string>, max = 3): string | undefined {
  let best: string | undefined, bd = Infinity;
  for (const c of candidates) {
    const d = lev(word.toLowerCase(), c.toLowerCase());
    if (d < bd) { bd = d; best = c; }
  }
  return bd <= Math.max(max, Math.floor(word.length / 3)) ? best : undefined;
}
function lev(a: string, b: string) {
  const m = a.length, n = b.length, d = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = d[0]!; d[0] = i;
    for (let j = 1; j <= n; j++) { const t = d[j]!; d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[n]!;
}

/** Check `value` against `schema`. `root` resolves $ref pointers (defaults to the schema itself). */
export function checkSchema(value: unknown, schema: S, path = '', root: S = schema): SchemaError[] {
  const out: SchemaError[] = [];
  walk(value, schema, path, root, out);
  return out;
}

function resolveRef(ref: string, root: S): S {
  if (!ref.startsWith('#')) throw new Error(`only local $ref supported: ${ref}`);
  let s: any = root;
  for (const p of ref.slice(1).split('/').filter(Boolean)) s = s?.[p.replace(/~1/g, '/').replace(/~0/g, '~')];
  if (s === undefined) throw new Error(`unresolved $ref ${ref}`);
  return s;
}

function walk(v: unknown, s: S, path: string, root: S, out: SchemaError[]) {
  if (s === true) return;
  if (s === false) { out.push({ path, message: 'is not allowed here' }); return; }
  if (s.$ref) walk(v, resolveRef(s.$ref, root), path, root, out);
  if (s.type !== undefined) {
    const ts: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!ts.some((t) => isType(v, t))) { out.push({ path, message: `must be ${ts.join(' or ')} (got ${typeOf(v)})` }); return; }
  }
  if (s.const !== undefined && !eq(v, s.const)) out.push({ path, message: `must be ${JSON.stringify(s.const)}` });
  if (s.enum && !s.enum.some((e: unknown) => eq(e, v))) {
    const near = typeof v === 'string' ? nearest(v, s.enum.filter((e: unknown) => typeof e === 'string')) : undefined;
    out.push({ path, message: `must be one of ${s.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}`, hint: near ? `did you mean "${near}"?` : undefined });
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) out.push({ path, message: `must be ≥ ${s.minimum}` });
    if (s.maximum !== undefined && v > s.maximum) out.push({ path, message: `must be ≤ ${s.maximum}` });
    if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) out.push({ path, message: `must be > ${s.exclusiveMinimum}` });
    if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) out.push({ path, message: `must be < ${s.exclusiveMaximum}` });
    if (!Number.isFinite(v)) out.push({ path, message: 'must be a finite number' });
  }
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) out.push({ path, message: s.minLength === 1 ? 'must not be empty' : `must be at least ${s.minLength} characters` });
    if (s.maxLength !== undefined && v.length > s.maxLength) out.push({ path, message: `must be at most ${s.maxLength} characters` });
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) out.push({ path, message: `must match ${s.pattern}` });
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) out.push({ path, message: `must have at least ${s.minItems} item(s)` });
    if (s.maxItems !== undefined && v.length > s.maxItems) out.push({ path, message: `must have at most ${s.maxItems} item(s)` });
    if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) out.push({ path, message: 'must not repeat items' });
    const pre: S[] = s.prefixItems ?? [];
    v.forEach((x, i) => {
      if (i < pre.length) walk(x, pre[i]!, ptr(path, i), root, out);
      else if (s.items !== undefined) walk(x, s.items, ptr(path, i), root, out);
    });
  }
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in o)) out.push({ path: ptr(path, k), message: `is required` });
    const props: Record<string, S> = s.properties ?? {};
    const pats: [RegExp, S][] = Object.entries(s.patternProperties ?? {}).map(([p, sc]) => [new RegExp(p, 'u'), sc as S]);
    for (const [k, x] of Object.entries(o)) {
      if (k in props) { walk(x, props[k]!, ptr(path, k), root, out); continue; }
      const pm = pats.filter(([re]) => re.test(k));
      if (pm.length) { for (const [, sc] of pm) walk(x, sc, ptr(path, k), root, out); continue; }
      if (s.additionalProperties === false) {
        const near = nearest(k, Object.keys(props));
        out.push({ path: ptr(path, k), message: `unknown property "${k}"`, hint: near ? `did you mean "${near}"?` : Object.keys(props).length ? `allowed: ${Object.keys(props).join(', ')}` : undefined });
      } else if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(x, s.additionalProperties, ptr(path, k), root, out);
    }
  }
  if (s.allOf) for (const sub of s.allOf) walk(v, sub, path, root, out);
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (!s[key]) continue;
    const results = (s[key] as S[]).map((sub) => { const e: SchemaError[] = []; walk(v, sub, path, root, e); return e; });
    const ok = results.filter((r) => r.length === 0).length;
    if (key === 'anyOf' ? ok >= 1 : ok === 1) continue;
    if (key === 'oneOf' && ok > 1) { out.push({ path, message: 'matches more than one allowed form' }); continue; }
    // report the branch that got furthest (fewest errors below its own type check)
    const typed = results.filter((r) => !(r.length === 1 && r[0]!.path === path && r[0]!.message.startsWith('must be ') && r[0]!.message.includes('(got ')));
    if (typed.length === 1) out.push(...typed[0]!);
    else {
      const forms = (s[key] as any[]).map((b) => b.description ?? (b.type ? [].concat(b.type).join('|') : b.const !== undefined ? JSON.stringify(b.const) : b.$ref ? b.$ref.split('/').pop() : 'schema')).join(', ');
      out.push({ path, message: `must be one of: ${forms}`, hint: typed.length ? typed.sort((a, b) => a.length - b.length)[0]!.map((e) => `${e.path || '/'} ${e.message}`).join('; ') : undefined });
    }
  }
  if (s.not) { const e: SchemaError[] = []; walk(v, s.not, path, root, e); if (!e.length) out.push({ path, message: 'matches a form that is not allowed' }); }
}
