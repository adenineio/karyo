// Jarvis mode: the page ↔ server protocol (one WebSocket, JSON text frames). The server (integrations/jarvis)
// transcribes speech locally and runs a `claude -p` session that drives the plate through `action` messages.
// Indices the page sends and accepts (steps, requests, slices) are 1-based, as the plates number them on screen.
import type { PlateKind } from '../model/outline';

export const DEFAULT_WS = 'ws://127.0.0.1:5190/ws';

export interface JarvisSettings { wakeWord: string; wakeEnabled: boolean }

export interface ViewSelection {
  /** Board: the card whose panel is open. */
  open?: string | null;
  /** Board, trace board: the open card's details, measured from the screen (what is actually visible). */
  section?: string | null;
  sections?: { id: string; title: string; count: number | null }[];
  /** In words: "7 of 7 fields", "2 of 7 fields fully visible, total partly; scroll for the rest". */
  visible?: string;
  /** Item names wholly visible, partly visible, and out of view; and whether there is more to scroll to. */
  items?: { shown: string[]; partly: string[]; hidden: string[] };
  more?: { above: boolean; below: boolean };
  /** Board: the group drilled into. */
  drill?: string | null;
  /** Pinned legend entry ids (`highlight` is the ad-hoc highlight). */
  pins?: string[];
  /** The cards the ad-hoc highlight lights (when `pins` has `highlight`). */
  highlighted?: string[];
  /** Tour, explainer: the current step (1-based). */
  step?: number;
  /** Trace board: the selected request (1-based), null = the whole trace. */
  request?: number | null;
  /** Stack view: the current slice (1-based) and the exploded overview. */
  slice?: number;
  fan?: boolean;
  /** Board, trace board: the pinned inspector beside the window (docs/ENGINE.md "Pinned inspector"): pinned, on
   *  screen, locked, its side, and what it shows (a card and section, or a request's calls) measured like the details. */
  inspector?: {
    pinned: boolean; shown: boolean; locked: boolean; side: 'left' | 'right';
    node: string | null; label: string | null; section: string | null; visible: string;
    items: { shown: string[]; partly: string[]; hidden: string[] }; more: { above: boolean; below: boolean };
  };
  /** Board: the open splice (docs/ENGINE.md "Splice"): proposals only, never the real diagram; null in the real view. */
  splice?: SpliceState | null;
  /** A splice action's own words: what it did (opened, saved to …) or a warning the change raised. */
  spliceNote?: string;
  /** Board: a stack of splices (docs/ENGINE.md "Stack of splices"), or null: its slices (1-based, the real view first), the
   *  current one, whether it is on screen (false: you are on the board editing one of its slices), the combination's conflicts. */
  spliceStack?: SpliceStackState | null;
  /** splice_list: the saved splices. */
  splices?: { id: string; title: string; ops: number; landed: number; noLongerApply: number; updated: string | null; file: string }[];
  /** The plate laid out for the window (on) or at its page layout, scaled to fit (off). */
  theater: boolean;
  bench: boolean;
  /** The viewer's zoom in percent: 100 = fit (the whole plate), up to 400 (docs/ENGINE.md "Zoom and pan"). */
  zoom?: number;
}
/** A stack of splices as Jarvis reports it (src/model/board.ts SpliceStackView). */
export interface SpliceStackState {
  shown: boolean;
  cur: number;
  slices: { index: number; title: string; kind: 'real' | 'splice' | 'combined'; unsaved: boolean; changes: number; about: string[]; warning: string | null }[];
  /** What combining found, one line each (conflicts first, then consequences, the order, same names, notes). */
  conflicts: string[];
  /** Each item explained, numbered as the combined slice lists them: its kind (conflict, consequence, order, same name,
   *  same thing, agreed, follows), what it is about, the splices, what each does to it, and what the combination shows
   *  (the words its card shows). */
  explained: { n: number; kind: string; what: string; splices: string[]; parts: { splice: string; does: string }[]; result: string }[];
  /** The combined slice's order, the other order, whether the other order gives something else and what. */
  order: { now: string[]; other: string[]; matters: boolean; gives: string | null; otherGives: string | null } | null;
  /** The item whose card is on screen and lit (1-based) and whether it is pinned; null: none is. */
  lit: { n: number; pinned: boolean } | null;
  /** A question on screen (the combined slice is read-only …), or null. */
  asking: string | null;
}
/** The open splice as Jarvis reports it. */
export interface SpliceState {
  id: string;
  title: string;
  /** Changes not saved yet. */
  dirty: boolean;
  /** How many changes, and the last one in plain words. */
  ops: number;
  last: string | null;
  /** Changes that no longer apply over the current code (a node they name is gone …). */
  warnings: string[];
  /** Where it is saved, or null. */
  file: string | null;
  /** How many of its changes the code already has. */
  landed: number;
}
export interface ViewSnapshot {
  plate: PlateKind;
  title: string;
  nodes: { id: string; label: string; group: string | null; category: string | null; tags: string[] }[];
  groups: { id: string; label: string }[];
  tags: { id: string; label: string; count: number }[];
  steps: { index: number; title: string }[];
  selection: ViewSelection;
}

export type SpliceActionName = 'splice_open' | 'splice_add' | 'splice_connect' | 'splice_disconnect' | 'splice_remove' | 'splice_replace' | 'splice_rename' | 'splice_move' | 'splice_undo' | 'splice_redo' | 'splice_save' | 'splice_discard' | 'splice_leave' | 'splice_list'
  | 'splice_stack' | 'splice_stack_open' | 'splice_stack_return' | 'splice_stack_leave' | 'splice_stack_conflict' | 'splice_stack_swap' | 'splice_stack_same';
export type ActionName = 'focus' | 'open' | 'close' | 'drill' | 'back' | 'highlight' | 'clear' | 'show_details' | 'scroll' | 'step' | 'select' | 'theater' | 'fan' | 'bench' | 'pin_inspector' | 'zoom' | 'pan' | SpliceActionName;
export const ACTIONS: readonly ActionName[] = ['focus', 'open', 'close', 'drill', 'back', 'highlight', 'clear', 'show_details', 'scroll', 'step', 'select', 'theater', 'fan', 'bench', 'pin_inspector', 'zoom', 'pan',
  'splice_open', 'splice_add', 'splice_connect', 'splice_disconnect', 'splice_remove', 'splice_replace', 'splice_rename', 'splice_move', 'splice_undo', 'splice_redo', 'splice_save', 'splice_discard', 'splice_leave', 'splice_list',
  'splice_stack', 'splice_stack_open', 'splice_stack_return', 'splice_stack_leave', 'splice_stack_conflict', 'splice_stack_swap', 'splice_stack_same'];

export type PageMsg =
  | { type: 'hello'; scene: string; vocab: string[]; settings: JarvisSettings }
  | { type: 'audio'; mode: 'ptt' | 'wake'; sampleRate: 16000; pcm: string }
  | { type: 'text'; text: string }
  | { type: 'settings'; settings: JarvisSettings }
  | { type: 'view'; snapshot: ViewSnapshot }
  | { type: 'action_result'; id: string; ok: boolean; state?: ViewSelection; error?: string };

export type MicState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'acting';
export type ServerMsg =
  | { type: 'status'; state: MicState | string; detail?: string }
  | { type: 'transcript'; text: string; wake?: boolean; accepted: boolean }
  | { type: 'action'; id: string; name: string; args?: Record<string, unknown> }
  | { type: 'activity'; text: string }
  | { type: 'caption'; text: string; final: boolean }
  | { type: 'error'; message: string };

/** Float32 samples → base64 of their little-endian bytes (the `audio` message's `pcm`). */
export function pcmToBase64(pcm: Float32Array): string {
  const bytes = new Uint8Array(pcm.length * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) dv.setFloat32(i * 4, pcm[i]!, true);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function base64ToPcm(b64: string): Float32Array {
  const bin = atob(b64), dv = new DataView(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i));
  const out = new Float32Array(bin.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}
