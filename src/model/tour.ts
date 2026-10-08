// The tour plate: a recorded pipeline as a timeline you step through like a theater
// (docs/ENGINE.md, "Interactive plates"). Across the top, one station per step with its real
// duration; left, the real source the step runs (focus lines lit, centred in a clipped window);
// right, the step's prose, timing facts and a mini diagram of the nodes involved. A step is the only
// thing that moves: the marker glides to the station, the old code slides out as the new slides in,
// and the diagram's cards that persist glide to their new places while the others fade.
import { Scene, Morph, Path, roundCorners, ease, clamp, mix, outline, lightUnder, settleChrome, chromeBoxFor, type Frame, type Fx, type SceneClass, type Vals, type Node, type KeyHelp } from '../engine';
import { type Model, type MNode, type BuiltTour, type BuiltStep, type BuiltCode } from './model';
import { stepWires } from './tours';
import { cssId, esc } from './scenes';
import { kitsFor, modelStats, type KitSet } from '../kits/registry';
import type { PlateOutline } from './outline';

/** What a page can call on a mounted tour (`stage.scene as unknown as TourApi`). */
export interface TourApi {
  /** Go to step i (0-based); stops play. */
  go(i: number): void;
  next(): void;
  prev(): void;
  /** Step through the remaining steps (from the first when on the last); again: stop. */
  play(): void;
  readonly step: number;
  /** What is on the plate, as plain data (src/model/outline.ts). */
  describe?(): PlateOutline;
}

const W = 1600, H = 900, SIDE = 48;
const D = 0.7;                 // one transition (s)
const DWELL = 1200;            // play: ms a landed step stays before the next one
// timeline
const TY = 170;                // track y
const GY = 114;                // group label y
const BY = 138;                // bracket y
// panels
const PY = 272;                // panels top
const CODE_W = 876, CODE_H = 578;
const RX = SIDE + CODE_W + 32, RW = W - SIDE - RX;
const TEXT_H = 300;
const DIA_Y = PY + TEXT_H + 16, DIA_H = PY + CODE_H - DIA_Y;
// code
const HEAD_H = 44, LH = 21, PAD = 10;
const SL = 56, SLT = 28;       // slide distances: code, text
// mini diagram
const CH = 44;
// fitted to a space (docs/ENGINE.md "Theater"): below this band width (designed px) or a squarer window, the panels stack
const WIDE = 900, FOOT = 50, PGAP = 16;

interface Box { x: number; y: number; w: number; h: number }
type XY = { x: number; y: number };
/** Where everything sits: the page's layout, or one fitted to a space (`fit`). The band (header, tools, step rail) is laid
 *  out `bandW` wide and drawn k times larger from the top-left corner by the chrome floor; the code and text panels are
 *  laid out at `code` / `text` so that, boosted, they are drawn at `codeD` / `textD` (chromeBoxFor); the diagram (content,
 *  never boosted) fills `dia`. `w` × `h` is the logical size. */
interface Geo {
  key: string; w: number; h: number; bandW: number; X0: number; X1: number; sp: number; STW: number; BW: number;
  code: Box; codeD: Box; text: Box; dia: Box; winH: number; CW: number; mini: Map<string, XY>[];
}

const KW: Record<string, Set<string>> = {
  python: new Set('def class return if elif else for while in not and or is None True False import from as with try except finally raise async await lambda yield pass break continue global nonlocal del assert self'.split(' ')),
  go: new Set('func package import return if else for range var const type struct interface map chan go defer select case switch default break continue nil true false error'.split(' ')),
  ts: new Set('function const let var return if else for while of in new class extends import from export async await throw try catch finally typeof instanceof interface type null undefined true false this default switch case break continue'.split(' ')),
};
const SH_KW = new Set('if then else elif fi for while until do done case esac in function return export local readonly select set unset shift source exit'.split(' '));
const langKey = (l: string) => (/^py/.test(l) ? 'python' : /^go/.test(l) ? 'go'
  : /^(sh|bash|zsh|shell|console|just(file)?|make(file)?)$/i.test(l) ? 'sh' : /^(text|plain|txt|none)$/i.test(l) ? 'text' : 'ts');

/** Shell (and justfile, make): `#` comments at a word's start, '…' and "…" strings, `…` substitutions,
 *  $VAR / ${…} / $1 / {{just}} variables, and the shell's reserved words. */
function highlightSh(line: string): string {
  let out = '', plain = '', i = 0;
  const flush = () => { if (plain) { out += esc(plain); plain = ''; } };
  const tok = (cls: string, x: string) => { flush(); out += `<span class="${cls}">${esc(x)}</span>`; };
  while (i < line.length) {
    const c = line[i]!;
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) { tok('tok-c', line.slice(i)); break; }
    if (c === "'") { const j = line.indexOf("'", i + 1); const e = j < 0 ? line.length : j + 1; tok('tok-s', line.slice(i, e)); i = e; continue; }
    if (c === '"' || c === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
      tok('tok-s', line.slice(i, j + 1)); i = j + 1; continue;
    }
    if (c === '$') {
      const m = /^\$(\{[^}]*\}|[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(line.slice(i));
      if (m) { tok('tok-v', m[0]); i += m[0].length; continue; }
    }
    if (line.startsWith('{{', i)) { const j = line.indexOf('}}', i + 2); if (j >= 0) { tok('tok-v', line.slice(i, j + 2)); i = j + 2; continue; } }
    if (/[A-Za-z_]/.test(c) && (i === 0 || !/[\w./-]/.test(line[i - 1]!))) {
      let j = i + 1;
      while (j < line.length && /[\w-]/.test(line[j]!)) j++;
      const w = line.slice(i, j);
      if (SH_KW.has(w) && (j >= line.length || /[\s;]/.test(line[j]!))) tok('tok-k', w); else plain += w;
      i = j; continue;
    }
    plain += c; i++;
  }
  flush();
  return out;
}

/** A light syntax tint: keywords, strings, comments. Line by line, carrying Python triple quotes across lines.
 *  `lang`: py, go, ts (and anything else), sh (bash, zsh, shell, console, just, make), text (no tint). */
export function highlight(lines: string[], lang: string): string[] {
  const key = langKey(lang);
  if (key === 'text') return lines.map(esc);
  if (key === 'sh') return lines.map(highlightSh);
  const kw = KW[key]!, py = key === 'python', lc = py ? '#' : '//';
  let triple: string | null = null;
  return lines.map((line) => {
    let out = '', plain = '', i = 0;
    const flush = () => { if (plain) { out += esc(plain); plain = ''; } };
    const tok = (cls: string, s: string) => { flush(); out += `<span class="${cls}">${esc(s)}</span>`; };
    if (triple) {
      const j = line.indexOf(triple);
      if (j < 0) return `<span class="tok-s">${esc(line)}</span>`;
      tok('tok-s', line.slice(0, j + 3)); i = j + 3; triple = null;
    }
    while (i < line.length) {
      const c = line[i]!;
      if (line.startsWith(lc, i)) { tok('tok-c', line.slice(i)); break; }
      if (py && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
        const q = line.slice(i, i + 3), j = line.indexOf(q, i + 3);
        if (j < 0) { tok('tok-s', line.slice(i)); triple = q; break; }
        tok('tok-s', line.slice(i, j + 3)); i = j + 3; continue;
      }
      if (c === '"' || c === "'" || (!py && c === '`')) {
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
        tok('tok-s', line.slice(i, j + 1)); i = j + 1; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i + 1;
        while (j < line.length && /\w/.test(line[j]!)) j++;
        const w = line.slice(i, j);
        if (kw.has(w)) tok('tok-k', w); else plain += w;
        i = j; continue;
      }
      plain += c; i++;
    }
    flush();
    return out;
  });
}

/** Markdown-lite: paragraphs, `code`, **bold**. Escaped first. */
export const mdInline = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\s*\n\s*/g, ' ');
export function mdLite(src: string): string {
  const inline = mdInline;
  return src.trim().split(/\n\s*\n/).filter(Boolean).map((p) => `<p>${inline(p.trim())}</p>`).join('');
}

export const fmtMs = (ms: number) =>
  ms < 1 ? `${Math.max(1, Math.round(ms * 1000))} µs` : ms < 10 ? `${ms.toFixed(2)} ms` : ms < 100 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;

export function tourScene(model: Model, tourId: string, o: { title?: string; kits?: KitSet } = {}): SceneClass {
  // kit kinds (docs/KITS.md): a kind's mini template (or its glyph and name) on the step's map
  const kits = o.kits ?? kitsFor(model);
  const found = model.tours?.find((t) => t.id === tourId);
  if (!found) throw new Error(`karyo: model has no tour "${tourId}" (have: ${(model.tours ?? []).map((t) => t.id).join(', ') || 'none'})`);
  const tour: BuiltTour = found;
  const steps: BuiltStep[] = tour.steps;
  const N = steps.length;
  if (!N) throw new Error(`karyo: tour "${tourId}" has no steps`);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const nodeOf = (id: string): MNode => byId.get(id) ?? { id, kind: 'external', label: id, sources: [] };
  const title = o.title ?? tour.title;

  // ---- timeline
  const sx = (g: Geo, i: number) => g.X0 + i * g.sp;
  const maxMs = Math.max(0, ...steps.map((s) => s.timing?.ms ?? 0));
  const runs: { group: string; i0: number; i1: number }[] = [];
  steps.forEach((s, i) => {
    const last = runs[runs.length - 1];
    if (s.group && last && last.group === s.group && last.i1 === i - 1) last.i1 = i;
    else if (s.group) runs.push({ group: s.group, i0: i, i1: i });
  });
  const bracket = (g: Geo, r: { i0: number; i1: number }) => ({ x0: sx(g, r.i0) - Math.min(g.sp * 0.42, g.STW / 2), x1: sx(g, r.i1) + Math.min(g.sp * 0.42, g.STW / 2) });

  // ---- mini diagrams: one layered layout per step (show ∪ node), in the right column
  const idsOf = (s: BuiltStep) => [...new Set([...(s.node ? [s.node] : []), ...s.show])];
  const allIds = [...new Set(steps.flatMap(idsOf))];
  // each step's wires among its cards, one per ordered pair: a type card's include its methods' (stepWires); drawn as one list
  // (a wire shows while both its cards do)
  const wiresByStep = steps.map((s) => stepWires(model, idsOf(s)));
  const pairs = [...new Map(wiresByStep.flat().map((w) => [w.key, w])).values()];
  const layersOf = (ids: string[], ws: { from: string; to: string }[]) => {
    const set = new Set(ids), inn = new Map<string, string[]>();
    for (const e of ws) if (set.has(e.from) && set.has(e.to)) (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)!).push(e.from);
    const layer = new Map<string, number>();
    const depth = (id: string, seen: Set<string>): number => {
      if (layer.has(id)) return layer.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const d = Math.max(0, ...(inn.get(id) ?? []).map((p) => depth(p, seen) + 1));
      seen.delete(id); layer.set(id, d);
      return d;
    };
    ids.forEach((id) => depth(id, new Set()));
    return layer;
  };
  const stepLayers = steps.map((s, i) => { const ids = s.show.length ? [...new Set([...s.show, ...(s.node ? [s.node] : [])])] : idsOf(s); return { ids, layer: layersOf(ids, wiresByStep[i]!) }; });
  const maxL = Math.max(1, ...stepLayers.map((x) => Math.max(0, ...x.layer.values()) + 1));
  // the diagram's least height (its frame, label and the tallest column of cards, never overlapping)
  const DIA_MIN = Math.max(120, 48 + Math.max(1, ...stepLayers.map(({ ids, layer }) => Math.max(...[...new Set(layer.values())].map((l) => ids.filter((id) => layer.get(id) === l).length)))) * (CH + 6));
  const miniIn = (AREA: Box, CW: number) => stepLayers.map(({ ids, layer }) => {
    const L = Math.max(0, ...layer.values()) + 1;
    const cols: string[][] = Array.from({ length: L }, () => []);
    for (const id of ids) cols[layer.get(id)!]!.push(id);   // authored order within a column
    const gap = L > 1 ? clamp((AREA.w - L * CW) / (L - 1), 16, 76) : 0;
    const x0 = AREA.x + (AREA.w - (L * CW + (L - 1) * gap)) / 2;
    const rows = Math.max(...cols.map((c) => c.length));
    const pitch = Math.min(CH + 20, AREA.h / rows);
    const pos = new Map<string, { x: number; y: number }>();
    cols.forEach((c, l) => {
      const h = c.length * pitch - (pitch - CH);
      c.forEach((id, r) => pos.set(id, { x: x0 + l * (CW + gap), y: AREA.y + (AREA.h - h) / 2 + r * pitch }));
    });
    return pos;
  });

  // ---- the layout: the page's (1600 × 900), or fitted to a space with room for the chrome floor's boost `k`
  const geo = (Wl: number, Hl: number, k: number, fitted: boolean): Geo => {
    const bandW = Wl / k;
    const X0 = N === 1 ? bandW / 2 : SIDE + 64, X1 = N === 1 ? bandW / 2 : bandW - SIDE - 64;
    const sp = N === 1 ? 0 : (X1 - X0) / (N - 1);
    const STW = N === 1 ? 180 : Math.min(150, sp - 10), BW = Math.min(STW - 18, 104);
    let codeD: Box, textD: Box, dia: Box;
    if (!fitted) {
      codeD = { x: SIDE, y: PY, w: CODE_W, h: CODE_H }; textD = { x: RX, y: PY, w: RW, h: TEXT_H }; dia = { x: RX, y: DIA_Y, w: RW, h: DIA_H };
    } else {
      // as drawn: under the band, above the mode line, the stage's margins; the band, the panels' text and the gaps
      // are drawn k times their designed size
      const m = Math.round(SIDE * k), top = Math.round(PY * k), avail = Hl - Math.round(FOOT * k) - top, gap = Math.round(PGAP * k);
      if (bandW >= WIDE && Wl >= Hl * 1.15) {
        // side by side, as on the page: the code left; the text over the diagram right. In a low window, where the text
        // would not get its height, the diagram moves under the code and the text takes the whole right column.
        const inner = Wl - 2 * m - Math.round(32 * k), cw = Math.round((inner * CODE_W) / (CODE_W + RW)), rx = m + cw + Math.round(32 * k);
        const want = Math.round(TEXT_H * k), th = Math.min(want, avail - gap - 120);
        if (th >= want * 0.9) {
          codeD = { x: m, y: top, w: cw, h: avail }; textD = { x: rx, y: top, w: Wl - m - rx, h: th };
          dia = { x: rx, y: top + th + gap, w: Wl - m - rx, h: avail - th - gap };
        } else {
          const dh = Math.round(clamp(DIA_MIN, 120, avail * 0.5));
          codeD = { x: m, y: top, w: cw, h: avail - gap - dh }; textD = { x: rx, y: top, w: Wl - m - rx, h: avail };
          dia = { x: m, y: top + avail - dh, w: cw, h: dh };
        }
      } else {
        // stacked, for a tall or narrow window: the code, the text, the diagram
        const ch = Math.round(avail * 0.42), th = Math.round(Math.min(avail * 0.3, TEXT_H * k));
        codeD = { x: m, y: top, w: Wl - 2 * m, h: ch }; textD = { x: m, y: top + ch + gap, w: Wl - 2 * m, h: th };
        dia = { x: m, y: top + ch + th + 2 * gap, w: Wl - 2 * m, h: avail - ch - th - 2 * gap };
      }
    }
    const AREA = { x: dia.x + 18, y: dia.y + 34, w: dia.w - 36, h: dia.h - 34 - 14 };
    const CW = Math.min(132, Math.floor((AREA.w - (maxL - 1) * 22) / maxL));
    const code = chromeBoxFor(codeD, Wl, Hl, k), text = chromeBoxFor(textD, Wl, Hl, k);
    return { key: `${Wl}x${Hl}@${k}${fitted ? '' : ':page'}`, w: Wl, h: Hl, bandW, X0, X1, sp, STW, BW, code, codeD, text, dia, winH: codeD.h / k - HEAD_H, CW, mini: miniIn(AREA, CW) };
  };
  const PAGE = geo(W, H, 1, false);

  // ---- code excerpts: each step's window scrolls (statically) to centre its first focus line
  const scrollOf = (c: BuiltCode, WIN_H = PAGE.winH) => {
    const n = c.text.split('\n').length, full = n * LH + 2 * PAD;
    if (full <= WIN_H) return 0;
    const f = c.focus.length ? Math.min(...c.focus) - c.start : 0;
    return clamp(PAD + f * LH + LH / 2 - WIN_H / 2, 0, full - WIN_H);
  };
  const codeHTML = (s: BuiltStep, i: number) => {
    const c = s.code;
    if (!c) return `<div class="tr-cs" id="cs${i}"><div class="tr-ch"><span class="tr-file tr-none">no code for this step</span></div><div class="tr-win tr-empty" data-pl-clip><span>${esc(s.node ? nodeOf(s.node).label ?? s.node : s.title)} has no captured source</span></div></div>`;
    const focus = new Set(c.focus);
    const src = c.text.replace(/\n$/, '').split('\n');
    const html = highlight(src, c.lang);
    const lines = html.map((h, j) => `<span class="ln${focus.has(c.start + j) ? ' is-lit' : ''}"><span class="no">${c.start + j}</span>${h}</span>`).join('');
    const end = c.start + src.length - 1;
    return `<div class="tr-cs" id="cs${i}">
      <div class="tr-ch"><span class="tr-file" title="${esc(c.file)}">${esc(c.file)}:${c.start}–${Math.max(end, c.end)}</span>${c.symbol ? `<span class="tr-sym">· ${esc(c.symbol)}</span>` : ''}${c.truncated ? '<span class="tr-trunc">truncated</span>' : ''}<span class="tr-lang">${esc(c.lang)}</span></div>
      <div class="tr-win" data-pl-clip><pre class="pl-code tr-pre" style="top:${-scrollOf(c)}px">${lines}</pre></div>
    </div>`;
  };
  const factsHTML = (s: BuiltStep) => {
    const t = s.timing;
    if (!t) return '<div class="tr-facts"><span class="tr-untimed">not timed in the recorded run</span></div>';
    const attrs = Object.entries(t.attrs ?? {}).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object').slice(0, 3);
    const fact = (k: string, v: string, cls = '') => `<span class="tr-fact ${cls}"><i>${esc(k)}</i><b>${esc(v.length > 42 ? v.slice(0, 41) + '…' : v)}</b></span>`;
    return `<div class="tr-facts">${fact('took', fmtMs(t.ms))}${fact('spans', String(t.spans))}${fact('status', t.status, t.status === 'error' ? 'is-err' : 'is-ok')}${attrs.map(([k, v]) => fact(k, String(v), k === 'error' ? 'is-err' : '')).join('')}</div>
      <div class="tr-tlabel" title="${esc(t.label)}">${esc(t.label)}</div>`;
  };
  const textHTML = (s: BuiltStep, i: number) => `<div class="tr-tx" id="tx${i}">
      <div class="tr-kick"><span class="pl-label">Step ${i + 1} of ${N}${s.group ? ` · ${esc(s.group)}` : ''}</span>${s.source === 'expanded' ? '<span class="tr-tag" title="Expanded from the recorded trace, not authored">from the trace</span>' : ''}</div>
      <h2 class="tr-h">${esc(s.title)}</h2>
      ${s.text ? `<div class="tr-prose">${mdLite(s.text)}</div>` : ''}
      ${factsHTML(s)}
    </div>`;
  const stationHTML = (s: BuiltStep, i: number) => {
    const t = s.timing, err = t?.status === 'error';
    const bw = t && maxMs > 0 ? Math.max(2, (PAGE.BW * t.ms) / maxMs) : 0;
    return `<button type="button" class="tr-st${err ? ' is-err' : ''}" id="st${i}" style="left:${sx(PAGE, i) - PAGE.STW / 2}px;width:${PAGE.STW}px" title="${esc(s.title)}${t ? ` — ${fmtMs(t.ms)}` : ''}${i < 9 ? ` (${i + 1})` : ''}" aria-label="Step ${i + 1}: ${esc(s.title)}">
      <span class="tr-dot"></span><span class="tr-stt">${esc(s.title)}</span>
      <span class="tr-bar">${t ? `<i style="width:${bw.toFixed(1)}px"></i>` : ''}</span><span class="tr-ms">${t ? fmtMs(t.ms) : 'untimed'}</span>
    </button>`;
  };
  const nodeHTML = (id: string) => {
    const n = nodeOf(id);
    if (kits.kind(n.kind)) {
      const mini = kits.mini(n, modelStats(model).get(id));
      const g = kits.glyph(n.kind);
      const inner = mini !== null ? `<div class="km-${esc(n.kind)} tr-km">${mini}</div>`
        : `<div class="tr-nn">${g ? `<span class="tr-glyph" aria-hidden="true">${esc(g)}</span>` : ''}${esc(n.label ?? id)}</div><div class="tr-nr">${esc(kits.label(n.kind))}</div>`;
      return `<div class="pl-card tr-node is-kit${!n.ref ? ' is-ext' : ''}" id="d${cssId(id)}" data-kind="${esc(n.kind)}" title="${esc(id)}${n.summary ? ' — ' + esc(n.summary) : ''}">${inner}</div>`;
    }
    const cls = n.kind === 'actor' ? 'is-actor' : n.kind === 'external' || !n.ref ? 'is-ext' : '';
    const ref = n.ref ? `${n.ref.file.split('/').pop()}${n.ref.line ? `:${n.ref.line}` : ''}` : n.kind === 'actor' ? '' : n.kind;
    return `<div class="pl-card tr-node ${cls}" id="d${cssId(id)}" title="${esc(id)}${n.summary ? ' — ' + esc(n.summary) : ''}">
      <div class="tr-nn">${esc(n.label ?? id)}</div>${ref ? `<div class="tr-nr">${esc(ref)}</div>` : ''}</div>`;
  };

  const CSS = /* css */ `
    /* the header, tools and step rail: one chrome band (docs/ENGINE.md "Zoom and pan"); it lays nothing out itself */
    .tr-top { position: absolute; left: 0; top: 0; width: ${PAGE.bandW}px; height: ${PY - 14}px; pointer-events: none; }
    .tr-top > * { pointer-events: auto; }
    .tr-top > .tr-marker { pointer-events: none; }
    .tr-head { position: absolute; left: ${SIDE}px; top: 26px; display: grid; gap: 6px; width: calc(100% - ${2 * SIDE}px); }
    .tr-sum code { font: 13px/1 var(--pl-font-mono); }
    .tr-sum { margin: 0; font-size: 14px; line-height: 18px; color: var(--pl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tr-tools { position: absolute; right: ${SIDE}px; top: 36px; display: flex; gap: 8px; }
    .tr-btn { font: 500 11px/1 var(--pl-font-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--pl-fg); background: var(--pl-card); border: 1px solid var(--pl-line); border-radius: min(var(--pl-radius), 6px); padding: 8px 12px; min-width: 40px; cursor: pointer; }
    .tr-btn:hover { border-color: var(--pl-fg); }
    .tr-btn:focus-visible, .tr-st:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: 2px; }
    .tr-btn.is-on { border-color: var(--pl-accent); color: var(--pl-accent); }
    #tr-play { min-width: 76px; }

    .tr-grp { position: absolute; top: ${GY}px; text-align: center; font: 500 11px/14px var(--pl-font-mono); letter-spacing: 0.06em; color: var(--pl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tr-grp.is-cur { color: var(--pl-accent); }
    .tr-st { position: absolute; top: ${TY - 8}px; height: 92px; margin: 0; padding: 0; border: 0; background: none; color: var(--pl-fg); font: inherit; cursor: pointer; display: flex; flex-direction: column; align-items: center; border-radius: min(var(--pl-radius), 6px); }
    .tr-dot { flex: none; box-sizing: border-box; width: 12px; height: 12px; margin-top: 2px; border-radius: 50%; border: 2px solid var(--pl-line); background: var(--pl-bg); }
    .tr-st.is-past .tr-dot { border-color: var(--pl-muted); background: var(--pl-muted); }
    .tr-st.is-cur .tr-dot { border-color: var(--pl-accent); background: var(--pl-accent); }
    .tr-st.is-err .tr-dot { border-color: var(--pl-accent-2); }
    .tr-st.is-err.is-past .tr-dot, .tr-st.is-err.is-cur .tr-dot { background: var(--pl-accent-2); }
    .tr-stt { flex: none; margin-top: 9px; width: 100%; height: 32px; font: 600 13px/16px var(--pl-font-display); text-align: center; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
    .tr-st.is-cur .tr-stt { color: var(--pl-accent); }
    .tr-st:hover .tr-stt { text-decoration: underline; text-underline-offset: 3px; }
    .tr-bar { flex: none; margin-top: 6px; width: var(--tr-bw, ${PAGE.BW}px); height: 4px; border-radius: 2px; overflow: hidden; background: color-mix(in srgb, var(--pl-line) 40%, transparent); }
    .tr-bar i { display: block; height: 100%; border-radius: 2px; background: var(--pl-muted); }
    .tr-st.is-cur .tr-bar i { background: var(--pl-accent); }
    .tr-st.is-err .tr-bar i { background: var(--pl-accent-2); }
    .tr-ms { margin-top: 6px; font: 11.5px/14px var(--pl-font-mono); color: var(--pl-muted); font-variant-numeric: tabular-nums; }
    .tr-st.is-cur .tr-ms { color: var(--pl-fg); }
    .tr-st.is-err .tr-ms { color: var(--pl-accent-2); }
    .tr-marker { position: absolute; left: -12px; top: ${TY - 12}px; width: 24px; height: 24px; box-sizing: border-box; border-radius: 50%; border: 2px solid var(--pl-accent); pointer-events: none; }

    .tr-code { position: absolute; left: ${SIDE}px; top: ${PY}px; width: ${CODE_W}px; height: ${CODE_H}px; padding: 0; overflow: hidden; }
    /* (an inner clip: content that no longer fits a panel the chrome floor lays out narrower is clipped here, so the
       panel itself never overflows and keeps its span, docs/ENGINE.md "Chrome floor") */
    .tr-clip { position: absolute; inset: 0; overflow: hidden; }
    .tr-cs { position: absolute; inset: 0; }
    .tr-ch { position: absolute; left: 0; right: 0; top: 0; height: ${HEAD_H}px; box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 0 18px; border-bottom: 1px solid var(--pl-card-border); font: 12.5px/1 var(--pl-font-mono); color: var(--pl-muted); white-space: nowrap; }
    .tr-file { color: var(--pl-fg); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .tr-file.tr-none { color: var(--pl-muted); }
    .tr-sym { color: var(--pl-accent); }
    .tr-trunc { font-size: 11px; padding: 3px 6px; border: 1px dashed var(--pl-line); border-radius: min(var(--pl-radius), 4px); }
    .tr-lang { margin-left: auto; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
    .tr-win { position: absolute; left: 0; right: 0; top: ${HEAD_H}px; bottom: 0; overflow: hidden; -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 36px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 36px), transparent); }
    .tr-empty { display: grid; place-items: center; font: 13px/1.4 var(--pl-font-mono); color: var(--pl-muted); }
    .tr-pre.pl-code { position: absolute; left: 0; right: 0; margin: 0; padding: ${PAD}px 0; border: 0; border-radius: 0; background: transparent; font-size: 13.5px; line-height: ${LH}px; tab-size: 4; }
    .tr-pre .ln { height: ${LH}px; margin: 0; padding: 0 16px 0 0; border-radius: 0; }
    .tr-pre .ln.is-lit { box-shadow: inset 3px 0 0 var(--pl-accent); }
    .tr-pre .no { display: inline-block; width: 44px; padding-right: 18px; text-align: right; color: var(--pl-muted); opacity: 0.55; user-select: none; -webkit-user-select: none; }
    .tr-pre .ln.is-lit .no { color: var(--pl-accent); opacity: 1; }

    .tr-texts { position: absolute; left: ${RX}px; top: ${PY}px; width: ${RW}px; height: ${TEXT_H}px; overflow: hidden; }
    .tr-tx { position: absolute; left: 0; right: 0; top: 0; display: grid; gap: 10px; align-content: start; }
    .tr-kick { display: flex; align-items: center; gap: 10px; }
    .tr-tag { font: 500 11px/1 var(--pl-font-mono); padding: 3px 6px; border: 1px dashed var(--pl-line); border-radius: min(var(--pl-radius), 4px); color: var(--pl-muted); }
    .tr-h { margin: 0; font: 700 26px/1.15 var(--pl-font-display); letter-spacing: -0.01em; }
    .tr-prose p { margin: 0 0 8px; font-size: 15.5px; line-height: 1.5; color: var(--pl-fg); max-width: 60ch; }
    .tr-prose p:last-child { margin-bottom: 0; }
    .tr-prose code { font: 13.5px/1 var(--pl-font-mono); color: var(--pl-accent); }
    .tr-facts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
    .tr-fact { display: inline-flex; align-items: baseline; gap: 6px; font: 12px/1 var(--pl-font-mono); padding: 6px 9px; background: var(--pl-card); border: 1px solid var(--pl-card-border); border-radius: min(var(--pl-radius), 6px); }
    .tr-fact i { font-style: normal; color: var(--pl-muted); }
    .tr-fact b { font-weight: 600; font-variant-numeric: tabular-nums; }
    .tr-fact.is-err { border-color: var(--pl-accent-2); }
    .tr-fact.is-err b { color: var(--pl-accent-2); }
    .tr-tlabel { font: 11.5px/1.3 var(--pl-font-mono); color: var(--pl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tr-untimed { font: 12px/1 var(--pl-font-mono); color: var(--pl-muted); }

    .tr-dia { position: absolute; left: ${RX}px; top: ${DIA_Y}px; width: ${RW}px; height: ${DIA_H}px; box-sizing: border-box; border: 1px dashed var(--pl-line); border-radius: calc(var(--pl-radius) + 6px); }
    .tr-dia > .pl-label { position: absolute; left: 14px; top: 11px; }
    .tr-node { position: absolute; left: 0; top: 0; z-index: 2; width: var(--tr-cw, ${PAGE.CW}px); height: ${CH}px; padding: 5px 10px; display: grid; align-content: center; gap: 2px; }
    .tr-nn { font: 600 13px/1.2 var(--pl-font-display); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tr-nr { font: 10.5px/1.2 var(--pl-font-mono); color: var(--pl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tr-node.is-ext { border-style: dashed; box-shadow: none; }
    .tr-node.is-actor { border-radius: 999px; text-align: center; }
    .tr-node.is-lit { border-color: var(--pl-accent); }
    .tr-node.is-lit .tr-nn { color: var(--pl-accent); }
    .tr-glyph { display: inline-block; min-width: 14px; margin-right: 6px; font: 600 11px/1 var(--pl-font-mono); color: var(--pl-accent); }
    .tr-km { min-width: 0; overflow: hidden; }
    ${kits.css()}

    .tr-mode { position: absolute; left: ${SIDE}px; bottom: 16px; font: 12px/1.2 var(--pl-font-mono); color: var(--pl-muted); white-space: nowrap; }
  `;

  return class TourPlate extends Scene implements TourApi {
    static title = title;
    static width = W;
    static height = H;
    static duration = D;
    static fx = 'under' as const;
    static interactive = true;

    private cur = 0;
    private playing = false;
    private timer: ReturnType<typeof setTimeout> | 0 = 0;
    private morph = new Morph();
    /** Transition progress (eased): everything, and the code / text panes leaving and arriving. The old
     *  pane is gone before the new one is readable, so two excerpts never overlap. */
    private kk = { main: 1, out: 1, in: 1 };
    /** The layout drawn now: the page's, or the one fitted to the space the plate fills (`fit`). */
    private g: Geo = PAGE;
    private fits = new Map<string, Geo>();

    get step() { return this.cur; }

    /** Theater, fill and Jarvis (docs/ENGINE.md "Theater"): laid out for the space's shape, never drawn smaller than its
     *  designed size (the chrome floor), with room for the chrome the floor draws `o.chrome` times larger (settled, as
     *  the trace board does: settleChrome); side by side in a wide window, stacked in a tall or narrow one. A larger
     *  window draws the page's layout larger. null: the page's layout. */
    fit(space: { w: number; h: number } | null, o?: { chrome?: number }) {
      let g = PAGE;
      if (space) {
        const s0 = Math.max(1, Math.min(space.w / W, space.h / H));
        const Wl = Math.round(space.w / s0), Hl = Math.round(space.h / s0);
        const at = (k: number) => { const key = `${Wl}x${Hl}@${k}`; return this.fits.get(key) ?? this.fits.set(key, geo(Wl, Hl, k, true)).get(key)!; };
        const k0 = Math.max(1, Math.round((o?.chrome ?? 1) * 100) / 100);
        g = k0 > 1 ? settleChrome(space, k0, at, (sc) => this.stage.chrome.boostAt(sc)) : at(1);
      }
      if (g.key !== this.g.key) {
        this.g = g;
        if (this.built) { this.applyGeo(); this.morph = new Morph(); this.morph.snap(this.targets()); }
      }
      return { w: g.w, h: g.h };
    }
    private built = false;
    /** Put every element where the layout says (the page's layout is what the CSS and the HTML already say). */
    private applyGeo() {
      const g = this.g, dom = this.stage.dom, px = (v: number) => `${Math.round(v * 1000) / 1000}px`;
      const box = (e: HTMLElement | null, b: Box) => { if (e) Object.assign(e.style, { left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h) }); };
      dom.style.setProperty('--tr-bw', px(g.BW));
      dom.style.setProperty('--tr-cw', px(g.CW));
      dom.querySelector<HTMLElement>('.tr-top')!.style.width = px(g.bandW);
      steps.forEach((st, i) => {
        const e = dom.querySelector<HTMLElement>(`#st${i}`)!;
        e.style.left = px(sx(g, i) - g.STW / 2); e.style.width = px(g.STW);
        const bar = e.querySelector<HTMLElement>('.tr-bar i'), t = st.timing;
        if (bar && t && maxMs > 0) bar.style.width = `${Math.max(2, (g.BW * t.ms) / maxMs).toFixed(1)}px`;
        const pre = dom.querySelector<HTMLElement>(`#cs${i} .tr-pre`);
        if (pre && st.code) pre.style.top = `${-scrollOf(st.code, g.winH)}px`;
      });
      runs.forEach((r, j) => { const b = bracket(g, r), e = dom.querySelector<HTMLElement>(`#gr${j}`)!; e.style.left = px(b.x0); e.style.width = px(b.x1 - b.x0); });
      box(dom.querySelector('.tr-code'), g.code);
      box(dom.querySelector('.tr-texts'), g.text);
      box(dom.querySelector('.tr-dia'), g.dia);
    }

    build(dom: HTMLElement) {
      const sub = `Tour · ${N} steps${tour.flow ? ` · recorded flow ${tour.flow}` : ''}`;
      dom.innerHTML = `<style>${CSS}</style>
        <div class="tr-top" data-pl-chrome><header class="tr-head"><div class="pl-label">${esc(sub)}</div><h1 class="pl-title">${esc(title)}</h1>${tour.summary ? `<p class="tr-sum" data-pl-clip title="${esc(tour.summary)}">${mdInline(tour.summary)}</p>` : ''}</header>
        <div class="tr-tools"><button type="button" class="tr-btn" id="tr-prev" title="Previous step (← or k)" aria-label="Previous step">‹</button><button type="button" class="tr-btn" id="tr-play" title="Play the tour (p; any key stops)">Play</button><button type="button" class="tr-btn" id="tr-next" title="Next step (→, j or Enter)" aria-label="Next step">›</button></div>
        ${runs.map((r, j) => { const b = bracket(PAGE, r); return `<div class="tr-grp" id="gr${j}" style="left:${b.x0}px;width:${b.x1 - b.x0}px">${esc(r.group)}</div>`; }).join('')}
        ${steps.map(stationHTML).join('')}
        <div class="tr-marker" id="tr-marker"></div></div>
        <div class="pl-card tr-code" data-pl-clip data-pl-chrome>${steps.map(codeHTML).join('')}</div>
        <div class="tr-texts" data-pl-clip data-pl-chrome><div class="tr-clip" data-pl-clip>${steps.map(textHTML).join('')}</div></div>
        <div class="tr-dia"><span class="pl-label">Where it runs</span></div>
        ${allIds.map(nodeHTML).join('')}
        <div class="tr-mode" id="tr-mode" data-pl-chrome aria-live="polite"></div>`;

      steps.forEach((_, i) => dom.querySelector(`#st${i}`)!.addEventListener('click', () => this.go(i)));
      dom.querySelector('#tr-prev')!.addEventListener('click', () => this.prev());
      dom.querySelector('#tr-next')!.addEventListener('click', () => this.next());
      dom.querySelector('#tr-play')!.addEventListener('click', () => this.play());
      // any press stops play (then does what it does)
      dom.addEventListener('pointerdown', (e) => { if (this.playing && !(e.target as HTMLElement).closest('#tr-play')) this.stop(); }, true);
      // play: when a step has landed, give it time to be read, then step on
      this.stage.onFrame((t) => {
        if (this.playing && !this.timer && t >= this.stage.duration && !this.stage.playing)
          this.timer = setTimeout(() => this.playNext(), DWELL);
      });
      // the mode line names the key that leaves the theater: re-render when the plate enters or leaves it
      new MutationObserver(() => this.stage.redraw()).observe(this.stage.root, { attributes: true, attributeFilter: ['class'] });
      this.built = true;
      if (this.g !== PAGE) this.applyGeo();
      this.morph.snap(this.targets());
    }

    // ------------------------------------------------------------ public API
    go(i: number) { this.stop(); this.to(i); }
    next() { this.go(this.cur + 1); }
    prev() { this.go(this.cur - 1); }
    play() {
      if (this.playing) { this.stop(); return; }
      this.playing = true;
      if (this.cur >= N - 1) this.to(0);
      else this.stage.redraw();          // at rest: the frame listener starts the dwell
    }

    describe(): PlateOutline {
      const nodes = allIds.map(nodeOf);
      const gs = [...new Set(nodes.map((n) => n.group).filter((g): g is string => !!g))];
      return {
        kind: 'tour', title,
        nodes: nodes.map((n) => ({ id: n.id, label: n.label ?? n.id, group: n.group ?? null, category: n.category ?? null, tags: [...(n.tags ?? [])] })),
        groups: gs.map((g) => ({ id: g, label: g })),
        tags: [],
        steps: steps.map((s) => s.title),
        stepMembers: steps.map(idsOf),
      };
    }

    // ------------------------------------------------------------ state
    private to(i: number) {
      i = clamp(Math.round(i), 0, N - 1);
      if (i === this.cur) return;
      this.cur = i;
      this.retarget();
      this.stage.transition();
    }
    private stop() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = 0;
      if (this.playing) { this.playing = false; this.stage.redraw(); }
    }
    private playNext() {
      this.timer = 0;
      if (!this.playing) return;
      if (this.cur >= N - 1) { this.stop(); return; }
      this.to(this.cur + 1);
    }

    /** The resting layout of the current step. */
    private targets() {
      const m = new Map<string, Vals>(), c = this.cur;
      m.set('mk', { x: sx(this.g, c) });
      steps.forEach((_, i) => {
        m.set(`s${i}`, { o: i <= c ? 1 : 0.55, lit: i === c ? 1 : 0 });
        m.set(`c${i}`, { x: i === c ? 0 : Math.sign(i - c) * SL, o: i === c ? 1 : 0 });
        m.set(`t${i}`, { x: i === c ? 0 : Math.sign(i - c) * SLT, o: i === c ? 1 : 0 });
      });
      runs.forEach((r, j) => m.set(`g${j}`, { lit: c >= r.i0 && c <= r.i1 ? 1 : 0 }));
      const pos = this.g.mini[c]!, lit = steps[c]!.node;
      for (const id of allIds) {
        const p = pos.get(id);
        m.set(`d:${id}`, p ? { x: p.x, y: p.y, o: 1, lit: id === lit ? 1 : 0 } : { x: 0, y: 0, o: 0, lit: 0 });
      }
      return m;
    }
    /** Transition from what is on screen now to the current step: diagram cards that arrive fade in
     *  where they land, cards that leave fade out where they are; everything else interpolates. */
    private retarget() {
      const to = this.targets(), from = new Map<string, Vals>();
      for (const [key, tv] of to) {
        const cur = this.val(key);
        if (!cur) { from.set(key, tv); continue; }
        if (key.startsWith('d:')) {
          if (tv.o! > 0 && cur.o! < 0.02) { from.set(key, { x: tv.x!, y: tv.y! + 10, o: 0, lit: 0 }); continue; }
          if (tv.o === 0) to.set(key, { ...tv, x: cur.x!, y: cur.y! });
        }
        from.set(key, cur);
      }
      const m = new Morph();
      m.snap(from); m.retarget(to);
      this.morph = m;
    }

    getState() { return { step: this.cur }; }
    setState(st: unknown) {
      const v = (st ?? {}) as { step?: number };
      this.stop();
      // as if navigated from step 1: start there, then transition into the state
      this.cur = 0;
      this.morph = new Morph();
      this.morph.snap(this.targets());
      this.cur = clamp(Math.round(v.step ?? 0), 0, N - 1);
      this.retarget();
    }
    states() {
      const mid = steps.findIndex((s) => s.group || s.source === 'expanded');
      const err = steps.findIndex((s) => s.timing?.status === 'error');
      const out = [{ name: 'step-1', state: { step: 0 } }];
      if (mid > 0) out.push({ name: 'step-mid', state: { step: mid } });
      if (N > 1) out.push({ name: 'step-last', state: { step: N - 1 } });
      if (err >= 0) out.push({ name: 'step-error', state: { step: err } });
      return out;
    }

    /** Key help (docs/ENGINE.md "Key help"): what `onKey` does right now. */
    keys(): KeyHelp[] {
      const T = 'Tour';
      if (this.playing) return [{ group: T, keys: 'any key', gesture: true, does: 'stop playing' }];
      const first = this.cur === 0, last = this.cur === N - 1, n = Math.min(9, N);
      return [
        { group: T, keys: ['→', 'j', 'Enter'], does: 'next step', ...(last ? { off: true, when: 'before the last step' } : {}) },
        { group: T, keys: ['←', 'k'], does: 'previous step', ...(first ? { off: true, when: 'after the first step' } : {}) },
        { group: T, keys: 'Home', does: 'the first step', ...(first ? { off: true, when: 'after the first step' } : {}) },
        { group: T, keys: 'End', does: 'the last step', ...(last ? { off: true, when: 'before the last step' } : {}) },
        ...(n > 1 ? [{ group: T, keys: `1–${n}`, does: `go to step 1–${n}` }] : []),
        { group: T, keys: 'p', does: last ? 'play the tour from the start' : 'play the tour from here' },
      ];
    }
    onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      const k = e.key;
      if (this.playing) {
        this.stop();
        return k !== 'f';                 // any key stops play; f still toggles the theater
      }
      if ((k === 'Enter' || k === ' ') && (e.target as HTMLElement).closest?.('button')) return false; // the button's own click
      if (k === 'ArrowRight' || k === 'j' || k === 'Enter') this.to(this.cur + 1);
      else if (k === 'ArrowLeft' || k === 'k') this.to(this.cur - 1);
      else if (k === 'Home') this.to(0);
      else if (k === 'End') this.to(N - 1);
      else if (/^[1-9]$/.test(k)) { if (+k <= N) this.to(+k - 1); }
      else if (k === 'p') this.play();
      else return false;                  // Esc included: falls through to the theater
      return true;
    }

    // ------------------------------------------------------------ frame
    /** A key's value at the current progress. Code (`c…`) and text (`t…`) panes leave early and arrive
     *  late; so does a diagram card's opacity (`d:…`), while its position glides on the main curve. */
    private val(key: string): Vals | undefined {
      const pane = key[0] === 'c' || key[0] === 't', card = key.startsWith('d:');
      if (!pane && !card) return this.morph.value(key);
      this.morph.progress(this.morph.target(key)?.o === 0 ? this.kk.out : this.kk.in);
      const v = this.morph.value(key);
      this.morph.progress(this.kk.main);
      return card && v ? { ...this.morph.value(key)!, o: v.o! } : v;
    }

    update(f: Frame) {
      const p = clamp(f.t / f.duration);
      this.kk = { main: ease.outCubic(p), out: ease.inOutCubic(clamp(p / 0.45)), in: ease.outCubic(clamp((p - 0.35) / 0.65)) };
      this.morph.progress(this.kk.main);
      const mk = this.morph.value('mk')!.x!;
      this.$('#tr-marker').x = mk;
      steps.forEach((_, i) => {
        const v = this.morph.value(`s${i}`)!, st = this.$(`#st${i}`);
        st.opacity = v.o!;
        st.classes['is-cur'] = v.lit! > 0.5;
        st.classes['is-past'] = mk > sx(this.g, i) + 1 && v.lit! <= 0.5;   // dots fill as the marker passes them
        for (const [p, id] of [['c', `#cs${i}`], ['t', `#tx${i}`]] as const) {
          const w = this.val(`${p}${i}`)!, n = this.$(id);
          n.set({ x: w.x!, opacity: w.o! });
          n.hidden = w.o! < 0.004;
        }
      });
      runs.forEach((_, j) => { this.$(`#gr${j}`).classes['is-cur'] = this.morph.value(`g${j}`)!.lit! > 0.5; });
      for (const id of allIds) {
        const v = this.val(`d:${id}`)!, n = this.$(`#d${cssId(id)}`);
        n.set({ x: v.x!, y: v.y!, opacity: v.o! });
        n.hidden = v.o! < 0.004;
        n.classes['is-lit'] = v.lit! > 0.5;
        n.vars['--kx-lit'] = String(Math.round(v.lit! * 100) / 100);   // how lit, through the transition (a theme may ramp with it)
      }
      this.$('#tr-play').text = this.playing ? 'Stop' : 'Play';
      this.$('#tr-play').classes['is-on'] = this.playing;
      this.$('#tr-prev').opacity = this.cur === 0 ? 0.4 : 1;
      this.$('#tr-next').opacity = this.cur === N - 1 ? 0.4 : 1;
      const where = `step ${this.cur + 1} of ${N}`;
      this.$('#tr-mode').text = this.playing ? `playing · ${where} · any key or click stops`
        : `${where} · ←/→ step · p play · ${this.stage.inTheater ? 'Esc leave theater' : 'f theater'}`;
    }

    /** A wire between two diagram cards: elbow left → right, or a vertical hop within a column. */
    private wirePath(A: Node, B: Node): Path {
      const a = A.bounds(), b = B.bounds();
      if (b.x > a.x + a.w + 4 || a.x > b.x + b.w + 4) {
        const fwd = b.x > a.x;
        const pa = A.at(fwd ? 'right' : 'left', 0.5, 3), pb = B.at(fwd ? 'left' : 'right', 0.5, 3);
        if (Math.abs(pb.y - pa.y) < 1.5) return new Path([pa, pb]);
        const xm = pa.x + (fwd ? 1 : -1) * Math.min(16, Math.abs(pb.x - pa.x) / 2);
        return new Path(roundCorners([pa, { x: xm, y: pa.y }, { x: xm, y: pb.y }, pb], 8));
      }
      const down = b.y > a.y;
      return new Path([A.at(down ? 'bottom' : 'top', 0.5, 3), B.at(down ? 'top' : 'bottom', 0.5, 3)]);
    }

    draw(f: Frame, fx: Fx) {
      const Ln = fx.under.lines, bg = fx.under.bg, th = f.theme;
      bg.pattern = 'dots'; bg.patternAlpha = 0.18;
      const mk = this.morph.value('mk')!.x!;

      // timeline: the track, lit up to the marker; group brackets (the rail is chrome: its fx go on the chrome's layer)
      const Lr = fx.front.lines;
      const { X0, X1 } = this.g;
      Lr.seg(X0, TY, X1, TY, { color: 'line', width: 2 });
      if (mk > X0) Lr.seg(X0, TY, mk, TY, { color: 'accent', width: 2.4, glow: 1.2 });
      runs.forEach((r, j) => {
        const b = bracket(this.g, r), lit = this.morph.value(`g${j}`)!.lit!;
        Lr.polyline([{ x: b.x0, y: BY + 7 }, { x: b.x0, y: BY }, { x: b.x1, y: BY }, { x: b.x1, y: BY + 7 }], { color: mix(th.line, th.accent, lit), width: 1.4 });
      });
      fx.front.bg.light(mk, TY, 46, 0.3, th.accent);

      // mini diagram: model edges among the visible cards, the step's own edges lit
      for (const e of pairs) {
        const va = this.val(`d:${e.from}`), vb = this.val(`d:${e.to}`);
        if (!va || !vb) continue;
        const o = Math.min(va.o!, vb.o!);
        if (o < 0.01) continue;
        const lit = Math.max(va.lit!, vb.lit!);
        const p = this.wirePath(this.$(`#d${cssId(e.from)}`), this.$(`#d${cssId(e.to)}`));
        const col = mix(th.line, th.accent, lit);
        Ln.path(p, { color: col, width: 1.3 + 0.6 * lit, alpha: o * (0.75 + 0.25 * lit), glow: lit });
        const end = p.at(0.999);
        Ln.arrow(end, end.angle, 6, { color: col, width: 1.3, alpha: o });
      }
      for (const id of allIds) {
        const v = this.val(`d:${id}`)!;
        const lit = v.lit! * v.o!;
        if (lit < 0.01) continue;
        const n = this.$(`#d${cssId(id)}`);
        outline(Ln, n, { pad: 4, radius: 10, width: 1.2, alpha: lit * 0.85, glow: 1.2 });
        lightUnder(bg, n, 0.24 * lit, th.accent, 0.5);
      }
    }
  };
}
