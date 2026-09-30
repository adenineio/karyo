// Resolve an explainer's steps into explicit per-step state: which elements are visible, lit and
// dimmed, which links are drawn, the camera focus, every element's props (step `set`s are
// cumulative) and the layout in force. Pure; unknown ids are dropped here (validateSpec reports them).
import type { ExplainerSpec, LayoutSpec, LinkSpec, Rect, StepSpec } from './types';

export interface ResolvedStep {
  index: number;
  id: string;
  title: string;
  text: string;
  visible: Set<string>;
  emph: Set<string>;
  dim: Set<string>;
  /** Link ids drawn (explicit spec links, or ad-hoc "a->b"). */
  links: string[];
  /** The step listed its links (`connect`) rather than taking the default. */
  explicitConnect: boolean;
  focus: string | Rect | null;
  /** Props per element id, with every `set` up to and including this step applied. */
  props: Record<string, Record<string, unknown>>;
  layout: LayoutSpec;
  /** Index of the layout in `layouts` (steps that share a layout share an index). */
  layoutIndex: number;
}

export interface Resolved {
  steps: ResolvedStep[];
  /** Spec links plus the ad-hoc "a->b" links steps connect. */
  links: LinkSpec[];
  layouts: LayoutSpec[];
}

/** Props with the component's top-level schema defaults filled in. */
export function withDefaults(schema: Record<string, unknown> | undefined, props: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(props ?? {}) };
  const ps = (schema?.properties ?? {}) as Record<string, { default?: unknown }>;
  for (const [k, s] of Object.entries(ps)) if (!(k in out) && s && typeof s === 'object' && 'default' in s) out[k] = s.default;
  return out;
}

export const DEFAULT_LAYOUT: LayoutSpec = { kind: 'flow', gap: 24, direction: 'right', scope: 'all' };

/** "a->b" → ["a", "b"] (null when it isn't one). */
export function parseArrow(s: string): [string, string] | null {
  const m = s.match(/^(.+?)->(.+)$/);
  return m ? [m[1]!.trim(), m[2]!.trim()] : null;
}

export function resolveSteps(spec: ExplainerSpec): Resolved {
  const elements = spec.elements ?? [];
  const ids = elements.map((e) => e.id);
  const known = new Set(ids);
  const links: LinkSpec[] = [...(spec.links ?? [])];
  const linkById = new Map(links.map((l) => [l.id, l]));
  // a link is its ordered pair: an ad-hoc "a->b" (any spacing) is the spec link joining a to b when there
  // is one (its label and style kept), never a second wire drawn on top of it
  const linkByPair = new Map<string, LinkSpec>();
  for (const l of links) if (!linkByPair.has(`${l.from}->${l.to}`)) linkByPair.set(`${l.from}->${l.to}`, l);
  const raw: StepSpec[] = spec.steps?.length ? spec.steps : [{ title: spec.title, text: spec.summary ?? '' }];
  const base = { ...DEFAULT_LAYOUT, ...(spec.layout ?? {}) };
  const layouts: LayoutSpec[] = [base];
  let layoutIndex = 0;
  let visible = new Set(ids);
  let props: Record<string, Record<string, unknown>> = Object.fromEntries(elements.map((e) => [e.id, { ...(e.props ?? {}) }]));
  const steps = raw.map((s, i): ResolvedStep => {
    const only = (xs: string[] | undefined) => (xs ?? []).filter((x) => known.has(x));
    if (s.show === '*') visible = new Set(ids);
    else if (Array.isArray(s.show)) visible = new Set(only(s.show));
    else if (i === 0) visible = new Set(ids);
    else visible = new Set(visible);
    for (const a of only(s.add)) visible.add(a);
    for (const h of only(s.hide)) visible.delete(h);
    const emph = new Set(only(s.emphasize).filter((x) => visible.has(x)));
    const dim = new Set(s.dim === 'others' ? [...visible].filter((x) => !emph.has(x)) : only(Array.isArray(s.dim) ? s.dim : []).filter((x) => visible.has(x)));
    let stepLinks: string[];
    if (s.connect) {
      stepLinks = [];
      for (const c of s.connect) {
        if (linkById.has(c)) { stepLinks.push(c); continue; }
        const ab = parseArrow(c);
        if (!ab || !known.has(ab[0]) || !known.has(ab[1])) continue;
        const key = `${ab[0]}->${ab[1]}`;
        let l = linkByPair.get(key);
        if (!l) { l = { id: key, from: ab[0], to: ab[1] }; links.push(l); linkById.set(key, l); linkByPair.set(key, l); }
        stepLinks.push(l.id);
      }
    } else stepLinks = (spec.links ?? []).filter((l) => visible.has(l.from) && visible.has(l.to)).map((l) => l.id);
    if (s.set) {
      props = { ...props };
      for (const [id, ch] of Object.entries(s.set)) if (known.has(id) && ch && typeof ch === 'object') props[id] = { ...props[id], ...ch };
    }
    if (s.layout) { layouts.push({ ...DEFAULT_LAYOUT, ...s.layout }); layoutIndex = layouts.length - 1; }
    const groupIds = new Set((spec.groups ?? []).map((g) => g.id));
    const focus = typeof s.focus === 'string' ? (known.has(s.focus) || groupIds.has(s.focus) ? s.focus : null) : s.focus ?? null;
    return {
      index: i, id: s.id ?? `step-${i + 1}`, title: s.title ?? `Step ${i + 1}`, text: s.text ?? '',
      visible, emph, dim, links: [...new Set(stepLinks)], explicitConnect: !!s.connect, focus, props, layout: layouts[layoutIndex]!, layoutIndex,
    };
  });
  return { steps, links, layouts };
}
