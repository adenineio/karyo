// The sequence plate: one recorded flow as lanes and messages (docs/KITS.md; the built-in `sequence` kit's plate type).
// A lane per node the flow touched (its entry first, then in the order they first appear), a message per recorded call
// (caller → callee, in start order, labelled with what the span says it did and how long it took), an activation bar
// for as long as each call ran, and a band per top-level call. Shape-neutral: lanes, calls and bands come from the
// model's spans; nothing here knows what they are.
//
// An interactive plate (docs/ENGINE.md "Interactive plates"). At rest it shows the whole flow from its first message.
// Hover a message: it lights with its two lanes, and the mode line says it; click pins it (a card with its facts);
// ←/→ steps the pin through the messages (scrolling it into view), Esc unpins. Hover a lane head or a legend entry:
// its messages light. The body scrolls (wheel, PgUp/PgDn, Home/End) under fixed lane heads; the theater lays the
// lanes out for the window and shows as many messages as fit.
//
// Folding (src/model/sequence-fold.ts has the rule): lanes that belong together (what the model already folds or
// groups, else three or more sibling leaves of one caller that share a category) draw as one folded lane when the flow
// has too many lanes. Its head names what it holds ("5 stages"); calls to a member land on it, labelled with the member.
// Hover its head: the members are listed. Click it (Enter on focus): it expands into its members' lanes, gliding; the
// bracket above them folds it back. Folded or expanded is view state (`expanded`), so stills show both.
import { Scene, Morph, ease, clamp, type Frame, type Fx, type SceneClass, type Vals, type KeyHelp } from '../engine';
import { checksFor, type Model, type MFlow, type MNode, type MSpan } from './model';
import { cssId, esc } from './scenes';
import { modelLegend, categorySlots, nodeCategory, litMembers, resolveEntry, LegendStrip, LEGEND_CSS, type LegendEntry } from './legend';
import { kitsFor, modelStats, type KitSet } from '../kits/registry';
import { flowLanes, foldLanes, isSequenceFold, type FoldUnit, type SequenceFold } from './sequence-fold';
import type { PlateOutline } from './outline';

export interface SequenceOpts {
  title?: string;
  /** The kits its lanes' node kinds are drawn with (default: the model's). */
  kits?: KitSet;
  /** Durations beside each message (default true). */
  durations?: boolean;
  /** A band per top-level call (default true). */
  group?: boolean;
  /** Only these lanes (a plate type's filter): calls between other nodes are left out. */
  keep?: Set<string>;
  /** Fold lanes that belong together into one expandable lane: 'auto' (the default: only when the flow has too many
   *  lanes), 'none', or explicit groups of node ids (src/model/sequence-fold.ts). */
  fold?: SequenceFold;
}
export interface SequenceState {
  /** The pinned message (index in start order), or null. */
  step: number | null;
  /** The message under the pointer (lit at once; part of the state so stills can show it). */
  hover?: number | null;
  /** The lane head under the pointer. */
  lane?: string | null;
  /** How far the body is scrolled (px). */
  scroll?: number;
  pins: string[];
  lhover?: string | null;
  /** The folded lanes the viewer expanded (their ids, `fold:<first member>`). */
  expanded?: string[];
}
/** What a page (or Jarvis) can call on a mounted sequence plate. */
export interface SequenceApi {
  /** Pin message i (0-based; null unpins), scrolling it into view. */
  go(i: number | null): void;
  next(): void;
  prev(): void;
  focusTag(id: string | null): void;
  highlight(ids: string[] | null): void;
  describe(): PlateOutline;
  /** The folded lanes: what each holds, and whether it is expanded. */
  folds(): { id: string; name: string; sub: string; members: string[]; expanded: boolean }[];
  /** Expand a folded lane (its id, name, noun or one of its members; null: every one). False when nothing matched or changed. */
  expand(unit: string | null): boolean;
  /** Fold an expanded lane back (as expand; null or none: every one). */
  collapse(unit?: string | null): boolean;
}

const SIDE = 48, HEAD_Y = 104, HEAD_H = 46, BODY_Y = HEAD_Y + HEAD_H + 12, ROW = 30, BAND_H = 24, BAND_GAP = 10, FOOT_H = 132, ACT = 10;
const P_MIN = 132, P_DEF = 150, P_MAX = 230, BODY_MAX = 620, DIM = 0.28, CARD_W = 300;

export function sequenceScene(model0: Model, flowId: string, o: SequenceOpts = {}): SceneClass {
  const kits = o.kits ?? kitsFor(model0);
  const model = kits.decorate(model0);
  const found = model.flows.find((f) => f.id === flowId);
  if (!found) throw new Error(`karyo: model has no flow "${flowId}" (have: ${model.flows.map((f) => f.id).join(', ')})`);
  const flow: MFlow = found;
  const byNode = new Map(model.nodes.map((n) => [n.id, n]));
  const nodeOf = (id: string): MNode => byNode.get(id) ?? { id, kind: 'external', label: id, sources: [] };
  const label = (id: string) => nodeOf(id).label ?? id;
  const durations = o.durations !== false, grouped = o.group !== false;

  // ---- messages: every span in start order, with its caller (the parent span's node, else the flow's entry)
  const all = [...flow.spans].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const byId = new Map(all.map((s) => [s.id, s]));
  const callerOf = (s: MSpan) => (s.parent && byId.has(s.parent) ? byId.get(s.parent)!.node : flow.entry ?? null);
  const spans = o.keep ? all.filter((s) => o.keep!.has(s.node)) : all;
  const rootOf = (s: MSpan): MSpan => { let r = s; while (r.parent && byId.has(r.parent)) r = byId.get(r.parent)!; return r; };
  // lanes: the entry first, then each node in the order it is first called
  const { lanes, calls } = flowLanes(flow, o.keep);
  const laneIx = new Map(lanes.map((id, i) => [id, i]));
  // folded lanes: units of lanes drawn as one until the viewer expands them (the rule: sequence-fold.ts)
  const units = foldLanes(model, flow, lanes, calls, isSequenceFold(o.fold) ? o.fold : 'auto');
  const unitOf = new Map(units.flatMap((u) => u.members.map((id) => [id, u] as const)));
  const unitById = new Map(units.map((u) => [u.id, u]));
  /** The lanes drawn with these units expanded: a folded unit stands at its first member's place. */
  const shownLanes = (exp: Set<string>) => lanes.flatMap((id) => { const u = unitOf.get(id); return !u || exp.has(u.id) ? [id] : u.members[0] === id ? [u.id] : []; });
  // a flow that crosses languages says so on its lane heads
  const multiLang = new Set(lanes.map((id) => nodeOf(id).lang).filter(Boolean)).size > 1;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const ms = (ns: number) => { const v = ns / 1e6; return v < 10 ? v.toFixed(1) : String(Math.round(v)); };
  const t0 = all[0]?.start ?? 0;

  interface Msg { i: number; s: MSpan; from: string | null; to: string; band: number; y: number; endY: number; depth: number; err: boolean; op: string }
  interface Band { i: number; root: MSpan; y: number; h: number; msgs: number[]; err: boolean }
  const msgs: Msg[] = [];
  const bands: Band[] = [];
  {
    let y = 8;
    const bandOf = new Map<string, number>();
    for (const s of spans) {
      const r = rootOf(s);
      if (grouped && !bandOf.has(r.id)) {
        if (bands.length) y += BAND_GAP;
        bandOf.set(r.id, bands.length);
        bands.push({ i: bands.length, root: r, y, h: 0, msgs: [], err: false });
        y += BAND_H;
      }
      const b = grouped ? bandOf.get(r.id)! : 0;
      const from = callerOf(s);
      const op = s.label && s.label !== s.node && s.label !== nodeOf(s.node).label ? s.label : '';
      msgs.push({ i: msgs.length, s, from: from && laneIx.has(from) ? from : null, to: s.node, band: b, y, endY: y + ROW, depth: 0, err: s.status === 'error', op });
      if (grouped) { bands[b]!.msgs.push(msgs.length - 1); if (s.status === 'error') bands[b]!.err = true; }
      y += ROW;
    }
    for (const b of bands) { const last = msgs[b.msgs[b.msgs.length - 1]!]!; b.h = last.y + ROW - b.y + 4; }
    // an activation runs from its call to the end of its last nested call; calls nested on the same lane step right
    const ixOf = new Map(msgs.map((m) => [m.s.id, m.i]));
    for (const m of msgs) {
      let last = m.i;
      for (const n of msgs) { let p = n.s.parent; while (p) { if (p === m.s.id) { last = Math.max(last, n.i); break; } p = byId.get(p)?.parent ?? null; } }
      m.endY = msgs[last]!.y + ROW * 0.86;
      let d = 0; for (let p = m.s.parent; p; p = byId.get(p)?.parent ?? null) if (byId.get(p)?.node === m.to && ixOf.has(p)) d++;
      m.depth = d;
    }
  }
  const contentH = (msgs.length ? Math.max(...msgs.map((m) => m.y + ROW), ...bands.map((b) => b.y + b.h)) : ROW) + 12;
  /** A call's activation steps right once per enclosing call drawn on the same lane (`show`: the lane a node is drawn on). */
  const msgIds = new Set(msgs.map((m) => m.s.id));
  const depthFor = (m: Msg, show: (id: string) => string) => { let d = 0; for (let p = m.s.parent; p; p = byId.get(p)?.parent ?? null) { const q = byId.get(p); if (q && msgIds.has(p) && show(q.node) === show(m.to)) d++; } return d; };
  const parentMsg = new Map(msgs.map((m) => [m.i, m.s.parent ? msgs.find((x) => x.s.id === m.s.parent) : undefined]));

  // ---- geometry: the lane pitch and the body's height follow the plate's size (the theater's fit) and the lanes shown
  const W0For = (n: number) => Math.max(960, 2 * SIDE + n * P_DEF);
  const W0 = W0For(shownLanes(new Set()).length);
  const H0 = BODY_Y + Math.min(contentH, BODY_MAX) + 16 + FOOT_H;
  interface Geo { W: number; H: number; P: number; x0: number; n: number; bodyH: number; maxScroll: number }
  const geoFor = (W: number, H: number, n: number): Geo => {
    const P = clamp((W - 2 * SIDE) / Math.max(1, n), P_MIN, P_MAX);
    const bodyH = Math.max(160, H - BODY_Y - 16 - FOOT_H);
    return { W, H, P, x0: (W - P * n) / 2, n, bodyH, maxScroll: Math.max(0, contentH - bodyH) };
  };

  // ---- legend: the lanes' categories, kit kinds, declared tags, and the lanes a failed call reached
  const laneNodes = lanes.map(nodeOf);
  const ML = modelLegend({
    nodes: laneNodes, wires: [], groups: [], groupOf: () => '', groupName: (g) => g,
    warned: new Set(lanes.filter((id) => checksFor(model, id).some((c) => c.level === 'warn'))),
    kindEntry: (k) => (kits.kind(k) ? { name: kits.plural(k), glyph: kits.glyph(k) } : null),
  });
  // a category keeps the colour it has on the model's other plates (its slot among all the model's categories)
  const slots = categorySlots([...new Set(model.nodes.filter((n) => n.kind !== 'module').map(nodeCategory).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b)));
  ML.categories = ML.categories.map((e) => (e.id === 'cat:·other' ? e : { ...e, slot: slots.get(e.name) ?? 0 }));
  const errLanes = [...new Set(msgs.filter((m) => m.err).map((m) => m.to))];
  const entries: LegendEntry[] = [...ML.categories, ...ML.kinds, ...ML.declared,
    ...(errLanes.length ? [{ id: 'errors', name: '✕ failed calls', kind: 'derived' as const, members: errLanes, hint: 'lanes a failed call reached' }] : []),
    ...ML.derived.filter((e) => e.id !== 'unseen' && e.id !== 'undeclared')];
  const stats = modelStats(model);

  const msgWords = (m: Msg) => `${m.from ? label(m.from) : 'start'} → ${label(m.to)}${m.op ? ` · ${m.op}` : ''}`;
  const bandTitle = (b: Band) => `${b.i + 1} · ${b.root.label && b.root.label !== b.root.node ? b.root.label : label(b.root.node)} · ${ms((b.root.end ?? b.root.start) - b.root.start)} ms${b.err ? ' · ✕ failed' : ''}`;
  const headHTML = (id: string) => {
    const n = nodeOf(id), c = nodeCategory(n), slot = c ? slots.get(c) : undefined;
    const kit = kits.kind(n.kind), g = kit ? kits.glyph(n.kind) : null;
    const mini = kit ? kits.mini(n, stats.get(id)) : null;
    const inner = mini !== null ? `<div class="km-${esc(n.kind)} sq-km">${mini}</div>`
      : `<div class="mm-kind">${g ? `${esc(g)} ` : ''}${esc(kit ? kits.label(n.kind) : n.kind)}${n.lang && multiLang ? ` <span class="sq-lang">· ${esc(n.lang)}</span>` : ''}</div><div class="sq-hn">${esc(label(id))}</div>`;
    return `<div class="pl-card sq-head${kit ? ' is-kit' : ''}${n.kind === 'actor' ? ' is-actor' : ''}" id="h-${cssId(id)}" data-lane="${esc(id)}"${slot !== undefined ? ` data-cat="${slot}"` : ''} data-kind="${esc(n.kind)}" title="${esc(id)}${n.summary ? ` — ${esc(n.summary)}` : ''}">${inner}</div>`;
  };
  // ---- folded lanes: a head that stands for its members (stacked, named for what they share), and the line above it
  // that says who calls them, which becomes the bracket (and its fold button) over the members when expanded
  const memberNames = (u: FoldUnit) => u.members.map(label);
  const foldHeadHTML = (u: FoldUnit) => {
    const cs = new Set(u.members.map((id) => nodeCategory(nodeOf(id)))), c = cs.size === 1 ? [...cs][0] : null, slot = c ? slots.get(c) : undefined;
    const names = memberNames(u), short = names.length > 2 && names[0]!.length + names[1]!.length > 10 ? `${names[0]} +${names.length - 1}` : names.length > 2 ? `${names[0]} · ${names[1]} +${names.length - 2}` : names.join(' · ');
    return `<div class="pl-card sq-head is-fold" id="h-${cssId(u.id)}" data-lane="${esc(u.id)}" data-fold="${esc(u.id)}"${slot !== undefined ? ` data-cat="${slot}"` : ''} tabindex="0" role="button" aria-expanded="false" aria-label="${esc(`${u.name} folded: ${names.join(', ')}. Press Enter to expand.`)}"><div class="mm-kind"><span class="sq-fk">${esc(u.name)}</span><span class="sq-fx" aria-hidden="true">⤢</span></div><div class="sq-hn">${esc(short)}</div></div>`;
  };
  const unitLine = (u: FoldUnit, open: boolean) => (open ? `⤡ fold · ${u.name} · ${u.sub}` : u.sub);
  /** A call's label: what it did; on a folded lane, which member it reached first ("Normalize: normalize()"). */
  const msgLabel = (m: Msg, folded: boolean) => `${esc(folded ? (m.op ? `${label(m.to)}: ${m.op}` : label(m.to)) : m.op || label(m.to))}${durations ? `<span class="d">${ms((m.s.end ?? m.s.start) - m.s.start)} ms</span>` : ''}${m.err ? ' ✕' : ''}`;
  const headWords = (shown: number, folded: FoldUnit[]) => `Sequence · ${plural(msgs.length, 'call')} across ${plural(shown, 'lane')}${folded.length ? ` (${folded.map((u) => u.name).join(', ')} folded)` : ''} · ${all.length ? ms(Math.max(...all.map((s) => s.end ?? s.start)) - t0) : '0'} ms recorded`;

  const CSS = /* css */ `
    .sq-top { position: absolute; left: ${SIDE}px; top: 30px; right: ${SIDE}px; display: grid; gap: 6px; }
    .sq-top .pl-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sq-head { position: absolute; left: 0; top: ${HEAD_Y}px; height: ${HEAD_H}px; box-sizing: border-box; padding: 6px 10px; display: grid; align-content: center; gap: 3px; cursor: default; z-index: 3; }
    .sq-head .mm-kind { font: 500 10px/1 var(--pl-font-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--pl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sq-head[data-cat] .mm-kind { color: color-mix(in oklab, var(--lg-c) var(--pl-cat-kind, 0%), var(--pl-muted)); }
    .sq-head[data-cat] { --pl-card-border: color-mix(in oklab, var(--lg-c) var(--pl-cat-ring, 0%), var(--pl-card-border-base)); }
    .sq-head[data-cat]::before { content: ''; position: absolute; left: -1px; top: -1px; bottom: -1px; width: 4px; border-radius: var(--pl-radius) 0 0 var(--pl-radius); background-color: var(--lg-c); background-image: var(--lg-f); }
    .sq-head.is-actor { border-radius: 999px; text-align: center; }
    .sq-head.is-actor[data-cat]::before { display: none; }
    .sq-lang { color: var(--pl-muted); text-transform: none; letter-spacing: 0; }
    .sq-hn { font: 600 13.5px/1.2 var(--pl-font-display); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sq-km { min-width: 0; overflow: hidden; }
    .sq-head.is-lit { border-color: var(--pl-accent); }
    .sq-head.is-lit .sq-hn { color: var(--pl-accent); }
    .sq-head.is-fold { cursor: pointer; --sq-stack: color-mix(in oklab, var(--pl-muted) 55%, var(--pl-card)); box-shadow: 4px 4px 0 -1px var(--pl-card), 4px 4px 0 0 var(--sq-stack), 8px 8px 0 -1px var(--pl-card), 8px 8px 0 0 var(--sq-stack); }
    .sq-head.is-fold .sq-hn { font-size: 12.5px; }
    .sq-head.is-fold .mm-kind { display: flex; align-items: center; gap: 6px; color: var(--pl-fg); }
    .sq-head.is-fold .sq-fk { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .sq-fx { margin-left: auto; font: 600 13px/1 var(--pl-font); color: var(--pl-accent); }
    .sq-head.is-fold:hover { border-color: var(--pl-accent); }
    .sq-head.is-fold:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: 3px; }
    .sq-unit { position: absolute; left: 0; top: ${HEAD_Y - 21}px; height: 16px; display: flex; justify-content: center; align-items: center; z-index: 3; pointer-events: none; }
    .sq-ub { position: absolute; left: 0; right: 0; top: 7px; height: 9px; box-sizing: border-box; border: 1.5px solid color-mix(in srgb, var(--pl-accent) 65%, var(--pl-line)); border-bottom: 0; border-radius: 5px 5px 0 0; }
    .sq-ul { position: relative; pointer-events: auto; font: 10.5px/14px var(--pl-font-mono); color: var(--pl-muted); background: var(--pl-bg); border: 0; border-radius: 3px; padding: 0 6px; white-space: nowrap; cursor: pointer; }
    .sq-unit.is-open .sq-ul { color: var(--pl-accent); font-weight: 600; }
    .sq-ul:hover { color: var(--pl-accent); }
    .sq-ul:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: 1px; }
    .sq-fcard { position: absolute; left: 0; top: 0; width: 240px; box-sizing: border-box; padding: 9px 12px; display: grid; gap: 4px; z-index: 21; pointer-events: none; }
    .sq-fcard .t { font: 700 14px/1.25 var(--pl-font-display); }
    .sq-fcard .s { font: 11.5px/1.3 var(--pl-font-mono); color: var(--pl-muted); }
    .sq-fcard ol { margin: 2px 0 0; padding: 0 0 0 20px; font: 12px/1.5 var(--pl-font-mono); }
    .sq-fcard li b { font-weight: 400; color: var(--pl-muted); margin-left: 6px; }
    .sq-fcard .h { font: 11.5px/1.3 var(--pl-font-mono); color: var(--pl-accent); }
    .sq-msg.to-fold .sq-lbl { left: 50%; right: auto; width: max(calc(100% - 8px), 200px); transform: translateX(-50%); }
    .sq-msg.self .sq-arrow { left: 0; right: auto; width: 16px; top: ${Math.round(ROW * 0.36)}px; height: ${Math.round(ROW * 0.42)}px; box-sizing: border-box; border: 1.5px solid var(--pl-muted); border-left: 0; border-radius: 0 5px 5px 0; }
    .sq-msg.self .sq-arrow::after { top: auto; bottom: -6px; right: auto; left: -2px; border-left: 0; border-right: 8px solid var(--pl-muted); }
    .sq-msg.self .sq-lbl { left: 22px; right: auto; width: 200px; text-align: left; }
    .sq-msg.self.is-lit .sq-arrow { border-width: 2.5px; border-left: 0; border-color: var(--pl-accent); top: ${Math.round(ROW * 0.36)}px; }
    .sq-msg.self.is-lit .sq-arrow::after { border-right-color: var(--pl-accent); }
    .sq-foot .lg-e[data-lg^="fold:"] > b { display: none; }
    .sq-clip { position: absolute; left: 0; top: ${BODY_Y}px; overflow: hidden; }
    .sq-sheet { position: absolute; left: 0; top: 0; }
    .sq-life { position: absolute; top: 0; width: 0; border-left: 1px dashed var(--pl-line); }
    .sq-band { position: absolute; box-sizing: border-box; border: 1px dashed var(--pl-line); border-radius: calc(var(--pl-radius) + 4px); }
    .sq-band > .pl-label { position: absolute; left: 10px; top: 5px; white-space: nowrap; }
    .sq-band.is-err > .pl-label { color: var(--pl-accent-2); }
    .sq-act { position: absolute; width: ${ACT}px; box-sizing: border-box; background: color-mix(in srgb, var(--pl-accent) 16%, var(--pl-card)); border: 1px solid color-mix(in srgb, var(--pl-accent) 50%, var(--pl-line)); border-radius: 2px; }
    .sq-act.is-err { border-color: var(--pl-accent-2); background: color-mix(in srgb, var(--pl-accent-2) 18%, var(--pl-card)); }
    .sq-msg { position: absolute; height: ${ROW}px; cursor: pointer; }
    .sq-arrow { position: absolute; left: 0; right: 0; top: ${Math.round(ROW * 0.64)}px; height: 0; border-top: 1.5px solid var(--pl-muted); }
    .sq-arrow::after { content: ''; position: absolute; top: -5.5px; right: -1px; border: 5px solid transparent; border-left: 8px solid var(--pl-muted); border-right: 0; }
    .sq-msg.rev .sq-arrow::after { right: auto; left: -1px; border-left: 0; border-right: 8px solid var(--pl-muted); }
    .sq-msg.found .sq-arrow::before { content: ''; position: absolute; left: -4px; top: -4.5px; width: 7px; height: 7px; border-radius: 50%; background: var(--pl-muted); }
    .sq-lbl { position: absolute; left: 4px; right: 4px; top: 1px; text-align: center; font: 11.5px/15px var(--pl-font-mono); color: var(--pl-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sq-lbl .d { color: var(--pl-muted); margin-left: 6px; }
    .sq-msg.is-err .sq-arrow { border-top-color: var(--pl-accent-2); }
    .sq-msg.is-err .sq-arrow::after { border-left-color: var(--pl-accent-2); }
    .sq-msg.is-err.rev .sq-arrow::after { border-right-color: var(--pl-accent-2); }
    .sq-msg.is-err .sq-lbl { color: var(--pl-accent-2); }
    .sq-msg.is-lit .sq-arrow { border-top: 2.5px solid var(--pl-accent); top: ${Math.round(ROW * 0.64) - 0.5}px; }
    .sq-msg.is-lit .sq-arrow::after { border-left-color: var(--pl-accent); }
    .sq-msg.is-lit.rev .sq-arrow::after { border-right-color: var(--pl-accent); border-left-color: transparent; }
    .sq-msg.is-lit .sq-lbl { color: var(--pl-accent); font-weight: 600; }
    .sq-msg.is-pin .sq-lbl { background: color-mix(in srgb, var(--pl-accent) 12%, var(--pl-bg)); border-radius: 3px; }
    .sq-card { position: absolute; left: 0; top: 0; width: ${CARD_W}px; box-sizing: border-box; padding: 10px 12px; display: grid; gap: 5px; z-index: 20; pointer-events: none; }
    .sq-card .t { font: 700 15px/1.25 var(--pl-font-display); }
    .sq-card .op { font: 600 12.5px/1.3 var(--pl-font-mono); color: var(--pl-accent); overflow-wrap: anywhere; }
    .sq-card .f { font: 12px/1.4 var(--pl-font-mono); color: var(--pl-muted); }
    .sq-card .f b { color: var(--pl-fg); font-weight: 600; }
    .sq-card .f.err b { color: var(--pl-accent-2); }
    .sq-card .sum { margin: 0; font-size: 12.5px; line-height: 1.4; }
    .sq-foot { position: absolute; left: ${SIDE}px; right: ${SIDE}px; bottom: 14px; height: ${FOOT_H - 26}px; box-sizing: border-box; border-top: 1px dashed var(--pl-line); padding-top: 8px; display: grid; grid-template-rows: auto auto; row-gap: 6px; z-index: 4; }
    .sq-foot .lg-cats .lg-list, .sq-foot .lg-tags .lg-list { --lg-max-h: 28px; }
    .sq-mode { font: 12px/1.3 var(--pl-font-mono); color: var(--pl-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sq-mode::before { content: '▸ '; color: var(--pl-accent); }
    .sq-more { position: absolute; right: ${SIDE}px; font: 11px/1 var(--pl-font-mono); color: var(--pl-muted); z-index: 4; }
    ${LEGEND_CSS}
    ${kits.css()}
  `;
  const blank = (): SequenceState => ({ step: null, hover: null, lane: null, scroll: 0, pins: [], lhover: null, expanded: [] });

  return class SequenceScene extends Scene implements SequenceApi {
    static title = o.title ?? `${flow.title ?? flow.id}: sequence`;
    static width = W0;
    static height = H0;
    static duration = 0.45;
    static interactive = true;
    static fx = 'under' as const;

    private st: SequenceState = blank();
    /** The expanded units, and the lanes drawn (folded units in their members' place). */
    private exp = new Set<string>();
    private vis: string[] = shownLanes(this.exp);
    private visIx = new Map(this.vis.map((id, i) => [id, i]));
    private g: Geo = geoFor(W0, H0, this.vis.length);
    /** The space the plate was last fitted to (null: the page), so a change of lanes refits for the same space. */
    private space: { w: number; h: number } | null = null;
    private morph = new Morph();
    private legend!: LegendStrip;
    private spot: LegendEntry | null = null;
    private laidFor = '';
    private cardFor = '';
    private fcardFor = '';
    private els!: { head: Map<string, HTMLElement>; life: Map<string, HTMLElement>; unit: Map<string, HTMLElement>; act: HTMLElement[]; msg: HTMLElement[]; lbl: HTMLElement[]; band: HTMLElement[] };

    /** The legend's entries: the lanes' categories, kinds and tags, then one per folded lane (click: expand or fold). */
    private foldEntries(): LegendEntry[] {
      return units.map((u) => ({ id: u.id, name: this.exp.has(u.id) ? `⤡ ${u.name} expanded · click to fold` : `⧉ ${u.name} folded · click to expand`, kind: 'derived' as const, members: u.members, hint: `${u.sub}: ${memberNames(u).join(', ')}` }));
    }
    private entries() { const f = units.length ? [...entries, ...this.foldEntries()] : entries; return this.spot ? [...f, this.spot] : f; }
    /** The lane a node is drawn on: its folded unit's, else its own. */
    private showOf(id: string) { const u = unitOf.get(id); return u && !this.exp.has(u.id) ? u.id : id; }
    private laneX(id: string) { return this.g.x0 + this.g.P * ((this.visIx.get(id) ?? 0) + 0.5); }

    build(dom: HTMLElement) {
      const laneIds = [...lanes, ...units.map((u) => u.id)];
      dom.innerHTML = `<style>${CSS}</style>
        <header class="sq-top" data-pl-chrome><div class="pl-label">${esc(headWords(this.vis.length, units))}</div><h1 class="pl-title">${esc(o.title ?? flow.title ?? flow.id)}</h1></header>
        ${lanes.map(headHTML).join('')}
        ${units.map(foldHeadHTML).join('')}
        ${units.map((u) => `<div class="sq-unit" id="u-${cssId(u.id)}"><i class="sq-ub"></i><button type="button" class="sq-ul" data-unit="${esc(u.id)}">${esc(unitLine(u, false))}</button></div>`).join('')}
        <div class="sq-clip" data-pl-clip><div class="sq-sheet">
          ${bands.map((b) => `<div class="sq-band${b.err ? ' is-err' : ''}" id="b${b.i}"><span class="pl-label">${esc(bandTitle(b))}</span></div>`).join('')}
          ${laneIds.map((id) => `<div class="sq-life" id="l-${cssId(id)}"></div>`).join('')}
          ${msgs.map((m) => `<div class="sq-act${m.err ? ' is-err' : ''}" id="a${m.i}"></div>`).join('')}
          ${msgs.map((m) => `<div class="sq-msg${m.err ? ' is-err' : ''}${m.from ? '' : ' found'}" id="m${m.i}" data-m="${m.i}" title="${esc(msgWords(m))}"><div class="sq-arrow"></div><div class="sq-lbl">${msgLabel(m, false)}</div></div>`).join('')}
        </div></div>
        <div class="sq-more" id="sq-more" data-pl-chrome="bare"></div>
        <div class="pl-card sq-card" id="sq-card" role="status" aria-live="polite"></div>
        <div class="pl-card sq-fcard" id="sq-fcard" aria-hidden="true"></div>
        <div class="sq-foot" id="sq-foot" data-pl-chrome><div class="sq-mode" id="sq-mode"></div></div>`;
      const q = (sel: string) => dom.querySelector<HTMLElement>(sel)!;
      this.els = {
        head: new Map(laneIds.map((id) => [id, q(`#h-${cssId(id)}`)])), life: new Map(laneIds.map((id) => [id, q(`#l-${cssId(id)}`)])),
        unit: new Map(units.map((u) => [u.id, q(`#u-${cssId(u.id)}`)])),
        act: msgs.map((m) => q(`#a${m.i}`)), msg: msgs.map((m) => q(`#m${m.i}`)), lbl: msgs.map((m) => q(`#m${m.i} .sq-lbl`)), band: bands.map((b) => q(`#b${b.i}`)),
      };
      const foot = dom.querySelector<HTMLElement>('#sq-foot')!;
      this.legend = new LegendStrip(foot, {
        onHover: (id) => { this.st.lhover = id; this.stage.redraw(); },
        onToggle: (id) => {
          if (unitById.has(id)) { this.toggle(id); return; }
          this.st.pins = this.st.pins.includes(id) ? this.st.pins.filter((p) => p !== id) : [...this.st.pins, id]; this.go0();
        },
      });
      foot.insertBefore(this.legend.el, foot.firstChild);
      this.relane();
      // pointer: a message row, a lane head
      const clip = dom.querySelector<HTMLElement>('.sq-clip')!;
      clip.addEventListener('pointermove', (e) => { const m = (e.target as HTMLElement).closest<HTMLElement>('[data-m]'); const h = m ? +m.dataset.m! : null; if (h !== this.st.hover) { this.st.hover = h; this.stage.redraw(); } });
      clip.addEventListener('pointerleave', () => { if (this.st.hover != null) { this.st.hover = null; this.stage.redraw(); } });
      clip.addEventListener('click', (e) => { const m = (e.target as HTMLElement).closest<HTMLElement>('[data-m]'); this.go(m ? (this.st.step === +m.dataset.m! ? null : +m.dataset.m!) : null); });
      clip.addEventListener('wheel', (e) => { e.preventDefault(); this.scrollBy(e.deltaY); }, { passive: false });
      for (const id of laneIds) {
        const h = this.els.head.get(id)!;
        h.addEventListener('pointerenter', () => { this.st.lane = id; this.stage.redraw(); });
        h.addEventListener('pointerleave', () => { if (this.st.lane === id) { this.st.lane = null; this.stage.redraw(); } });
      }
      // a folded head expands on a click (Enter or Space on focus: onKey); the line above a unit folds or expands it
      for (const u of units) this.els.head.get(u.id)!.addEventListener('click', () => this.toggle(u.id));
      dom.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-unit]'); if (b) this.toggle(b.dataset.unit!); });
      this.morph.snap(this.targets());
    }

    // ------------------------------------------------------------ folding
    /** Recompute the lanes drawn from `st.expanded` (and what depends on them: activation steps, labels, the legend).
     *  True when the lanes changed (the plate then needs a refit). */
    private relane(): boolean {
      this.exp = new Set((this.st.expanded ?? []).filter((id) => unitById.has(id)));
      const vis = shownLanes(this.exp), changed = vis.join('\n') !== this.vis.join('\n');
      this.vis = vis; this.visIx = new Map(vis.map((id, i) => [id, i]));
      const show = (id: string) => this.showOf(id);
      for (const m of msgs) m.depth = depthFor(m, show);
      if (this.els) {
        for (const m of msgs) {
          const folded = unitOf.has(m.to) && show(m.to) !== m.to;
          this.els.lbl[m.i]!.innerHTML = msgLabel(m, folded);
          this.els.msg[m.i]!.classList.toggle('to-fold', folded);
          this.els.msg[m.i]!.classList.toggle('self', !!m.from && show(m.from) === show(m.to));
        }
        for (const u of units) {
          const open = this.exp.has(u.id), el = this.els.unit.get(u.id)!;
          el.classList.toggle('is-open', open);
          const b = el.querySelector<HTMLElement>('.sq-ul')!;
          b.textContent = unitLine(u, open);
          b.title = open ? `Fold ${memberNames(u).join(', ')} back into one lane` : `${u.name}: ${memberNames(u).join(', ')} · click to expand`;
          b.setAttribute('aria-expanded', String(open));
          this.els.head.get(u.id)!.setAttribute('aria-expanded', String(open));
        }
        this.legend.render(entries.filter((e) => e.kind === 'category'), [...entries.filter((e) => e.kind !== 'category'), ...this.foldEntries()]);
      }
      return changed;
    }
    /** Expand or fold units (animate: glide from what is on screen, the plate refitted for its new width). */
    private setExpanded(ids: string[], animate = true): boolean {
      const next = units.filter((u) => ids.includes(u.id)).map((u) => u.id);
      if (next.length === this.exp.size && next.every((x) => this.exp.has(x))) return false;
      const keys = [...this.targets().keys()], now = new Map(keys.map((k) => [k, this.morph.value(k)!] as const).filter(([, v]) => !!v));
      this.st.expanded = next;
      if (this.st.lane && !this.vis.includes(this.st.lane)) this.st.lane = null;
      if (this.relane()) this.stage.refit(this.space);
      if (this.st.lane && !this.vis.includes(this.st.lane)) this.st.lane = null;
      if (animate) { this.morph.snap(now); this.go0(); }
      else { this.morph.snap(this.targets()); this.stage.redraw(); }
      return true;
    }
    private toggle(id: string) { this.setExpanded(this.exp.has(id) ? [...this.exp].filter((x) => x !== id) : [...this.exp, id]); }
    /** A unit by id, name, noun ("stages", "the stages") or one of its members. */
    private unitFor(ref: string): FoldUnit | undefined {
      const r = ref.trim().toLowerCase().replace(/^the\s+/, '');
      return unitById.get(ref) ?? unitOf.get(ref)
        ?? units.find((u) => [u.name, u.noun, u.id, `${u.members.length} ${u.noun}`].some((x) => x.toLowerCase() === r))
        ?? units.find((u) => u.name.toLowerCase().includes(r) || u.members.some((id) => label(id).toLowerCase() === r));
    }

    // ------------------------------------------------------------ geometry & state
    fit(space: { w: number; h: number } | null) {
      this.space = space ? { w: space.w, h: space.h } : null;
      const n = this.vis.length, w0 = W0For(n);
      if (!space) { this.g = geoFor(w0, H0, n); this.snapScroll(); return { w: w0, h: H0 }; }
      const a = space.w / space.h;
      // keep the lanes readable: as wide as the default at least, as tall as the window's shape makes it
      const W = Math.max(w0, Math.round(H0 * a)), H = Math.max(H0, Math.round(W / a));
      this.g = geoFor(W, H, n);
      this.snapScroll();
      return { w: W, h: H };
    }
    private snapScroll() { this.st.scroll = clamp(this.st.scroll ?? 0, 0, this.g.maxScroll); this.morph.snap(this.targets()); }
    private targets() {
      const t = new Map<string, Vals>([['s', { y: clamp(this.st.scroll ?? 0, 0, this.g.maxScroll) }], ['c', { o: this.st.step != null ? 1 : 0 }]]);
      // lanes: a folded member sits (unseen) on its unit's lane; an expanded unit (unseen) in the middle of its members
      const g = this.g, hw = g.P - 14;
      for (const id of lanes) { const sh = this.showOf(id); t.set(`L:${id}`, { x: this.laneX(sh), o: sh === id ? 1 : 0 }); }
      for (const u of units) {
        const open = this.exp.has(u.id), xs = u.members.map((id) => this.laneX(id));
        const a = open ? Math.min(...xs) : this.laneX(u.id), b = open ? Math.max(...xs) : a;
        t.set(`L:${u.id}`, { x: open ? (a + b) / 2 : a, o: open ? 0 : 1 });
        t.set(`U:${u.id}`, { x: a - hw / 2, w: b - a + hw, e: open ? 1 : 0 });
      }
      t.set('band', { l: g.x0 + 4, r: g.x0 + g.P * g.n - 4 });
      return t;
    }
    /** A change of meaning: glide from what is on screen. */
    private go0() { this.morph.retarget(this.targets()); this.stage.transition(); }
    /** Scroll so message i is in view (a margin of one row). */
    private reveal(i: number) {
      const m = msgs[i]!, s = this.st.scroll ?? 0, top = (grouped ? Math.min(m.y, bands[m.band]!.y) : m.y) - ROW, bot = m.y + ROW * 2.2;
      if (top < s) this.st.scroll = Math.max(0, top);
      else if (bot > s + this.g.bodyH) this.st.scroll = Math.min(this.g.maxScroll, bot - this.g.bodyH);
    }
    private scrollBy(dy: number) {
      const s = clamp((this.st.scroll ?? 0) + dy, 0, this.g.maxScroll);
      if (s === this.st.scroll) return;
      this.st.scroll = s;
      this.morph.snap(this.targets());   // direct manipulation: no transition
      this.stage.redraw();
    }
    private lit(): Set<string> | null {
      if (this.st.lane) { const u = unitById.get(this.st.lane); return new Set(u && !this.exp.has(u.id) ? [u.id, ...u.members] : [this.st.lane]); }
      return litMembers(this.entries(), this.st.pins, this.st.lhover ?? null);
    }

    // ------------------------------------------------------------ API
    go(i: number | null) {
      this.st.step = i === null || !msgs.length ? null : clamp(Math.round(i), 0, msgs.length - 1);
      if (this.st.step !== null) this.reveal(this.st.step);
      this.go0();
    }
    next() { this.go(this.st.step === null ? 0 : Math.min(msgs.length - 1, this.st.step + 1)); }
    prev() { this.go(this.st.step === null ? msgs.length - 1 : Math.max(0, this.st.step - 1)); }
    focusTag(id: string | null) {
      const e = id ? resolveEntry(this.entries(), id) : null;
      this.st.pins = e ? [e] : [];
      if (!e) this.spot = null;
      this.go0();
    }
    highlight(ids: string[] | null) {
      this.spot = ids?.length ? { id: 'highlight', name: 'highlighted', kind: 'derived', members: ids.filter((x) => laneIx.has(x)), hint: 'highlighted from outside the plate' } : null;
      this.st.pins = this.spot ? ['highlight'] : this.st.pins.filter((p) => p !== 'highlight');
      this.go0();
    }
    describe(): PlateOutline {
      return {
        kind: 'sequence', title: (this.constructor as SceneClass).title,
        nodes: laneNodes.map((n) => ({ id: n.id, label: n.label ?? n.id, group: n.group ?? null, category: nodeCategory(n), tags: n.tags ?? [] })),
        // the folded lanes are the plate's groups (Jarvis: drill expands one, back folds it)
        groups: units.map((u) => ({ id: u.id, label: u.name })), tags: entries.map((e) => ({ id: e.id, label: e.name, count: e.members.length })),
        steps: msgs.map(msgWords), stepMembers: msgs.map((m) => (m.from ? [m.from, m.to] : [m.to])),
      };
    }
    folds() { return units.map((u) => ({ id: u.id, name: u.name, sub: u.sub, members: [...u.members], expanded: this.exp.has(u.id) })); }
    expand(unit: string | null) {
      if (unit === null) return this.setExpanded(units.map((u) => u.id));
      const u = this.unitFor(unit);
      return !!u && this.setExpanded([...this.exp, u.id]);
    }
    collapse(unit?: string | null) {
      if (unit == null) return this.setExpanded([]);
      const u = this.unitFor(unit);
      return !!u && this.setExpanded([...this.exp].filter((x) => x !== u.id));
    }
    getState(): SequenceState { return { ...this.st, pins: [...this.st.pins], expanded: [...this.exp] }; }
    setState(s0: unknown) {
      const s = (s0 ?? {}) as Partial<SequenceState>;
      this.st = { ...blank(), ...s, pins: Array.isArray(s.pins) ? s.pins.filter((p) => entries.some((e) => e.id === p)) : [], expanded: Array.isArray(s.expanded) ? s.expanded.filter((id) => unitById.has(id)) : [] };
      // folded or expanded: the lanes (and so the plate's width) follow
      if (this.relane()) this.stage.refit(this.space);
      if (this.st.step != null) { this.st.step = clamp(this.st.step, 0, msgs.length - 1); if (s.scroll === undefined) this.reveal(this.st.step); }
      this.st.scroll = clamp(this.st.scroll ?? 0, 0, this.g.maxScroll);
      this.morph.snap(this.targets());
    }
    states() {
      const out: { name: string; state: SequenceState }[] = [{ name: 'rest', state: blank() }];
      if (!msgs.length) return out;
      const err = msgs.find((m) => m.err), deep = [...msgs].sort((a, b) => b.depth - a.depth || a.i - b.i)[0]!;
      out.push({ name: 'message-pin', state: { ...blank(), step: (err ?? msgs[Math.min(2, msgs.length - 1)]!).i } });
      out.push({ name: 'message-hover', state: { ...blank(), hover: Math.min(1, msgs.length - 1) } });
      out.push({ name: 'message-pin-last', state: { ...blank(), step: msgs.length - 1 } });
      out.push({ name: 'lane-hover', state: { ...blank(), lane: unitOf.get(deep.to)?.id ?? deep.to } });
      if (contentH > BODY_MAX) out.push({ name: 'scrolled-end', state: { ...blank(), scroll: 1e9 } });
      const cat = entries.find((e) => e.kind === 'category'), tag = entries.find((e) => e.kind !== 'category');
      if (cat) out.push({ name: `legend-hover-${cat.id.replace(/^cat:/, '')}`, state: { ...blank(), lhover: cat.id } });
      if (tag) out.push({ name: `legend-pin-${tag.id.replace(/^(tag|kind):/, '')}`, state: { ...blank(), pins: [tag.id] } });
      // folded lanes: folded (the rest), expanded, the folded head hovered (its members listed), a call into it pinned
      if (units.length) {
        const u = units[0]!, into = msgs.find((m) => u.members.includes(m.to));
        const pinAt = (step: number, expanded: string[]) => { const { scroll: _s, ...b } = blank(); return { ...b, step, expanded }; };
        out.push({ name: 'folded', state: blank() });
        out.push({ name: 'expanded', state: { ...blank(), expanded: units.map((x) => x.id) } });
        out.push({ name: 'fold-hover', state: { ...blank(), lane: u.id } });
        if (into) out.push({ name: 'fold-message-pin', state: pinAt(into.i, []) });
        if (into) out.push({ name: 'expanded-message-pin', state: pinAt(into.i, units.map((x) => x.id)) });
      }
      return out;
    }
    /** Key help (docs/ENGINE.md "Key help"): what `onKey` does right now. */
    keys(): KeyHelp[] {
      const M = 'Messages', s = this.st.step, L = msgs.length, out: KeyHelp[] = [];
      if (L) {
        out.push({ group: M, keys: ['j', '↓', '→'], does: s === null ? 'pin the first message' : 'next message', ...(s === L - 1 ? { off: true, when: 'before the last message' } : {}) });
        out.push({ group: M, keys: ['k', '↑', '←'], does: s === null ? 'pin the last message' : 'previous message', ...(s === 0 ? { off: true, when: 'after the first message' } : {}) });
      }
      const max = this.g.maxScroll, at = this.st.scroll ?? 0;
      if (max > 0) {
        const top = at <= 0, end = at >= max;
        out.push({ group: M, keys: ['PgDn', 'Space'], does: 'scroll down a page', ...(end ? { off: true, when: 'above the end' } : {}) });
        out.push({ group: M, keys: 'PgUp', does: 'scroll up a page', ...(top ? { off: true, when: 'below the top' } : {}) });
        out.push({ group: M, keys: 'Home', does: 'scroll to the top', ...(top ? { off: true, when: 'below the top' } : {}) });
        out.push({ group: M, keys: 'End', does: 'scroll to the end', ...(end ? { off: true, when: 'above the end' } : {}) });
      }
      const esc = s !== null ? 'unpin the message' : this.st.pins.length ? 'clear the pinned legend entries' : null;
      if (esc) out.push({ group: M, keys: 'Esc', does: esc });
      const n = Math.min(9, this.entries().length);
      if (n) out.push({ group: 'Legend', keys: n === 1 ? '1' : `1–${n}`, does: `pin legend entry 1${n > 1 ? `–${n}` : ''} (again to unpin)` });
      return out;
    }
    onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      // Enter (or Space) on a focused folded head expands it
      const f = (e.key === 'Enter' || e.key === ' ') ? (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('[data-fold]') : null;
      if (f && this.stage.dom.contains(f)) { this.toggle(f.dataset.fold!); return true; }
      const page = this.g.bodyH * 0.8;
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': case 'j': this.next(); return true;
        case 'ArrowLeft': case 'ArrowUp': case 'k': this.prev(); return true;
        case 'PageDown': case ' ': this.scrollBy(page); return true;
        case 'PageUp': this.scrollBy(-page); return true;
        case 'Home': this.st.scroll = 0; this.go0(); return true;
        case 'End': this.st.scroll = this.g.maxScroll; this.go0(); return true;
        case 'Escape':
          if (this.st.step !== null) { this.go(null); return true; }
          if (this.st.pins.length) { this.st.pins = []; this.spot = null; this.go0(); return true; }
          if (this.exp.size) return this.setExpanded([]);       // then fold what was expanded
          return false;
      }
      if (/^[1-9]$/.test(e.key)) { const x = this.entries()[+e.key - 1]; if (x && unitById.has(x.id)) { this.toggle(x.id); return true; } if (x) { this.st.pins = this.st.pins.includes(x.id) ? this.st.pins.filter((p) => p !== x.id) : [...this.st.pins, x.id]; this.go0(); return true; } }
      return false;
    }

    // ------------------------------------------------------------ frame
    /** Sizes follow the geometry: written when it changes (a fit). */
    private layoutDom() {
      const g = this.g, key = `${g.W}x${g.H}`;
      if (this.laidFor === key) return;
      this.laidFor = key;
      const dom = this.stage.dom, px = (n: number) => `${Math.round(n * 10) / 10}px`;
      const set = (el: HTMLElement | null, s: Record<string, string>) => { if (el) Object.assign(el.style, s); };
      for (const el of this.els.life.values()) set(el, { height: px(contentH) });
      set(dom.querySelector('.sq-clip'), { width: px(g.W), height: px(g.bodyH) });
      set(dom.querySelector('.sq-sheet'), { width: px(g.W), height: px(contentH) });
    }
    /** Positions follow the lanes, which glide when a folded lane expands or folds (the morph's `L:<lane>` values). */
    private place() {
      const g = this.g, px = (n: number) => `${Math.round(n * 10) / 10}px`, hw = g.P - 14;
      const X = (id: string) => this.morph.value(`L:${id}`)!.x!;
      for (const [id, el] of this.els.head) { el.style.left = px(X(id) - hw / 2); el.style.width = px(hw); }
      for (const [id, el] of this.els.life) el.style.left = px(X(id));
      for (const u of units) { const v = this.morph.value(`U:${u.id}`)!, el = this.els.unit.get(u.id)!; el.style.left = px(v.x!); el.style.width = px(v.w!); }
      const bv = this.morph.value('band')!, L = bv.l!, R = bv.r!;
      for (const b of bands) Object.assign(this.els.band[b.i]!.style, { left: px(L), top: px(b.y), width: px(R - L), height: px(b.h) });
      for (const m of msgs) {
        const xb = X(m.to) + m.depth * 4;
        Object.assign(this.els.act[m.i]!.style, { left: px(xb - ACT / 2), top: px(m.y + ROW * 0.5), height: px(Math.max(ROW * 0.5, m.endY - m.y - ROW * 0.5)) });
        // the arrow runs from the caller's activation edge to the callee's (a call with no caller starts at the band's edge)
        const fromLane = m.from ?? null, xa0 = fromLane ? X(fromLane) : L + 8;
        const parent = parentMsg.get(m.i);
        const xa = fromLane ? xa0 + (parent && parent.to === fromLane ? parent.depth * 4 : 0) : xa0;
        const el = this.els.msg[m.i]!;
        // a call within one folded lane (a member calling a member) loops back to its own lane
        if (el.classList.contains('self')) { el.classList.remove('rev'); Object.assign(el.style, { left: px(xa + ACT / 2), top: px(m.y), width: px(22) }); continue; }
        const rev = xb < xa, a = rev ? xb + ACT / 2 : xa + (fromLane ? ACT / 2 : 0), b = rev ? xa - ACT / 2 : xb - ACT / 2;
        el.classList.toggle('rev', rev);
        Object.assign(el.style, { left: px(Math.min(a, b)), top: px(m.y), width: px(Math.max(12, Math.abs(b - a))) });
      }
    }

    update(f: Frame) {
      this.morph.progress(ease.outCubic(clamp(f.t / f.duration)));
      this.layoutDom();
      this.place();
      const g = this.g, st = this.st;
      const lit = this.lit(), hv = st.hover != null ? msgs[st.hover] : undefined, pin = st.step != null ? msgs[st.step] : undefined;
      const on = (m: Msg) => m === hv || m === pin;
      const litMsg = (m: Msg) => on(m) || (!!lit && lit.has(m.to));
      const any = !!lit || !!hv || !!pin;
      for (const m of msgs) {
        const n = this.$(`#m${m.i}`), a = this.$(`#a${m.i}`);
        const l = litMsg(m);
        n.classes['is-lit'] = l;
        n.classes['is-pin'] = m === pin;
        const d = !any || l || (st.lane && ((m.from && this.showOf(m.from) === st.lane) || this.showOf(m.to) === st.lane)) ? 1 : DIM;
        n.opacity = d;
        a.opacity = !any || l || (lit?.has(m.to) ?? false) ? 1 : 0.45;
      }
      const ends = new Set([hv?.from, hv?.to, pin?.from, pin?.to].filter((x): x is string => !!x).map((x) => this.showOf(x)));
      for (const id of this.els.head.keys()) {
        const h = this.$(`#h-${cssId(id)}`), life = this.$(`#l-${cssId(id)}`), o = this.morph.value(`L:${id}`)!.o!;
        const u = unitById.get(id), on = ends.has(id) || !!lit?.has(id) || (!!u && !!lit && u.members.some((x) => lit.has(x)));
        h.classes['is-lit'] = on;
        h.opacity = (!lit || on ? 1 : 0.45) * o;
        h.hidden = life.hidden = o < 0.02;
        life.opacity = o;
      }
      for (const u of units) { const e = this.morph.value(`U:${u.id}`)!.e!; this.$(`#u-${cssId(u.id)} .sq-ub`).opacity = e; }
      this.$('.sq-top .pl-label').text = headWords(this.vis.length, units.filter((u) => !this.exp.has(u.id)));
      this.foldCard();
      const sy = this.morph.value('s')!.y!;
      this.$('.sq-sheet').y = -sy;
      // what lies beyond the body, in words
      const above = msgs.filter((m) => m.y + ROW <= sy).length, below = msgs.filter((m) => m.y >= sy + g.bodyH).length;
      const more = this.$('#sq-more');
      more.text = above || below ? `${above ? `↑ ${above} above` : ''}${above && below ? ' · ' : ''}${below ? `↓ ${below} below · scroll` : ''}` : '';
      more.el.style.top = `${BODY_Y + g.bodyH + 3}px`;
      // the pinned message's card, beside its arrow, inside the body
      const card = this.$('#sq-card'), co = this.morph.value('c')!.o!;
      const cm = pin ?? (co > 0.01 ? msgs[Number(this.cardFor.split(':')[0])] : undefined);
      if (!cm || co < 0.01) card.set({ hidden: true, opacity: 0 });
      else {
        const k = `${cm.i}:${g.W}`;
        if (this.cardFor !== k) { card.el.innerHTML = this.cardHTML(cm); this.cardFor = k; }
        const box = this.$(`#m${cm.i}`).el, bw = parseFloat(box.style.width);
        // a call into a folded lane has a label wider than its arrow: the card keeps clear of it
        const ext = box.classList.contains('to-fold') ? Math.max(0, (200 - (bw - 8)) / 2) : box.classList.contains('self') ? 200 : 0;
        const bx = parseFloat(box.style.left) + bw + ext;
        // beside the arrow when there is room, else under it (above it near the body's bottom), by its head
        const bl = parseFloat(box.style.left) - (box.classList.contains('self') ? 0 : ext), ch = card.el.offsetHeight, rowY = BODY_Y + cm.y - sy;
        let x: number, y: number;
        if (bx + 16 + CARD_W <= g.W - 8) { x = bx + 16; y = rowY - 4; }
        else if (bl - 16 - CARD_W >= 8) { x = bl - 16 - CARD_W; y = rowY - 4; }
        else { x = clamp((box.classList.contains('rev') ? bl : bx) - CARD_W / 2, 8, g.W - CARD_W - 8); y = rowY + ROW + 6 + ch <= BODY_Y + g.bodyH ? rowY + ROW + 6 : rowY - ch - 6; }
        y = clamp(y, BODY_Y, BODY_Y + g.bodyH - ch);
        const view = this.stage.view;
        if (!view.zoomed) card.set({ x, y: y + 8 * (1 - co), opacity: co });
        else {
          // zoomed in (docs/ENGINE.md "Zoom and pan"): beside the arrow, at its fit size, inside the visible part
          const k = 1 / view.zoom, arrow = { x: bl, y: rowY, w: bx - bl, h: ROW };
          const o = view.overlay({ x: bl, y: rowY }, CARD_W, ch, [arrow], (_a, w, h, W, H, av) => {
            const r = av[0]!, m = 8 * k, gap = 16 * k;
            const p = r.x + r.w + gap + w <= W - m ? { x: r.x + r.w + gap, y: r.y - 4 * k } : r.x - gap - w >= m ? { x: r.x - gap - w, y: r.y - 4 * k } : { x: r.x + r.w / 2 - w / 2, y: r.y + r.h + 6 * k + h <= H - m ? r.y + r.h + 6 * k : r.y - h - 6 * k };
            return { x: clamp(p.x, m, W - w - m), y: clamp(p.y, m, H - h - m) };
          });
          card.set({ x: o.x, y: o.y + 8 * (1 - co) * k, scale: o.scale, opacity: co });
        }
      }
      this.legend.sync({ pins: st.pins, hover: st.lhover ?? null, picked: 0, editable: false });
      const lu = st.lane ? unitById.get(st.lane) : undefined, folded = units.filter((u) => !this.exp.has(u.id)), open = units.filter((u) => this.exp.has(u.id));
      const foldWords = `${folded.length ? `${folded.map((u) => u.name).join(', ')} folded · click to expand · ` : ''}${open.length ? `${open.map((u) => u.name).join(', ')} expanded · ⤡ folds · ` : ''}`;
      this.$('#sq-mode').text = hv ? `${msgWords(hv)} · ${ms((hv.s.end ?? hv.s.start) - hv.s.start)} ms${hv.err ? ' · failed' : ''} · click to pin`
        : pin ? `${pin.i + 1} of ${msgs.length}: ${msgWords(pin)} — ←/→ the next call · Esc unpins`
        : lu && !this.exp.has(lu.id) ? `${lu.name} (${lu.sub}): ${memberNames(lu).join(', ')} · ${plural(msgs.filter((m) => lu.members.includes(m.to)).length, 'call')} in · click to expand`
        : st.lane ? `${label(st.lane)}: ${plural(msgs.filter((m) => m.to === st.lane).length, 'call')} in, ${msgs.filter((m) => m.from === st.lane).length} out`
        : `${foldWords}${msgs.length} calls in order, top to bottom · hover or click a call · ←/→ step through them${g.maxScroll ? ' · scroll for more' : ''}`;
    }

    /** Hovering a folded head lists its members (and how often each was called) under it. */
    private foldCard() {
      const card = this.$('#sq-fcard'), u = this.st.lane ? unitById.get(this.st.lane) : undefined;
      if (!u || this.exp.has(u.id)) { card.set({ hidden: true, opacity: 0 }); return; }
      if (this.fcardFor !== u.id) {
        card.el.innerHTML = `<div class="t">${esc(u.name)}</div><div class="s">${esc(u.sub)}</div>
          <ol>${u.members.map((id) => `<li>${esc(label(id))}<b>${plural(msgs.filter((m) => m.to === id).length, 'call')}</b></li>`).join('')}</ol>
          <div class="h">⤢ click to expand into ${u.members.length} lanes</div>`;
        this.fcardFor = u.id;
      }
      const h = this.els.head.get(u.id)!, w = card.el.offsetWidth || 240, left = parseFloat(h.style.left);
      card.set({ x: clamp(left, 8, this.g.W - w - 8), y: HEAD_Y + HEAD_H + 8 });
    }

    private cardHTML(m: Msg) {
      const n = nodeOf(m.to), d = (m.s.end ?? m.s.start) - m.s.start;
      const nested = msgs.filter((x) => x.s.parent === m.s.id).length;
      return `<div class="pl-label">call ${m.i + 1} of ${msgs.length}${grouped ? ` · band ${m.band + 1}` : ''}</div>
        <div class="t">${esc(m.from ? label(m.from) : 'start')} → ${esc(label(m.to))}</div>
        ${m.op ? `<div class="op">${esc(m.op)}</div>` : ''}
        <div class="f${m.err ? ' err' : ''}"><b>${ms(d)} ms</b> · ${m.err ? '<b>failed</b>' : 'ok'} · at +${ms(m.s.start - t0)} ms${nested ? ` · ${nested} nested call${nested === 1 ? '' : 's'}` : ''}</div>
        ${m.err && m.s.attrs?.error ? `<div class="f err">${esc(String(m.s.attrs.error))}</div>` : ''}
        ${n.summary ? `<p class="sum">${esc(n.summary)}</p>` : ''}`;
    }

    draw(_f: Frame, fx: Fx) { fx.under.bg.pattern = 'dots'; fx.under.bg.patternAlpha = 0.18; }
  };
}

