// The kits a page draws with (docs/KITS.md): node kinds (their cards, details sections, sizes, legend entries) and
// plate types, from a KitBundle (the `virtual:karyo-kits` module the dev server builds, vite.config.ts). Pure (no DOM,
// no fs): the views use it in the browser, `karyo kit check` in bun.
//
// Which kits a model is drawn with: the set bound to it (`useKits(model, set)`, a scene that imports its project's
// kits), else the page's default (`setDefaultKits`, the built-ins and the shared library, plus the project's kits in
// `karyo view`). A view takes `kitsFor(model)` once, when it is built, and keeps it for the models it derives (a splice).
import { renderTemplate, scopeCss, esc, TemplateError } from '../explainer/template';
import { withDefaults } from '../explainer/resolve';
import { wiresOf, type Model, type MNode } from '../model/model';
import type { BundledKind, BundledPlate, KitBundle } from './types';

/** A model node as a kit reads it: `fields` are the kind's own data (checked against its props schema). */
export type KitNode = MNode & { fields?: Record<string, unknown> };

/** What the model says around a node, for its card: relationships, recorded calls and the operations they carried. */
export interface NodeStats {
  in: number;
  out: number;
  /** Recorded calls into it (spans of it, across every flow). */
  calls: number;
  /** The operations recorded on it (span labels), busiest first. */
  ops: { label: string; count: number }[];
  callers: string[];
  callees: string[];
}
const NO_STATS: NodeStats = { in: 0, out: 0, calls: 0, ops: [], callers: [], callees: [] };

const statsMemo = new WeakMap<Model, Map<string, NodeStats>>();
/** Every node's stats in a model (memoized per model object). */
export function modelStats(m: Model): Map<string, NodeStats> {
  let s = statsMemo.get(m);
  if (s) return s;
  s = new Map();
  const label = new Map(m.nodes.map((n) => [n.id, n.label ?? n.id]));
  const get = (id: string) => s!.get(id) ?? s!.set(id, { in: 0, out: 0, calls: 0, ops: [], callers: [], callees: [] }).get(id)!;
  for (const w of wiresOf(m)) {
    const a = get(w.from), b = get(w.to);
    a.out++; b.in++;
    a.callees.push(label.get(w.to) ?? w.to); b.callers.push(label.get(w.from) ?? w.from);
  }
  const ops = new Map<string, Map<string, number>>();
  for (const f of m.flows ?? []) for (const sp of f.spans) {
    get(sp.node).calls++;
    const l = sp.label && sp.label !== sp.node ? sp.label : null;
    if (l) { const o = ops.get(sp.node) ?? ops.set(sp.node, new Map()).get(sp.node)!; o.set(l, (o.get(l) ?? 0) + 1); }
  }
  for (const [id, o] of ops) get(id).ops = [...o].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  statsMemo.set(m, s);
  return s;
}

/** Where a card says the node is: its file (long paths keep their last segments), or where it was declared. */
export function whereOf(n: MNode): { short: string; full: string } {
  const full = n.ref ? `${n.ref.file}${n.ref.line ? `:${n.ref.line}` : ''}` : '';
  if (!n.ref) return { short: n.kind === 'actor' ? '' : n.sources?.length ? 'declared elsewhere' : 'declared nowhere', full };
  const tail = (k: number) => `…/${full.split('/').slice(-k).join('/')}`;
  return { short: full.length <= 24 ? full : tail(2).length <= 24 ? tail(2) : full.split('/').pop()!, full };
}

/** A details section a kind renders for one node (the board's DetailSection shape). */
export interface KitSection { id: string; title: string; html: string; compact?: string; noun?: string; keywords?: string[] }

const BOARD_OWN = new Set(['summary', 'calls', 'checks']);

export class KitSet {
  private cssMemo: string | null = null;
  private decorated = new WeakMap<Model, Model>();
  constructor(readonly bundle: KitBundle) {}

  kind(k: string | undefined): BundledKind | undefined { return k ? this.bundle.kinds[k] : undefined; }
  get kinds(): string[] { return Object.keys(this.bundle.kinds).sort(); }
  get plates(): BundledPlate[] { return Object.values(this.bundle.plates).sort((a, b) => a.id.localeCompare(b.id)); }
  plate(id: string): BundledPlate | undefined { return this.bundle.plates[id]; }
  /** The card size of a kit kind, else null (the default card). */
  size(k: string | undefined): { w: number; h: number } | null { const c = this.kind(k); return c ? { w: c.meta.size.w, h: c.meta.size.h } : null; }
  label(k: string) { return this.kind(k)?.meta.node.label ?? k; }
  plural(k: string) { const n = this.kind(k)?.meta.node; return n?.plural ?? `${n?.label ?? k}s`; }
  glyph(k: string) { return this.kind(k)?.meta.node.glyph ?? null; }

  /** What a kind's templates see for a node: its fields (with the schema's defaults), `node.*` and `stats.*`. */
  scope(n: KitNode, stats: NodeStats = NO_STATS): Record<string, unknown> {
    const c = this.kind(n.kind);
    const fields = n.fields && typeof n.fields === 'object' && !Array.isArray(n.fields) ? n.fields : {};
    const w = whereOf(n);
    const node = {
      id: n.id, kind: n.kind, kindLabel: c ? this.label(n.kind) : n.kind, label: n.label ?? n.id, summary: n.summary ?? '',
      category: n.category ?? '', tags: n.tags ?? [], lang: n.lang ?? '', group: n.group ?? '', where: w.short, file: w.full,
      symbol: n.ref?.symbol ?? '', proposed: !!n.sources?.length && n.sources.every((s) => s === 'proposed'), sources: n.sources ?? [],
    };
    return { ...withDefaults(c?.meta.props, fields), node, stats: { ...stats, opsCount: stats.ops.length } };
  }

  /** The inside of a kit kind's card (null when the node's kind has no kit). A broken template draws a plain inside
   *  that says so, never nothing. */
  cardInner(n: KitNode, stats?: NodeStats): string | null {
    const c = this.kind(n.kind);
    if (!c) return null;
    try { return renderTemplate(c.template, this.scope(n, stats)); }
    catch (e) {
      const why = e instanceof TemplateError ? e.message : String(e);
      return `<div class="mm-top"><span class="mm-kind">${esc(this.label(n.kind))}</span></div><div class="mm-name">${esc(n.label ?? n.id)}</div><div class="mm-ref" title="${esc(why)}">template error: ${esc(why)}</div>`;
    }
  }

  /** A node's kit sections, rendered, each wrapped in its kind's section scope (.ks-<kind>). */
  sections(n: KitNode, stats?: NodeStats): KitSection[] {
    const c = this.kind(n.kind);
    if (!c) return [];
    const sc = this.scope(n, stats), wrap = (h: string) => `<div class="ks-${c.name}">${h}</div>`;
    const out: KitSection[] = [];
    for (const s of c.sections) {
      if (BOARD_OWN.has(s.id)) continue;
      try {
        out.push({ id: s.id, title: s.title, html: wrap(renderTemplate(s.template, sc)), ...(s.compact ? { compact: wrap(renderTemplate(s.compact, sc)) } : {}),
          ...(s.noun ? { noun: s.noun } : {}), ...(s.keywords ? { keywords: s.keywords } : {}) });
      } catch (e) { out.push({ id: s.id, title: s.title, html: `<p class="bd-none">template error: ${esc(e instanceof Error ? e.message : String(e))}</p>` }); }
    }
    return out;
  }

  /** A kind's mini rendering (the tour's map, sequence lanes): its mini template, else null (the view draws glyph + label). */
  mini(n: KitNode, stats?: NodeStats): string | null {
    const c = this.kind(n.kind);
    if (!c?.mini) return null;
    try { return renderTemplate(c.mini, this.scope(n, stats)); } catch { return null; }
  }

  /** The CSS every view that draws kit cards needs: each kind's card size, and its stylesheet scoped to its cards
   *  (.kc-<kind>), its sections (.ks-<kind>) and its minis (.km-<kind>). Not scoped under the plate: the pinned
   *  inspector shows sections outside it. */
  css(): string {
    if (this.cssMemo !== null) return this.cssMemo;
    this.cssMemo = Object.values(this.bundle.kinds).map((c) => `/* kind ${c.name} (kit ${c.kit}) */
.mm-card.kc-${c.name} { width: ${c.meta.size.w}px; height: ${c.meta.size.h}px; }
${scopeCss(c.css, c.name)}${scopeCss(noHost(c.css), c.name, `.ks-${c.name}`)}${c.mini ? scopeCss(noHost(c.css), c.name, `.km-${c.name}`) : ''}`).join('\n');
    return this.cssMemo;
  }

  /** The model with each kit kind's default category on its nodes that declare none (the model itself is untouched). */
  decorate(m: Model): Model {
    const hit = this.decorated.get(m);
    if (hit) return hit;
    const cat = (n: MNode) => (!n.category ? this.kind(n.kind)?.meta.node.category : undefined);
    const out = m.nodes.some(cat) ? { ...m, nodes: m.nodes.map((n) => (cat(n) ? { ...n, category: cat(n) } : n)) } : m;
    this.decorated.set(m, out);
    return out;
  }
}

/** A stylesheet without its `:host` (and `&`) rules: they style the card itself, not a section or a mini that shares
 *  the stylesheet. */
const noHost = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[;}])\s*(?::host|&)[^{};]*\{[^{}]*\}/g, '$1');

export const EMPTY_BUNDLE: KitBundle = { kits: [], kinds: {}, plates: {}, warnings: [] };
let DEFAULT = new KitSet(EMPTY_BUNDLE);
const bound = new WeakMap<Model, KitSet>();

/** The page's kits (its entry point calls this first: src/kits/boot.ts). Warnings go to the console once. */
export function setDefaultKits(b: KitBundle | KitSet) {
  DEFAULT = b instanceof KitSet ? b : new KitSet(b);
  for (const w of DEFAULT.bundle.warnings) console.warn(`[karyo kits] ${w}`);
}
export const defaultKits = () => DEFAULT;
/** Draw this model with these kits (a scene that imports its own project's kits). Returns the model. */
export function useKits<M extends Model>(m: M, kits: KitSet | KitBundle): M { bound.set(m, kits instanceof KitSet ? kits : new KitSet(kits)); return m; }
export const kitsFor = (m: Model): KitSet => bound.get(m) ?? DEFAULT;
