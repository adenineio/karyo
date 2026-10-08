// What a wire means, in words: the card that appears when you hover a wire on a model plate (the
// structure board, trace boards; docs/ENGINE.md "Wire hover"). Everything here is generated from the
// model, shape-neutrally: the relationship's kinds (calls, reads, writes …), its verdict (model.ts
// `verdict`: the same one that styles the wire), the operations the recorded runs made along it (span
// labels, attributed to the pair with `attributeCall`, as the merge counted them), where the code declares
// it, and the relationship's own `label` when the code gave one (it replaces the generated sentence).
import { attributeCall, relations, pairKey, kindsOf, type Model, type MEdge, type MNode, type MSpan, type Wire, type EdgeKind, type Verdict } from './model';
import { esc } from './scenes';

/** One recorded call along a relationship. */
export interface RecordedCall { flow: string; flowTitle: string; span: MSpan; op: string; ns: number; err: boolean }

/** The operation a span names: its label, unless that only repeats the node; `fn()` reads as `fn`. */
export function opOf(s: MSpan, node?: MNode): string {
  const l = (s.label ?? '').trim();
  if (!l || l === s.node || l === node?.label) return '';
  return l.replace(/\(\s*\)$/, '');
}

/** Every recorded call, keyed by the relationship it was counted on (`pairKey`), in flow then start order. */
export function callsByPair(model: Model, flows = model.flows): Map<string, RecordedCall[]> {
  const rel = new Map(relations(model).map((e) => [pairKey(e.from, e.to), e]));
  const nodes = new Map(model.nodes.map((n) => [n.id, n]));
  const out = new Map<string, RecordedCall[]>();
  for (const f of flows) {
    const byId = new Map(f.spans.map((s) => [s.id, s]));
    for (const s of [...f.spans].sort((a, b) => a.start - b.start)) {
      const caller = s.parent && byId.has(s.parent) ? byId.get(s.parent)!.node : f.entry;
      if (!caller || caller === s.node) continue;
      const h = attributeCall((k) => rel.get(k), caller, s.node);
      const c: RecordedCall = { flow: f.id, flowTitle: f.title ?? f.id, span: s, op: opOf(s, nodes.get(s.node)), ns: (s.end ?? s.start) - s.start, err: s.status === 'error' };
      (out.get(h.key) ?? out.set(h.key, []).get(h.key)!).push(c);
    }
  }
  return out;
}

const flowsPhrase = (fs: string[]) => (!fs.length ? null : fs.length === 1 ? `in the recorded flow “${fs[0]}”` : `in the recorded flows ${listing(fs.map((f) => `“${f}”`), 6)}`);

const VERB: Record<EdgeKind, string> = { calls: 'calls', reads: 'reads from', writes: 'writes to', publishes: 'publishes to', subscribes: 'subscribes to', imports: 'imports' };
/** "a", "a and b", "a, b and c" (more than `max`: "a, b, c and 2 more"). */
export function listing(xs: string[], max = 4): string {
  if (xs.length > max) return `${xs.slice(0, max - 1).join(', ')} and ${xs.length - max + 1} more`;
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
/** Plain words (`get`, `add source`) read as verbs; anything else (`text_slugify`, a path) is a name. */
const plainWords = (ops: string[]) => ops.every((o) => /^[A-Za-z][A-Za-z -]*$/.test(o));

/** One plain sentence of what the relationship does, from its kinds and the operations recorded along it. */
export function wireSentence(from: string, to: string, kinds: EdgeKind[], ops: string[]): string {
  if (kinds.length === 1 && kinds[0] === 'calls') {
    if (!ops.length) return `${from} calls ${to}.`;
    return plainWords(ops) ? `${from} asks ${to} to ${listing(ops)}.` : `${from} calls ${to} for ${listing(ops)}.`;
  }
  return `${from} ${listing(kinds.map((k) => VERB[k]), 5)} ${to}.`;
}

const VERDICT_TEXT: Record<Verdict, string> = {
  confirmed: 'declared in the code and seen in recorded runs',
  unseen: 'declared in the code, never seen in a recorded run',
  extracted: 'found in the code by static analysis, not seen in a recorded run',
  unexercised: 'in the code, but not exercised: recorded runs that watched both ends never made this call',
  undeclared: 'seen in recorded runs, not declared in the code',
  entry: 'a caller from outside, seen calling in',
  possible: 'possible (imports allow it), not declared or seen',
  proposed: 'proposed in a splice: not in the code yet',
};

export interface WireInfo {
  key: string;
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  kinds: EdgeKind[];
  verdict: Verdict;
  style: Wire['style'];
  /** The declared label when the code gave one, else the generated sentence. */
  sentence: string;
  /** The sentence is the relationship's own label (from the code). */
  labelled: boolean;
  count: number;
  /** Operations by count (most first), then first seen. */
  ops: [string, number][];
  /** Where the relationship is (or would be) declared: the from-node's directive. */
  at: string | null;
  /** Where the calls were recorded, as a phrase (the flows, or what the plate passes, e.g. its requests). */
  where: string | null;
  /** Which way data travels, when that isn't the arrow's way (reads, subscriptions). */
  direction: string | null;
  verdictText: string;
  /** An annotation declares it (else static analysis found it, or only a run saw it). */
  declared: boolean;
}

/** What the code has, in a model with no recorded run (model.ts `hasRuns`): nothing could have been seen. */
const NO_RUNS_TEXT: Partial<Record<Verdict, string>> = {
  unseen: 'declared in the code (no runs are recorded)',
  extracted: 'found in the code by static analysis (no runs are recorded)',
};

export function wireInfo(w: Wire, calls: RecordedCall[], o: { label: (id: string) => string; node: (id: string) => MNode | undefined; where?: string | null; statics?: boolean; runs?: boolean }): WireInfo {
  const A = o.label(w.from), B = o.label(w.to);
  const kinds = w.kinds.length ? w.kinds : kindsOf(w.edge as MEdge);
  const firstSeen: string[] = [];
  const n = new Map<string, number>();
  for (const c of calls) { const op = c.op || 'call'; if (!n.has(op)) firstSeen.push(op); n.set(op, (n.get(op) ?? 0) + 1); }
  const ops = [...n].sort((a, b) => b[1] - a[1] || firstSeen.indexOf(a[0]) - firstSeen.indexOf(b[0]));
  const label = (w.edge.label ?? '').trim();
  const fn = o.node(w.from);
  const at = fn?.code ? `${fn.code.file}:${fn.code.start}` : fn?.ref ? `${fn.ref.file}${fn.ref.line ? `:${fn.ref.line}` : ''}` : null;
  const direction = kinds.includes('subscribes') ? `${B} delivers to ${A}` : kinds.includes('reads') && !kinds.includes('writes') ? `data comes back to ${A}` : null;
  return {
    key: w.key, from: w.from, to: w.to, fromLabel: A, toLabel: B, kinds, verdict: w.verdict, style: w.style, declared: w.decl,
    sentence: label || wireSentence(A, B, kinds, firstSeen.filter((x) => x !== 'call')),
    labelled: !!label, count: calls.length, ops, at,
    where: o.where !== undefined ? o.where : flowsPhrase([...new Set(calls.map((c) => c.flowTitle))]),
    direction, verdictText: w.verdict === 'confirmed' && !w.edge.sources.includes('declared') ? 'found in the code by static analysis and seen in recorded runs'
      : w.verdict === 'undeclared' && w.edge.sources.includes('extracted') === false && o.statics ? 'seen in recorded runs; neither declared nor found by static analysis'
      : (o.runs === false && NO_RUNS_TEXT[w.verdict]) || VERDICT_TEXT[w.verdict],
  };
}

const fmtMs = (ns: number) => { const v = ns / 1e6; return v < 0.1 ? `${Math.max(1, Math.round(v * 1000))} µs` : v < 10 ? `${v.toFixed(2)} ms` : `${Math.round(v)} ms`; };

/** The card's HTML. `calls`: the recorded calls to list (when the card is pinned). */
export function wireCardHTML(i: WireInfo, o: { pinned: boolean; calls?: RecordedCall[]; callsTitle?: string; hint?: string }): string {
  const glyph = `<i class="wh-glyph ${i.style}" aria-hidden="true"></i>`;
  const ev: string[] = [];
  if (i.count) ev.push(`recorded ${i.count}×: ${i.ops.map(([op, k]) => `${esc(op)} ×${k}`).join(' · ')}`);
  else ev.push(i.verdict === 'proposed' ? 'nothing recorded: it is only a proposal' : i.verdict === 'unexercised' ? 'no recorded call, though the recording watched both ends'
    : i.verdict === 'unseen' || i.verdict === 'possible' || i.verdict === 'extracted' ? 'no recorded call' : 'recorded, no calls in this view');
  if (i.at) ev.push(i.verdict === 'undeclared' || i.verdict === 'possible' ? `not declared · declare it at ${esc(i.at)}` : i.verdict === 'extracted' || (i.verdict !== 'unseen' && !i.declared) ? `in the code at ${esc(i.at)}` : `declared at ${esc(i.at)}`);
  if (i.where) ev.push(esc(i.where));
  const calls = o.pinned && o.calls ? o.calls : null;
  const MAX = 12;
  return `<div class="wh-h"><span class="wh-t">${esc(i.fromLabel)} <span class="wh-arrow">→</span> ${esc(i.toLabel)}</span>${i.kinds.map((k) => `<span class="wh-k">${k}</span>`).join('')}</div>
    <p class="wh-s${i.labelled ? ' is-label' : ''}">${esc(i.sentence)}</p>
    ${i.direction ? `<div class="wh-dir">↩ ${esc(i.direction)}</div>` : ''}
    <div class="wh-v">${glyph}<span>${esc(i.verdictText)}</span></div>
    <div class="wh-ev">${ev.map((x) => `<div>${x}</div>`).join('')}</div>
    ${calls ? `<div class="wh-calls"><div class="pl-label">${esc(o.callsTitle ?? 'recorded calls')} · ${calls.length}</div>${calls.slice(0, MAX).map((c) => `<div class="wh-call${c.err ? ' is-err' : ''}"><span>${esc(c.op || 'call')}</span><span>${fmtMs(c.ns)}</span></div>`).join('')}${calls.length > MAX ? `<div class="wh-more">+ ${calls.length - MAX} more</div>` : ''}${calls.length ? '' : '<div class="wh-more">none</div>'}</div>` : ''}
    <div class="wh-hint">${esc(o.hint ?? (o.pinned ? 'pinned · Esc or click elsewhere to close' : 'click the wire to pin this card'))}</div>`;
}

/** A warning's card (a Stack view slice's numbered warning item, e.g. a conflict between splices), in the wire card's
 *  style: which one it is, what it concerns, what each party does to it (with a button that opens that party), and how
 *  it ended up. Shape-neutral: every word comes from the caller. */
export interface WarningCard {
  /** Its number and how many there are (1-based), what one is called ("conflict") and its symbol (default ⚠). */
  n: number; of: number; name: string; sym?: string;
  /** What it concerns ("Report renderer → Session store"). */
  title: string;
  /** What it means, in plain words ("two splices change this"). */
  meaning?: string;
  lines: { who: string; text: string; open?: number }[];
  result?: string;
  /** Its own buttons (`data-item-act` = the id), before the ones that open a party. */
  actions?: { id: string; label: string }[];
}
export function warningCardHTML(c: WarningCard, o: { pinned: boolean }): string {
  const opens = c.lines.filter((l) => typeof l.open === 'number'), acts = c.actions ?? [];
  return `<div class="wh-h"><span class="wh-warn">${esc(c.sym ?? '⚠')} ${esc(c.name)}${c.of > 1 ? ` ${c.n} of ${c.of}` : ''}</span></div>
    <div class="wh-t">${esc(c.title)}</div>
    ${c.meaning ? `<p class="wh-s">${esc(c.meaning[0]!.toUpperCase() + c.meaning.slice(1))}${/[?!.]$/.test(c.meaning) ? '' : ':'}</p>` : ''}
    ${c.lines.length ? `<div class="wh-parts">${c.lines.map((l) => `<div class="wh-part"><b>${esc(l.who)}</b><span>${esc(l.text)}</span></div>`).join('')}</div>` : ''}
    ${c.result ? `<div class="wh-res">${esc(c.result)}</div>` : ''}
    ${opens.length || acts.length ? `<div class="wh-acts">${acts.map((a) => `<button type="button" class="wh-open is-act" data-item-act="${esc(a.id)}">${esc(a.label)}</button>`).join('')}${opens.map((l) => `<button type="button" class="wh-open" data-open-slice="${l.open}">Open ${esc(l.who)}</button>`).join('')}</div>` : ''}
    <div class="wh-hint">${o.pinned ? 'pinned · Esc or click elsewhere to close' : 'click to pin this card'}</div>`;
}

export const WIRE_CARD_W = 340;
export const WIRE_CSS = /* css */ `
  .wh-card { position: absolute; left: 0; top: 0; width: ${WIRE_CARD_W}px; box-sizing: border-box; z-index: 40; padding: 10px 12px; display: grid; gap: 6px; pointer-events: none; }
  .wh-card.is-pinned { pointer-events: auto; border-color: var(--pl-accent); }
  .wh-h { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .wh-t { font: 600 14px/1.25 var(--pl-font-display); margin-right: 2px; }
  .wh-arrow { color: var(--pl-muted); font-weight: 400; }
  .wh-k { font: 500 10px/1 var(--pl-font-mono); padding: 3px 6px; border: 1px solid var(--pl-card-border); border-radius: min(var(--pl-radius), 999px); color: var(--pl-muted); }
  .wh-s { margin: 0; font-size: 13px; line-height: 1.4; }
  .wh-s.is-label::before { content: '“'; } .wh-s.is-label::after { content: '”'; }
  .wh-dir { font: 11.5px/1.3 var(--pl-font-mono); color: var(--pl-muted); }
  .wh-v { display: flex; align-items: center; gap: 8px; font: 11.5px/1.3 var(--pl-font-mono); color: var(--pl-muted); }
  .wh-glyph { flex: none; width: 20px; height: 0; border-top: 2px solid var(--pl-line); }
  .wh-glyph.dashed { border-top-style: dashed; }
  .wh-glyph.idle { border-top-style: dotted; opacity: 0.75; }
  .wh-glyph.warn { border-color: var(--pl-accent-2); }
  .wh-ev { display: grid; gap: 2px; font: 11.5px/1.35 var(--pl-font-mono); color: var(--pl-muted); overflow-wrap: anywhere; }
  .wh-calls { display: grid; gap: 1px; border-top: 1px solid var(--pl-card-border); padding-top: 6px; }
  .wh-calls > .pl-label { margin-bottom: 3px; }
  .wh-call { display: flex; justify-content: space-between; gap: 10px; font: 11.5px/1.45 var(--pl-font-mono); }
  .wh-call span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .wh-call span:last-child { color: var(--pl-muted); font-variant-numeric: tabular-nums; }
  .wh-call.is-err span { color: var(--pl-accent-2); }
  .wh-more { font: 11px/1.4 var(--pl-font-mono); color: var(--pl-muted); }
  .wh-hint { font: 10.5px/1.2 var(--pl-font-mono); color: var(--pl-muted); opacity: 0.85; }
  /* a warning's card (warningCardHTML): the warning colour, its parties, their buttons */
  .wh-card.is-warncard { pointer-events: auto; border-color: color-mix(in srgb, var(--pl-accent-2) 70%, var(--pl-card-border)); }
  .wh-card.is-warncard.is-pinned { border-color: var(--pl-accent-2); box-shadow: var(--pl-shadow), 0 0 0 1px var(--pl-accent-2); }
  /* a quiet note (e.g. two splices agree) and a question (the same thing?) */
  .wh-card.is-warncard.is-note { border-color: var(--pl-line); }
  .wh-card.is-warncard.is-note.is-pinned { border-color: var(--pl-fg); box-shadow: var(--pl-shadow), 0 0 0 1px var(--pl-line); }
  .wh-card.is-note .wh-warn { color: var(--pl-muted); }
  .wh-card.is-warncard.is-ask { border-color: color-mix(in srgb, var(--pl-accent) 70%, var(--pl-card-border)); }
  .wh-card.is-warncard.is-ask.is-pinned { border-color: var(--pl-accent); box-shadow: var(--pl-shadow), 0 0 0 1px var(--pl-accent); }
  .wh-card.is-ask .wh-warn { color: var(--pl-accent); }
  .wh-open.is-act { border-color: var(--pl-accent); color: var(--pl-accent); font-weight: 600; }
  .wh-warn { display: inline-flex; align-items: center; gap: 7px; font: 700 10.5px/1 var(--pl-font-mono); letter-spacing: 0.07em; text-transform: uppercase; color: var(--pl-accent-2); }
  .wh-parts { display: grid; gap: 4px; }
  .wh-part { display: grid; grid-template-columns: minmax(0, max-content) 1fr; column-gap: 8px; font-size: 12.5px; line-height: 1.35; }
  .wh-part b { font-weight: 600; white-space: nowrap; }
  .wh-part b::after { content: ':'; }
  .wh-res { font: 12px/1.4 var(--pl-font-mono); border-top: 1px dashed var(--pl-line); padding-top: 6px; }
  .wh-acts { display: flex; flex-wrap: wrap; gap: 6px; }
  .wh-open { font: 500 11px/1 var(--pl-font-mono); color: var(--pl-fg); background: var(--pl-card); border: 1px solid var(--pl-line); border-radius: min(var(--pl-radius), 6px); padding: 6px 9px; cursor: pointer; }
  .wh-open:hover { border-color: var(--pl-accent); color: var(--pl-accent); }
  .plate-dom.wh-over { cursor: pointer; }
`;

/** Where the card sits: beside the pointer (or the anchor), kept inside the plate, off the boxes in `avoid`
 *  (the wire's two cards) when a corner around the pointer allows it, and off the boxes in `keep` (what it was
 *  pointed at, e.g. a ⚠ to click) before anything else. */
export function placeCard(at: { x: number; y: number }, w: number, h: number, W: number, H: number, avoid: { x: number; y: number; w: number; h: number }[] = [], keep: { x: number; y: number; w: number; h: number }[] = []): { x: number; y: number } {
  const G = 16;
  const fit = (x: number, y: number) => ({ x: Math.max(8, Math.min(W - w - 8, x)), y: Math.max(8, Math.min(H - h - 8, y)) });
  const cands = [fit(at.x + G, at.y + G), fit(at.x + G, at.y - G - h), fit(at.x - G - w, at.y + G), fit(at.x - G - w, at.y - G - h)];
  const over = (c: { x: number; y: number }, rs: typeof avoid) => rs.reduce((s, r) => s + Math.max(0, Math.min(c.x + w, r.x + r.w) - Math.max(c.x, r.x)) * Math.max(0, Math.min(c.y + h, r.y + r.h) - Math.max(c.y, r.y)), 0);
  const overlap = (c: { x: number; y: number }) => over(c, keep) * 1e6 + over(c, avoid);
  let best = cands[0]!, bestO = Infinity;
  for (const c of cands) { const o = overlap(c); if (o < bestO - 1) { best = c; bestO = o; } }
  return best;
}

/** Elements the pointer can be over without meaning a wire (cards, buttons, panels, the legend …). */
export const NOT_A_WIRE = '[data-pl-chrome], .mm-card, .bd-chip, .bd-panel, .bd-foot, .bd-toolbar, .bd-gl, .wh-card, button, input, a, .tb-req, .tb-legend, .tb-bar, .tb-mode, .mm-head';
