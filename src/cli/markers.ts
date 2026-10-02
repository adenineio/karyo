// Comment markers: Karyo directives written as `// karyo:` (or `//karyo:`) comments in any language whose line
// comments start with `//`. The same grammar as the Go SDK's `//karyo:` and the Python SDK's `# karyo:`:
//
//   // karyo:node id=billing.charge kind=service label="Charge card" category=api tags=money calls=billing.ledger
//   //   calls=billing.fraud                       (a `//` and three or more spaces continues the line above)
//   // karyo:external id=card.network label="Card network" category=outside
//   // karyo:edge from=billing.ledger to=billing.db kind=writes
//
// Verbs node, external, edge. Values are bare words or "double-quoted"; lists are comma-separated, and a list key
// (tags, calls, reads, writes, publishes) may repeat: its values add up. Anything malformed (an unknown verb or key, a
// bad id or kind, a missing id, a key given twice, a directive after code on the same line) is a `directive-invalid`
// warning and is ignored, never half-applied. A target that no marker declares, and an id declared twice, are warned
// about too. Only real comments count: text inside strings and block comments never does.
//
// Nothing is compiled or run: each file is read line by line. A `node` marker records the declaration directly below
// it (other comment lines and attribute lines may sit between, a blank line may not) when the language's pattern
// finds one: its name (qualified by the types around it), its line, and its source as the node's code. Languages are
// entries in LANGS (extensions, a declaration pattern, how a file maps to a module); nothing else here knows one.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- languages

export interface Decl { name: string; container: boolean }
export interface MarkerLang {
  /** The model's `lang`, and the code excerpt's. */
  lang: string;
  exts: string[];
  /** A declaration on this line (comments and strings already blanked), or null. */
  decl: (code: string) => Decl | null;
  /** A line that may sit between a marker and its declaration (an attribute or annotation on a line of its own). */
  attribute?: RegExp;
  /** String delimiters: single-line quotes, and the multi-line one (if the language has it). */
  quotes: string[];
  multiline?: string;
  /** Block comments nest (Swift: yes; C, Objective-C, TypeScript: no). */
  nestedBlocks?: boolean;
  /** The module a file belongs to (its path relative to the project); by default the file's folder. */
  module?: (rel: string) => string | undefined;
}

const SWIFT_MOD = String.raw`(?:@[A-Za-z_][\w.]*(?:\([^)]*\))?\s+|(?:public|private|internal|fileprivate|open|package|final|static|class|override|nonisolated|isolated|mutating|nonmutating|indirect|lazy|weak|unowned|required|convenience|dynamic|distributed|optional|async)(?:\([^)]*\))?\s+)*`;
const SWIFT_DECL = new RegExp(String.raw`^\s*${SWIFT_MOD}(class|struct|enum|actor|protocol|extension|func|var|let|init|typealias)\b\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?`);
const SWIFT_CONTAINERS = new Set(['class', 'struct', 'enum', 'actor', 'protocol', 'extension']);

export const SWIFT: MarkerLang = {
  lang: 'swift',
  exts: ['.swift'],
  decl(code) {
    const m = SWIFT_DECL.exec(code);
    if (!m) return null;
    const name = m[1] === 'init' ? 'init' : m[2];
    return name ? { name, container: SWIFT_CONTAINERS.has(m[1]!) } : null;
  },
  attribute: /^\s*@[A-Za-z_][\w.]*(?:\(.*\))?\s*$/,
  quotes: ['"'],
  multiline: '"""',
  nestedBlocks: true,
  // a Swift package keeps each target's sources in Sources/<Target>/ (tests in Tests/<Target>/)
  module(rel) {
    const p = rel.split('/');
    return (p[0] === 'Sources' || p[0] === 'Tests') && p.length > 2 ? p[1] : undefined;
  },
};

/** Languages read for markers, by extension. Add an entry for another `//` language. */
export const LANGS: MarkerLang[] = [SWIFT];
export const langByName = (name: string) => LANGS.find((l) => l.lang === name);

// ---------------------------------------------------------------- the grammar (shared with the Go and Python SDKs)

export const NODE_KINDS = ['service', 'function', 'type', 'store', 'queue', 'external', 'actor', 'module'];
export const EDGE_KINDS = ['calls', 'reads', 'writes', 'publishes', 'subscribes', 'imports'];
export const KEYS: Record<string, string[]> = {
  node: ['id', 'kind', 'label', 'summary', 'group', 'category', 'tags', 'calls', 'reads', 'writes', 'publishes'],
  external: ['id', 'kind', 'label', 'summary', 'group', 'category', 'tags'],
  edge: ['from', 'to', 'kind', 'label'],
};
const LIST_KEYS = ['tags', 'calls', 'reads', 'writes', 'publishes'];
const EDGE_KEYS = ['calls', 'reads', 'writes', 'publishes'];
const ID_KEYS = ['id', 'from', 'to'];
export const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$/;
const DIRECTIVE = /^\/\/ ?karyo:(\S*)(.*)$/;
const CONTINUE = /^\/\/\s{3,}(\S.*)$/;

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length]!;
}
/** The nearest option, when it is close enough to read as a typo. */
function nearest(word: string, options: string[]): string | null {
  let best: string | null = null, bd = Infinity;
  for (const o of options) { const d = editDistance(word, o); if (d < bd) { bd = d; best = o; } }
  return best !== null && (bd <= 1 || (bd === 2 && best.length >= 5) || (bd <= 3 && best.length >= 9)) ? best : null;
}
const suggest = (word: string, options: string[]) => { const n = nearest(word, options); return n ? ` (did you mean '${n}'?)` : ''; };

/** A node kind a kit adds (docs/KITS.md): any other lowercase word, unless it reads as a typo of a built-in kind. */
export function isKitKind(k: string): boolean {
  if (!/^[a-z][a-z0-9-]*$/.test(k)) return false;
  return !NODE_KINDS.some((b) => { const d = editDistance(k, b); return d <= 1 || (d === 2 && b.length >= 6); });
}

/** `a=b c="d e" f=g,h`: list keys given twice add up; anything else given twice, and anything unreadable, is an error. */
export function parseKV(text: string): { kv: Record<string, string>; errors: string[] } {
  const kv: Record<string, string> = {};
  const errors: string[] = [];
  let i = 0;
  const n = text.length;
  const KEY = /[A-Za-z_][A-Za-z0-9_-]*=/y;
  while (true) {
    while (i < n && /\s/.test(text[i]!)) i++;
    if (i >= n) break;
    KEY.lastIndex = i;
    const m = KEY.exec(text);
    if (!m) {
      let j = i;
      while (j < n && !/\s/.test(text[j]!)) j++;
      errors.push(`expected key=value, got '${text.slice(i, j)}'`);
      i = j;
      continue;
    }
    const key = m[0].slice(0, -1);
    i = KEY.lastIndex;
    let val = '';
    if (text[i] === '"') {
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) i++;
        val += text[i];
        i++;
      }
      if (i >= n) errors.push(`${key}: unterminated quote`);
      i++;
    } else {
      let j = i;
      while (j < n && !/\s/.test(text[j]!)) j++;
      val = text.slice(i, j);
      i = j;
    }
    if (key in kv && LIST_KEYS.includes(key)) { kv[key] = `${kv[key]},${val}`; continue; }
    if (key in kv) errors.push(`${key} given twice`);
    kv[key] = val;
  }
  return { kv, errors };
}

export const splitList = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Check one directive's keys and values: the errors, none when it is well formed. */
export function validate(verb: string, kv: Record<string, string>): string[] {
  const allowed = KEYS[verb];
  if (!allowed) return [`unknown directive karyo:${verb}${suggest(verb, Object.keys(KEYS))} (one of ${Object.keys(KEYS).join(', ')})`];
  const errors: string[] = [];
  for (const [k, v] of Object.entries(kv)) {
    if (!allowed.includes(k)) { errors.push(`karyo:${verb} has no key '${k}'${suggest(k, allowed)} (keys: ${allowed.join(', ')})`); continue; }
    if (LIST_KEYS.includes(k)) {
      for (const x of splitList(v)) if (!ID_RE.test(x)) errors.push(`${k}: '${x}' is not a valid ${EDGE_KEYS.includes(k) ? 'node id' : 'tag'}`);
    } else if (ID_KEYS.includes(k)) {
      if (!ID_RE.test(v)) errors.push(`${k}: '${v}' is not a valid node id (letters, digits and _ . : / -)`);
    } else if (k === 'kind') {
      const edge = verb === 'edge';
      const kinds = edge ? EDGE_KINDS : NODE_KINDS;
      if (!kinds.includes(v) && (edge || !isKitKind(v))) errors.push(`kind: '${v}' is not ${edge ? 'an edge' : 'a node'} kind${suggest(v, kinds)} (one of ${kinds.join(', ')})`);
    } else if (k === 'category') {
      if (!ID_RE.test(v)) errors.push(`category: '${v}' is not a single word`);
    } else if (!v) errors.push(`${k} is empty`);
  }
  if (verb === 'edge') { if (!kv.from || !kv.to) errors.push('karyo:edge needs from= and to='); }
  else if (!kv.id) errors.push(`karyo:${verb} needs id=`);
  return errors;
}

// ---------------------------------------------------------------- reading one file

interface Line {
  text: string;
  /** The line with comments and strings blanked out. */
  code: string;
  /** A `//` comment on this line: where it starts, and its text. */
  comment: { col: number; text: string } | null;
  /** The line began inside a block comment or a multi-line string. */
  inside: boolean;
}

/** Split a source into lines, telling code from comments and strings. */
function lex(source: string, L: MarkerLang): Line[] {
  const out: Line[] = [];
  let block = 0, multi = false;
  for (const s of source.replace(/\r\n?/g, '\n').split('\n')) {
    const inside = block > 0 || multi;
    let code = '', comment: Line['comment'] = null, i = 0;
    while (i < s.length) {
      if (block > 0) {
        if (s.startsWith('*/', i)) { block--; i += 2; code += '  '; continue; }
        if (L.nestedBlocks && s.startsWith('/*', i)) { block++; i += 2; code += '  '; continue; }
        code += ' '; i++; continue;
      }
      if (multi) {
        if (s.startsWith(L.multiline!, i)) { multi = false; i += L.multiline!.length; code += ' '.repeat(L.multiline!.length); continue; }
        if (s[i] === '\\') { code += '  '; i += 2; continue; }
        code += ' '; i++; continue;
      }
      if (s.startsWith('//', i)) { comment = { col: i, text: s.slice(i) }; break; }
      if (s.startsWith('/*', i)) { block = 1; i += 2; code += '  '; continue; }
      if (L.multiline && s.startsWith(L.multiline, i)) { multi = true; i += L.multiline.length; code += ' '.repeat(L.multiline.length); continue; }
      const q = s[i]!;
      if (L.quotes.includes(q)) {
        code += ' '; i++;
        while (i < s.length && s[i] !== q) { if (s[i] === '\\') { code += ' '; i++; } code += ' '; i++; }
        code += ' '; i++;
        continue;
      }
      code += q; i++;
    }
    out.push({ text: s, code, comment, inside });
  }
  return out;
}

const isFullComment = (l: Line | undefined) => !!l && !l.inside && !!l.comment && !l.code.trim();
const isBlank = (l: Line | undefined) => !!l && !l.inside && !l.comment && !l.code.trim();

/** The line (0-based) where the block opened at or after line i closes; null when no `{` opens one near i. */
function blockEnd(lines: Line[], i: number, L: MarkerLang): number | null {
  let depth = 0, open = false;
  for (let j = i; j < lines.length; j++) {
    // a body opens on the declaration's line or soon after it: not past a blank line or the next declaration
    if (!open && j > i && (isBlank(lines[j]) || j - i > 6 || L.decl(lines[j]!.code))) return null;
    for (const c of lines[j]!.code) {
      if (c === '{') { depth++; open = true; }
      else if (c === '}') { if (!open) return null; depth--; if (depth === 0) return j; }
    }
  }
  return null;
}

export interface Directive {
  verb: string;
  kv: Record<string, string>;
  /** 1-based: the marker's first and last line (continuations included). */
  line: number;
  end: number;
  /** node: the declaration below it, when the language's pattern finds one. */
  decl?: { line: number; name: string; symbol: string; start: number; end: number };
  summary?: string;
}
export interface Problem { file: string; line: number; message: string }
export interface ParsedFile { directives: Directive[]; problems: Problem[]; lines: string[] }

const CODE_MAX_LINES = 80;

/** Every marker in one source file, validated, with the declaration each `node` marker sits on. */
export function readMarkers(source: string, file: string, L: MarkerLang): ParsedFile {
  const lines = lex(source, L);
  const out: ParsedFile = { directives: [], problems: [], lines: lines.map((l) => l.text) };
  // the types (containers) each line sits in, for qualified names
  const containers: { name: string; start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const d = L.decl(lines[i]!.code);
    if (!d?.container) continue;
    const end = blockEnd(lines, i, L);
    if (end !== null) containers.push({ name: d.name, start: i, end });
  }
  const qualified = (i: number, name: string) =>
    [...containers.filter((c) => c.start < i && i <= c.end).map((c) => c.name), name].join('.');

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.comment || l.inside) continue;
    const m = DIRECTIVE.exec(l.comment.text);
    if (!m) continue;
    if (l.code.trim()) { out.problems.push({ file, line: i + 1, message: 'a karyo: directive must be a comment on its own line' }); continue; }
    let rest = m[2]!, end = i;
    while (isFullComment(lines[end + 1])) {
      const t = lines[end + 1]!.comment!.text;
      const c = CONTINUE.exec(t);
      if (!c || DIRECTIVE.test(t)) break;
      rest += ' ' + c[1];
      end++;
    }
    const verb = m[1]!;
    const { kv, errors } = parseKV(rest);
    errors.push(...validate(verb, kv));
    const d: Directive = { verb, kv, line: i + 1, end: end + 1 };
    if (verb === 'node' && !errors.length) {
      // the declaration: past other comment lines and attribute lines, no blank line between
      let j = end + 1;
      while (j < lines.length && (isFullComment(lines[j]) || (L.attribute && !lines[j]!.inside && L.attribute.test(lines[j]!.code)))) j++;
      const decl = j < lines.length && !lines[j]!.inside ? L.decl(lines[j]!.code) : null;
      if (decl) {
        let top = i;
        while (top > 0 && isFullComment(lines[top - 1])) top--;
        const close = blockEnd(lines, j, L) ?? j;
        d.decl = { line: j + 1, name: decl.name, symbol: qualified(j, decl.name), start: top + 1, end: close + 1 };
        // a doc line from the comments above the declaration (not a marker, its continuations, or a MARK / TODO)
        for (let k = top; k < j; k++) {
          const t = lines[k]!.comment?.text;
          if (!t || DIRECTIVE.test(t) || CONTINUE.test(t)) continue;
          const s = t.replace(/^\/\/\/?\s?/, '').trim();
          if (s && !/^(MARK|TODO|FIXME|NOTE)\b/.test(s) && !s.startsWith('-')) { d.summary = s; break; }
        }
      }
    }
    for (const e of errors) out.problems.push({ file, line: i + 1, message: e });
    if (!errors.length) out.directives.push(d);
    i = end;
  }
  return out;
}

// ---------------------------------------------------------------- a project

export interface MarkerCheck { level: 'warn'; code: string; subject: string; message: string }
export interface MarkerScan {
  fragment: {
    karyo: 1;
    producers: { name: string; lang: string; version?: string; at?: string }[];
    nodes: Record<string, unknown>[];
    edges: { from: string; to: string; kind: string; label?: string; sources: string[] }[];
    flows: [];
    checks?: MarkerCheck[];
  };
  /** Files read, and markers found (well formed or not), by language. */
  files: number;
  markers: number;
  byLang: Record<string, { files: number; markers: number }>;
}

/** Folders never read: dependencies, build output, caches, and every dot-folder (.git, .build, .swiftpm …). */
export const SKIP_DIRS = new Set(['node_modules', 'DerivedData', 'Pods', 'Carthage', 'build', 'dist', 'out', 'vendor', 'target', '__pycache__']);

/** The project's source files in the given languages, sorted, relative to `root`. */
export function sourceFiles(root: string, langs: MarkerLang[] = LANGS): string[] {
  const exts = new Set(langs.flatMap((l) => l.exts));
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.') || SKIP_DIRS.has(n)) continue;
      const f = path.join(dir, n);
      let st; try { st = statSync(f); } catch { continue; }
      if (st.isDirectory()) { if (!n.endsWith('.xcodeproj') && !n.endsWith('.xcworkspace')) walk(f, depth + 1); }
      else if (exts.has(path.extname(n))) out.push(path.relative(root, f).split(path.sep).join('/'));
    }
  };
  walk(root, 0);
  return out.sort();
}

const langOf = (rel: string, langs: MarkerLang[]) => langs.find((l) => l.exts.includes(path.extname(rel)));
const MARKER_LINE = /^\s*\/\/ ?karyo:/m;

/** How many marker lines the given files hold (a quick count for `karyo init`; not validated). */
export function countMarkers(root: string, files: string[]): { files: number; markers: number } {
  let markers = 0, withMarkers = 0;
  for (const f of files) {
    let t: string; try { t = readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    if (!MARKER_LINE.test(t)) continue;
    const n = t.split('\n').filter((l) => MARKER_LINE.test(l)).length;
    markers += n;
    withMarkers++;
  }
  return { files: withMarkers, markers };
}

/** Read every marker under `root` into one model fragment (source: declared), with the warnings in its checks. */
export function scanMarkers(root: string, o: { langs?: MarkerLang[]; files?: string[]; version?: string; at?: string } = {}): MarkerScan {
  const langs = o.langs ?? LANGS;
  const files = o.files ?? sourceFiles(root, langs);
  const checks: MarkerCheck[] = [];
  const warn = (code: string, file: string, line: number, msg: string) => {
    const subject = `${file}:${line}`;
    checks.push({ level: 'warn', code, subject, message: `${subject}: ${msg}` });
  };
  const nodes = new Map<string, Record<string, unknown>>();
  const declaredAt = new Map<string, string>();
  const edges = new Map<string, MarkerScan['fragment']['edges'][number]>();
  const targets: { id: string; file: string; line: number; key: string }[] = [];
  const byLang: MarkerScan['byLang'] = {};
  let markers = 0;
  const addEdge = (from: string, to: string, kind: string, label?: string) => {
    const k = `${from}\u0000${to}\u0000${kind}`;
    const e = edges.get(k);
    if (e) { if (!e.label && label) e.label = label; return; }
    edges.set(k, { from, to, kind, ...(label ? { label } : {}), sources: ['declared'] });
  };

  for (const rel of files) {
    const L = langOf(rel, langs);
    if (!L) continue;
    let source: string;
    try { source = readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    const tally = (byLang[L.lang] ??= { files: 0, markers: 0 });
    tally.files++;
    if (!source.includes('karyo:')) continue;
    const p = readMarkers(source, rel, L);
    const found = p.directives.length + new Set(p.problems.map((x) => x.line)).size;
    tally.markers += found;
    markers += found;
    for (const pr of p.problems) warn('directive-invalid', pr.file, pr.line, pr.message);
    for (const d of p.directives) {
      const kv = d.kv;
      if (d.verb === 'node' || d.verb === 'external') {
        const id = kv.id!;
        const n: Record<string, unknown> = {
          id, kind: kv.kind || (d.verb === 'node' ? 'function' : 'external'),
          label: kv.label || (d.verb === 'node' && d.decl ? d.decl.name : id),
          summary: kv.summary || d.summary, group: kv.group || id.split('.')[0],
          category: kv.category, tags: splitList(kv.tags).length ? splitList(kv.tags) : undefined,
        };
        if (d.verb === 'node') {
          const at = declaredAt.get(id);
          if (at) { warn('directive-invalid', rel, d.line, `node ${id} is declared twice (also at ${at}); the first one is kept`); continue; }
          declaredAt.set(id, `${rel}:${d.line}`);
          n.module = L.module?.(rel) ?? (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : undefined);
          n.lang = L.lang;
          n.ref = d.decl ? { file: rel, line: d.decl.line, symbol: d.decl.symbol } : { file: rel, line: d.line };
          if (d.decl) {
            let end = d.decl.end, truncated = false;
            if (end - d.decl.start + 1 > CODE_MAX_LINES) { end = d.decl.start + CODE_MAX_LINES - 1; truncated = true; }
            n.code = { file: rel, start: d.decl.start, end, lang: L.lang, text: p.lines.slice(d.decl.start - 1, end).join('\n'), ...(truncated ? { truncated } : {}) };
          }
          n.sources = ['declared'];
          nodes.set(id, n);
          for (const k of EDGE_KEYS) for (const t of splitList(kv[k])) { addEdge(id, t, k); targets.push({ id: t, file: rel, line: d.line, key: `${k}=` }); }
        } else {
          n.sources = ['declared'];
          // a node declared in code wins over an external of the same id
          if (!nodes.has(id)) nodes.set(id, n);
        }
      } else if (d.verb === 'edge') {
        addEdge(kv.from!, kv.to!, kv.kind || 'calls', kv.label);
        targets.push({ id: kv.from!, file: rel, line: d.line, key: 'from=' }, { id: kv.to!, file: rel, line: d.line, key: 'to=' });
      }
    }
  }
  // a target no marker declares: a typo, or a part nobody marked yet
  const known = [...nodes.keys()];
  for (const t of targets) {
    if (nodes.has(t.id)) continue;
    warn('directive-unknown-target', t.file, t.line, `${t.key}${t.id} names a node no marker declares${suggest(t.id, known)}; mark it (karyo:node, or karyo:external for something outside)`);
  }

  const clean = (n: Record<string, unknown>) => Object.fromEntries(Object.entries(n).filter(([, v]) => v !== undefined && v !== ''));
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const fragment: MarkerScan['fragment'] = {
    karyo: 1,
    producers: Object.keys(byLang).sort().map((lang) => ({ name: 'karyo markers', lang, ...(o.version ? { version: o.version } : {}), ...(o.at ? { at: o.at } : {}) })),
    nodes: [...nodes.values()].map(clean).sort((a, b) => cmp(String(a.id), String(b.id))),
    edges: [...edges.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind)),
    flows: [],
    ...(checks.length ? { checks } : {}),
  };
  return { fragment, files: Object.values(byLang).reduce((s, x) => s + x.files, 0), markers, byLang };
}
