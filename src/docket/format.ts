// The docket file: parse and format, pure (no fs, no git). docs/DOCKET.md describes the format.
//
// The Markdown file is the source of truth and people edit it by hand, so the parser is tolerant and
// the formatter is conservative: a docket is a flat list of nodes (a plain line, or an item), and an
// item that no command touched is written back from its original lines, byte for byte. Unknown
// lines, unknown sections, prose and the order of items all survive a rewrite untouched.

export type Kind = 'decision' | 'review' | 'later';
export const KINDS: Kind[] = ['decision', 'review', 'later'];
export const SECTION: Record<Kind | 'closed', string> = {
  decision: 'Needs a decision',
  review: 'To review',
  later: 'Come back to',
  closed: 'Closed',
};
const ORDER: (Kind | 'closed')[] = ['decision', 'review', 'later', 'closed'];

export type Item = {
  n: number;
  done: boolean;
  summary: string;
  /** closed items: the resolution, date and who closed it */
  resolution?: string;
  closed?: string;
  closedSession?: string;
  /** metadata line, known keys */
  kind?: Kind; // written only on closed items (so reopen knows where to go); open items take their section's
  before?: string;
  from?: string; // "<branch> @ <sha>" or "<sha>"
  worktree?: string;
  session?: string;
  ref?: string;
  date?: string;
  /** metadata keys this version doesn't know, kept in order */
  extra: [string, string][];
  why?: string;
  /** any other continuation lines under the item, kept verbatim */
  notes: string[];
  /** the item's lines as read; dropped when a command changes the item, which then gets re-formatted */
  raw?: string[];
};

export type Node = { t: 'line'; text: string } | { t: 'item'; item: Item };
export type Docket = { nodes: Node[]; trailingNewline: boolean };

const ITEM_RE = /^[-*+] \[( |x|X)\] \*\*D-(\d+)\*\*\s?(.*)$/;
const HEADING_RE = /^##\s+(.*?)\s*#*\s*$/;
const CLOSED_TAIL_RE = /^(.*) · closed (\d{4}-\d{2}-\d{2})(?: · session: (.+))?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KNOWN_META = new Set(['kind', 'before', 'from', 'worktree', 'session', 'ref']);

// ---------------------------------------------------------------- new file

export function emptyDocket(o: { name: string; root: string }): string {
  return [
    `# Docket · ${o.name}`,
    `<!-- karyo docket · repo root ${o.root} · edit freely; keep the **D-n** ids -->`,
    '',
    'Milestones: none yet (write anything here: names, dates, what each one means)',
    '',
    `## ${SECTION.decision}`,
    '',
    `## ${SECTION.review}`,
    '',
    `## ${SECTION.later}`,
    '',
    `## ${SECTION.closed}`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- parse

export function parse(md: string): Docket {
  const trailingNewline = md.endsWith('\n');
  const lines = (trailingNewline ? md.slice(0, -1) : md).split('\n');
  if (md === '') lines.length = 0;
  const nodes: Node[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : ITEM_RE.exec(line);
    if (!m) { nodes.push({ t: 'line', text: line }); continue; }
    const raw = [line];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) raw.push(lines[++i]!);
    nodes.push({ t: 'item', item: parseItem(raw) });
  }
  return { nodes, trailingNewline };
}

export function parseItem(raw: string[]): Item {
  const m = ITEM_RE.exec(raw[0]!)!;
  const item: Item = { n: +m[2]!, done: m[1] !== ' ', summary: m[3]!.trim(), extra: [], notes: [], raw };
  if (item.done) {
    const c = CLOSED_TAIL_RE.exec(item.summary);
    if (c) {
      item.closed = c[2];
      if (c[3]) item.closedSession = c[3].trim();
      const head = c[1]!;
      const cut = head.lastIndexOf(' — ');
      if (cut >= 0) { item.summary = head.slice(0, cut).trim(); item.resolution = head.slice(cut + 3).trim(); }
      else item.summary = head.trim();
    }
  }
  let sawMeta = false;
  for (const line of raw.slice(1)) {
    const t = line.trim();
    const why = /^>\s*Why:\s*(.*)$/i.exec(t);
    if (why && item.why === undefined) { item.why = why[1]!; continue; }
    if (!sawMeta && isMetaLine(t)) { sawMeta = true; readMeta(item, t); continue; }
    item.notes.push(line);
  }
  return item;
}

function isMetaLine(t: string): boolean {
  const parts = t.split(' · ');
  return parts.every((p) => DATE_RE.test(p.trim()) || /^[a-z][a-z0-9_-]*:\s/i.test(p.trim() + ' ')) &&
    parts.some((p) => DATE_RE.test(p.trim()) || KNOWN_META.has(p.trim().split(':')[0]!.toLowerCase()));
}

function readMeta(item: Item, t: string) {
  for (const part of t.split(' · ').map((p) => p.trim())) {
    if (DATE_RE.test(part)) { item.date = part; continue; }
    const k = part.slice(0, part.indexOf(':')).trim().toLowerCase();
    const v = part.slice(part.indexOf(':') + 1).trim();
    if (k === 'kind' && (KINDS as string[]).includes(v)) item.kind = v as Kind;
    else if (k === 'before' || k === 'from' || k === 'worktree' || k === 'session' || k === 'ref') item[k] = v;
    else item.extra.push([part.slice(0, part.indexOf(':')).trim(), v]);
  }
}

// ---------------------------------------------------------------- format

/** One-line text: newlines and runs of blanks become one space; the field separator " · " can't appear inside. */
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const field = (s: string) => oneLine(s).replace(/ · /g, ' / ');

export function formatItem(it: Item): string[] {
  if (it.raw) return it.raw;
  let head = `- [${it.done ? 'x' : ' '}] **D-${it.n}** ${oneLine(it.summary)}`;
  if (it.done) {
    // The resolution follows the last " — " on the line, so it can't hold one itself.
    if (it.resolution) head += ` — ${oneLine(it.resolution).replace(/ — /g, ' – ')}`;
    head += ` · closed ${it.closed ?? ''}`.trimEnd();
    if (it.closedSession) head += ` · session: ${field(it.closedSession)}`;
  }
  const meta: string[] = [];
  if (it.done && it.kind) meta.push(`kind: ${it.kind}`);
  if (it.before) meta.push(`before: ${field(it.before)}`);
  if (it.from) meta.push(`from: ${field(it.from)}`);
  if (it.worktree) meta.push(`worktree: ${field(it.worktree)}`);
  if (it.session) meta.push(`session: ${field(it.session)}`);
  if (it.ref) meta.push(`ref: ${field(it.ref)}`);
  for (const [k, v] of it.extra) meta.push(`${k}: ${field(v)}`);
  if (it.date) meta.push(it.date);
  const out = [head];
  if (meta.length) out.push(`  ${meta.join(' · ')}`);
  if (it.why) out.push(`  > Why: ${oneLine(it.why)}`);
  out.push(...it.notes);
  return out;
}

export function format(d: Docket): string {
  const out: string[] = [];
  for (const n of d.nodes) {
    if (n.t === 'line') out.push(n.text);
    else out.push(...formatItem(n.item));
  }
  return out.join('\n') + (d.trailingNewline || out.length === 0 ? '\n' : '');
}

// ---------------------------------------------------------------- reading

export const headingOf = (n: Node): string | null => (n.t === 'line' ? HEADING_RE.exec(n.text)?.[1] ?? null : null);

/** Which canonical section a heading names (case- and space-insensitive), or null for anything else. */
export function sectionKind(heading: string): Kind | 'closed' | null {
  const h = heading.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const k of ORDER) if (SECTION[k].toLowerCase() === h) return k;
  return null;
}

export type Located = { item: Item; index: number; section: string | null; kind: Kind | null; status: 'open' | 'closed' };

/** Every item, in file order, with the section it sits in. An open item's kind is its section's. */
export function items(d: Docket): Located[] {
  const out: Located[] = [];
  let section: string | null = null;
  d.nodes.forEach((n, index) => {
    const h = headingOf(n);
    if (h !== null) { section = h; return; }
    if (n.t !== 'item') return;
    const sk = section === null ? null : sectionKind(section);
    const status = n.item.done || sk === 'closed' ? 'closed' : 'open';
    const kind = sk && sk !== 'closed' ? sk : n.item.kind ?? null;
    out.push({ item: n.item, index, section, kind, status });
  });
  return out;
}

export function find(d: Docket, n: number): Located | undefined {
  return items(d).find((l) => l.item.n === n);
}

export function maxId(d: Docket): number {
  return d.nodes.reduce((m, n) => (n.t === 'item' ? Math.max(m, n.item.n) : m), 0);
}

export function title(d: Docket): string | null {
  for (const n of d.nodes) if (n.t === 'line' && /^#\s/.test(n.text)) return n.text.replace(/^#\s+/, '').replace(/^Docket\s*·\s*/, '');
  return null;
}

/** The free prose of the `Milestones:` line, if there is one. */
export function milestonesNote(d: Docket): string | null {
  for (const n of d.nodes) if (n.t === 'line' && /^Milestones:/i.test(n.text)) return n.text.replace(/^Milestones:\s*/i, '');
  return null;
}

/** "D-14", "d-14", "14" → 14. */
export function parseId(s: string | undefined): number | null {
  const m = /^(?:d-)?(\d+)$/i.exec((s ?? '').trim());
  return m ? +m[1]! : null;
}

// ---------------------------------------------------------------- changing

/** Where a new item of a section goes: after its last item, else after the section's prose. The section is created
 *  (in canonical order) when the file doesn't have it. Returns the node index to insert at. */
function slotIn(d: Docket, key: Kind | 'closed', where: 'end' | 'top'): number {
  let start = -1;
  for (let i = 0; i < d.nodes.length; i++) {
    const h = headingOf(d.nodes[i]!);
    if (h !== null && sectionKind(h) === key) { start = i; break; }
  }
  if (start < 0) start = createSection(d, key);
  let end = d.nodes.length;
  for (let i = start + 1; i < d.nodes.length; i++) if (headingOf(d.nodes[i]!) !== null) { end = i; break; }
  const itemIdx: number[] = [];
  for (let i = start + 1; i < end; i++) if (d.nodes[i]!.t === 'item') itemIdx.push(i);
  if (itemIdx.length) return where === 'top' ? itemIdx[0]! : itemIdx[itemIdx.length - 1]! + 1;
  // No items yet: after the section's prose (its last non-blank line), as "blank, item, blank".
  let at = start + 1;
  for (let i = start + 1; i < end; i++) if (!isBlank(d.nodes[i]!)) at = i + 1;
  if (at < end && isBlank(d.nodes[at]!)) at++;
  else { d.nodes.splice(at, 0, { t: 'line', text: '' }); at++; end++; }
  if (at < d.nodes.length && !(at < end && isBlank(d.nodes[at]!))) d.nodes.splice(at, 0, { t: 'line', text: '' });
  return at;
}

const isBlank = (n: Node) => n.t === 'line' && n.text.trim() === '';

function createSection(d: Docket, key: Kind | 'closed'): number {
  // Before the first canonical section that comes after it; else at the end.
  const later = ORDER.slice(ORDER.indexOf(key) + 1);
  let at = d.nodes.length;
  for (let i = 0; i < d.nodes.length; i++) {
    const h = headingOf(d.nodes[i]!);
    const k = h === null ? null : sectionKind(h);
    if (k && later.includes(k)) { at = i; break; }
  }
  const ins: Node[] = [];
  if (at > 0 && !isBlank(d.nodes[at - 1]!)) ins.push({ t: 'line', text: '' });
  ins.push({ t: 'line', text: `## ${SECTION[key]}` }, { t: 'line', text: '' });
  d.nodes.splice(at, 0, ...ins);
  return at + ins.length - 2;
}

function place(d: Docket, it: Item, key: Kind | 'closed', where: 'end' | 'top' = 'end') {
  d.nodes.splice(slotIn(d, key, where), 0, { t: 'item', item: it });
}

function remove(d: Docket, n: number): Item {
  const l = find(d, n);
  if (!l) throw new Error(`no D-${n}`);
  d.nodes.splice(l.index, 1);
  // An item alone between two blank lines leaves one blank behind, not two.
  const [a, b] = [d.nodes[l.index - 1], d.nodes[l.index]];
  if (a && b && isBlank(a) && isBlank(b)) d.nodes.splice(l.index, 1);
  return l.item;
}

export type NewItem = Omit<Item, 'n' | 'done' | 'extra' | 'notes' | 'raw'> & { kind: Kind };

export function addItem(d: Docket, n: number, x: NewItem): Item {
  const it: Item = { ...x, n, done: false, summary: oneLine(x.summary), extra: [], notes: [] };
  const kind = it.kind!;
  delete it.kind; // an open item's kind is its section
  place(d, it, kind);
  return it;
}

export function closeItem(d: Docket, n: number, o: { resolution: string; date: string; session?: string }): Item {
  const l = find(d, n)!;
  const it = remove(d, n);
  delete it.raw;
  it.done = true;
  it.kind = l.kind ?? it.kind;
  it.resolution = oneLine(o.resolution) || undefined;
  it.closed = o.date;
  it.closedSession = o.session;
  place(d, it, 'closed', 'top');
  return it;
}

export function reopenItem(d: Docket, n: number): Item {
  const l = find(d, n)!;
  const it = remove(d, n);
  delete it.raw;
  const kind: Kind = l.kind ?? it.kind ?? 'later';
  it.done = false;
  delete it.kind; delete it.resolution; delete it.closed; delete it.closedSession;
  place(d, it, kind);
  return it;
}

export type Edit = { summary?: string; kind?: Kind; before?: string; why?: string; ref?: string };

/** An empty string clears before / why / ref. Changing an open item's kind moves it to the end of that section. */
export function editItem(d: Docket, n: number, e: Edit): Item {
  const l = find(d, n)!;
  const it = l.item;
  delete it.raw;
  if (e.summary !== undefined) it.summary = oneLine(e.summary);
  for (const k of ['before', 'why', 'ref'] as const) if (e[k] !== undefined) { const v = oneLine(e[k]!); if (v) it[k] = v; else delete it[k]; }
  if (e.kind && e.kind !== l.kind) {
    if (l.status === 'closed') it.kind = e.kind;
    else { remove(d, n); place(d, it, e.kind); }
  }
  return it;
}
