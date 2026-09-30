// The built-in `radial` kit's plate (docs/KITS.md "Code in kits"): a model's groups as an inner ring and each group's
// nodes around it, coloured by category. It is the example of a kit that draws with its own JavaScript: Karyo runs it
// in a sealed frame and hands it data (the model, the theme's colours, the size, its state); it hands back events.
// Deterministic: the same inputs draw the same picture (no clock, no randomness), so stills and lint render it.
//
//   render(host, ctx)   draw into `host` (a <div> filling the frame)
//   update(host, ctx)   the theme, the size or the state changed: draw again
//   dispose(host)       the plate is going away
//   ctx = { model, plate, theme, size: {w, h}, state, emit(type, data) }
//   emit('state', {...})  keep a view state (stills and a reload restore it)
//   emit('status', text)  one line the plate shows beside its notice

const SVG = 'http://www.w3.org/2000/svg';
const DEG = Math.PI / 180;
const MAX_CATS = 8;

export function render(host, ctx) { draw(host, ctx); }
export function update(host, ctx) { draw(host, ctx); }
export function dispose(host) { host.replaceChildren(); }

const el = (tag, attrs = {}, text) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
};
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** A ring sector from angle a0 to a1 (degrees, 0 = up, clockwise) between radii r0 and r1. */
function sector(cx, cy, r0, r1, a0, a1) {
  const p = (r, a) => `${(cx + r * Math.sin(a * DEG)).toFixed(2)} ${(cy - r * Math.cos(a * DEG)).toFixed(2)}`;
  const big = a1 - a0 > 180 ? 1 : 0;
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${big} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${big} 0 ${p(r0, a0)} Z`;
}

function draw(host, ctx) {
  const { model, size, emit } = ctx;
  const state = ctx.state && typeof ctx.state === 'object' ? ctx.state : {};
  const nodes = model.nodes.filter((n) => n.kind !== 'module');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const groupLabel = new Map((model.groups ?? []).map((g) => [g.id, g.label ?? g.id]));
  // groups in the model's order, then by name; nodes with none share one
  const order = (model.groups ?? []).map((g) => g.id);
  const groups = [...new Set(nodes.map((n) => n.group ?? ''))].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    if (!a || !b) return a ? -1 : 1;
    return a.localeCompare(b);
  });
  const gName = (g) => (g ? groupLabel.get(g) ?? g : 'no group');
  // categories take the board's colour slots: sorted by name, 1…8, past eight the rest share "other"
  const cats = [...new Set(nodes.map((n) => n.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const slot = new Map(cats.map((c, i) => [c, cats.length <= MAX_CATS ? i + 1 : i < MAX_CATS - 1 ? i + 1 : 0]));
  const catColor = (c) => (c && slot.get(c) ? `var(--pl-cat-${slot.get(c)})` : c ? 'var(--pl-cat-other)' : 'var(--pl-card)');
  const rel = new Map(nodes.map((n) => [n.id, { in: 0, out: 0 }]));
  for (const e of model.edges ?? []) { if (e.kind === 'imports') continue; rel.get(e.from) && rel.get(e.from).out++; rel.get(e.to) && rel.get(e.to).in++; }

  const W = size.w, H = size.h;
  const cx = 350, cy = Math.round(H / 2), R0 = 70, R1 = 124, R2 = 128, R3 = 200, RL = 208;
  const PAD = groups.length > 1 ? 1.4 : 0;
  const total = 360 - PAD * groups.length;
  let a = PAD / 2;
  const arcs = groups.map((g) => {
    const members = nodes.filter((n) => (n.group ?? '') === g).sort((x, y) => (x.label ?? x.id).localeCompare(y.label ?? y.id));
    const span = (total * members.length) / Math.max(1, nodes.length);
    const arc = { g, a0: a, a1: a + span, members };
    a += span + PAD;
    return arc;
  });

  const pin = typeof state.pin === 'string' && byId.has(state.pin) ? state.pin : null;
  const pinGroup = typeof state.group === 'string' && groups.includes(state.group) ? state.group : null;
  let hover = null, hoverGroup = null;

  host.replaceChildren();
  const style = document.createElement('style');
  style.textContent = `
    svg { display: block; font-family: var(--pl-font); }
    .g-arc { fill: color-mix(in srgb, var(--pl-card) 88%, var(--pl-fg)); stroke: var(--pl-line); stroke-width: 1; cursor: pointer; }
    .n-arc { stroke: var(--pl-bg); stroke-width: 1.5; cursor: pointer; }
    .dim { opacity: 0.28; }
    .lit .g-arc, .g-arc.lit { stroke: var(--pl-accent); stroke-width: 2; }
    .n-arc.lit { stroke: var(--pl-accent); stroke-width: 2.5; }
    .g-lbl { font: 600 12px/1 var(--pl-font); fill: var(--pl-fg); pointer-events: none; }
    .n-lbl { font: 12px/1 var(--pl-font); fill: var(--pl-muted); pointer-events: none; }
    .n-lbl.lit { fill: var(--pl-accent); font-weight: 600; }
    .c-num { font: 700 30px/1 var(--pl-font); fill: var(--pl-fg); }
    .c-sub { font: 12px/1 var(--pl-font-mono); fill: var(--pl-muted); letter-spacing: 0.04em; }
    .side { position: absolute; left: 700px; right: 28px; top: 28px; bottom: 28px; display: grid; grid-template-rows: auto auto 1fr auto; gap: 14px; color: var(--pl-fg); font: 13px/1.4 var(--pl-font); }
    .side .k { font: 500 11px/1 var(--pl-font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--pl-muted); }
    .side h2 { margin: 6px 0 0; font: 700 21px/1.2 var(--pl-font-display, var(--pl-font)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rows { display: grid; gap: 2px; align-content: start; }
    .row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 8px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
    .row span:first-child { overflow: hidden; text-overflow: ellipsis; }
    .row .n { color: var(--pl-muted); font-family: var(--pl-font-mono); }
    .row.lit { background: color-mix(in srgb, var(--pl-accent) 14%, transparent); color: var(--pl-accent); }
    .card { align-self: start; max-height: 100%; box-sizing: border-box; border: 1px solid var(--pl-card-border); border-radius: var(--pl-radius); background: var(--pl-card); padding: 10px 12px; display: grid; gap: 5px; align-content: start; overflow: hidden; }
    .card b { font-size: 15px; }
    .card .m { font: 12px/1.4 var(--pl-font-mono); color: var(--pl-muted); }
    .card p { margin: 0; font-size: 12.5px; color: var(--pl-fg); display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
    .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
    .hint { font: 12px/1.3 var(--pl-font-mono); color: var(--pl-muted); }
  `;
  host.append(style);
  host.style.position = 'relative';

  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${plural(groups.length, 'group')} and ${plural(nodes.length, 'node')}` });
  host.append(svg);
  const gRing = el('g'), nRing = el('g'), labels = el('g');
  svg.append(gRing, nRing, labels);
  svg.append(el('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', class: 'c-num' }, String(nodes.length)));
  svg.append(el('text', { x: cx, y: cy + 24, 'text-anchor': 'middle', class: 'c-sub' }, `NODES · ${groups.length} GROUP${groups.length === 1 ? '' : 'S'}`));

  const nodeEls = new Map(), groupEls = new Map(), labelEls = new Map(), rowEls = new Map();
  for (const arc of arcs) {
    const p = el('path', { d: sector(cx, cy, R0, R1, arc.a0, arc.a1), class: 'g-arc' });
    p.addEventListener('pointerenter', () => { hoverGroup = arc.g; paint(); emit('status', `${gName(arc.g)} · ${plural(arc.members.length, 'node')}`); });
    p.addEventListener('pointerleave', () => { hoverGroup = null; paint(); });
    p.addEventListener('click', (e) => { e.stopPropagation(); emit('state', { pin: null, group: pinGroup === arc.g ? null : arc.g }); });
    p.append(el('title', {}, `${gName(arc.g)}: ${plural(arc.members.length, 'node')}`));
    gRing.append(p);
    groupEls.set(arc.g, p);
    const mid = (arc.a0 + arc.a1) / 2, span = arc.a1 - arc.a0;
    if (span > 14) {
      const r = (R0 + R1) / 2, x = cx + r * Math.sin(mid * DEG), y = cy - r * Math.cos(mid * DEG);
      labels.append(el('text', { x: x.toFixed(1), y: (y + 4).toFixed(1), 'text-anchor': 'middle', class: 'g-lbl' }, cut(gName(arc.g), Math.max(4, Math.floor(span / 5)))));
    }
    const step = (arc.a1 - arc.a0) / Math.max(1, arc.members.length);
    arc.members.forEach((n, i) => {
      const b0 = arc.a0 + i * step, b1 = b0 + step;
      const np = el('path', { d: sector(cx, cy, R2, R3, b0, b1), class: 'n-arc', style: `fill: ${catColor(n.category)}` });
      np.addEventListener('pointerenter', () => { hover = n.id; paint(); emit('status', `${n.label ?? n.id} · ${n.kind}${n.group ? ` · in ${gName(n.group)}` : ''}`); });
      np.addEventListener('pointerleave', () => { hover = null; paint(); });
      np.addEventListener('click', (e) => { e.stopPropagation(); emit('state', { pin: pin === n.id ? null : n.id, group: null }); });
      np.append(el('title', {}, n.label ?? n.id));
      nRing.append(np);
      nodeEls.set(n.id, np);
      if (step >= 4.5) {
        const m = (b0 + b1) / 2, x = cx + RL * Math.sin(m * DEG), y = cy - RL * Math.cos(m * DEG);
        const anchor = Math.sin(m * DEG) > 0.12 ? 'start' : Math.sin(m * DEG) < -0.12 ? 'end' : 'middle';
        const t = el('text', { x: x.toFixed(1), y: (y + 4 - 6 * Math.cos(m * DEG)).toFixed(1), 'text-anchor': anchor, class: 'n-lbl' }, cut(n.label ?? n.id, 22));
        labels.append(t);
        labelEls.set(n.id, t);
      }
    });
  }
  svg.addEventListener('click', () => { if (pin || pinGroup) emit('state', { pin: null, group: null }); });

  // the side: what this is, the groups (hover lights one), the pinned or hovered node
  const side = document.createElement('div');
  side.className = 'side';
  const head = document.createElement('div');
  head.innerHTML = '<div class="k"></div><h2></h2>';
  head.querySelector('.k').textContent = `Radial · ${plural(groups.length, 'group')} · ${plural(nodes.length, 'node')}`;
  head.querySelector('h2').textContent = model.project ?? 'The model';
  const rows = document.createElement('div');
  rows.className = 'rows';
  for (const arc of arcs) {
    const r = document.createElement('div');
    r.className = 'row';
    r.innerHTML = '<span></span><span class="n"></span>';
    r.firstChild.textContent = gName(arc.g);
    r.lastChild.textContent = String(arc.members.length);
    r.addEventListener('pointerenter', () => { hoverGroup = arc.g; paint(); });
    r.addEventListener('pointerleave', () => { hoverGroup = null; paint(); });
    r.addEventListener('click', () => emit('state', { pin: null, group: pinGroup === arc.g ? null : arc.g }));
    rows.append(r);
    rowEls.set(arc.g, r);
  }
  const card = document.createElement('div');
  card.className = 'card';
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'hover to light · click to pin';
  side.append(head, rows, card, hint);
  host.append(side);

  function showCard(id) {
    card.replaceChildren();
    const n = id ? byId.get(id) : null;
    if (!n) {
      const g = hoverGroup ?? pinGroup;
      const b = document.createElement('b');
      b.textContent = g !== null ? gName(g) : 'Categories';
      card.append(b);
      const list = g !== null ? nodes.filter((x) => (x.group ?? '') === g) : null;
      const items = list ? list.map((x) => [x.label ?? x.id, x.category]) : cats.map((c) => [c, c]);
      for (const [text, c] of items.slice(0, 9)) {
        const m = document.createElement('div');
        m.className = 'm';
        m.innerHTML = '<span class="sw"></span><span></span>';
        m.firstChild.style.background = catColor(c);
        m.lastChild.textContent = text;
        card.append(m);
      }
      if (items.length > 9) { const m = document.createElement('div'); m.className = 'm'; m.textContent = `and ${items.length - 9} more`; card.append(m); }
      return;
    }
    const b = document.createElement('b'); b.textContent = n.label ?? n.id;
    const m = document.createElement('div'); m.className = 'm';
    m.textContent = `${n.kind}${n.group ? ` · in ${gName(n.group)}` : ''}${n.category ? ` · ${n.category}` : ''}`;
    const r = rel.get(n.id);
    const m2 = document.createElement('div'); m2.className = 'm';
    m2.textContent = `${plural(r.in, 'caller')} · ${plural(r.out, 'callee')}`;
    card.append(b, m, m2);
    if (n.summary) { const p = document.createElement('p'); p.textContent = n.summary; card.append(p); }
  }

  function paint() {
    const focusNode = hover ?? pin;
    const focusGroup = focusNode ? null : hoverGroup ?? pinGroup;
    const lit = focusNode ? new Set([focusNode]) : focusGroup !== null ? new Set(nodes.filter((n) => (n.group ?? '') === focusGroup).map((n) => n.id)) : null;
    for (const [id, p] of nodeEls) { p.classList.toggle('dim', !!lit && !lit.has(id)); p.classList.toggle('lit', !!lit && lit.has(id) && !!focusNode); }
    for (const [id, t] of labelEls) { t.classList.toggle('dim', !!lit && !lit.has(id)); t.classList.toggle('lit', !!lit && lit.has(id)); }
    const litGroup = focusGroup ?? (focusNode ? byId.get(focusNode).group ?? '' : null);
    for (const [g, p] of groupEls) { p.classList.toggle('dim', litGroup !== null && g !== litGroup); p.classList.toggle('lit', litGroup !== null && g === litGroup); }
    for (const [g, r] of rowEls) r.classList.toggle('lit', litGroup !== null && g === litGroup);
    showCard(focusNode);
  }
  paint();
}
