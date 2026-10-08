// Board layouts for explainers (pure): given each element's size, place them in board px.
//   flow   rows (direction right) or columns (down) that wrap at the view's width / height; rows centred
//   grid   `columns` columns; each cell as wide as its widest member, each row as tall as its tallest
//   stack  one row (right) or one column (down), centred across
//   graph  layered by links (longest path from the sources), callers before callees; direction right
//          = layers are columns, down = layers are rows; within a layer, ordered by the mean position
//          of their predecessors, then declaration order
//   free   each element's at.x / at.y (elements without one continue in a row under the rest)
// Positions are top-left corners. The camera (scene.ts) frames the result, so the origin is arbitrary.
import type { ElementAt, LayoutSpec } from './types';

export interface Sized { id: string; w: number; h: number; at?: ElementAt }
export type Placed = Map<string, { x: number; y: number }>;

export interface LayoutOpts {
  /** Gap when the spec gives none (px). */
  gap?: number;
  /** graph: the least space between layers (e.g. room for link labels). */
  layerGap?: number;
}

export function layoutBoard(items: Sized[], spec: LayoutSpec, links: { from: string; to: string }[], view: { w: number; h: number }, o: LayoutOpts = {}): Placed {
  const gap = spec.gap ?? o.gap ?? 32;
  const dir = spec.direction ?? 'right';
  const out: Placed = new Map();
  if (!items.length) return out;
  switch (spec.kind) {
    case 'grid': return grid(items, spec.columns ?? Math.ceil(Math.sqrt(items.length)), gap);
    case 'stack': return stack(items, dir, gap);
    case 'graph': return graph(items, links, dir, gap, o.layerGap ?? 0);
    case 'free': {
      const loose: Sized[] = [];
      let bottom = 0;
      for (const it of items) {
        if (typeof it.at?.x === 'number' && typeof it.at?.y === 'number') { out.set(it.id, { x: it.at.x, y: it.at.y }); bottom = Math.max(bottom, it.at.y + it.h); }
        else loose.push(it);
      }
      for (const [id, p] of flow(loose, 'right', gap, view)) out.set(id, { x: p.x, y: p.y + (out.size ? bottom + gap : 0) });
      return out;
    }
    default: return flow(items, dir, gap, view);
  }
}

function flow(items: Sized[], dir: 'right' | 'down', gap: number, view: { w: number; h: number }): Placed {
  const out: Placed = new Map();
  const main = (it: Sized) => (dir === 'right' ? it.w : it.h), cross = (it: Sized) => (dir === 'right' ? it.h : it.w);
  const limit = Math.max(1, dir === 'right' ? view.w : view.h);
  const lines: Sized[][] = [[]];
  let used = 0;
  for (const it of items) {
    const line = lines[lines.length - 1]!;
    if (line.length && used + gap + main(it) > limit) { lines.push([it]); used = main(it); }
    else { used += (line.length ? gap : 0) + main(it); line.push(it); }
  }
  const lens = lines.map((l) => l.reduce((a, it) => a + main(it), 0) + gap * Math.max(0, l.length - 1));
  const widest = Math.max(...lens);
  let c = 0;
  lines.forEach((line, li) => {
    let m = (widest - lens[li]!) / 2;
    const thick = Math.max(...line.map(cross));
    for (const it of line) {
      const off = (thick - cross(it)) / 2;
      out.set(it.id, dir === 'right' ? { x: m, y: c + off } : { x: c + off, y: m });
      m += main(it) + gap;
    }
    c += thick + gap;
  });
  return out;
}

function stack(items: Sized[], dir: 'right' | 'down', gap: number): Placed {
  const out: Placed = new Map();
  const thick = Math.max(...items.map((it) => (dir === 'right' ? it.h : it.w)));
  let m = 0;
  for (const it of items) {
    if (dir === 'right') { out.set(it.id, { x: m, y: (thick - it.h) / 2 }); m += it.w + gap; }
    else { out.set(it.id, { x: (thick - it.w) / 2, y: m }); m += it.h + gap; }
  }
  return out;
}

function grid(items: Sized[], columns: number, gap: number): Placed {
  const out: Placed = new Map();
  const cols = Math.max(1, Math.min(columns, items.length));
  const colW = Array.from({ length: cols }, (_, j) => Math.max(0, ...items.filter((_, i) => i % cols === j).map((it) => it.w)));
  const rows = Math.ceil(items.length / cols);
  const rowH = Array.from({ length: rows }, (_, r) => Math.max(0, ...items.slice(r * cols, r * cols + cols).map((it) => it.h)));
  items.forEach((it, i) => {
    const j = i % cols, r = Math.floor(i / cols);
    const x = colW.slice(0, j).reduce((a, w) => a + w + gap, 0) + (colW[j]! - it.w) / 2;
    const y = rowH.slice(0, r).reduce((a, h) => a + h + gap, 0);
    out.set(it.id, { x, y });
  });
  return out;
}

function graph(items: Sized[], links: { from: string; to: string }[], dir: 'right' | 'down', gap: number, minLayerGap: number): Placed {
  const out: Placed = new Map();
  const ids = new Set(items.map((it) => it.id));
  const order = new Map(items.map((it, i) => [it.id, i]));
  const inn = new Map<string, string[]>();
  for (const l of links) if (ids.has(l.from) && ids.has(l.to) && l.from !== l.to) (inn.get(l.to) ?? inn.set(l.to, []).get(l.to)!).push(l.from);
  // longest path from the sources (cycle-safe)
  const layer = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(0, ...(inn.get(id) ?? []).map((p) => depth(p, seen) + 1));
    seen.delete(id); layer.set(id, d);
    return d;
  };
  items.forEach((it) => depth(it.id, new Set()));
  const L = Math.max(0, ...layer.values()) + 1;
  const cols: Sized[][] = Array.from({ length: L }, () => []);
  for (const it of items) cols[layer.get(it.id)!]!.push(it);
  const rank = new Map<string, number>();
  cols.forEach((col) => {
    const bary = (it: Sized) => { const ps = (inn.get(it.id) ?? []).map((p) => rank.get(p)).filter((r): r is number => r !== undefined); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : order.get(it.id)!; };
    col.sort((a, b) => bary(a) - bary(b) || order.get(a.id)! - order.get(b.id)!);
    col.forEach((it, i) => rank.set(it.id, i));
  });
  const layerGap = Math.max(gap * 2.5, 72, dir === 'right' ? minLayerGap : 0);
  const main = (it: Sized) => (dir === 'right' ? it.w : it.h), cross = (it: Sized) => (dir === 'right' ? it.h : it.w);
  const thick = cols.map((c) => Math.max(0, ...c.map(main)));
  const span = cols.map((c) => c.reduce((a, it) => a + cross(it), 0) + gap * Math.max(0, c.length - 1));
  const tallest = Math.max(...span);
  let m = 0;
  cols.forEach((col, l) => {
    let c = (tallest - span[l]!) / 2;
    for (const it of col) {
      const off = (thick[l]! - main(it)) / 2;
      out.set(it.id, dir === 'right' ? { x: m + off, y: c } : { x: c, y: m + off });
      c += cross(it) + gap;
    }
    m += thick[l]! + layerGap;
  });
  return out;
}
