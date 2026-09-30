// A curation file (docs/MODEL.md "Curation"): what matters in a model and how it's grouped, without touching the code.
// Written by people or by Claude (`karyo/curation.json` next to the model), applied at build time by `merge`
// (scripts/model.ts build --curation): renames, categories, tags, groups (with labels and nesting), which nodes are
// their own cards (`top`) and which are drawn folded into their parent (`fold`), and which are left out (`hide`).
// Entries name nodes by their stable ids; `*` in a selector matches any run of characters (`orders.db.*`). An entry that
// matches nothing is a `curation-unresolved` warning in the model's checks, never silently ignored, so the next refresh
// can fix it. Pure: browser and bun.
import { ID_RE, isProposed, type MCheck, type MGroup, type MNode, type Model, type NodeKind } from './model';

export interface CurationNode { label?: string; summary?: string; kind?: NodeKind; category?: string; tags?: string[]; group?: string }
export interface CurationGroup { label?: string; parent?: string; summary?: string; members?: string[] }
export interface Curation {
  karyo: 'curation/1';
  note?: string;
  /** Selectors of nodes drawn as their own cards (unfolded). Wins over `fold`. */
  top?: string[];
  /** Selectors of nodes drawn folded into their parent (only nodes that have one). */
  fold?: string[];
  /** Selectors of nodes left out of the model (with their relationships). What a recorded run reached is kept (and said). */
  hide?: string[];
  /** Groups by id: label, the group they sit in, and members (selectors) moved into them. */
  groups?: Record<string, CurationGroup>;
  /** Per node (an id or a selector): what to show instead of what the code says. Tags add to the code's. */
  nodes?: Record<string, CurationNode>;
}

const KINDS: NodeKind[] = ['service', 'function', 'type', 'store', 'queue', 'external', 'actor'];
const TOP_KEYS = ['karyo', 'note', 'top', 'fold', 'hide', 'groups', 'nodes', '$schema'];
const NODE_KEYS = ['label', 'summary', 'kind', 'category', 'tags', 'group'];
const GROUP_KEYS = ['label', 'parent', 'summary', 'members'];
const WORD_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$/;

/** A selector's matcher: an exact id, or a glob where `*` matches any run of characters (dots included). */
export function selector(sel: string): (id: string) => boolean {
  if (!sel.includes('*')) return (id) => id === sel;
  const re = new RegExp(`^${sel.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return (id) => re.test(id);
}

/** The closest real ids to a selector that matched nothing (a rename in the code is the usual cause). */
function closest(sel: string, ids: string[]): string[] {
  const s = sel.replace(/\*/g, '');
  const d = (a: string, b: string) => {
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
    return prev[n]!;
  };
  const tail = (x: string) => x.split(/[.:]/).pop() ?? x;
  return ids.map((id) => ({ id, k: Math.min(d(s, id), d(tail(s), tail(id)) + 2) })).filter((x) => x.k <= Math.max(3, s.length / 4)).sort((a, b) => a.k - b.k || (a.id < b.id ? -1 : 1)).slice(0, 2).map((x) => x.id);
}

/** Schema and meaning problems of a curation file (the build reports them as `curation-invalid` warnings). */
export function validateCuration(c: unknown): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return [{ path: '', message: 'a curation file is a JSON object' }];
  const o = c as Record<string, unknown>;
  if (o.karyo !== 'curation/1') out.push({ path: 'karyo', message: `expected "curation/1", got ${JSON.stringify(o.karyo)}` });
  for (const k of Object.keys(o)) if (!TOP_KEYS.includes(k)) out.push({ path: k, message: `unknown key (keys: ${TOP_KEYS.filter((x) => x !== '$schema').join(', ')})` });
  for (const k of ['top', 'fold', 'hide'] as const)
    if (o[k] !== undefined && (!Array.isArray(o[k]) || !(o[k] as unknown[]).every((x) => typeof x === 'string' && x))) out.push({ path: k, message: 'a list of node ids or selectors' });
  const nodes = o.nodes as Record<string, Record<string, unknown>> | undefined;
  if (nodes !== undefined && (typeof nodes !== 'object' || Array.isArray(nodes))) out.push({ path: 'nodes', message: 'an object: node id (or selector) → what to show' });
  else for (const [id, v] of Object.entries(nodes ?? {})) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { out.push({ path: `nodes.${id}`, message: 'an object' }); continue; }
    for (const k of Object.keys(v)) if (!NODE_KEYS.includes(k)) out.push({ path: `nodes.${id}.${k}`, message: `unknown key (keys: ${NODE_KEYS.join(', ')})` });
    if (v.kind !== undefined && !KINDS.includes(v.kind as NodeKind)) out.push({ path: `nodes.${id}.kind`, message: `one of ${KINDS.join(', ')}` });
    if (v.category !== undefined && (typeof v.category !== 'string' || !WORD_RE.test(v.category))) out.push({ path: `nodes.${id}.category`, message: 'one word' });
    if (v.tags !== undefined && (!Array.isArray(v.tags) || !v.tags.every((t) => typeof t === 'string' && WORD_RE.test(t)))) out.push({ path: `nodes.${id}.tags`, message: 'a list of words' });
    for (const k of ['label', 'summary', 'group'] as const) if (v[k] !== undefined && (typeof v[k] !== 'string' || !v[k])) out.push({ path: `nodes.${id}.${k}`, message: 'a non-empty string' });
  }
  const groups = o.groups as Record<string, Record<string, unknown>> | undefined;
  if (groups !== undefined && (typeof groups !== 'object' || Array.isArray(groups))) out.push({ path: 'groups', message: 'an object: group id → label, parent, members' });
  else for (const [id, g] of Object.entries(groups ?? {})) {
    if (!ID_RE.test(id)) out.push({ path: `groups.${id}`, message: 'a group id is a word (letters, digits, _ . : / -)' });
    if (!g || typeof g !== 'object' || Array.isArray(g)) { out.push({ path: `groups.${id}`, message: 'an object' }); continue; }
    for (const k of Object.keys(g)) if (!GROUP_KEYS.includes(k)) out.push({ path: `groups.${id}.${k}`, message: `unknown key (keys: ${GROUP_KEYS.join(', ')})` });
    if (g.members !== undefined && (!Array.isArray(g.members) || !g.members.every((x) => typeof x === 'string' && x))) out.push({ path: `groups.${id}.members`, message: 'a list of node ids or selectors' });
    // a group inside itself, directly or not, can't be drawn
    const seen = new Set([id]);
    for (let p = g.parent; typeof p === 'string'; p = (groups?.[p] as Record<string, unknown> | undefined)?.parent) {
      if (seen.has(p)) { out.push({ path: `groups.${id}.parent`, message: `groups nest in a circle (${[...seen, p].join(' → ')})` }); break; }
      seen.add(p);
    }
  }
  return out;
}

/** Apply a curation file to a merged model, in place (before reconcile): node fields, groups, top / fold, then hide.
 *  Returns its checks: `curation-invalid` (a malformed file or entry: that part is skipped), `curation-unresolved` (an
 *  entry naming nothing in the model), `curation-kept` (a hidden node a recorded run reached, kept). */
export function applyCuration(m: Model, c: Curation, file = 'karyo/curation.json'): MCheck[] {
  const checks: MCheck[] = [];
  const invalid = validateCuration(c);
  for (const i of invalid) checks.push({ level: 'warn', code: 'curation-invalid', subject: `curation:${i.path || '/'}`, message: `${file}${i.path ? ` ${i.path}` : ''}: ${i.message}; that part is skipped.` });
  if (invalid.some((i) => i.path === '' || i.path === 'karyo')) return checks;
  const bad = new Set(invalid.map((i) => i.path));
  const nodes = m.nodes.filter((n) => n.kind !== 'module' && !isProposed(n));
  const ids = nodes.map((n) => n.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const match = (where: string, sel: string): MNode[] => {
    const f = selector(sel);
    const hit = nodes.filter((n) => f(n.id));
    if (!hit.length) {
      const near = closest(sel, ids);
      checks.push({ level: 'warn', code: 'curation-unresolved', subject: `curation:${where}:${sel}`,
        message: `${file} ${where} names ${sel}, which matches nothing in the model${near.length ? ` (did you mean ${near.join(' or ')}?)` : ''}; refresh the curation.` });
    }
    return hit;
  };
  // what each node shows
  for (const [sel, v] of Object.entries(c.nodes ?? {})) {
    if ([...bad].some((p) => p === `nodes.${sel}` || p.startsWith(`nodes.${sel}.`))) continue;
    for (const n of match(`nodes`, sel)) {
      if (v.label) n.label = v.label;
      if (v.summary) n.summary = v.summary;
      if (v.kind) n.kind = v.kind;
      if (v.category) n.category = v.category;
      if (v.group) n.group = v.group;
      if (v.tags?.length) n.tags = [...new Set([...(n.tags ?? []), ...v.tags])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
  }
  // groups: members move in; labels and nesting go into the model
  const groups: MGroup[] = [];
  for (const [id, g] of Object.entries(c.groups ?? {})) {
    if ([...bad].some((p) => p === `groups.${id}` || p === `groups.${id}.parent`)) continue;
    if (!bad.has(`groups.${id}.members`)) for (const sel of g.members ?? []) for (const n of match(`groups.${id}.members`, sel)) n.group = id;
    groups.push({ id, ...(g.label ? { label: g.label } : {}), ...(g.parent ? { parent: g.parent } : {}), ...(g.summary ? { summary: g.summary } : {}) });
  }
  if (groups.length) m.groups = [...(m.groups ?? []).filter((g) => !groups.some((x) => x.id === g.id)), ...groups].sort((a, b) => (a.id < b.id ? -1 : 1));
  // folding: fold first, top wins
  if (!bad.has('fold')) for (const sel of c.fold ?? []) for (const n of match('fold', sel)) {
    if (n.parent && byId.has(n.parent)) n.fold = true;
    else if (!sel.includes('*')) checks.push({ level: 'warn', code: 'curation-invalid', subject: `curation:fold:${sel}`, message: `${file} fold names ${sel}, which has no parent to fold into; hide it, or move it to a group.` });
  }
  if (!bad.has('top')) for (const sel of c.top ?? []) for (const n of match('top', sel)) delete n.fold;
  // hiding: left out with its relationships, unless a recorded run reached it (then it stays, and the check says so)
  if (!bad.has('hide')) {
    const hide = new Set<string>();
    for (const sel of c.hide ?? []) for (const n of match('hide', sel)) {
      if (n.sources.includes('observed')) checks.push({ level: 'info', code: 'curation-kept', subject: n.id, message: `${file} hides ${n.id}, but a recorded run reached it: kept, so no recorded call goes missing.` });
      else hide.add(n.id);
    }
    if (hide.size) {
      m.nodes = m.nodes.filter((n) => !hide.has(n.id));
      m.edges = m.edges.filter((e) => !hide.has(e.from) && !hide.has(e.to));
      for (const n of m.nodes) if (n.parent && hide.has(n.parent)) { delete n.parent; delete n.fold; }
    }
  }
  return checks;
}

/** A group's label as views show it: its own label (else its id), under its parent's (`parent / label`). */
export function groupLabel(m: Pick<Model, 'groups'>, id: string): string {
  const by = new Map((m.groups ?? []).map((g) => [g.id, g]));
  const parts: string[] = [];
  const seen = new Set<string>();
  for (let g: string | undefined = id; g !== undefined && !seen.has(g); g = by.get(g)?.parent) { seen.add(g); parts.unshift(by.get(g)?.label ?? g); }
  return parts.join(' / ');
}
