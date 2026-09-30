// Splice on the structure board (docs/ENGINE.md "Splice"): a sandbox over the current view where you propose
// changes (add a node between two others, connect, remove, rename, move) and see what the picture would be,
// without touching the real diagram. The ops and their meaning live in the core (src/model/splice.ts:
// applySplice, describeOp, landed …); this file is the board's side: the session (ops, undo/redo, saved or
// not), what the board draws (the spliced model plus ghosts of what it removed), the dev-server calls that
// save and list splices, and the chrome's CSS. Shape-neutral: nothing here knows what the nodes are.
import { applySplice, describeOp, landed, slug, validateSplice, type Splice, type SpliceOp, type SpliceResult, type SpliceWarning } from './splice';
import type { Model } from './model';

type XY = { x: number; y: number };

/** What a page (or Jarvis) reads about the open splice. */
export interface SpliceView {
  id: string;
  title: string;
  /** Changes not saved yet. */
  dirty: boolean;
  /** How many ops (changes) the splice holds, and the last one in plain words. */
  ops: number;
  last: string | null;
  /** Ops that no longer apply cleanly over the current code (a node they name is gone …), in words. */
  warnings: string[];
  /** Where it is saved (repo-relative), or null. */
  file: string | null;
  /** How many of its ops the code already carries. */
  landed: number;
  canUndo: boolean;
  canRedo: boolean;
}

/** One saved splice, as the Splices list shows it. */
export interface SpliceEntry { file: string; id: string; title: string; ops: number; updated?: string; landed: number; warnings: number; error?: string; splice?: Splice }

/** What the board draws: the spliced model. The core keeps every real node and relationship in it (a removed or
 *  rerouted one carries its mark and is drawn as a ghost), so nothing ever just vanishes from the plate. */
export const drawnModel = (r: SpliceResult): Model => r.model;

const warnText = (w: SpliceWarning, i?: number) => `${i !== undefined ? `change ${w.op + 1}: ` : ''}${w.message}${w.hint ? ` (${w.hint})` : ''}`;

/** The open splice: its ops (applied in order over the base model), what was undone, and whether it is saved. */
export class SpliceSession {
  splice: Splice;
  redo: SpliceOp[] = [];
  /** The ops as last saved (JSON), null when never saved. */
  private savedOps: string | null;
  file: string | null;
  result!: SpliceResult;
  drawn!: Model;
  /** Where cards were dragged inside the splice (the real view's positions are never written from here). */
  positions: Record<string, XY>;
  /** A plain-words line for the mode line: the last change, or what undo/redo just did. */
  note: string | null = null;

  constructor(readonly base: Model, splice: Splice, o: { file?: string | null; saved?: boolean; positions?: Record<string, XY> } = {}) {
    this.splice = { ...splice, ops: [...splice.ops] };
    this.file = o.file ?? null;
    this.savedOps = o.saved ? JSON.stringify(this.splice.ops) : null;
    this.positions = { ...(o.positions ?? {}) };
    this.recompute();
    const last = this.splice.ops[this.splice.ops.length - 1];
    this.note = last ? this.words(this.splice.ops.length - 1) : null;
  }
  recompute() { this.result = applySplice(this.base, this.splice); this.drawn = drawnModel(this.result); }
  get title() { return this.splice.title || this.splice.id || ''; }
  /** Changes since it was last saved (a new splice with no changes has nothing to lose). */
  get dirty() { return JSON.stringify(this.splice.ops) !== (this.savedOps ?? '[]'); }
  /** Apply one more change. One that can't apply (the core skips it: a node it names isn't there, nothing to insert
   *  into …) isn't kept: `applied` is false and the warnings say why. One that applies may still warn (e.g. a no-op part). */
  push(op: SpliceOp): { applied: boolean; warnings: string[] } {
    const i = this.splice.ops.length;
    this.splice.ops.push(op);
    this.recompute();
    const ws = this.result.warnings.filter((w) => w.op === i);
    const t = this.result.marks.touched[i];
    if (ws.length && (!t || (!t.nodes.length && !t.edges.length))) {
      this.splice.ops.pop();
      this.recompute();
      return { applied: false, warnings: ws.map((w) => warnText(w)) };
    }
    this.redo = [];
    this.note = this.words(i);
    return { applied: true, warnings: ws.map((w) => warnText(w)) };
  }
  undo(): SpliceOp | null {
    if (!this.splice.ops.length) return null;
    const words = this.words(this.splice.ops.length - 1);
    const op = this.splice.ops.pop()!;
    this.redo.push(op);
    this.recompute();
    this.note = `undid: ${words}`;
    return op;
  }
  redoOne(): SpliceOp | null {
    const op = this.redo.pop();
    if (!op) return null;
    this.splice.ops.push(op);
    this.recompute();
    this.note = `redid: ${this.words(this.splice.ops.length - 1)}`;
    return op;
  }
  lastWords(): string | null { return this.splice.ops.length ? this.words(this.splice.ops.length - 1) : null; }
  /** Op i in plain words, naming nodes as they were just before it (a rename says the old name). */
  words(i: number): string {
    if (i === 0) return describeOp(this.base, this.splice.ops[0]!);
    const before = applySplice(this.base, { ...this.splice, ops: this.splice.ops.slice(0, i) });
    return describeOp(before.model, this.splice.ops[i]!, before.marks);
  }
  warnings(): string[] { return this.result.warnings.map((w) => warnText(w, w.op)); }
  view(): SpliceView {
    return {
      id: this.splice.id, title: this.title, dirty: this.dirty, ops: this.splice.ops.length, last: this.lastWords(),
      warnings: this.warnings(), file: this.file, landed: landed(this.base, this.splice).filter((x) => x === 'landed').length,
      canUndo: this.splice.ops.length > 0, canRedo: this.redo.length > 0,
    };
  }
  /** Name it: the title as given, the id its slug (kept once saved, so the file doesn't move). */
  name(title: string) {
    const t = title.trim();
    if (!t) return;
    this.splice.title = t;
    if (!this.file || !this.splice.id) this.splice.id = slug(t);
  }

  // ------------------------------------------------------------ dev server (vite.config.ts: /__karyo/splice, /__karyo/splices)
  /** Write it to `<dir>/<id>.splice.json`. */
  async save(dir: string, view?: unknown): Promise<{ ok: boolean; file?: string; error?: string }> {
    if (!this.splice.id) return { ok: false, error: 'name the splice first' };
    const file = `${dir.replace(/\/$/, '')}/${this.splice.id}.splice.json`;
    const now = new Date().toISOString();
    const body: Splice = { ...this.splice, ...(view !== undefined ? { view } : {}), created: this.splice.created ?? now, updated: now };
    try {
      const r = await fetch(`/__karyo/splice?file=${encodeURIComponent(file)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) return { ok: false, error: j.error ?? `save failed (HTTP ${r.status})` };
      this.splice = body;
      this.file = j.file ?? file;
      this.savedOps = JSON.stringify(this.splice.ops);
      return { ok: true, file: this.file! };
    } catch (e) { return { ok: false, error: `the dev server isn't reachable (${e instanceof Error ? e.message : String(e)})` }; }
  }
}

/** Delete a saved splice file. */
export async function deleteSplice(file: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/__karyo/splice?file=${encodeURIComponent(file)}`, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.ok !== false ? { ok: true } : { ok: false, error: j.error ?? `HTTP ${r.status}` };
  } catch (e) { return { ok: false, error: String(e) }; }
}

/** Read one saved splice. */
export async function loadSplice(file: string): Promise<{ ok: true; splice: Splice } | { ok: false; error: string }> {
  try {
    const r = await fetch(`/__karyo/splice?file=${encodeURIComponent(file)}`);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return { ok: false, error: j?.error ?? `HTTP ${r.status}` };
    const errors = validateSplice(j).filter((x) => x.level === 'error');
    if (errors.length) return { ok: false, error: errors.map((x) => `${x.path || '/'}: ${x.message}`).join('; ') };
    return { ok: true, splice: j as Splice };
  } catch (e) { return { ok: false, error: String(e) }; }
}

/** The saved splices in `dir`, each read and applied over `base` (its warnings and how much has landed). */
export async function listSplices(dir: string, base: Model): Promise<{ ok: boolean; entries: SpliceEntry[]; error?: string }> {
  let files: string[] = [];
  try {
    const r = await fetch(`/__karyo/splices?dir=${encodeURIComponent(dir)}`);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return { ok: false, entries: [], error: j?.error ?? `HTTP ${r.status}` };
    const list: unknown[] = Array.isArray(j) ? j : Array.isArray(j.splices) ? j.splices : Array.isArray(j.files) ? j.files : [];
    files = list.map((x) => (typeof x === 'string' ? x : (x as { file?: string })?.file ?? '')).filter(Boolean);
  } catch (e) { return { ok: false, entries: [], error: `the dev server isn't reachable (${String(e)})` }; }
  const entries = await Promise.all(files.map(async (file): Promise<SpliceEntry> => {
    const s = await loadSplice(file);
    if (!s.ok) return { file, id: file.split('/').pop()!.replace(/\.splice\.json$/, ''), title: '', ops: 0, landed: 0, warnings: 0, error: s.error };
    const r = applySplice(base, s.splice);
    return { file, id: s.splice.id, title: s.splice.title || s.splice.id, ops: s.splice.ops.length, updated: s.splice.updated, landed: landed(base, s.splice).filter((x) => x === 'landed').length, warnings: r.warnings.length, splice: s.splice };
  }));
  entries.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || a.id.localeCompare(b.id));
  return { ok: true, entries };
}

/** The splice's chrome on the board: the tinted frame, the banner, proposed / removed cards, the palette, the
 *  connect handle, the rename field, and the Splices list (page chrome beside the plate, so not scoped to it).
 *  Theme tokens only; no transitions (the plate's motion is the morph's). */
export const SPLICE_CSS = /* css */ `
  .sp-frame { position: absolute; left: 0; top: 0; right: 0; bottom: 0; z-index: 35; pointer-events: none; box-sizing: border-box; border: 4px solid color-mix(in srgb, var(--pl-accent) 70%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--pl-accent) 35%, transparent), inset 0 0 60px color-mix(in srgb, var(--pl-accent) 13%, transparent); }
  .plate-dom:not(.sp-on) .sp-frame, .plate-dom:not(.sp-on) .sp-banner { display: none; }
  .sp-banner { position: absolute; left: 12px; right: 12px; top: 5px; height: 27px; z-index: 36; box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 0 5px 0 4px; font: 12.5px/1 var(--pl-font-mono); color: var(--pl-fg); background: color-mix(in srgb, var(--pl-accent) 12%, var(--pl-card)); border: 1px solid color-mix(in srgb, var(--pl-accent) 60%, transparent); border-radius: min(var(--pl-radius), 8px); white-space: nowrap; }
  .sp-banner > * { flex: none; }
  .sp-tag { font: 700 11px/1 var(--pl-font-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--pl-card); background: var(--pl-accent); padding: 5px 8px; border-radius: min(var(--pl-radius), 5px); }
  .sp-title { font: 700 14.5px/1 var(--pl-font-display); max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
  .sp-title.is-untitled { font-weight: 500; font-style: italic; color: var(--pl-muted); }
  .sp-banner > .sp-sub { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--pl-muted); }
  .sp-sub b { color: var(--pl-fg); font-weight: 600; }
  .sp-warn { color: var(--pl-accent-2); font-weight: 600; }
  .sp-msg { color: var(--pl-accent); }
  .sp-msg.is-bad { color: var(--pl-accent-2); }
  .sp-banner .bd-btn { padding: 4px 9px; }
  .sp-banner .bd-btn.is-primary { border-color: var(--pl-accent); color: var(--pl-accent); }
  .sp-banner .bd-btn:disabled { opacity: 0.45; cursor: default; }
  .sp-banner [hidden] { display: none; }
  .sp-name { width: 220px; height: 24px; box-sizing: border-box; font: 12px/1 var(--pl-font-mono); padding: 0 8px; background: var(--pl-card); color: var(--pl-fg); border: 1px solid var(--pl-accent); border-radius: min(var(--pl-radius), 6px); }
  .sp-q { color: var(--pl-accent-2); font-weight: 600; }
  .sp-acts { display: flex; gap: 6px; }

  .mm-card.bd-card.sp-proposed { border: 1.5px dashed var(--pl-accent); background-image: repeating-linear-gradient(135deg, color-mix(in srgb, var(--pl-accent) 11%, transparent) 0 5px, transparent 5px 11px); box-shadow: 0 0 0 3px color-mix(in srgb, var(--pl-accent) 14%, transparent); }
  .mm-card.bd-card.sp-removed { border-style: dashed; box-shadow: none; background: transparent; }
  .mm-card.sp-removed .mm-name { text-decoration: line-through; text-decoration-thickness: 1.5px; }
  .sp-badge { flex: none; font: 700 9.5px/1 var(--pl-font-mono); letter-spacing: 0.07em; text-transform: uppercase; padding: 3px 5px; border-radius: min(var(--pl-radius), 999px); white-space: nowrap; }
  .sp-badge.proposed { background: var(--pl-accent); color: var(--pl-card); }
  .sp-badge.removed { border: 1px dashed var(--pl-muted); color: var(--pl-muted); }
  .sp-badge.renamed, .sp-badge.moved { border: 1px solid var(--pl-accent); color: var(--pl-accent); }
  .mm-card.is-actor .sp-badge { position: absolute; right: 12px; top: -9px; background: var(--pl-card); }
  .mm-ref.sp-was s { text-decoration-thickness: 1px; opacity: 0.8; }
  .mm-ref.sp-new { color: var(--pl-accent); }
  .sp-handle { position: absolute; right: -8px; top: 50%; width: 14px; height: 14px; margin-top: -7px; box-sizing: border-box; border-radius: 50%; background: var(--pl-card); border: 2px solid var(--pl-accent); cursor: crosshair; display: none; z-index: 3; touch-action: none; }
  .plate.is-bench .plate-dom.sp-on .mm-card.bd-card:not(.sp-removed):hover .sp-handle, .plate.is-bench .plate-dom.sp-on .mm-card.bd-card.is-cursor:not(.sp-removed) .sp-handle, .plate.is-bench .plate-dom.sp-on.sp-linking .mm-card.bd-card:not(.sp-removed) .sp-handle { display: block; }
  .sp-handle:hover { background: var(--pl-accent); }
  .plate.is-bench .plate-dom.sp-on .mm-card.bd-card .mm-name { cursor: text; }
  .plate-dom.sp-placing, .plate-dom.sp-placing .mm-card.bd-card { cursor: copy; }
  .sp-rename { position: absolute; left: 0; top: 0; z-index: 45; box-sizing: border-box; height: 26px; font: 600 15px/1 var(--pl-font-display); padding: 0 6px; background: var(--pl-card); color: var(--pl-fg); border: 1.5px solid var(--pl-accent); border-radius: min(var(--pl-radius), 5px); }
  .sp-rename[hidden] { display: none; }

  .sp-pal { position: absolute; top: 74px; width: 316px; z-index: 32; box-sizing: border-box; display: grid; gap: 9px; padding: 12px 14px; cursor: default; }
  .sp-pal[hidden] { display: none; }
  .sp-pal label { display: grid; grid-template-columns: 70px minmax(0, 1fr); align-items: center; gap: 8px; font: 11px/1 var(--pl-font-mono); color: var(--pl-muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .sp-pal input, .sp-pal select { height: 26px; box-sizing: border-box; min-width: 0; font: 13px/1 var(--pl-font); padding: 0 7px; background: var(--pl-card); color: var(--pl-fg); border: 1px solid var(--pl-line); border-radius: min(var(--pl-radius), 5px); text-transform: none; letter-spacing: 0; }
  .sp-pal input:focus, .sp-pal select:focus { border-color: var(--pl-accent); outline: none; }
  .sp-pal .sp-row { display: flex; gap: 8px; justify-content: flex-end; }
  .sp-pal .sp-hint { margin: 0; font: 11.5px/1.4 var(--pl-font-mono); color: var(--pl-muted); }
  .bd-btn.sp-add { border-style: dashed; border-color: var(--pl-accent); color: var(--pl-accent); }
  .bd-toolbar .bd-btn.sp-add[hidden] { display: none; }
  .bd-glyph.proposed, .wh-glyph.proposed { border-top: 2px dashed var(--pl-accent); }
  .bd-tag.sp { color: var(--pl-accent); border-color: var(--pl-accent); border-style: dashed; }
  .sp-note { margin: 0; font: 600 12px/1.35 var(--pl-font-mono); color: var(--pl-accent); }
  .sp-note.removed { color: var(--pl-muted); }

  .plate-btn.sp-btn[aria-pressed="true"] { border-color: var(--pl-accent); color: var(--pl-accent); }
  .sp-pop { position: fixed; z-index: 1000; width: 380px; max-height: 60vh; overflow: auto; box-sizing: border-box; padding: 10px; display: grid; gap: 6px; background: var(--pl-card); color: var(--pl-fg); border: 1px solid var(--pl-line); border-radius: min(var(--pl-radius), 8px); box-shadow: var(--pl-shadow); font: 13px/1.35 var(--pl-font); }
  .sp-pop[hidden] { display: none; }
  .sp-pop .pl-label { margin: 2px 2px 4px; }
  .sp-pop .sp-e { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; text-align: left; padding: 8px 10px; background: transparent; color: var(--pl-fg); border: 1px solid var(--pl-card-border); border-radius: min(var(--pl-radius), 6px); cursor: pointer; font: inherit; }
  .sp-pop .sp-e:hover, .sp-pop .sp-e:focus-visible { border-color: var(--pl-accent); outline: none; }
  .sp-pop .sp-e .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp-pop .sp-e .m { grid-column: 1 / -1; font: 11.5px/1.3 var(--pl-font-mono); color: var(--pl-muted); }
  .sp-pop .sp-e .lb { font: 700 10px/1 var(--pl-font-mono); text-transform: uppercase; letter-spacing: 0.06em; padding: 3px 6px; border-radius: 999px; border: 1px solid var(--pl-ok); color: var(--pl-ok); align-self: center; }
  .sp-pop .sp-e .lb.none { border-color: var(--pl-line); color: var(--pl-muted); }
  .sp-pop .sp-e .w { color: var(--pl-accent-2); }
  .sp-pop .sp-none { font: 12px/1.4 var(--pl-font-mono); color: var(--pl-muted); padding: 4px 2px; }
  .sp-pop .sp-new { justify-self: start; }
`;
