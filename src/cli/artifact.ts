// Explainers published as Claude artifacts (docs/ARTIFACTS.md): the link record, staleness, and the plugin's hooks.
//
// Only Claude, in a session, can publish an artifact (its Artifact tool). Karyo never publishes: it builds the page
// (`karyo artifact build`, src/explainer/build.ts with the artifact target), keeps the link record and tells Claude,
// through the hooks, when a linked explainer has changed since it was published.
//
//   karyo/artifacts.json        the link record, committed with the project: one entry per linked explainer
//                               { spec (project-relative), url, hash (sha256 of the published page), content (sha256 of
//                               its explainer data), title, publishedAt }
//   .karyo/artifacts/<id>.html  the last page `karyo artifact build` wrote (generated; .karyo/ is git-ignored)
//
// Nothing here assumes what an explainer is about.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const RECORD = 'karyo/artifacts.json';
export const OUT_DIR = '.karyo/artifacts';
const MEMO = '.karyo/artifacts/.stop-memo.json';
const FORMAT = 'artifacts/1';

export class ArtifactError extends Error {}

export interface ArtifactLink {
  /** The explainer spec, relative to the project, with forward slashes. */
  spec: string;
  /** The artifact's URL (https://claude.ai/artifact/<id>, or the same under the /code/ path). */
  url: string;
  /** sha256 (hex) of the HTML last published there. */
  hash: string;
  /** sha256 (hex) of that page's explainer data (spec and components): tells a content change from a runtime one. */
  content?: string;
  title?: string;
  /** ISO time of the link (the publish it records). */
  publishedAt: string;
}
export interface ArtifactRecord { karyo: typeof FORMAT; artifacts: ArtifactLink[] }

export type LinkState = 'up-to-date' | 'stale';
/** Why a linked explainer is stale: its content changed, only Karyo's runtime changed, its spec is gone, or it no
 *  longer builds. */
export type StaleKind = 'content' | 'runtime' | 'missing' | 'broken';
export interface LinkStatus extends ArtifactLink { state: LinkState; kind?: StaleKind; reason?: string; current?: string; file?: string }
export interface Status { project: string; record: string; linked: LinkStatus[]; unlinked: string[] }

// ---------------------------------------------------------------- hashes and paths

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
/** The explainer data inside a built page (the bundle JSON), hashed; null when the page has none. */
export function contentHash(html: string): string | null {
  const m = html.match(/<script type="application\/json" id="karyo-bundle">([\s\S]*?)<\/script>/);
  return m ? sha256(m[1]!) : null;
}
const slash = (p: string) => p.split(path.sep).join('/');

/** A spec's key in the record: its path relative to the project. Throws when the spec is outside the project. */
export function specKey(project: string, specAbs: string): string {
  const r = path.relative(project, path.resolve(specAbs));
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new ArtifactError(`${specAbs} is outside the project (${project}); links are kept per project`);
  return slash(r);
}

/** The explainer's id (its `id`, else its file name) as a safe file name. */
export function explainerId(specAbs: string): string {
  let id = '';
  try { const j = JSON.parse(readFileSync(specAbs, 'utf8')); if (typeof j?.id === 'string') id = j.id; } catch { /* the file name */ }
  if (!id) id = path.basename(specAbs).replace(/\.explainer\.json$/, '').replace(/\.json$/, '');
  return id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'explainer';
}
/** Where `karyo artifact build` writes a spec's page. */
export const artifactFile = (project: string, specAbs: string) => path.join(project, OUT_DIR, `${explainerId(specAbs)}.html`);
/** Where it writes the page's review copy (`reviewCopy`). */
export const reviewFile = (project: string, specAbs: string) => path.join(project, OUT_DIR, `${explainerId(specAbs)}.review.txt`);

/** The page with Karyo's runtime (the bundled engine script, its stylesheet and the themes' inlined fonts, as
 *  src/explainer/build.ts inlines them) swapped for one-line markers: everything else, the spec and the mount script, is
 *  left to read before publishing. `verified` is true when all three were found byte for byte, i.e. the page carries
 *  exactly this install's runtime. */
export function reviewCopy(html: string, rt: { js: string; css: string; fonts: string; hash: string }): { text: string; verified: boolean } {
  const js = rt.js.replace(/<\/script/gi, '<\\/script');
  const jsTag = `<script>${js}</script>`, cssTag = `<style>${rt.css}</style>`, fontTag = `<style>${rt.fonts}</style>`;
  const verified = html.includes(jsTag) && html.includes(cssTag) && html.includes(fontTag);
  const text = html
    .replace(jsTag, () => `<script>/* Karyo runtime ${rt.hash}: ${Buffer.byteLength(js)} bytes, this install's own build, verified byte for byte */</script>`)
    .replace(cssTag, () => `<style>/* Karyo runtime stylesheet ${rt.hash}: ${Buffer.byteLength(rt.css)} bytes, verified byte for byte */</style>`)
    .replace(fontTag, () => `<style>/* Karyo's theme fonts (Inter, Geist, Geist Mono, Newsreader; SIL OFL 1.1), inlined: ${Buffer.byteLength(rt.fonts)} bytes, verified byte for byte */</style>`);
  return { text, verified };
}

/** Make <project>/.karyo/artifacts/, with a .gitignore that keeps its generated pages out of git. */
export function ensureOutDir(project: string): string {
  const d = path.join(project, OUT_DIR);
  mkdirSync(d, { recursive: true });
  const gi = path.join(d, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, '# Karyo: pages built for Claude artifacts (`karyo artifact build`); karyo/artifacts.json is the record to commit\n*\n');
  return d;
}

/** Is this an artifact URL? https on claude.ai, at /artifact/<id> (also under the /code/ path). */
export function isArtifactUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && /(^|\.)claude\.ai$/.test(x.hostname) && /^\/(code\/)?artifacts?\/[A-Za-z0-9_-]+\/?$/.test(x.pathname);
  } catch { return false; }
}

// ---------------------------------------------------------------- the record

export const recordPath = (project: string) => path.join(project, RECORD);

export function readRecord(project: string): ArtifactRecord {
  const f = recordPath(project);
  if (!existsSync(f)) return { karyo: FORMAT, artifacts: [] };
  let j: any;
  try { j = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { throw new ArtifactError(`${RECORD} is not valid JSON: ${(e as Error).message}`); }
  if (!j || typeof j !== 'object' || !Array.isArray(j.artifacts)) throw new ArtifactError(`${RECORD} has no "artifacts" list`);
  const artifacts: ArtifactLink[] = [];
  for (const a of j.artifacts) {
    if (!a || typeof a.spec !== 'string' || typeof a.url !== 'string' || typeof a.hash !== 'string') continue;
    artifacts.push({ spec: a.spec, url: a.url, hash: a.hash, ...(typeof a.content === 'string' ? { content: a.content } : {}),
      ...(typeof a.title === 'string' ? { title: a.title } : {}), publishedAt: typeof a.publishedAt === 'string' ? a.publishedAt : '' });
  }
  return { karyo: FORMAT, artifacts };
}

/** Write the record (sorted by spec, so diffs stay small); an empty record removes the file. */
export function writeRecord(project: string, rec: ArtifactRecord) {
  const f = recordPath(project);
  if (!rec.artifacts.length) { if (existsSync(f)) writeFileSync(f, JSON.stringify({ karyo: FORMAT, artifacts: [] }, null, 2) + '\n'); return; }
  mkdirSync(path.dirname(f), { recursive: true });
  const sorted = [...rec.artifacts].sort((a, b) => a.spec.localeCompare(b.spec));
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ karyo: FORMAT, artifacts: sorted }, null, 2) + '\n');
  renameSync(tmp, f);
}

/** Link (or re-link) a spec to an artifact URL with the hash of what was published there. */
export function link(project: string, specAbs: string, entry: { url: string; hash: string; content?: string | null; title?: string; at?: Date }): ArtifactLink {
  if (!isArtifactUrl(entry.url)) throw new ArtifactError(`"${entry.url}" doesn't look like an artifact URL (https://claude.ai/artifact/<id>, or the same under /code/)`);
  if (!/^[0-9a-f]{64}$/.test(entry.hash)) throw new ArtifactError(`--hash takes a sha256 in hex (64 characters), as \`karyo artifact build\` prints it`);
  const spec = specKey(project, specAbs);
  const rec = readRecord(project);
  const e: ArtifactLink = { spec, url: entry.url, hash: entry.hash, ...(entry.content ? { content: entry.content } : {}), ...(entry.title ? { title: entry.title } : {}), publishedAt: (entry.at ?? new Date()).toISOString() };
  rec.artifacts = [...rec.artifacts.filter((a) => a.spec !== spec), e];
  writeRecord(project, rec);
  return e;
}

/** Forget a spec's link. Returns the entry removed, or null. `specAbs` may also be a recorded key that no longer exists. */
export function unlink(project: string, specAbs: string): ArtifactLink | null {
  const rec = readRecord(project);
  let key: string;
  try { key = specKey(project, specAbs); } catch { key = slash(specAbs); }
  const hit = rec.artifacts.find((a) => a.spec === key);
  if (!hit) return null;
  rec.artifacts = rec.artifacts.filter((a) => a !== hit);
  writeRecord(project, rec);
  return hit;
}

// ---------------------------------------------------------------- status

/** Renders a spec's artifact page as a string (src/explainer/build.ts renderHtml with the artifact target). */
export type Render = (specAbs: string) => Promise<{ html: string; errors: string[] }>;

/** Each linked explainer, up to date or stale (with why), and, with `unlinked`, the explainers that aren't linked. */
export async function status(project: string, render: Render, o: { unlinked?: boolean } = {}): Promise<Status> {
  const rec = readRecord(project);
  const linked: LinkStatus[] = [];
  for (const a of rec.artifacts) {
    const abs = path.join(project, a.spec);
    if (!existsSync(abs)) { linked.push({ ...a, state: 'stale', kind: 'missing', reason: 'the spec is gone (moved or deleted); unlink it, or link it again at its new path' }); continue; }
    let r: { html: string; errors: string[] };
    try { r = await render(abs); } catch (e) { r = { html: '', errors: [(e as Error).message] }; }
    if (r.errors.length || !r.html) { linked.push({ ...a, state: 'stale', kind: 'broken', reason: `it doesn't build: ${r.errors.slice(0, 2).join('; ') || 'no output'}`, file: abs }); continue; }
    const current = sha256(r.html);
    if (current === a.hash) { linked.push({ ...a, state: 'up-to-date', current, file: abs }); continue; }
    const c = contentHash(r.html);
    const runtimeOnly = !!a.content && c === a.content;
    linked.push({ ...a, state: 'stale', current, file: abs, kind: runtimeOnly ? 'runtime' : 'content',
      reason: runtimeOnly ? 'same explainer, newer Karyo runtime (a republish picks it up)' : 'the explainer changed since it was published' });
  }
  let unlinked: string[] = [];
  if (o.unlinked) {
    const { indexProject } = await import('../project/files');
    const idx = await indexProject(project);
    const have = new Set(rec.artifacts.map((a) => a.spec));
    unlinked = idx.explainers.map((e) => e.rel).filter((r) => !have.has(r));
  }
  return { project, record: recordPath(project), linked, unlinked };
}

// ---------------------------------------------------------------- hooks (hooks/hooks.json → scripts/plugin/artifact-hook.sh → `karyo artifact hook`)

export interface HookInput { session_id?: string; transcript_path?: string; stop_hook_active?: boolean; cwd?: string; hook_event_name?: string }

/** The current turn from a transcript (JSONL): when its prompt was sent and the inputs of the tools it used. Reads the
 *  file backwards in chunks, so a long session costs no more than its last turn. */
export function lastTurn(transcript: string, maxBytes = 16 * 1024 * 1024): { start: number | null; inputs: unknown[] } {
  const inputs: unknown[] = [];
  let fd: number;
  try { fd = openSync(transcript, 'r'); } catch { return { start: null, inputs }; }
  try {
    const size = statSync(transcript).size;
    let pos = size, carry = '', read = 0;
    const CH = 256 * 1024;
    while (pos > 0 && read < maxBytes) {
      const n = Math.min(CH, pos);
      pos -= n; read += n;
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, pos);
      const text = buf.toString('utf8') + carry;
      const lines = text.split('\n');
      carry = pos > 0 ? lines.shift()! : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const r = turnLine(lines[i]!, inputs);
        if (r !== undefined) return { start: r, inputs };
      }
    }
    if (carry) { const r = turnLine(carry, inputs); if (r !== undefined) return { start: r, inputs }; }
    return { start: null, inputs };
  } finally { closeSync(fd); }
}
/** One transcript line, newest first: collects tool inputs; returns the prompt's time (ms) when the line is the
 *  turn's prompt (a user message that isn't only tool results), else undefined. */
function turnLine(line: string, inputs: unknown[]): number | undefined {
  if (!line.trim()) return undefined;
  let e: any;
  try { e = JSON.parse(line); } catch { return undefined; }
  const content = e?.message?.content;
  if (e?.type === 'assistant' && Array.isArray(content)) { for (const c of content) if (c?.type === 'tool_use') inputs.push(c.input); return undefined; }
  if (e?.type === 'user' && !e.isMeta) {
    const prompt = typeof content === 'string' || (Array.isArray(content) && content.some((c: any) => c?.type === 'text'));
    if (prompt) { const t = Date.parse(e.timestamp); return Number.isFinite(t) ? t : 0; }
  }
  return undefined;
}

const mentionsExplainer = (v: unknown): boolean => {
  if (typeof v === 'string') return v.includes('.explainer.json');
  if (Array.isArray(v)) return v.some(mentionsExplainer);
  if (v && typeof v === 'object') return Object.values(v).some(mentionsExplainer);
  return false;
};
/** The newest change (ms) to a spec or anything in its folder (its components), one level of folders down. */
function newestIn(specAbs: string): number {
  let t = 0;
  const dir = path.dirname(specAbs);
  const visit = (d: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.') || n === 'node_modules' || n === 'stills') continue;
      const p = path.join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 3) visit(p, depth + 1); } else t = Math.max(t, st.mtimeMs);
    }
  };
  try { t = statSync(specAbs).mtimeMs; } catch { /* gone */ }
  visit(dir, 1);
  return t;
}

/** Did this turn touch an explainer: a tool input naming a *.explainer.json, or a linked explainer's files changed
 *  since the turn's prompt? */
export function touchedThisTurn(project: string, rec: ArtifactRecord, input: HookInput): boolean {
  if (!input.transcript_path) return false;
  const turn = lastTurn(input.transcript_path);
  if (turn.inputs.some(mentionsExplainer)) return true;
  if (turn.start === null) return false;
  return rec.artifacts.some((a) => newestIn(path.join(project, a.spec)) >= turn.start! - 1000);
}

export interface HookOpts { render: Render; karyo: string; skill?: string }

/** The Stop hook: block once when this turn touched an explainer and a linked one is stale (its content changed or its
 *  spec is gone). Never when `stop_hook_active`, and never twice in a session for the same stale state. Returns the
 *  hook's JSON output, or null to stay silent. */
export async function stopHook(project: string, input: HookInput, o: HookOpts): Promise<Record<string, unknown> | null> {
  if (input.stop_hook_active) return null;
  if (!existsSync(recordPath(project))) return null;
  const rec = readRecord(project);
  if (!rec.artifacts.length) return null;
  if (!touchedThisTurn(project, rec, input)) return null;
  const st = await status(project, o.render);
  const stale = st.linked.filter((l) => l.state === 'stale' && (l.kind === 'content' || l.kind === 'missing' || l.kind === 'broken'));
  if (!stale.length) return null;
  const sig = stale.map((l) => `${l.spec}:${l.current ?? l.kind}`).sort().join('|');
  const memoFile = path.join(project, MEMO);
  let memo: Record<string, string> = {};
  try { memo = JSON.parse(readFileSync(memoFile, 'utf8')); } catch { /* none yet */ }
  const sid = input.session_id ?? 'session';
  if (memo[sid] === sig) return null;
  memo = { ...Object.fromEntries(Object.entries(memo).slice(-20)), [sid]: sig };
  try { ensureOutDir(project); writeFileSync(memoFile, JSON.stringify(memo) + '\n'); } catch { /* blocks again next time: still once per stop */ }
  return { decision: 'block', reason: stopReason(stale, o) };
}

export function stopReason(stale: LinkStatus[], o: Pick<HookOpts, 'karyo' | 'skill'>): string {
  const k = JSON.stringify(o.karyo);
  const lines = stale.map((l) => l.kind === 'missing'
    ? `- ${l.spec} (published at ${l.url}): ${l.reason}. Run: ${k} artifact unlink ${JSON.stringify(l.spec)}`
    : l.kind === 'broken'
      ? `- ${l.spec} (published at ${l.url}): ${l.reason}. Fix it, then rebuild and republish as below.`
      : `- ${l.spec}: rebuild with ${k} artifact build ${JSON.stringify(l.spec)}, look at it, then republish the built file with your Artifact tool to the SAME url ${l.url} (pass it as \`url\`), then ${k} artifact link ${JSON.stringify(l.spec)} ${l.url}`);
  return [`Karyo: ${stale.length === 1 ? 'an explainer published as a Claude artifact has' : `${stale.length} explainers published as Claude artifacts have`} changed since publishing. Republish before you finish${o.skill ? ` (${o.skill} has the steps)` : ''}:`,
    ...lines,
    'If you have no Artifact tool, or the user lacks edit access to that artifact, don\'t retry: tell the user it is stale and that the owner must republish it.'].join('\n');
}

/** The SessionStart hook: one line of context when linked explainers are stale, else null. */
export async function sessionStartHook(project: string, o: HookOpts): Promise<Record<string, unknown> | null> {
  if (!existsSync(recordPath(project))) return null;
  const rec = readRecord(project);
  if (!rec.artifacts.length) return null;
  const st = await status(project, o.render);
  const stale = st.linked.filter((l) => l.state === 'stale');
  if (!stale.length) return null;
  const list = stale.slice(0, 4).map((l) => `${l.spec} (${l.kind === 'runtime' ? 'newer Karyo runtime' : l.kind === 'missing' ? 'spec gone' : l.kind === 'broken' ? "doesn't build" : 'changed'})`).join(', ') + (stale.length > 4 ? `, and ${stale.length - 4} more` : '');
  const line = `Karyo: ${stale.length === 1 ? 'an explainer published as a Claude artifact is' : `${stale.length} explainers published as Claude artifacts are`} out of date: ${list}. When the user wants them current, rebuild and republish each to its recorded url${o.skill ? ` (${o.skill})` : ''}; \`${o.karyo} artifact status\` lists them.`;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line } };
}
