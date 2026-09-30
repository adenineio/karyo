// Helpers for interactive plates (docs/ENGINE.md, "Interactive plates").
//
// An interactive scene keeps a view state. When the state changes it calls stage.transition(),
// and every frame of that transition is a pure function of (where things were, where they are
// going, t). `Morph` holds exactly that: per key, the values on screen when the transition began
// and the values of the new resting layout.
import type { Stage } from './stage';
import { lerp } from './util';

export type Vals = Record<string, number>;

export class Morph {
  private from = new Map<string, Vals>();
  private to = new Map<string, Vals>();
  private k = 1;

  /** Begin a transition to `targets`. Whatever is on screen now (at the current progress) becomes the
   *  start, so interrupting a transition never jumps. Keys missing from `targets` keep their values. */
  retarget(targets: Map<string, Vals>) {
    const now = new Map<string, Vals>();
    for (const key of new Set([...this.to.keys(), ...targets.keys()])) now.set(key, this.value(key) ?? targets.get(key)!);
    this.from = now;
    this.to = new Map([...this.to, ...targets]);
    this.k = 0;
  }
  /** Jump: no transition (restoring a state, a still, a drag at rest). */
  snap(targets: Map<string, Vals>) {
    this.to = new Map([...this.to, ...targets]);
    this.from = new Map(this.to);
    this.k = 1;
  }
  /** Set the transition progress for this frame (0..1, already eased). */
  progress(k: number) { this.k = k; }
  /** The value of every field of `key` at the current progress (undefined for an unknown key). */
  value(key: string): Vals | undefined {
    const b = this.to.get(key);
    if (!b) return undefined;
    const a = this.from.get(key) ?? b;
    if (this.k >= 1) return b;
    const out: Vals = {};
    for (const f in b) out[f] = lerp(a[f] ?? b[f]!, b[f]!, this.k);
    return out;
  }
  target(key: string) { return this.to.get(key); }
}

export interface DragOpts {
  /** CSS px the pointer must travel before a press becomes a drag (below it, it's a click). */
  threshold?: number;
  /** Where the drag may start (default: anywhere on the element). */
  handle?: (e: PointerEvent) => boolean;
  onStart?(p: { x: number; y: number }, e: PointerEvent): void;
  /** Total movement since the press, in stage px. */
  onMove?(d: { dx: number; dy: number }, e: PointerEvent): void;
  onEnd?(d: { dx: number; dy: number }, e: PointerEvent): void;
  /** A press that never became a drag. */
  onClick?(e: PointerEvent): void;
}

/** Pointer drag in stage px, telling a click from a drag. Returns a disposer. */
export function draggable(el: HTMLElement, stage: Stage, o: DragOpts): () => void {
  const threshold = o.threshold ?? 4;
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || (o.handle && !o.handle(e))) return;
    const sx = e.clientX, sy = e.clientY;
    let dragging = false;
    const d = (ev: PointerEvent) => ({ dx: (ev.clientX - sx) / stage.zoom, dy: (ev.clientY - sy) / stage.zoom });
    // listen on the window, not the element: a fast first move that leaves the element is still a drag
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < threshold) return;
      if (!dragging) { dragging = true; o.onStart?.(stage.toStage(sx, sy), e); }
      o.onMove?.(d(ev), ev);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      if (dragging) o.onEnd?.(d(ev), ev); else if (ev.type === 'pointerup') o.onClick?.(ev);
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  };
  el.addEventListener('pointerdown', down);
  return () => el.removeEventListener('pointerdown', down);
}
