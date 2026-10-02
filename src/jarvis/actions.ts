// Jarvis mode's actions: one adapter over whichever interactive plate is mounted (structure board, trace
// board, tour, Stack view, explainer), through the plates' public APIs only. Every action animates with the
// plate's own transitions (the motion dial applies) and answers { ok, state } or { ok: false, error } where the
// error says why and what IS available, so the model driving it can correct itself.
// Indices are 1-based (as the plates number steps, requests and slices on screen).
import type { Stage } from '../engine';
import type { PlateKind, PlateOutline, SectionInfo, DetailsView, InspectorView } from '../model/outline';
import { HIGHLIGHT } from '../model/outline';
import { cssId } from '../model/scenes';
import { best, rank, norm, type Candidate } from './fuzzy';
import type { ViewSelection, ViewSnapshot, SpliceState, SpliceStackState } from './protocol';
import type { SpliceView, SpliceEntry } from '../model/board-splice';
import { spliceOp, type SpliceOp, type SpliceAddOp, type SpliceAttach } from '../model/splice';
import type { EdgeKind, NodeKind } from '../model/model';
import type { BoardLevel } from '../model/board';

/** The union of what the plates expose (each implements its part; see src/model/{board,flowboard,tour,stack}.ts, src/explainer/scene.ts). */
interface AnyPlate {
  describe?(): PlateOutline;
  getState?(): any;
  // board
  reveal?(id: string): void; close?(): void; drill?(g: string | null): void; back?(): boolean;
  // board: group navigation (docs/ENGINE.md "Group navigation")
  enter?(g: string | null): boolean; up?(): boolean; groupView?(v: 'groups' | 'cards'): boolean; level?(): BoardLevel;
  openDetails?(id: string, section?: string | null): void | boolean; sections?(id: string): SectionInfo[]; detailsView?(): DetailsView | null;
  scrollDetails?(to: 'down' | 'up' | 'top' | 'bottom' | { item: string }): boolean;
  // board, trace: the pinned inspector
  inspector?(): InspectorView;
  // board, trace, stack, explainer
  focusTag?(id: string | null): void; highlight?(ids: string[] | null): void;
  // trace
  select?(i: number | null): void;
  // tour, stack, explainer
  go?(i: number): void; next?(): void; prev?(): void;
  // sequence: folded lanes (docs/KITS.md "Folding")
  expand?(unit: string | null): boolean; collapse?(unit?: string | null): boolean;
  folds?(): { id: string; name: string; members: string[]; expanded: boolean }[];
  // stack
  fan?(on?: boolean): void;
  showWarning?(k: number | null): boolean;
  // board: splices (docs/ENGINE.md "Splice")
  spliceView?(): SpliceView | null;
  spliceOpen?(o?: { title?: string }): SpliceView;
  spliceOpenSaved?(ref: string): Promise<{ ok: boolean; view?: SpliceView; error?: string }>;
  spliceOp?(op: SpliceOp): { applied: boolean; warnings: string[]; view: SpliceView };
  spliceUndo?(): boolean; spliceRedo?(): boolean;
  spliceSave?(name?: string): Promise<{ ok: boolean; file?: string; error?: string }>;
  spliceLeave?(force?: boolean): boolean;
  spliceDiscard?(force?: boolean): Promise<{ ok: boolean; deleted: string | null; error?: string }>;
  spliceList?(): Promise<{ ok: boolean; entries: SpliceEntry[]; error?: string }>;
  // board: a stack of splices (docs/ENGINE.md "Stack of splices")
  spliceStack?(o?: { names?: string[]; combine?: boolean | string[] }): Promise<{ ok: boolean; view?: SpliceStackState; error?: string }>;
  spliceStackOpen?(ref: number | string): { ok: boolean; view?: SpliceView | null; error?: string };
  spliceStackReturn?(): boolean; spliceStackLeave?(): boolean;
  spliceStackView?(): SpliceStackState | null; spliceStackPlate?(): unknown | null;
  spliceStackSwap?(): { ok: boolean; view?: SpliceStackState; error?: string };
  spliceStackSame?(ref?: number | string, same?: boolean): { ok: boolean; view?: SpliceStackState; error?: string };
}
const NODE_KINDS: readonly NodeKind[] = ['service', 'function', 'store', 'queue', 'external', 'actor'];
const EDGE_KINDS: readonly EdgeKind[] = ['calls', 'reads', 'writes', 'publishes', 'subscribes'];
/** The splice actions (docs/JARVIS.md "Splices"): proposals only, never the real diagram. */
export const SPLICE_ACTIONS = ['splice_open', 'splice_add', 'splice_group', 'splice_connect', 'splice_disconnect', 'splice_remove', 'splice_replace', 'splice_rename', 'splice_move', 'splice_undo', 'splice_redo', 'splice_save', 'splice_discard', 'splice_leave', 'splice_list', 'splice_stack', 'splice_stack_open', 'splice_stack_return', 'splice_stack_leave', 'splice_stack_conflict', 'splice_stack_swap', 'splice_stack_same'] as const;
/** The splice actions that change the open splice: not while a stack of splices covers the board. */
const SPLICE_CHANGES = ['splice_add', 'splice_group', 'splice_connect', 'splice_disconnect', 'splice_remove', 'splice_replace', 'splice_rename', 'splice_move', 'splice_undo', 'splice_redo'];

export interface ActionResult { ok: boolean; state?: ViewSelection; error?: string }
export interface PageControls { theater(): boolean; setTheater(on: boolean): void }

type Kind = 'node' | 'group' | 'tag' | 'step';
const LIST_MAX = 14;
const list = (xs: string[]) => (xs.length > LIST_MAX ? `${xs.slice(0, LIST_MAX).join(', ')} … (+${xs.length - LIST_MAX} more)` : xs.join(', '));
const PLATE_NAME: Record<PlateKind, string> = { board: 'structure board', trace: 'trace board', tour: 'tour', stack: 'Stack view', explainer: 'explainer', sequence: 'sequence diagram' };
const STEP_NOUN: Record<PlateKind, string> = { board: 'step', trace: 'request', tour: 'step', stack: 'slice', explainer: 'step', sequence: 'call' };

class Fail extends Error {}
const fail = (msg: string): never => { throw new Fail(msg); };

export class PlateAdapter {
  /** The node ids the last `highlight {nodes}` lit (the plates keep the entry; this is for the snapshot). */
  private highlighted: string[] = [];
  constructor(readonly stage: Stage, readonly page: PageControls) {}

  /** The mounted plate. */
  private get board() { return this.stage.scene as unknown as AnyPlate; }
  /** The plate on screen: a board's stack of splices (a Stack view over it) while it shows, else the mounted plate. */
  private get api() { return (this.board.spliceStackPlate?.() ?? this.board) as AnyPlate; }
  /** Null for a plate that can't describe itself (a clip). */
  outline(): PlateOutline | null { try { return this.api.describe?.() ?? null; } catch { return null; } }
  get kind(): PlateKind | null { return this.outline()?.kind ?? null; }

  selection(): ViewSelection {
    const o = this.outline(), st = this.api.getState?.() ?? {};
    const base = { theater: this.page.theater(), bench: this.stage.inBench, zoom: Math.round(this.stage.view.zoom * 100) };
    const pins: string[] = Array.isArray(st.pins) ? [...st.pins] : [];
    const hl = pins.includes(HIGHLIGHT) ? { highlighted: [...this.highlighted] } : {};
    switch (o?.kind) {
      case 'board': return { open: st.open ?? null, ...this.details(), ...this.inspectorState(), drill: (st.nav === 'groups' ? st.at : st.drill) ?? null, ...this.levelState(), pins, ...hl, ...this.spliceState(), ...this.stackState(), ...base };
      case 'trace': return { request: st.sel == null ? null : st.sel + 1, ...this.details(), ...this.inspectorState(), pins, ...hl, ...base };
      case 'tour': return { step: (st.step ?? 0) + 1, ...base };
      case 'stack': return { slice: (st.cur ?? 0) + 1, fan: !!st.fan, pins, ...hl, ...this.spliceState(), ...this.stackState(), ...base };
      case 'explainer': return { step: (st.step ?? 0) + 1, pins, ...hl, ...base };
      case 'sequence': return { step: st.step == null ? null : st.step + 1, drill: (this.api.folds?.() ?? []).filter((f) => f.expanded).map((f) => f.name).join(', ') || null, pins, ...hl, ...base } as ViewSelection;
      default: return base;
    }
  }

  /** The open card's details as the plate measures them on screen: never more than what is actually visible. */
  private details(): Partial<ViewSelection> {
    let d: DetailsView | null = null;
    try { d = this.api.detailsView?.() ?? null; } catch { d = null; }
    if (!d) return {};
    return { section: d.section, sections: d.sections, visible: d.visible, items: { shown: d.shown, partly: d.partly, hidden: d.hidden }, more: d.more };
  }

  /** The open splice, as Jarvis reports it: its name, whether it is saved, how many changes, the last one in words,
   *  and the changes that no longer apply. `splice: null` on a board in its real view. */
  private spliceState(): Partial<ViewSelection> {
    if (!this.board.spliceView) return {};
    const v = this.board.spliceView();
    if (!v) return { splice: null };
    const s: SpliceState = { id: v.id, title: v.title, dirty: v.dirty, ops: v.ops, last: v.last, warnings: v.warnings, file: v.file, landed: v.landed,
      ...(v.where !== undefined ? { where: v.where } : {}), ...(v.home !== undefined ? { home: v.home } : {}), ...(v.groups?.length ? { groups: v.groups } : {}) };
    return { splice: s };
  }

  /** A board's group navigation: the view, the group entered, its path, and what the level shows. */
  private levelState(): Partial<ViewSelection> {
    const l = this.board.level?.();
    if (!l || !l.available) return {};
    return { level: { view: l.view, at: l.at, path: l.path, groups: l.groups.map((g) => `${g.label}${g.proposed ? ' (proposed)' : ''}`), stubs: l.stubs.map((t) => `${t.label} (${t.side === 'in' ? 'calls in' : 'called'})`),
      ...(l.view === 'groups' ? { cards: l.cards.map((id) => this.outline()?.nodes.find((n) => n.id === id)?.label ?? id) } : {}), ...(l.proposed ? { proposed: true } : {}) } };
  }
  /** A board's stack of splices: its slices, the current one, on screen or not (null: none). */
  private stackState(): Partial<ViewSelection> {
    if (!this.board.spliceStackView) return {};
    return { spliceStack: this.board.spliceStackView() };
  }

  /** The pinned inspector as measured on screen (only on plates that have one). */
  private inspectorState(): Partial<ViewSelection> {
    if (!this.stage.dock || !this.api.inspector) return {};
    let v: InspectorView | null = null;
    try { v = this.api.inspector(); } catch { v = null; }
    if (!v) return {};
    const { pinned, locked, side, node, label, section, visible, items, more } = v;
    return { inspector: { pinned, shown: v.shown, locked, side, node, label, section, visible, items, more } };
  }

  snapshot(): ViewSnapshot | null {
    const o = this.outline();
    if (!o) return null;
    return {
      plate: o.kind, title: o.title, nodes: o.nodes, groups: o.groups, tags: o.tags,
      steps: o.steps.map((title, i) => ({ index: i + 1, title })),
      selection: this.selection(),
    };
  }

  /** Words worth biasing the transcriber toward: every label on the plate. */
  vocab(): string[] {
    const o = this.outline();
    if (!o) return [];
    return [...new Set([...o.nodes.map((n) => n.label), ...o.groups.map((g) => g.label), ...o.tags.map((t) => t.label), ...o.steps].filter(Boolean))];
  }

  // ------------------------------------------------------------ resolution
  private candidates(o: PlateOutline, kinds: Kind[]): Candidate<Kind>[] {
    const out: Candidate<Kind>[] = [];
    for (const k of kinds) {
      if (k === 'node') for (const n of o.nodes) out.push({ kind: 'node', id: n.id, label: n.label });
      if (k === 'group') for (const g of o.groups) { out.push({ kind: 'group', id: g.id, label: g.label }); const leaf = g.label.split(' / ').pop()!; if (leaf !== g.label) out.push({ kind: 'group', id: g.id, label: leaf }); }
      if (k === 'tag') for (const t of o.tags) out.push({ kind: 'tag', id: t.id, label: t.label });
      if (k === 'step') o.steps.forEach((s, i) => out.push({ kind: 'step', id: String(i + 1), label: s }));
    }
    return out;
  }
  /** A target by id or label (case and typo tolerant), or a step by number ("3", "step 3", "#3"). */
  private resolve(o: PlateOutline, target: unknown, kinds: Kind[], what = 'target'): { kind: Kind; id: string; label: string } {
    const q = typeof target === 'number' ? String(target) : typeof target === 'string' ? target.trim() : '';
    if (!q) fail(`${what} is required (a name or id on this ${PLATE_NAME[o.kind]})`);
    if (kinds.includes('step') && o.steps.length) {
      const m = q.match(/^(?:step|request|slice|#)?\s*(\d+)$/i);
      if (m) { const i = +m[1]!; if (i >= 1 && i <= o.steps.length) return { kind: 'step', id: String(i), label: o.steps[i - 1]! }; }
    }
    const cands = this.candidates(o, kinds);
    const exact = cands.find((c) => c.id === q);
    if (exact) return exact;
    const hit = best(q, cands);
    if (hit) return hit;
    const near = rank(q, cands).slice(0, 5).map((c) => `${c.label} (${c.kind})`);
    const names = { node: 'nodes', group: 'groups', tag: 'tags', step: `${STEP_NOUN[o.kind]}s` } as const;
    const avail = kinds.map((k) => { const cs = cands.filter((c) => c.kind === k).map((c) => c.label); return cs.length ? `${names[k]}: ${list(cs)}` : ''; }).filter(Boolean);
    return fail(`nothing on this ${PLATE_NAME[o.kind]} is called "${q}"${near.length ? `; closest: ${near.join(', ')}` : ''}. Available ${avail.join('; ') || 'names: none'}`);
  }
  private members(o: PlateOutline, groupId: string) { return o.nodes.filter((n) => n.group === groupId).map((n) => n.id); }
  /** The step (0-based) that features a node: the first at or after the current one, wrapping. */
  private stepWith(o: PlateOutline, id: string, cur: number): number | null {
    const sm = o.stepMembers ?? [];
    for (let k = 0; k < sm.length; k++) { const i = (cur + k) % sm.length; if (sm[i]!.includes(id)) return i; }
    return null;
  }
  private curStep(o: PlateOutline): number {
    const st = this.api.getState?.() ?? {};
    return o.kind === 'trace' ? st.sel ?? -1 : o.kind === 'stack' ? st.cur ?? 0 : st.step ?? 0;
  }
  private goStep(o: PlateOutline, i: number) {
    const a = this.api;
    if (o.kind === 'trace') a.select!(i);
    else a.go!(i);
  }
  private tagId(o: PlateOutline, id: string) { return o.tags.some((t) => t.id === id) ? id : null; }
  private light(ids: string[]) { this.highlighted = [...new Set(ids)]; this.api.highlight!(this.highlighted); }
  private clearLight() { this.highlighted = []; this.api.highlight?.(null); }
  private noSteps(o: PlateOutline): never { return fail(`this ${PLATE_NAME[o.kind]} has no steps${o.kind === 'board' ? '; it has cards (open, focus, highlight), groups (drill) and a legend (highlight {tag})' : ''}`); }

  /** A section of a card by id, title or one of its keywords ("inputs" → the section that lists it among its keywords). */
  private section(secs: SectionInfo[], q: string, label: string): SectionInfo {
    const w = q.trim().toLowerCase().replace(/^(the|its|their|all|all the)\s+/, '');
    const exact = secs.find((x) => x.id.toLowerCase() === w || x.title.toLowerCase() === w || x.keywords.some((k) => k.toLowerCase() === w));
    if (exact) return exact;
    const cands: Candidate<'section'>[] = secs.flatMap((x) => [x.title, x.id, ...x.keywords].map((l) => ({ kind: 'section' as const, id: x.id, label: l })));
    const hit = best(w, cands);
    if (hit) return secs.find((x) => x.id === hit.id)!;
    return fail(`${label} has no section called "${q}"; its sections: ${secs.map((x) => `${x.title}${x.id !== x.title ? ` (${x.id})` : ''}`).join(', ')}`);
  }
  /** An item (an operation, a relationship …) in a card's sections, by name. */
  private item(secs: SectionInfo[], q: string): { sec: SectionInfo; item: string } | null {
    const n = norm(q);
    for (const x of secs) { const it = x.items.find((i) => norm(i) === n); if (it) return { sec: x, item: it }; }
    const cands: Candidate<'item'>[] = secs.flatMap((x) => x.items.map((i) => ({ kind: 'item' as const, id: `${x.id}\u0000${i}`, label: i })));
    const hit = best(q, cands, 0.8);
    if (!hit) return null;
    const [sid, it] = hit.id.split('\u0000');
    return { sec: secs.find((x) => x.id === sid)!, item: it! };
  }
  /** A node named by one of its items ("charge_card" → the card that lists it): exact names only. */
  private nodeOfItem(o: PlateOutline, q: string): { node: string; sec: SectionInfo; item: string } | null {
    const a = this.api, n = norm(q);
    if (!a.sections || !n) return null;
    for (const nd of o.nodes) {
      for (const x of a.sections(nd.id)) { const it = x.items.find((i) => norm(i) === n); if (it) return { node: nd.id, sec: x, item: it }; }
    }
    return null;
  }

  // ------------------------------------------------------------ actions
  /** Run one action. Most answer at once; the ones that read or write files (saving, listing or opening a splice) answer
   *  with a promise. */
  run(name: string, args: Record<string, unknown> = {}): ActionResult | Promise<ActionResult> {
    const o = this.outline();
    if (!o) return { ok: false, error: `this plate (${this.stage.Cls.title || 'a clip'}) is not interactive: Jarvis can only change the theater` + (name === 'theater' ? '' : '; available: theater') };
    const fail = (e: unknown): ActionResult => (e instanceof Fail ? { ok: false, error: e.message } : { ok: false, error: `${name} failed: ${e instanceof Error ? e.message : String(e)}` });
    try {
      if (name.startsWith('splice_')) {
        const r = this.splice(o, name, args ?? {});
        if (r instanceof Promise) return r.then((extra) => ({ ok: true, state: { ...this.selection(), ...(extra ?? {}) } }), fail);
        return { ok: true, state: { ...this.selection(), ...(r ?? {}) } };
      }
      this.apply(o, name, args ?? {});
      return { ok: true, state: this.selection() };
    } catch (e) { return fail(e); }
  }

  // ------------------------------------------------------------ splices (docs/JARVIS.md "Splices")
  /** A node on the plate (the spliced one: proposed cards count) by id or label, loosely. */
  private nodeRef(o: PlateOutline, ref: unknown, what: string): string { return this.resolve(o, ref, ['node'], what).id; }
  /** A group on the board (the model's or one the splice proposes) by id or name, loosely. */
  private groupRef(o: PlateOutline, ref: unknown, what: string): string { return this.resolve(o, ref, ['group'], what).id; }
  /** A node, else a group when no node has that name (rename / remove act on either). */
  private nodeOrGroup(o: PlateOutline, ref: unknown, what: string): { node?: string; group?: string } {
    try { return { node: this.nodeRef(o, ref, what) }; } catch (e) {
      if (!(e instanceof Fail)) throw e;
      const q = typeof ref === 'string' ? ref.replace(/\s+group\s*$/i, '') : ref;
      try { return { group: this.groupRef(o, q, what) }; } catch { throw e; }
    }
  }
  /** Where the board is, in words, and what the level shows (for a caption that says only what is on screen). */
  private levelWords(): string {
    const l = this.board.level?.();
    if (!l || l.view !== 'groups') return '';
    const here = l.at === null ? 'on the overview of all groups' : `inside ${l.path.slice(1).join(' › ')}${l.proposed ? ' (a proposed group)' : ''}`;
    const o = this.outline(), name = (id: string) => o?.nodes.find((n) => n.id === id)?.label ?? id;
    const cards = l.cards.map(name), gs = l.groups.map((g) => `${g.label}${g.proposed ? ' (proposed)' : ''}`);
    const what = [cards.length ? `cards: ${list(cards)}` : l.at !== null && !gs.length ? 'no cards yet' : '', gs.length ? `groups: ${list(gs)}` : ''].filter(Boolean).join('; ');
    const ins = l.stubs.filter((t) => t.side === 'in').map((t) => t.label), outs = l.stubs.filter((t) => t.side === 'out').map((t) => t.label);
    const edges = [ins.length ? `${list(ins)} call${ins.length === 1 ? 's' : ''} in (left)` : '', outs.length ? `it calls ${list(outs)} (right)` : ''].filter(Boolean).join('; ');
    return `${here}: ${what || 'nothing on this level'}${edges ? `; at the edges: ${edges}` : ''}`;
  }
  private kindOf<T extends string>(v: unknown, all: readonly T[], what: string, dflt?: T): T | undefined {
    if (v === undefined || v === null || v === '') return dflt;
    const k = String(v).trim().toLowerCase() as T;
    if (!all.includes(k)) fail(`${what} "${String(v)}" isn't one of ${all.join(', ')}`);
    return k;
  }
  /** Apply one change; a change the splice can't apply fails with why (and the core's hint: a did-you-mean). */
  private change(op: SpliceOp): Partial<ViewSelection> {
    const r = this.api.spliceOp!(op);
    if (!r.applied) fail(`not applied: ${r.warnings.join('; ') || 'nothing changed'}`);
    return r.warnings.length ? { spliceNote: r.warnings.join('; ') } : {};
  }
  private splice(o: PlateOutline, name: string, args: Record<string, unknown>): Partial<ViewSelection> | void | Promise<Partial<ViewSelection> | void> {
    const a = this.board;
    if (!a.spliceOpen) fail(`splices are for structure boards (this is a ${PLATE_NAME[o.kind]})`);
    if (name.startsWith('splice_stack')) return this.stack(name, args);
    const sv = a.spliceStackView?.();
    if (sv?.shown && SPLICE_CHANGES.includes(name)) fail('the stack of splices is on screen: splice_stack_open a slice first (it opens that splice on the board), then change it');
    if (sv?.shown && (name === 'splice_open' || name === 'splice_leave' || name === 'splice_discard')) a.spliceStackLeave!();
    const open = a.spliceView!();
    const need = () => { if (!a.spliceView!()) fail('no splice is open: splice_open first ("open this view in a new splice")'); };
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    switch (name) {
      case 'splice_open': {
        const nm = str(args.name ?? args.title);
        const fresh = args.new === true || args.fresh === true;
        if (open?.dirty) fail(`the splice "${open.title}" is open with unsaved changes; splice_save it, or splice_leave {force: true} to drop them`);
        if (nm && !fresh && a.spliceOpenSaved) {
          return a.spliceOpenSaved(nm).then((r) => {
            if (r.ok) { const lw = this.levelWords(); return { spliceNote: `opened the saved splice "${r.view!.title}" over the current code${r.view!.home ? `, in the view it lives in (${r.view!.home})` : ''}${lw ? `; now ${lw}` : ''}` }; }
            if (!/^no saved splice/.test(r.error ?? '')) fail(r.error ?? 'could not open it');
            if (open) a.spliceLeave!(true);
            a.spliceOpen!({ title: nm });
            return { spliceNote: `new splice "${nm}" (no saved one had that name)` };
          });
        }
        if (open) a.spliceLeave!(true);
        // "splice the orders group": go there first, then open it in that view
        const g = args.group ?? args.at;
        if (g !== undefined && g !== null && g !== '') {
          if (typeof g === 'string' && /^(top|all|all groups|overview|the overview|the top|none)$/i.test(g.trim())) a.enter?.(null);
          else if (!a.enter?.(this.groupRef(o, g, 'group'))) fail('this board has no groups to show');
        }
        a.spliceOpen!(nm ? { title: nm } : {});
        const w = a.spliceView!()?.where;
        return { spliceNote: `a new splice${nm ? ` "${nm}"` : ''} of this view${w ? `, ${w === 'All groups' ? 'the overview of all groups' : w === 'every card' ? 'every card' : `inside ${w}`}` : ''}: proposals only, nothing real changes; it remembers this view` };
      }
      case 'splice_add': {
        need();
        const label = str(args.label ?? args.name);
        if (!label) fail('splice_add needs a label (the new node\'s name)');
        const node: SpliceAddOp['node'] = { label };
        const kind = this.kindOf(args.kind, NODE_KINDS, 'kind'); if (kind) node.kind = kind;
        if (str(args.category)) node.category = str(args.category);
        if (str(args.group)) node.group = this.groupRef(o, str(args.group), 'group');
        if (str(args.summary)) node.summary = str(args.summary);
        const op: SpliceAddOp = { op: 'add', node };
        const places = ['between', 'before', 'after', 'attach'].filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== '');
        // inside a group, a new card joins it (inside a proposed group always; else when it isn't placed next to others)
        const lv = a.level?.();
        if (!node.group && lv?.view === 'groups' && lv.at !== null && (!places.length || lv.proposed)) node.group = lv.at;
        if (places.length > 1) fail(`give one place for ${label}: between, before, after or attach (got ${places.join(' and ')})`);
        if (args.between !== undefined && args.between !== null) {
          const bw = Array.isArray(args.between) ? args.between : typeof args.between === 'string' ? args.between.split(/\s+and\s+|,/) : [];
          if (bw.length !== 2) fail('between takes two nodes, e.g. ["Checkout", "Orders store"]');
          op.between = [this.nodeRef(o, bw[0], 'between[0]'), this.nodeRef(o, bw[1], 'between[1]')];
        } else if (str(args.before)) op.before = this.nodeRef(o, args.before, 'before');
        else if (str(args.after)) op.after = this.nodeRef(o, args.after, 'after');
        else if (args.attach && typeof args.attach === 'object') {
          const at = args.attach as Record<string, unknown>;
          const att: SpliceAttach = { to: this.nodeRef(o, at.to, 'attach.to') };
          if (at.dir !== undefined) { const d = str(at.dir); if (d !== 'in' && d !== 'out') fail('attach.dir is "out" (the new node calls it) or "in" (it calls the new node)'); att.dir = d as 'in' | 'out'; }
          const ek = this.kindOf(at.kind, EDGE_KINDS, 'attach.kind'); if (ek) att.kind = ek;
          op.attach = att;
        }
        const r = this.change(op);
        const v = a.spliceView!();
        return { ...r, spliceNote: [r.spliceNote, v?.last ? `proposed: ${v.last}` : ''].filter(Boolean).join('; ') };
      }
      case 'splice_group': {
        // a new group, optionally its first card and one relationship (outlet_of X: X calls into it; inlet_of X: it calls X);
        // then, unless show is false, slide into its scene and say what is there
        need();
        const label = str(args.label ?? args.name);
        if (!label) fail('splice_group needs a label (the new group\'s name)');
        const lv = a.level?.();
        if (!lv?.available) fail('this board has no groups to show; splice_add with a group puts a card in a new group');
        const pr = args.parent ?? args.under ?? args.in;
        const parent = pr === undefined || pr === null || pr === '' ? (lv!.view === 'groups' ? lv!.at : null)
          : typeof pr === 'string' && /^(top|none|all groups|the top|top level|overview|the overview)$/i.test(pr.trim()) ? null : this.groupRef(o, pr, 'parent');
        const ofO = str(args.outlet_of), ofI = str(args.inlet_of);
        if (ofO && ofI) fail('give one of outlet_of (it calls into the new group) or inlet_of (the new group calls it)');
        const ek = this.kindOf(args.kind, EDGE_KINDS, 'kind');
        const attach: SpliceAttach | undefined = ofO ? { to: this.nodeRef(o, ofO, 'outlet_of'), dir: 'in', ...(ek ? { kind: ek } : {}) } : ofI ? { to: this.nodeRef(o, ofI, 'inlet_of'), dir: 'out', ...(ek ? { kind: ek } : {}) } : undefined;
        const first = str(args.first);
        const fk = this.kindOf(args.first_kind, NODE_KINDS, 'first_kind');
        const op = spliceOp.group(label, { ...(parent ? { parent } : {}), ...(attach ? { attach } : {}), ...(first ? { first: { label: first, ...(fk ? { kind: fk } : {}) } } : {}), taken: o.groups.map((g) => g.id) });
        if (op.first) op.first.id = spliceOp.add(first, null, { taken: o.nodes.map((n) => n.id) }).node.id;
        const r = this.change(op);
        const v = a.spliceView!();
        const gid = op.group.id!;
        const show = !(args.show === false || args.show === 'false');
        if (show) a.enter!(gid);
        const did = `proposed: ${v?.last ?? `Add group ${label}`} (a proposal, not in the code)`;
        return { ...r, spliceNote: [r.spliceNote, did, show ? `now ${this.levelWords()}` : `${(parent ?? null) === (lv!.view === 'groups' ? lv!.at : null) ? 'it is on this level' : `it is inside ${o.groups.find((g) => g.id === parent)?.label ?? parent}`} as a proposed group card; drill {group: "${label}"} goes into it`].filter(Boolean).join('. ') };
      }
      case 'splice_connect': {
        need();
        const kind = this.kindOf(args.kind, EDGE_KINDS, 'kind', 'calls')!;
        return this.change({ op: 'connect', from: this.nodeRef(o, args.from, 'from'), to: this.nodeRef(o, args.to, 'to'), kind, ...(str(args.label) ? { label: str(args.label) } : {}) });
      }
      case 'splice_disconnect': need(); return this.change({ op: 'disconnect', from: this.nodeRef(o, args.from, 'from'), to: this.nodeRef(o, args.to, 'to') });
      case 'splice_remove': {
        need();
        if (str(args.group)) return this.change({ op: 'remove', group: this.groupRef(o, args.group, 'group') });
        const t = this.nodeOrGroup(o, args.node ?? args.target, 'node');
        return this.change(t.group ? { op: 'remove', group: t.group } : { op: 'remove', node: t.node! });
      }
      case 'splice_replace': {
        // swap a node for a new one (with: its label) or for one on the plate (existing: true): it takes over every relationship
        need();
        const node = this.nodeRef(o, args.node ?? args.target, 'node');
        const w = str(args.with ?? args.label ?? args.by);
        if (!w) fail('splice_replace needs with: the new node\'s name (or a node on the plate, with existing: true)');
        if (args.existing === true) return this.change({ op: 'replace', node, with: this.nodeRef(o, w, 'with') });
        const nd: SpliceAddOp['node'] = { label: w };
        const kind = this.kindOf(args.kind, NODE_KINDS, 'kind'); if (kind) nd.kind = kind;
        if (str(args.summary)) nd.summary = str(args.summary);
        return this.change({ op: 'replace', node, with: nd });
      }
      case 'splice_rename': {
        need();
        const label = str(args.label ?? args.to);
        if (!label) fail('splice_rename needs the new label');
        if (str(args.group)) return this.change({ op: 'rename', group: this.groupRef(o, args.group, 'group'), label });
        const t = this.nodeOrGroup(o, args.node ?? args.target, 'node');
        return this.change(t.group ? { op: 'rename', group: t.group, label } : { op: 'rename', node: t.node!, label });
      }
      case 'splice_move': {
        need();
        const g = str(args.group);
        if (!g) fail('splice_move needs a group');
        const known = o.groups.find((x) => norm(x.id) === norm(g) || norm(x.label) === norm(g));
        return this.change({ op: 'move', node: this.nodeRef(o, args.node ?? args.target, 'node'), group: known?.id ?? g });
      }
      case 'splice_undo': need(); if (!a.spliceUndo!()) fail('nothing to undo in this splice'); return;
      case 'splice_redo': need(); if (!a.spliceRedo!()) fail('nothing to redo'); return;
      case 'splice_save': {
        need();
        return a.spliceSave!(str(args.name ?? args.title) || undefined).then((r) => {
          if (!r.ok) fail(`not saved: ${r.error}${/name/.test(r.error ?? '') ? ' (pass name)' : ''}`);
          return { spliceNote: `saved to ${r.file}` };
        });
      }
      case 'splice_leave': {
        if (!open) fail('no splice is open; this is the real view');
        if (!a.spliceLeave!(args.force === true || args.discard === true)) fail(`the splice "${open!.title}" has unsaved changes (${open!.ops}); splice_save first, or splice_leave {force: true} to drop them`);
        return { spliceNote: `left the splice "${open!.title}"; this is the real view` };
      }
      case 'splice_discard': {
        if (!open) fail('no splice is open');
        return a.spliceDiscard!(true).then((r) => ({ spliceNote: `discarded "${open!.title}"${r.deleted ? ` and deleted ${r.deleted}` : ''}${r.error ? `; ${r.error}` : ''}` }));
      }
      case 'splice_list': {
        return a.spliceList!().then((r) => {
          if (!r.ok) fail(r.error ?? 'the splices can\'t be listed');
          return { splices: r.entries.map((e) => ({ id: e.id, title: e.title, ops: e.ops, landed: e.landed, noLongerApply: e.warnings, updated: e.updated ?? null, file: e.file })) };
        });
      }
    }
    return fail(`unknown splice action "${name}"; actions: ${SPLICE_ACTIONS.join(', ')}`);
  }

  /** A stack of splices (docs/JARVIS.md): stack them, open a slice on the board, back to the stack, leave it. */
  private stack(name: string, args: Record<string, unknown>): Partial<ViewSelection> | Promise<Partial<ViewSelection>> {
    const a = this.board;
    const names = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? v.split(/\s*(?:,|\band\b|\+|&)\s*/i) : []).map((x) => x.trim()).filter(Boolean);
    const words = (v: SpliceStackState) => {
      const sl = v.slices.map((x) => `${x.index} ${x.title}${x.kind === 'combined' ? ' (combined, read-only)' : x.unsaved ? ' (unsaved)' : ''}${x.warning ? ` ${x.warning}` : ''}`);
      const ord = v.order ? ` The combination applies ${v.order.now.join(', then ')}; ${v.order.matters ? `the order matters: this order ${v.order.gives ?? 'gives one thing'}, ${v.order.other.join(', then ')} ${v.order.otherGives ?? 'gives another'}` : 'the other order gives the same result'}.` : '';
      return `slices: ${sl.join('; ')}. On slice ${v.cur}, ${v.slices[v.cur - 1]?.title ?? ''}.${ord}`;
    };
    switch (name) {
      case 'splice_stack': {
        const list = names(args.splices ?? args.names ?? args.name);
        const comb = args.combine === true || args.combine === 'true' ? true : names(args.combine);
        const combine = comb === true ? true : comb.length ? comb : undefined;
        return a.spliceStack!({ ...(list.length ? { names: list } : {}), ...(combine ? { combine } : {}) }).then((r) => {
          if (!r.ok) fail(r.error ?? 'the splices can\'t be stacked');
          return { spliceNote: `stacked the splices over the real view: ${words(r.view!)}` };
        });
      }
      case 'splice_stack_open': {
        const ref = args.slice ?? args.name ?? args.splice ?? args.index;
        if (ref === undefined || ref === null || ref === '') fail('splice_stack_open needs slice: a number, a splice\'s name, "real" or "combined"');
        const r = a.spliceStackOpen!(typeof ref === 'number' ? ref : String(ref));
        if (!r.ok) fail(r.error ?? 'no such slice');
        return { spliceNote: r.view ? `opened "${r.view.title}" on the board, ready to edit${r.view.dirty ? ' (with its unsaved changes)' : ''}; Esc goes back to the stack` : 'the real view, on the board; Esc goes back to the stack' };
      }
      case 'splice_stack_return': {
        const v = a.spliceStackView!();
        if (!v) fail('there is no stack of splices to go back to; splice_stack makes one');
        if (v!.shown) fail('the stack is already on screen');
        a.spliceStackReturn!();
        return { spliceNote: `back to the stack: ${words(a.spliceStackView!()!)}` };
      }
      case 'splice_stack_conflict': {
        // light one conflict of the combined slice and open its card (the words it shows are in spliceStack.explained)
        const v = a.spliceStackView!();
        if (!v) fail('there is no stack of splices: splice_stack {splices, combine: true} combines two and shows their conflicts');
        const cs = v!.explained, ci = v!.slices.findIndex((x) => x.kind === 'combined');
        if (ci < 0) fail('no splices are combined in this stack: splice_stack with combine: true first');
        if (!cs.length) fail(`${v!.slices[ci]!.title}: combining found nothing to report (no conflicts, consequences or notes); its splices change different things`);
        if (!v!.shown) fail('the stack is not on screen (a slice is open on the board): splice_stack_return first');
        const plate = a.spliceStackPlate!() as AnyPlate | null;
        if (!plate?.showWarning || !plate.go) fail('the stack can\'t show its conflicts');
        const key = ['n', 'conflict', 'index', 'what'].find((k) => k in args), raw = key ? args[key] : undefined;
        if (raw === null || raw === 0 || raw === false || raw === 'none' || raw === 'close') { plate!.showWarning!(null); return { spliceNote: 'closed the conflict card; no conflict is lit' }; }
        let n = raw === undefined || raw === '' ? 1 : typeof raw === 'number' || /^\s*#?\d+\s*$/.test(String(raw)) ? Math.round(Number(String(raw).replace('#', ''))) : 0;
        if (!n) {
          // words: the conflict whose contested thing shares the most words with them ("the report renderer one")
          const ws = (x: string) => norm(x).split(/\s+/).filter((w) => w.length > 2 && !['the', 'one', 'conflict', 'and', 'with', 'between'].includes(w));
          const q = ws(String(raw)), score = cs.map((c) => { const t = ws(`${c.what} ${c.splices.join(' ')}`); return q.filter((w) => t.some((x) => x === w || x.startsWith(w) || w.startsWith(x))).length; });
          const top = Math.max(0, ...score);
          n = top > 0 && score.filter((x) => x === top).length === 1 ? score.indexOf(top) + 1 : 0;
        }
        if (n < 1 || n > cs.length) fail(`no item "${String(raw)}"; the combined slice lists: ${cs.map((c) => `${c.n} ${c.what} (${c.kind})`).join('; ')}`);
        if (v!.cur !== ci + 1) plate!.go!(ci);
        plate!.showWarning!(n - 1);
        const c = cs[n - 1]!;
        return { spliceNote: `item ${n} of ${cs.length} (${c.kind}) is lit, its card open: ${c.what}. ${c.parts.map((p) => `${p.splice}: ${p.does}`).join('. ')}. ${c.result}` };
      }
      case 'splice_stack_swap': {
        const v = a.spliceStackView!();
        if (!v) fail('there is no stack of splices: splice_stack {splices, combine: true} combines two');
        if (!v!.order) fail('no splices are combined in this stack: splice_stack with combine: true first');
        const r = a.spliceStackSwap!();
        if (!r.ok) fail(r.error ?? 'the order can\'t be swapped');
        const w = r.view!.order!;
        return { spliceNote: `now ${w.now.join(', then ')}: ${w.matters ? `the order matters: this order ${w.gives ?? 'gives something else'}, the other ${w.otherGives ?? 'gave something else'}` : 'the same result as the other order'}` };
      }
      case 'splice_stack_same': {
        const v = a.spliceStackView!();
        if (!v?.order) fail('no splices are combined: splice_stack {splices, combine: true} first');
        const raw = args.n ?? args.what ?? args.item;
        const same = !(args.same === false || args.same === 'false' || args.different === true);
        const r = a.spliceStackSame!(typeof raw === 'number' ? raw : raw === undefined || raw === null ? undefined : String(raw), same);
        if (!r.ok) fail(r.error ?? 'no two proposals with one name to treat as the same');
        const it = r.view!.explained.find((x) => x.kind === (same ? 'same thing' : 'same name'));
        return { spliceNote: `${same ? 'treated them as the same thing, in this combination only (neither splice file changes)' : 'treated them as different things again'}${it ? `: ${it.what}. ${it.result}` : ''}` };
      }
      case 'splice_stack_leave': {
        if (!a.spliceStackView!()) fail('there is no stack of splices open');
        a.spliceStackLeave!();
        const sp = a.spliceView!();
        return { spliceNote: `left the stack; the board shows ${sp ? `the splice "${sp.title}"${sp.dirty ? ' (unsaved changes)' : ''}` : 'the real view'}` };
      }
    }
    return fail(`unknown action "${name}"`);
  }

  private apply(o: PlateOutline, name: string, args: Record<string, unknown>): void {
    const a = this.api, k = o.kind, P = PLATE_NAME[k];
    const onArg = (v: unknown, cur: boolean) => (typeof v === 'boolean' ? v : v === undefined || v === null ? !cur : v === 'on' || v === 'true' || v === 1);
    switch (name) {
      case 'focus': {
        const kinds: Kind[] = k === 'tour' ? ['node', 'step'] : k === 'board' ? ['node', 'group', 'tag'] : ['node', 'group', 'tag', 'step'];
        const t = this.resolve(o, args.target ?? args.node ?? args.name, kinds);
        if (t.kind === 'step') return this.goStep(o, +t.id - 1);
        if (t.kind === 'tag') { this.highlighted = []; return a.focusTag!(t.id); }
        if (t.kind === 'group') {
          if (k === 'board') return a.drill!(t.id);
          const g = this.tagId(o, `group:${t.id}`);
          if (g) { this.highlighted = []; return a.focusTag!(g); }
          return this.light(this.members(o, t.id));
        }
        // a node
        if (k === 'board') return a.reveal!(t.id);
        if (k === 'tour') {
          const i = this.stepWith(o, t.id, this.curStep(o));
          if (i === null) fail(`no step of this tour shows ${t.label}`);
          return a.go!(i!);
        }
        if (k === 'explainer') {
          const cur = this.curStep(o);
          if (!(o.stepMembers?.[cur] ?? []).includes(t.id)) { const i = this.stepWith(o, t.id, cur); if (i !== null) a.go!(i); }
        }
        return this.light([t.id]);
      }
      case 'open':
      case 'show_details': {
        const kinds: Kind[] = k === 'board' ? ['node'] : k === 'stack' ? ['step'] : ['node', 'step'];
        const raw = args.node ?? args.target ?? args.name;
        if (k === 'stack' && raw !== undefined && typeof raw === 'string' && !/^\s*(?:slice\s*|#)?\d+\s*$/i.test(raw) && !o.steps.some((s) => s.toLowerCase() === raw.toLowerCase())) {
          const tryNode = rank(raw, this.candidates(o, ['node']))[0];
          if (tryNode && tryNode.score >= 0.62) fail(`cards don't open on a Stack view; focus {target: "${tryNode.label}"} or highlight {nodes: ["${tryNode.label}"]} lights it, step {to} changes the slice`);
        }
        if (k === 'board' && name === 'show_details') return this.showDetails(o, raw, args);
        const t = this.resolve(o, raw, kinds, 'node');
        if (t.kind === 'step') {
          if (k === 'stack') { a.fan!(false); }
          return this.goStep(o, +t.id - 1);
        }
        if (k === 'board') return a.reveal!(t.id);
        if (k === 'trace' || k === 'tour') {
          // the next request (step) that touches it, after the current one: asking again walks through them
          const cur = this.curStep(o);
          const i = this.stepWith(o, t.id, k === 'trace' ? cur + 1 : cur);
          if (i === null) fail(`no ${STEP_NOUN[k]} on this ${P} touches ${t.label}`);
          return this.goStep(o, i!);
        }
        // explainer: bring it on screen and light it
        return this.apply(o, 'focus', { target: t.id });
      }
      case 'scroll': {
        if (k !== 'board' || !a.scrollDetails) fail(`only a structure board's open card scrolls (this is a ${P})`);
        const st = a.getState!();
        const held = a.inspector?.();
        const on = st.open ?? held?.node ?? null;
        if (!on) fail('no card is open; show_details {node, section} opens one');
        const to = String(args.to ?? args.item ?? 'down').trim();
        const dir = /^(down|next|more|page down|further)$/i.test(to) ? 'down' : /^(up|back up|previous|page up)$/i.test(to) ? 'up' : /^(top|start|beginning|first)$/i.test(to) ? 'top' : /^(bottom|end|last)$/i.test(to) ? 'bottom' : null;
        if (dir) {
          if (!a.scrollDetails!(dir)) fail(`the details are already at the ${dir === 'down' || dir === 'bottom' ? 'bottom' : 'top'} (nothing more to scroll to)`);
          return;
        }
        const secs = a.sections!(on), hit = this.item(secs, to);
        if (!hit) fail(`nothing called "${to}" in ${this.outlineLabel(o, on)}'s details; scroll {to} takes down, up, top, bottom or an item: ${secs.flatMap((x) => x.items).slice(0, LIST_MAX).join(', ') || 'none'}`);
        // the section on screen (a section view, or the inspector's) must be the item's
        const cur = st.open ? (a.detailsView?.()?.section ?? st.section ?? null) : held?.section ?? null;
        if (st.open && cur && cur !== hit!.sec.id) a.openDetails!(st.open, hit!.sec.id);
        if (!st.open && cur !== hit!.sec.id) fail(`${hit!.item} is in ${hit!.sec.title}, but the locked inspector shows ${cur}; unlock it or open that section`);
        a.scrollDetails!({ item: hit!.item });
        return;
      }
      case 'close': {
        if (k === 'board') return a.close!();
        if (k === 'trace') return a.select!(null);
        if (k === 'stack') return a.fan!(false);
        return;                                          // tours and explainers have nothing that opens
      }
      case 'drill': {
        // a sequence diagram: expand a folded lane into its members ("expand the stages"); out folds them back
        if (k === 'sequence' && a.expand) {
          const g = args.group ?? args.target, fs = a.folds?.() ?? [];
          if (!fs.length) fail('this sequence diagram has no folded lanes to expand');
          if (g === null || g === undefined || (typeof g === 'string' && /^(out|none|up|back|)$/i.test(g.trim()))) { if (!a.collapse!(null)) fail('no folded lane is expanded'); return; }
          if (a.expand(String(g))) return;
          const t = this.resolve(o, g, ['group'], 'folded lane');
          if (!a.expand(t.id)) fail(`${t.label} is already expanded; back (or drill {group: "out"}) folds it`);
          return;
        }
        if (k !== 'board') fail(`only the structure board drills into groups (this is a ${P}); highlight {tag: "group:<id>"} or focus {target: <group>} lights a group here`);
        const g = args.group ?? args.target;
        if (g === null || g === undefined || (typeof g === 'string' && /^(out|none|up|back|up a level|)$/i.test(g.trim()))) {
          if (a.level?.().view === 'groups' && a.level().at === null) fail('already at the top: the overview of all groups');
          return a.drill!(null);
        }
        // the groups view's overview ("all groups", "the top")
        if (typeof g === 'string' && /^(top|all|all groups|overview|the overview|the top|groups|top level)$/i.test(g.trim())) { if (!a.enter?.(null)) fail('this board has no groups to show'); return; }
        return a.drill!(this.resolve(o, g, ['group'], 'group').id);
      }
      case 'back': {
        if (k === 'board' || k === 'trace') {
          if (a.back!()) { if (!(a.getState?.().pins ?? []).includes(HIGHLIGHT)) this.highlighted = []; return; }
          return fail(`nothing to step out of on this ${P} (no open ${k === 'board' ? 'panel, pins or drill' : 'request or pins'})`);
        }
        if (k === 'stack') {
          const st = a.getState!();
          if (st.fan) return a.fan!(false);
          if (st.pins.length) { this.clearLight(); return a.focusTag!(null); }
          // a board's stack of splices: back leaves it, as Esc does
          if (this.board.spliceStackLeave && this.board.spliceStackPlate?.()) { this.board.spliceStackLeave(); return; }
          return fail('nothing to step out of on this Stack view; step {to: "prev"} goes to the previous slice');
        }
        if (k === 'explainer' && (a.getState!().pins ?? []).length) { this.clearLight(); return a.focusTag!(null); }
        if (k === 'sequence') {
          // "collapse the stages": fold what was expanded, else clear the pins
          if ((a.folds?.() ?? []).some((f) => f.expanded)) { a.collapse!(null); return; }
          if ((a.getState!().pins ?? []).length) { this.clearLight(); return a.focusTag!(null); }
        }
        return fail(`nothing to step out of on this ${P}; step {to: "prev"} goes to the previous step`);
      }
      case 'highlight': {
        if (!a.highlight) fail(`this ${P} has no legend to highlight; focus {target} goes to the step that shows a node`);
        const nodes = args.nodes ?? args.node;
        const names = Array.isArray(nodes) ? nodes : typeof nodes === 'string' && nodes ? [nodes] : [];
        if (names.length) return this.light(names.map((n) => this.resolve(o, n, ['node'], 'node').id));
        const tag = args.tag ?? args.target;
        if (tag === undefined || tag === null || tag === '') fail(`highlight needs tag or nodes. Tags: ${list(o.tags.map((t) => t.label))}`);
        const t = this.resolve(o, tag, ['tag', 'group'], 'tag');
        if (t.kind === 'group') {
          const g = this.tagId(o, `group:${t.id}`);
          if (g) { this.highlighted = []; return a.focusTag!(g); }
          return this.light(this.members(o, t.id));
        }
        this.highlighted = [];
        return a.focusTag!(t.id);
      }
      case 'clear': {
        this.clearLight();
        a.focusTag?.(null);
        return;
      }
      case 'step': {
        if (!o.steps.length || k === 'board') this.noSteps(o);
        const to = args.to ?? args.index ?? args.step;
        const n = o.steps.length, cur = this.curStep(o);
        let i: number;
        if (to === 'next') i = k === 'trace' && cur < 0 ? 0 : cur + 1;
        else if (to === 'prev' || to === 'previous') i = k === 'trace' && cur < 0 ? n - 1 : cur - 1;
        else if (to === 'first') i = 0;
        else if (to === 'last') i = n - 1;
        else if (typeof to === 'number' || (typeof to === 'string' && /^\d+$/.test(to.trim()))) i = +to - 1;
        else if (typeof to === 'string') i = +this.resolve(o, to, ['step'], 'step').id - 1;
        else return fail(`step needs to: a number 1–${n}, "next" or "prev"`);
        if (i < 0 || i >= n) fail(`${STEP_NOUN[k]} ${i + 1} doesn't exist: this ${P} has ${n} ${STEP_NOUN[k]}${n === 1 ? '' : 's'} (1–${n}), on ${Math.max(cur, 0) + 1} now`);
        return this.goStep(o, i);
      }
      case 'select': {
        if (!o.steps.length || k === 'board') this.noSteps(o);
        const idx = args.index ?? args.to;
        if (idx === null || idx === undefined) {
          if (k === 'trace') return a.select!(null);
          return fail(`select {index: null} (the whole trace) is for trace boards; this ${P} is always on one ${STEP_NOUN[k]}`);
        }
        return this.apply(o, 'step', { to: idx });
      }
      case 'theater': return this.page.setTheater(onArg(args.on, this.page.theater()));
      // group navigation: one card per group (entered level by level), or every card
      case 'groups': {
        if (k !== 'board' || !a.groupView) fail(`only a structure board has a groups view (this is a ${P})`);
        const l = a.level!();
        if (!l.available) fail('this board has no groups to show: every card is on it already');
        const on = onArg(args.on ?? (typeof args.view === 'string' ? args.view !== 'cards' : undefined), l.view !== 'groups');
        a.groupView!(on ? 'groups' : 'cards');
        if (on && a.level!().at !== null && args.top !== false) a.enter!(null);
        return;
      }
      case 'fan': {
        if (k !== 'stack') fail(`only a Stack view fans out (this is a ${P})`);
        return a.fan!(onArg(args.on, !!a.getState!().fan));
      }
      case 'bench': {
        if (!this.stage.Cls.bench) fail(`this ${P} has no Bench (it can't be rearranged)`);
        return this.stage.bench(onArg(args.on, this.stage.inBench));
      }
      // zoom and pan (docs/ENGINE.md "Zoom and pan"): the view only, never the plate's state
      case 'zoom': {
        const v = this.stage.view;
        if (!v.enabled) fail(`this ${P} doesn't zoom`);
        const target = args.target ?? args.node;
        const pct = typeof args.to === 'number' ? args.to : typeof args.to === 'string' && /^\d+(\.\d+)?\s*%?$/.test(args.to.trim()) ? parseFloat(args.to) : null;
        if (target !== undefined && target !== null && target !== '') {
          const t = this.resolve(o, target, k === 'board' ? ['node', 'group'] : ['node'], 'target');
          const el = this.elementOf(t.kind, t.id);
          if (!el) fail(`${t.label} isn't drawn on screen right now${k === 'board' ? ' (inside a group you drilled out of, or folded)' : ''}`);
          return v.focusEl(el!, pct ? pct / 100 : undefined);
        }
        const to = typeof args.to === 'string' ? args.to.trim().toLowerCase() : 'in';
        if (pct !== null) return v.zoomTo(pct / 100);
        if (to === 'in') return v.zoomIn();
        // "zoom out" at fit keeps its old meaning: back to the overview
        if (to === 'out') return v.zoomed ? v.zoomOut() : this.apply(o, 'clear', {});
        if (to === 'fit' || to === 'reset' || to === '100%') return v.reset();
        return fail(`zoom {to} is "in", "out", "fit" or a percentage (100 = fit, up to 400); or zoom {target} centres a card`);
      }
      case 'pan': {
        const v = this.stage.view;
        const d = typeof args.direction === 'string' ? args.direction.trim().toLowerCase() : typeof args.to === 'string' ? args.to.trim().toLowerCase() : '';
        const dirs: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
        if (!dirs[d]) fail(`pan {direction} is left, right, up or down, not "${String(args.direction ?? args.to ?? '')}"`);
        if (!v.zoomed) fail('the plate is at fit: the whole of it is on screen, so there is nothing to pan; zoom in first');
        const r = v.rect(), f = typeof args.amount === 'number' && args.amount > 0 ? Math.min(1, args.amount) : 0.4, [dx, dy] = dirs[d]!;
        return v.set({ x: r.x + dx * r.w * f, y: r.y + dy * r.h * f });
      }
      case 'pin_inspector': {
        const d = this.stage.dock;
        if (!d) fail(`this ${P} has no inspector to pin (structure boards and trace boards have one)`);
        if (!d!.available) fail('the inspector pins beside the window only while the plate fills it (theater)');
        const side = typeof args.side === 'string' ? args.side.trim().toLowerCase() : '';
        if (side && side !== 'left' && side !== 'right') fail(`side is "left" or "right", not "${args.side}"`);
        // lock or side alone keep it pinned (and pin it when it wasn't)
        const on = args.on === undefined && (args.lock !== undefined || side) ? true : onArg(args.on, d!.pinned);
        if (!on && args.lock === true) fail('an unpinned inspector cannot be locked; pin it first');
        if (side) d!.setSide(side as 'left' | 'right');
        d!.pin(on);
        if (on && args.lock !== undefined && args.lock !== null) {
          const lock = onArg(args.lock, d!.locked);
          if (!d!.lock(lock)) fail(`nothing to lock: the inspector shows no ${k === 'trace' ? 'request (select one first)' : 'card (show_details opens one)'}`);
        }
        return;
      }
      default:
        return fail(`unknown action "${name}"; actions: focus, open, close, drill, back, groups, highlight, clear, show_details, scroll, step, select, theater, fan, bench, pin_inspector, zoom, pan, ${SPLICE_ACTIONS.join(', ')}`);
    }
  }
  /** The element that draws a node (or a board's group) on screen: the first one with a size and not hidden. */
  private elementOf(kind: Kind, id: string): Element | null {
    const dom = this.stage.dom, q = CSS.escape(id);
    const sels = kind === 'group' ? [`#${cssId(`·g:${id}`)}`, `#g-${cssId(id)}`] : [`.mm-card[data-node="${q}"]`, `#${cssId(id)}`, `[data-node="${q}"]`, `[data-id="${q}"]`];
    for (const sel of sels) {
      for (const e of dom.querySelectorAll(sel)) {
        const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && +cs.opacity > 0.05) return e;
      }
    }
    return null;
  }

  private outlineLabel(o: PlateOutline, id: string) { return o.nodes.find((n) => n.id === id)?.label ?? id; }
  /** show_details on a structure board: {node, section?, item?}. A node may be named by one of its items. */
  private showDetails(o: PlateOutline, raw: unknown, args: Record<string, unknown>): void {
    const a = this.api;
    const q = typeof raw === 'string' ? raw.trim() : '';
    let node: string, sec: SectionInfo | null = null, item: string | null = null;
    // a node's own id or label wins; then an item named exactly (a tool, say); then the usual loose match on nodes
    const own = q && o.nodes.some((n) => n.id === q || norm(n.label) === norm(q));
    const byItem = q && !own ? this.nodeOfItem(o, q) : null;
    if (byItem) ({ node, sec, item } = { node: byItem.node, sec: byItem.sec, item: byItem.item });
    else node = this.resolve(o, raw, ['node'], 'node').id;
    const secs = a.sections?.(node) ?? [];
    const label = this.outlineLabel(o, node);
    const sq = typeof args.section === 'string' ? args.section.trim() : '';
    if (sq) {
      try { sec = this.section(secs, sq, label); } catch (e) {
        // say which cards do have such a section, so the next call can target one
        const others = o.nodes.filter((n) => n.id !== node && (a.sections?.(n.id) ?? []).some((x) => { try { return this.section([x], sq, '') === x; } catch { return false; } }));
        if (others.length && e instanceof Fail) fail(`${e.message}. Cards with a "${sq}" section: ${list(others.map((n) => n.label))}`);
        throw e;
      }
    }
    const iq = typeof args.item === 'string' ? args.item.trim() : '';
    if (iq) {
      const hit = this.item(sec ? [sec] : secs, iq) ?? (sec ? this.item(secs, iq) : null);
      if (!hit) fail(`${label}'s details list nothing called "${iq}"${sec ? ` (in ${sec.title}: ${sec.items.slice(0, LIST_MAX).join(', ') || 'no items'})` : ''}`);
      sec = hit!.sec; item = hit!.item;
    }
    if (a.openDetails) a.openDetails(node, sec?.id ?? null); else a.reveal!(node);
    if (item) a.scrollDetails?.({ item });
  }
}
