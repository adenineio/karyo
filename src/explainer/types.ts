// Types of the explainer spec (spec/karyo-explainer.schema.json) and of component libraries.
// An explainer is a JSON document: elements (instances of components) laid out on a board, links
// between them, and steps that change what is shown, lit, dimmed, linked and framed. See
// docs/EXPLAINERS.md. Pure types: shared by the browser plate and the bun/node tooling.

export const SPEC_VERSION = 'explainer/1';

/** Built-in component names (the repo's `components/` folder). They need no `uses` entry. */
export const BUILTINS = ['card', 'text', 'callout', 'code', 'image', 'metric', 'table', 'list', 'chip', 'kv', 'quote', 'figure', 'bar'] as const;

export interface Rect { x: number; y: number; w: number; h: number }

export interface ElementAt {
  /** Board position (px): used by the `free` layout. */
  x?: number;
  y?: number;
  /** Width / height (px): honoured by every layout. Height defaults to the content's natural height. */
  w?: number;
  h?: number;
}

export interface ElementSpec {
  id: string;
  /** Component name (built-in or from a component library). */
  type: string;
  props?: Record<string, unknown>;
  at?: ElementAt;
  /** Group id: members are framed together. */
  group?: string;
  /** A short name for the element (links, accessibility, the mode line). */
  label?: string;
  /** A category id (from the top-level `categories`): its colour marks the element and the legend. */
  category?: string;
  /** Tag ids (from the top-level `tags`): sets the legend can light and pin. */
  tags?: string[];
}

/** A legend category: its colour is its position (1st → --pl-cat-1 …; past the 8th, "other"). */
export interface CategorySpec { id: string; label?: string }
/** A legend tag: a named set of elements (those listing it in `tags`). */
export interface TagSpec { id: string; label?: string; description?: string }

export type LayoutKind = 'flow' | 'grid' | 'graph' | 'free' | 'stack';
export interface LayoutSpec {
  kind: LayoutKind;
  /** grid: number of columns. */
  columns?: number;
  /** Space between elements (px, default 24). */
  gap?: number;
  /** flow / stack / graph: main direction (default right). */
  direction?: 'right' | 'down';
  /** Lay out every element (stable positions, default) or only the step's visible ones (relayout glides). */
  scope?: 'all' | 'visible';
}

export interface GroupSpec { id: string; label?: string }

export type LinkStyle = 'solid' | 'dashed' | 'accent' | 'warn';
export interface LinkSpec {
  id: string;
  from: string;
  to: string;
  label?: string;
  style?: LinkStyle;
}

export interface StepSpec {
  id?: string;
  title?: string;
  /** Markdown-lite prose for the narration panel. */
  text?: string;
  /** The visible set ("*" = every element). Omitted: the previous step's set (the first step: every element). */
  show?: string[] | '*';
  add?: string[];
  hide?: string[];
  /** Lit: outline + light under. */
  emphasize?: string[];
  /** Dimmed to ~0.3: "others" = every visible element not emphasized. */
  dim?: 'others' | string[];
  /** Links drawn in this step: link ids or ad-hoc "a->b". Default: every link whose ends are both visible. */
  connect?: string[];
  /** Camera framing: an element id, a group id or a board rect. Default: fit the visible elements. */
  focus?: string | Rect;
  /** Prop changes, cumulative from step to step: { elementId: { prop: value } }. */
  set?: Record<string, Record<string, unknown>>;
  /** A relayout from this step on. */
  layout?: LayoutSpec;
}

export interface ExplainerSpec {
  $schema?: string;
  karyo: typeof SPEC_VERSION;
  id: string;
  title: string;
  summary?: string;
  /** A short line in the footer on every step (markdown-lite inline), e.g. "Names and files here are made-up examples." */
  note?: string;
  size?: { w: number; h: number };
  narration?: 'side' | 'bottom' | 'none';
  timeline?: boolean;
  /** Custom (non built-in) components this explainer needs. */
  uses?: string[];
  elements: ElementSpec[];
  layout?: LayoutSpec;
  groups?: GroupSpec[];
  links?: LinkSpec[];
  steps?: StepSpec[];
  /** Legend categories (colour = order) and tags. */
  categories?: CategorySpec[];
  tags?: TagSpec[];
  /** Show the legend strip (default: when any category or tag exists). */
  legend?: boolean;
}

// ------------------------------------------------------------------ components

export type MotionVerb = 'appear' | 'emphasize' | 'count' | 'draw';

/** components/<name>/component.json */
export interface ComponentMeta {
  name: string;
  description: string;
  version: string;
  /** JSON Schema (object) of the component's props. */
  props: Record<string, unknown>;
  /** Default element size (px). Height omitted: the content's natural height. */
  size?: { w: number; h?: number };
  motion?: MotionVerb[];
  example?: Record<string, unknown>;
}

/** What a plate needs of a component (the bundle carries only these). */
export interface BundledComponent {
  name: string;
  meta: ComponentMeta;
  template: string;
  css: string;
}

export type ComponentSource = 'project' | 'env' | 'adenine' | 'builtin';
export interface LibraryComponent extends BundledComponent {
  dir: string;
  source: ComponentSource;
}
export interface Shadowed {
  name: string;
  /** The copy that wins (first in resolution order). */
  used: { dir: string; source: ComponentSource };
  /** Copies further down the order that it hides. */
  hidden: { dir: string; source: ComponentSource }[];
}
export interface Library {
  components: Record<string, LibraryComponent>;
  shadowed: Shadowed[];
  /** Folders searched, in order. */
  searched: { dir: string; source: ComponentSource }[];
}
/** Anything with component metadata and templates (a Library, or a bundle's components). */
export interface LibraryLike { components: Record<string, { meta: ComponentMeta; template?: string; css?: string; source?: ComponentSource }> }

// ------------------------------------------------------------------ validation & bundles

export interface Issue {
  /** JSON pointer into the spec ("" = the document). */
  path: string;
  level: 'error' | 'warn';
  message: string;
  hint?: string;
}

export interface ExplainerBundle {
  spec: ExplainerSpec;
  components: Record<string, BundledComponent>;
}
