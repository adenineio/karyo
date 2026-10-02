// Tours (docs/MODEL.md "Tours"): an authored walk through a pipeline, resolved against the code and the
// recorded flows at build time. Prose is freeform; code, nodes and timings are strict: every excerpt is
// read from the source by symbol or line range, every node must exist in the model, every timing comes
// from recorded spans. Whatever can't be resolved becomes a `tour-unresolved` warning (never a failure),
// so drift between a tour and the code shows up in the build output and on the page.
//
// Pure functions: file access is injected (`ReadFile`), so this runs in the CLI (scripts/model.ts) and in tests.
import { kindsOf, pairKey, relations, type BuiltCode, type BuiltStep, type BuiltTiming, type BuiltTour, type MCheck, type MCode, type MFlow, type MNode, type MSpan, type Model } from './model';

export type { BuiltCode, BuiltStep, BuiltTiming, BuiltTour } from './model';

// ---------------------------------------------------------------- authored format

/** Where a step's code excerpt comes from: a symbol in the node's file, a symbol in another file, or a line range. */
export interface TourCodeRef { symbol?: string; file?: string; lines?: [number, number] }
/** Recorded spans a step is timed by. All given fields must match; `request` is 1-based among the flow's requests (root spans). */
export interface TourSpanRef { label?: string; node?: string; request?: number }
// (a request is a root span that does work: a bare construction at the root, a type's span with nothing under it, isn't one)
export interface AuthoredStep {
  id: string;
  title: string;
  text?: string;
  group?: string;
  node?: string;
  /** Omitted: the node's own code. */
  code?: TourCodeRef;
  /** Substrings; excerpt lines containing any of them are highlighted. */
  focus?: string[];
  show?: string[];
  span?: TourSpanRef | TourSpanRef[];
}
/** One step per declared callee of `expand`, in declared order. */
export interface ExpandStep { expand: string; group?: string; show?: string[] }
export interface AuthoredTour {
  id: string;
  title: string;
  summary?: string;
  /** A recorded flow id; steps take their timings from it. */
  flow?: string;
  /** Scope every span lookup to this request (1-based root span) of the flow, unless a step's span says otherwise. */
  request?: number;
  steps: (AuthoredStep | ExpandStep)[];
}

export type ReadFile = (path: string) => string | undefined;

export const CODE_MAX_LINES = 80;

const LANGS: Record<string, string> = { py: 'python', go: 'go', ts: 'typescript', tsx: 'typescript', js: 'javascript', rs: 'rust' };
export const langOf = (file: string) => LANGS[file.slice(file.lastIndexOf('.') + 1)] ?? 'text';

// ---------------------------------------------------------------- symbol lookup

export interface LineRange { start: number; end: number } // 1-based, inclusive

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const indentOf = (l: string) => l.length - l.trimStart().length;

/** Find a declaration in source text. Python: `def`/`class` (dotted `Class.method` = the method inside that
 *  class), its `# karyo:` directives and decorators included. Go: `func Name`, method `Type.Name`, `type Name`, leading comment included. */
export function findSymbol(src: string, symbol: string, lang: string): LineRange | undefined {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  if (lang === 'python') return findPython(lines, symbol);
  if (lang === 'go') return findGo(lines, symbol);
  return undefined;
}

/** For each line: does it start inside a triple-quoted string? (so docstring text never looks like code) */
function pyStringMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    mask.push(open !== null);
    for (let i = 0; i < line.length; i++) {
      if (open) {
        if (line[i] === '\\') { i++; continue; }
        if (line.startsWith(open, i)) { i += open.length - 1; open = null; }
        continue;
      }
      const c = line[i];
      if (c === '#') break;
      if (c === '"' || c === "'") {
        const tri = c.repeat(3);
        if (line.startsWith(tri, i)) { open = tri; i += 2; continue; }
        // a one-line string: skip to its closing quote
        for (i++; i < line.length && line[i] !== c; i++) if (line[i] === '\\') i++;
      }
    }
  }
  return mask;
}

/** Bracket depth change of one line of Python code, ignoring strings and comments (good enough for signatures). */
function pyDepth(line: string): { delta: number; code: string } {
  let d = 0, code = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '#') break;
    if (c === '"' || c === "'") {
      const j = i;
      for (i++; i < line.length && line[i] !== c; i++) if (line[i] === '\\') i++;
      code += line.slice(j, i + 1);
      continue;
    }
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) d--;
    code += c;
  }
  return { delta: d, code };
}

function findPython(lines: string[], symbol: string): LineRange | undefined {
  const mask = pyStringMask(lines);
  const parts = symbol.split('.');
  let lo = 0, hi = lines.length, parentIndent = -1;
  let found: LineRange | undefined;
  for (let p = 0; p < parts.length; p++) {
    const last = p === parts.length - 1;
    const re = new RegExp(`^\\s*(?:${last ? 'async\\s+def|def|class' : 'class'})\\s+${esc(parts[p]!)}\\b`);
    // the shallowest match inside the parent's block is the direct member
    let best = -1;
    for (let i = lo; i < hi; i++) {
      if (mask[i] || !re.test(lines[i]!)) continue;
      const ind = indentOf(lines[i]!);
      if (ind <= parentIndent) continue;
      if (best < 0 || ind < indentOf(lines[best]!)) best = i;
    }
    if (best < 0) return undefined;
    found = pyBlock(lines, mask, best);
    parentIndent = indentOf(lines[best]!);
    lo = best + 1;
    hi = found.end;
  }
  return found;
}

/** The block of the def/class on line `d` (0-based): its `# karyo:` directives and decorators above it, its signature, its indented body. */
function pyBlock(lines: string[], mask: boolean[], d: number): LineRange {
  const ind = indentOf(lines[d]!);
  // decorators: `@` lines at the same indentation, with their continuation lines, up to a blank line
  let start = d;
  for (let i = d - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.trim() || mask[i]) break;
    const li = indentOf(l);
    if (li === ind && l.trimStart().startsWith('@')) { start = i; continue; }
    if (li <= ind) break;
  }
  // a `# karyo:` directive right above (other comment lines may sit between) is part of the declaration,
  // as the SDK captures it: the excerpt starts at the topmost directive of that comment block
  for (let i = start - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (mask[i] || !/^\s*#/.test(l)) break;
    if (/^\s*#\s?karyo:/.test(l)) start = i;
  }
  // signature: until brackets balance
  let depth = 0, sig = d;
  for (let i = d; i < lines.length; i++) {
    depth += pyDepth(lines[i]!).delta;
    sig = i;
    if (depth <= 0) break;
  }
  // a one-liner (`def f(): return 1`) has code after the signature's colon
  const tail = pyDepth(lines[sig]!).code;
  if (/:\s*\S/.test(tail.slice(tail.lastIndexOf(':')))) return { start: start + 1, end: sig + 1 };
  let end = sig;
  for (let i = sig + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (mask[i]) { end = i; continue; }
    if (!l.trim()) continue;
    if (indentOf(l) <= ind) {
      if (l.trimStart().startsWith('#')) continue; // a comment at the margin doesn't end the block by itself
      break;
    }
    end = i;
  }
  return { start: start + 1, end: end + 1 };
}

function findGo(lines: string[], symbol: string): LineRange | undefined {
  const [a, b] = symbol.includes('.') ? symbol.split('.', 2) as [string, string] : [undefined, symbol];
  const recv = (t: string) => `\\(\\s*(?:\\w+\\s+)?\\*?\\s*${t}(?:\\[[^\\]]*\\])?\\s*\\)`;
  const pats = a
    ? [new RegExp(`^func\\s*${recv(esc(a))}\\s*${esc(b)}\\s*[[(]`)]
    : [new RegExp(`^func\\s+${esc(b)}\\s*[[(]`), new RegExp(`^type\\s+${esc(b)}\\b`), new RegExp(`^func\\s*${recv('\\w+')}\\s*${esc(b)}\\s*[[(]`)];
  for (const re of pats) {
    const d = lines.findIndex((l) => re.test(l));
    if (d >= 0) return goBlock(lines, d);
  }
  return undefined;
}

/** From line `d` (0-based): leading `//` comment lines, then to the brace matching the declaration's first `{` at depth 0. */
function goBlock(lines: string[], d: number): LineRange {
  let start = d;
  while (start > 0 && lines[start - 1]!.trimStart().startsWith('//')) start--;
  let paren = 0, brace = 0, opened = false, block = false;
  for (let i = d; i < lines.length; i++) {
    const l = lines[i]!;
    let str: string | null = null;
    for (let j = 0; j < l.length; j++) {
      const c = l[j]!;
      if (block) { if (l.startsWith('*/', j)) { block = false; j++; } continue; }
      if (str) { if (c === '\\' && str !== '`') j++; else if (c === str) str = null; continue; }
      if (l.startsWith('//', j)) break;
      if (l.startsWith('/*', j)) { block = true; j++; continue; }
      if (c === '"' || c === "'" || c === '`') { str = c; continue; }
      if (c === '(' || c === '[') paren++;
      else if (c === ')' || c === ']') paren--;
      else if (c === '{') { if (paren === 0 && !opened) opened = true; if (opened) brace++; }
      else if (c === '}' && opened) { if (--brace === 0) return { start: start + 1, end: i + 1 }; }
    }
    if (!opened && paren <= 0 && i >= d) {
      // no body on the declaration line and nothing open: a one-line declaration (`type ID string`)
      const rest = lines[i + 1]?.trim() ?? '';
      if (!l.trimEnd().endsWith(',') && !l.trimEnd().endsWith('(') && !rest.startsWith('{')) return { start: start + 1, end: i + 1 };
    }
  }
  return { start: start + 1, end: lines.length };
}

/** Lines `start`..`end` of a file as a code excerpt, capped at CODE_MAX_LINES. */
export function excerpt(file: string, src: string, start: number, end: number): MCode {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const code: MCode = { file, start, end, lang: langOf(file), text: '' };
  if (end - start + 1 > CODE_MAX_LINES) { code.end = start + CODE_MAX_LINES - 1; code.truncated = true; }
  code.text = lines.slice(start - 1, code.end).join('\n');
  return code;
}

// ---------------------------------------------------------------- a step's small diagram

/** What a node stands for on a step's diagram: itself and every node under it by `parent` (a type and its methods). */
function under(model: Model): (id: string) => Set<string> {
  const kids = new Map<string, string[]>();
  for (const n of model.nodes) if (n.parent && n.parent !== n.id) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n.id);
  const memo = new Map<string, Set<string>>();
  return (id) => {
    let out = memo.get(id);
    if (out) return out;
    out = new Set([id]);
    for (const q = [id]; q.length;) for (const c of kids.get(q.pop()!) ?? []) if (!out.has(c)) { out.add(c); q.push(c); }
    memo.set(id, out);
    return out;
  };
}

/** The wires of a step's small diagram among its cards (`ids`), one per ordered pair: the model's relationships between
 *  them, and for a card that stands for parts (a type whose methods fold into it on the board) its parts' relationships,
 *  rolled up onto it. Each end of a relationship goes to the closest card that holds it (itself, else its parent, …),
 *  so a step naming two types draws the calls between their methods, and one naming a method draws that method's. */
export function stepWires(model: Model, ids: readonly string[]): { key: string; from: string; to: string }[] {
  const set = new Set(ids);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const holder = (id: string): string | null => {
    for (let cur: string | undefined = id, k = 0; cur && k < 32; cur = byId.get(cur)?.parent, k++) if (set.has(cur)) return cur;
    return null;
  };
  const out = new Map<string, { key: string; from: string; to: string }>();
  for (const e of relations(model)) {
    const a = holder(e.from), b = holder(e.to);
    if (!a || !b || a === b) continue;
    const key = pairKey(a, b);
    if (!out.has(key)) out.set(key, { key, from: a, to: b });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- resolution

const isExpand = (s: AuthoredStep | ExpandStep): s is ExpandStep => typeof (s as ExpandStep).expand === 'string';
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Resolve authored tours against a model and the source files. Returns the built tours and the checks
 *  (`tour-unresolved`: something in a tour no longer matches the code or the recorded runs;
 *  `tour-invalid`: the tour itself is malformed). Nothing throws on drift. */
export function resolveTours(model: Model, tours: AuthoredTour[], readFile: ReadFile): { tours: BuiltTour[]; checks: MCheck[] } {
  const checks: MCheck[] = [];
  const built: BuiltTour[] = [];
  const nodes = new Map(model.nodes.map((n) => [n.id, n]));
  const parts = under(model);
  const files = new Map<string, string | undefined>();
  const read = (f: string) => (files.has(f) ? files.get(f) : (files.set(f, readFile(f)), files.get(f)));

  for (const t of tours) {
    if (!t || typeof t.id !== 'string' || typeof t.title !== 'string' || !Array.isArray(t.steps)) {
      checks.push({ level: 'warn', code: 'tour-invalid', subject: `tour:${t?.id ?? '?'}`, message: `tour ${JSON.stringify(t?.id ?? '?')} needs an id, a title and a steps array.` });
      continue;
    }
    const warn = (where: string, message: string) =>
      checks.push({ level: 'warn', code: 'tour-unresolved', subject: `tour:${t.id}/${where}`, message: `tour "${t.id}" step "${where}": ${message}` });

    let flow: MFlow | undefined;
    if (t.flow) {
      flow = model.flows.find((f) => f.id === t.flow);
      if (!flow) warn('*', `flow "${t.flow}" is not in the model (recorded flows: ${model.flows.map((f) => f.id).join(', ') || 'none'}); steps have no timings.`);
    }
    const spans = flow ? new Spans(flow, parts, (id) => nodes.get(id)?.kind) : undefined;

    const out: BuiltTour = { id: t.id, title: t.title, ...(t.summary ? { summary: t.summary } : {}), ...(t.flow ? { flow: t.flow } : {}), steps: [] };
    const ids = new Set<string>();
    const uniqueId = (id: string) => { let u = id, i = 2; while (ids.has(u)) u = `${id}-${i++}`; ids.add(u); return u; };
    const knownNodes = (where: string, list: (string | undefined)[]) => {
      const res: string[] = [];
      for (const id of list) {
        if (!id || res.includes(id)) continue;
        if (nodes.has(id)) res.push(id); else warn(where, `node "${id}" is not in the model.`);
      }
      return res;
    };
    /** A node's own code: captured by an SDK, or looked up from its ref. The captured copy dates from the
     *  last scan or recording, so it's checked against the file: if the file changed since, the fresh
     *  declaration is used (found by the ref's symbol) and the drift is reported. */
    const nodeCode = (where: string, n: MNode): BuiltCode | undefined => {
      const symbol = n.ref?.symbol ? { symbol: n.ref.symbol } : {};
      if (n.code) {
        const src = read(n.code.file);
        if (src === undefined) return { ...n.code, focus: [], ...symbol }; // source not here: trust the capture
        const now = src.replace(/\r\n/g, '\n').split('\n').slice(n.code.start - 1, n.code.end).join('\n');
        if (now === n.code.text) return { ...n.code, focus: [], ...symbol };
        const fresh = n.ref?.symbol && findSymbol(src, n.ref.symbol, langOf(n.code.file));
        warn(where, `${n.id}'s code in the model (${n.code.file}:${n.code.start}–${n.code.end}) no longer matches the file; ` +
          (fresh ? 'using the current source. Re-run the scan to refresh the model.' : 'showing the captured copy. Re-run the scan.'));
        return fresh ? { ...excerpt(n.code.file, src, fresh.start, fresh.end), focus: [], ...symbol } : { ...n.code, focus: [], ...symbol };
      }
      if (n.ref?.file && n.ref.symbol) return lookup(where, n.ref.file, n.ref.symbol);
      return undefined;
    };
    const lookup = (where: string, file: string, symbol: string): BuiltCode | undefined => {
      const src = read(file);
      if (src === undefined) { warn(where, `file ${file} can't be read.`); return undefined; }
      const lang = langOf(file);
      const r = findSymbol(src, symbol, lang);
      if (!r) { warn(where, `symbol ${symbol} not found in ${file}${lang === 'python' || lang === 'go' ? '' : ` (symbol lookup supports Python and Go, not ${lang})`}.`); return undefined; }
      return { ...excerpt(file, src, r.start, r.end), focus: [], symbol };
    };

    for (const [i, raw] of t.steps.entries()) {
      if (raw && isExpand(raw)) {
        const where = `expand ${raw.expand}`;
        const parent = nodes.get(raw.expand);
        if (!parent) { warn(where, `node "${raw.expand}" is not in the model.`); continue; }
        // one step per declared relationship that includes `calls` (a pair declared calls AND reads is one callee)
        const callees = relations(model).filter((e) => e.from === raw.expand && kindsOf(e).includes('calls') && e.sources.includes('declared')).map((e) => e.to);
        if (!callees.length) warn(where, `${raw.expand} declares no calls to expand.`);
        for (const cid of callees) {
          const callee = nodes.get(cid);
          if (!callee) { warn(where, `declared callee "${cid}" is not in the model.`); continue; }
          const step: BuiltStep = { id: uniqueId(cid), title: callee.label ?? cid, node: cid, show: knownNodes(where, [raw.expand, cid, ...(raw.show ?? [])]), source: 'expanded' };
          if (raw.group) step.group = raw.group;
          if (callee.summary) step.text = callee.summary;
          const code = nodeCode(`${where} → ${cid}`, callee);
          if (code) step.code = code;
          if (spans) {
            const timing = spans.callee(raw.expand, cid, t.request);
            if (timing) step.timing = timing; else warn(`${where} → ${cid}`, `flow "${t.flow}" has no recorded span of ${cid}${t.request ? ` in request ${t.request}` : ''}.`);
          }
          out.steps.push(step);
        }
        continue;
      }
      const s = raw as AuthoredStep;
      if (!s || typeof s.id !== 'string' || typeof s.title !== 'string') {
        checks.push({ level: 'warn', code: 'tour-invalid', subject: `tour:${t.id}/#${i + 1}`, message: `tour "${t.id}" step ${i + 1} needs an id and a title (or "expand": "<node id>").` });
        continue;
      }
      const where = s.id;
      const before = checks.length;
      const node = s.node ? nodes.get(s.node) : undefined;
      if (s.node && !node) warn(where, `node "${s.node}" is not in the model.`);
      const step: BuiltStep = { id: uniqueId(s.id), title: s.title, show: knownNodes(where, [node?.id, ...(s.show ?? [])]), source: 'authored' };
      if (s.group) step.group = s.group;
      if (s.text) step.text = s.text;
      if (node) step.node = node.id;

      // ---- code (strict: read from the source now)
      let code: BuiltCode | undefined;
      if (!s.code) code = node ? nodeCode(where, node) : undefined;
      else {
        const file = s.code.file ?? node?.code?.file ?? node?.ref?.file;
        if (!file) warn(where, `code ${s.code.symbol ?? ''} has no file: give "file", or a node with code.`);
        else if (s.code.lines) {
          const [a, b] = s.code.lines;
          const src = read(file);
          const n = src?.split('\n').length ?? 0;
          if (src === undefined) warn(where, `file ${file} can't be read.`);
          else if (!(a >= 1 && b >= a && b <= n)) warn(where, `lines ${a}–${b} are outside ${file} (${n} lines).`);
          else code = { ...excerpt(file, src, a, b), focus: [], ...(s.code.symbol ? { symbol: s.code.symbol } : {}) };
        } else if (s.code.symbol) code = lookup(where, file, s.code.symbol);
        else warn(where, `code needs "symbol" or "lines".`);
      }
      if (code && s.focus?.length) {
        const lines = code.text.split('\n');
        const hit = new Set<number>();
        for (const f of s.focus) {
          const found = lines.flatMap((l, k) => (l.includes(f) ? [code!.start + k] : []));
          if (!found.length) warn(where, `focus "${f}" matches no line of ${code.symbol ?? code.file}.`);
          found.forEach((x) => hit.add(x));
        }
        code.focus = [...hit].sort((x, y) => x - y);
      } else if (!code && s.focus?.length && checks.length === before) warn(where, `focus given but the step has no code.`);
      if (code) step.code = code;

      // ---- timing (strict: from recorded spans)
      if (s.span) {
        if (!spans) { if (!t.flow) warn(where, `span given but the tour has no "flow".`); }
        else {
          const r = spans.match(s.span, node?.id, t.request);
          if (r.error) warn(where, r.error);
          else if (r.timing) step.timing = r.timing;
        }
      }
      out.steps.push(step);
    }
    built.push(out);
  }
  return { tours: built, checks };
}

/** Span lookups within one recorded flow. */
class Spans {
  readonly roots: MSpan[];
  private byId: Map<string, MSpan>;
  /** `parts(id)`: a node and the nodes under it (a type's methods): a step or selector naming a type card is timed by its methods' spans. */
  constructor(readonly flow: MFlow, private parts: (id: string) => Set<string> = (id) => new Set([id]), kind: (id: string) => string | undefined = () => undefined) {
    this.byId = new Map(flow.spans.map((s) => [s.id, s]));
    // the requests: root spans, but not a bare construction (a span of a type with nothing under it: a test building
    // the app object or a record before it calls in), which is no request
    const parents = new Set(flow.spans.map((s) => s.parent).filter((p): p is string => !!p));
    this.roots = flow.spans.filter((s) => (!s.parent || !this.byId.has(s.parent)) && !(kind(s.node) === 'type' && !parents.has(s.id))).sort((a, b) => a.start - b.start);
  }
  private ancestors(s: MSpan): MSpan[] {
    const out: MSpan[] = [];
    for (let p = s.parent ? this.byId.get(s.parent) : undefined; p; p = p.parent ? this.byId.get(p.parent) : undefined) out.push(p);
    return out;
  }
  /** The spans of request `n` (1-based root span, with everything under it), or all spans. */
  private scope(n: number | undefined): MSpan[] | string {
    if (!n) return this.flow.spans;
    const root = this.roots[n - 1];
    if (!root) return `flow "${this.flow.id}" has ${this.roots.length} requests; there is no request ${n}.`;
    return this.flow.spans.filter((s) => s === root || this.ancestors(s).includes(root));
  }
  /** Drop spans nested in another matched span, so a duration is never counted twice. */
  private outermost(m: MSpan[]): MSpan[] {
    const set = new Set(m);
    return m.filter((s) => !this.ancestors(s).some((a) => set.has(a)));
  }
  match(sel: TourSpanRef | TourSpanRef[], stepNode: string | undefined, request: number | undefined): { timing?: BuiltTiming; error?: string } {
    const matched = new Set<MSpan>();
    for (const q of Array.isArray(sel) ? sel : [sel]) {
      const pool = this.scope(q.request ?? request);
      if (typeof pool === 'string') return { error: pool };
      let m: MSpan[];
      if (q.label !== undefined || q.node !== undefined) {
        const qn = q.node !== undefined ? this.parts(q.node) : null;
        m = pool.filter((s) => (q.label === undefined || s.label === q.label) && (qn === null || qn.has(s.node)));
        // a label names a request and the calls it made under the same name: prefer the step's own node (and its parts)
        if (q.node === undefined && stepNode) { const sn = this.parts(stepNode), own = m.filter((s) => sn.has(s.node)); if (own.length) m = own; }
      } else if (stepNode) { const sn = this.parts(stepNode); m = pool.filter((s) => sn.has(s.node)); }
      else if (q.request ?? request) m = [this.roots[(q.request ?? request)! - 1]!];
      else return { error: 'span selector is empty: give "label", "node" or "request".' };
      if (!m.length) return { error: `no recorded span in flow "${this.flow.id}" matches ${JSON.stringify(q)}${request && !q.request ? ` in request ${request}` : ''}.` };
      m.forEach((s) => matched.add(s));
    }
    return { timing: timing(this.outermost([...matched].sort((a, b) => a.start - b.start))) };
  }
  /** Spans of `callee` under a span of `parent` (or anywhere in scope, if it never ran under it). */
  callee(parent: string, callee: string, request: number | undefined): BuiltTiming | undefined {
    const pool = this.scope(request);
    if (typeof pool === 'string') return undefined;
    const all = pool.filter((s) => s.node === callee);
    const under = all.filter((s) => this.ancestors(s).some((a) => a.node === parent));
    const m = this.outermost(under.length ? under : all);
    return m.length ? timing(m) : undefined;
  }
}

function timing(spans: MSpan[]): BuiltTiming {
  const ms = round3(spans.reduce((acc, s) => acc + ((s.end ?? s.start) - s.start) / 1e6, 0));
  const labels = [...new Set(spans.map((s) => s.label ?? s.node))];
  const attrs = Object.assign({}, ...spans.map((s) => s.attrs ?? {})) as Record<string, unknown>;
  return {
    ms, label: labels.join(', '), status: spans.some((s) => s.status === 'error') ? 'error' : 'ok', spans: spans.length,
    ...(Object.keys(attrs).length ? { attrs } : {}),
  };
}
