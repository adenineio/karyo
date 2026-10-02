// Plate types (docs/KITS.md): a kit's `plates[]` entry composes one of the engine's views from JSON. `kitPlate` builds
// the scene for one model (and one of its flows or tours, per the type's `from`); `plateInstances` lists what a model
// offers (the project view and the gallery list them like any other plate). A plate type picks a view, a source, a
// node filter and view options, and the engine does the rest; the one exception is a `script` plate, drawn by the kit's
// own JavaScript, which runs only once the user trusted that version of the kit (src/kits/script-plate.ts).
import type { SceneClass } from '../engine';
import type { Model } from '../model/model';
import { boardScene } from '../model/board';
import { traceBoard } from '../model/flowboard';
import { tourScene } from '../model/tour';
import { sequenceScene } from '../model/sequence';
import { isSequenceFold, type SequenceFold } from '../model/sequence-fold';
import { wiresOf } from '../model/model';
import { kitsFor, type KitSet } from './registry';
import { scriptPlate } from './script-plate';
import type { BundledPlate, PlateFilter } from './types';

/** The nodes a filter keeps (null: no filter, every node). */
export function filterNodes(m: Model, f: PlateFilter | undefined): Set<string> | null {
  if (!f || !['kinds', 'categories', 'tags', 'groups'].some((k) => Array.isArray(f[k as keyof PlateFilter]))) return null;
  const keep = new Set(m.nodes.filter((n) => n.kind !== 'module'
    && (!f.kinds || f.kinds.includes(n.kind))
    && (!f.categories || (!!n.category && f.categories.includes(n.category)))
    && (!f.tags || (n.tags ?? []).some((t) => f.tags!.includes(t)))
    && (!f.groups || (!!n.group && f.groups.includes(n.group)))).map((n) => n.id));
  // one relationship away from what the filter matched (never further: a neighbour's neighbours stay out)
  if (f.neighbours) { const hit = new Set(keep); for (const w of wiresOf(m)) if (hit.has(w.from) || hit.has(w.to)) { keep.add(w.from); keep.add(w.to); } }
  return keep;
}

/** The model with only these nodes and the relationships between them (flows and tours kept as they are). */
export function subModel(m: Model, keep: Set<string> | null): Model {
  if (!keep) return m;
  return { ...m, nodes: m.nodes.filter((n) => keep.has(n.id)), edges: m.edges.filter((e) => keep.has(e.from) && keep.has(e.to)), checks: (m.checks ?? []).filter((c) => !c.subject || c.subject.split('->').every((x) => keep.has(x))) };
}

export interface PlateInstance { plate: BundledPlate; flow?: string; tour?: string; title: string }

/** Every plate a model offers from these kits: one per model, per recorded flow or per tour, as the type's `from` says. */
export function plateInstances(model: Model, kits: KitSet = kitsFor(model)): PlateInstance[] {
  const out: PlateInstance[] = [];
  for (const p of kits.plates) {
    if (p.from === 'model') out.push({ plate: p, title: `${p.title}: ${model.project ?? 'the model'}` });
    else if (p.from === 'flow') for (const f of model.flows) { if (f.spans.length) out.push({ plate: p, flow: f.id, title: `${p.title}: ${f.title ?? f.id}` }); }
    else for (const t of model.tours ?? []) out.push({ plate: p, tour: t.id, title: `${p.title}: ${t.title}` });
  }
  return out;
}

export interface KitPlateOpts {
  title?: string;
  /** Where the plate keeps a viewer's arrangement (a board's localStorage key). */
  key?: string;
  /** A board's model file (splices are saved next to it). */
  modelFile?: string;
}

/** The scene for plate type `id` over `model` (and `src.flow` / `src.tour` when the type is drawn from one). Throws
 *  when the kits have no such type, or the source is missing. */
export function kitPlate(kits: KitSet, id: string, model: Model, src: { flow?: string; tour?: string } = {}, o: KitPlateOpts = {}): SceneClass {
  const p = kits.plate(id);
  if (!p) throw new Error(`karyo: no plate type "${id}" (have: ${kits.plates.map((x) => x.id).join(', ') || 'none'})`);
  const opt = (k: string) => p.options?.[k];
  const keep = filterNodes(model, p.filter);
  const need = (what: 'flow' | 'tour') => { const v = src[what] ?? (what === 'flow' ? model.flows[0]?.id : model.tours?.[0]?.id); if (!v) throw new Error(`karyo: plate type "${id}" is drawn from a ${what}, and the model has none`); return v; };
  switch (p.view) {
    case 'board': return boardScene(subModel(model, keep), { kits, title: o.title ?? `${p.title}: ${model.project ?? 'the model'}`, key: o.key ?? `kit:${id}:${model.project ?? 'model'}`, benchOpen: opt('bench') === true, ...(opt('start') === 'groups' || opt('start') === 'cards' ? { start: opt('start') as 'groups' | 'cards' } : {}), ...(o.modelFile ? { modelFile: o.modelFile } : {}) });
    case 'trace': { const f = need('flow'); return traceBoard(model, f, { kits, title: o.title ?? `${p.title}: ${model.flows.find((x) => x.id === f)?.title ?? f}` }); }
    case 'tour': return tourScene(model, need('tour'), { kits, ...(o.title ? { title: o.title } : {}) });
    case 'script': return scriptPlate(kits, p, model, { ...(o.title ? { title: o.title } : {}), ...(p.from === 'flow' ? { flow: need('flow') } : p.from === 'tour' ? { tour: need('tour') } : {}) });
    case 'sequence': { const f = need('flow'); return sequenceScene(model, f, { kits, title: o.title ?? `${p.title}: ${model.flows.find((x) => x.id === f)?.title ?? f}`, durations: opt('durations') !== false, group: opt('group') !== false, ...(isSequenceFold(opt('fold')) ? { fold: opt('fold') as SequenceFold } : {}), ...(keep ? { keep } : {}) }); }
  }
  throw new Error(`karyo: plate type "${id}" has an unknown view "${String(p.view)}"`);
}
