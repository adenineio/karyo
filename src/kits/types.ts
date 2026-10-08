// Types of kits (docs/KITS.md, spec/karyo-kit.schema.json). A kit is a folder `karyo/kits/<name>/`: kit.json, plus
// node kinds (kinds/<kind>/, each a component: component.json, template.html, style.css, with a `node` block) and
// plate types (declared in kit.json: a view the engine has, drawn from a model, a flow or a tour). Kits are data and
// templates; the one exception is a `script` plate type (the JS escape hatch, docs/KITS.md "Code in kits"): it runs
// the kit's own JavaScript in a sandboxed frame, and only after the user trusted that exact version of the kit.
// Pure types: shared by the browser (src/kits/registry.ts) and bun (src/kits/library.ts).
import type { ComponentMeta, ComponentSource } from '../explainer/types';

export const KIT_VERSION = 'kit/1';

/** Where a kit came from, nearest first: the project, $KARYO_KITS, the shared library (~/.adenine/karyo/kits), the built-ins. */
export type KitSource = ComponentSource;

/** The engine views a plate type may compose, and what one plate of each is drawn from (null: any of them; a `script`
 *  plate is drawn by the kit's own code from whatever its `from` says). */
export const PLATE_VIEWS = { board: 'model', trace: 'flow', tour: 'tour', sequence: 'flow', script: null } as const;
export type PlateView = keyof typeof PLATE_VIEWS;
export type PlateFrom = 'model' | 'flow' | 'tour';

/** Which nodes a plate draws: a node stays when it matches every list given; `neighbours` adds the nodes one relationship away. */
export interface PlateFilter { kinds?: string[]; categories?: string[]; tags?: string[]; groups?: string[]; neighbours?: boolean }

/** A plate type (kit.json `plates[]`). */
export interface PlateType {
  id: string;
  title: string;
  description: string;
  view: PlateView;
  from: PlateFrom;
  filter?: PlateFilter;
  /** View options (sequence: durations, group, fold; board: bench, start; script: anything, handed to the script). */
  options?: Record<string, unknown>;
  /** view `script`: the kit's JavaScript module that draws the plate, relative to the kit's folder (`plates/radial.js`).
   *  It runs in a sandboxed frame, and only once the user trusts this version of the kit (docs/KITS.md). */
  script?: string;
  /** view `script`: the script draws the same picture from the same inputs (no clock, no randomness), so stills and
   *  lint may render it. Without it, stills show a notice instead of the plate. */
  deterministic?: boolean;
  /** view `script`: the plate's logical size (default 960 × 600). */
  size?: { w: number; h: number };
}

/** kit.json */
export interface KitManifest {
  $schema?: string;
  karyo: typeof KIT_VERSION;
  name: string;
  description: string;
  version: string;
  /** The node kinds it adds (folders under kinds/); omitted: every folder there. */
  kinds?: string[];
  plates?: PlateType[];
}

/** A details section a node kind adds (component.json `node.sections[]`): templates are files in the kind's folder. */
export interface KindSectionMeta { id: string; title: string; noun?: string; keywords?: string[]; template: string; compact?: string }

/** component.json `node`: what makes a component a node kind. */
export interface KindNodeMeta {
  /** The kind's name on its cards (default: the kind). */
  label?: string;
  /** Its legend entry (default: label + "s"). */
  plural?: string;
  /** A mark (≤ 2 characters) for small places: the tour's map, sequence lanes. */
  glyph?: string;
  /** The category its nodes take when they declare none. */
  category?: string;
  sections?: KindSectionMeta[];
  /** A template for small places (default: glyph and label). */
  mini?: string;
  /** The node `karyo kit check` renders the example with. */
  exampleNode?: { id?: string; label?: string; summary?: string; category?: string; tags?: string[]; lang?: string; ref?: { file: string; line?: number } };
}

/** A node kind's component.json: a component (`props` = the fields' schema, `example` = example fields) with a `node`
 *  block and a required size. */
export interface KindMeta extends ComponentMeta { size: { w: number; h: number }; node: KindNodeMeta }

/** A node kind as the browser needs it: templates read, CSS unscoped (the registry scopes it). */
export interface BundledKind {
  name: string;
  kit: string;
  source: KitSource;
  meta: KindMeta;
  template: string;
  css: string;
  /** Sections with their templates read. */
  sections: { id: string; title: string; noun?: string; keywords?: string[]; template: string; compact?: string }[];
  mini?: string;
}
export interface BundledPlate extends PlateType { kit: string; source: KitSource }

/** One file of a kit's code, as the page and the CLI show it before anything runs. */
export interface KitCodeFile { path: string; sha256: string; bytes: number }
/** What a kit runs: its script files plus kit.json (which says what runs), and one hash over them. Any byte changed in
 *  any of them is a new version, which must be trusted again. */
export interface KitCode {
  /** sha256 over the files (src/kits/code.ts `kitHash`). */
  hash: string;
  files: KitCodeFile[];
}
/** A kit's code as a page gets it: the files' text too (shown in the warning panel, run once trusted). */
export interface BundledCode extends KitCode {
  /** Where the kit is, absolute (the trust store's key). */
  dir: string;
  /** Where it is, in words for people: "this project (~/src/app/karyo/kits/radial)", "built into Karyo". */
  where: string;
  sources: Record<string, string>;
}

/** What a page gets (the `virtual:karyo-kits` module, vite.config.ts): every kind and plate type on the resolution path. */
export interface KitBundle {
  kits: { name: string; source: KitSource; description: string; version: string; kinds: string[]; plates: string[]; code?: BundledCode }[];
  kinds: Record<string, BundledKind>;
  plates: Record<string, BundledPlate>;
  /** Collisions (a nearer kit's kind or plate hides another) and load problems, in words. */
  warnings: string[];
}
