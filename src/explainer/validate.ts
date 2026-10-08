// Validate an explainer spec: the JSON Schema (spec/karyo-explainer.schema.json), then semantic
// checks against a component library. Pure (no DOM, no fs): runs in bun, node and the browser.
import schemaJson from '../../spec/karyo-explainer.schema.json';
import { checkSchema, nearest } from './jsonschema';
import { parseTemplate, tweenProps, cssProblems, TemplateError } from './template';
import { resolveSteps, parseArrow, parsePart, withDefaults } from './resolve';
import { chartIssues, chartKindOf, partProblem, seriesOf } from './chart/data';
export { withDefaults };
import { BUILTINS, SPEC_VERSION, type ExplainerSpec, type Issue, type LibraryLike } from './types';

export const explainerSchema = schemaJson as unknown as Record<string, unknown>;

const esc = (k: string | number) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
const at = (...parts: (string | number)[]) => parts.map((p) => `/${esc(p)}`).join('');

export function validateSpec(spec: unknown, lib: LibraryLike): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string, hint?: string) => issues.push({ path, level: 'error', message, ...(hint ? { hint } : {}) });
  const warn = (path: string, message: string, hint?: string) => issues.push({ path, level: 'warn', message, ...(hint ? { hint } : {}) });

  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { err('', 'an explainer spec must be a JSON object', `start from { "karyo": "${SPEC_VERSION}", "id": …, "title": …, "elements": [ … ] }`); return issues; }
  for (const e of checkSchema(spec, explainerSchema as never)) err(e.path, e.message, e.hint);
  const s = spec as ExplainerSpec;
  // semantic checks need the basic shape; with a broken shape, the schema errors say enough
  if (!Array.isArray(s.elements) || s.elements.some((e) => !e || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.type !== 'string')) return issues;
  const arr = <T>(v: T[] | undefined) => (Array.isArray(v) ? v : []);
  const steps = arr(s.steps), links = arr(s.links).filter((l) => l && typeof l === 'object'), groups = arr(s.groups).filter((g) => g && typeof g === 'object');
  const cats = arr(s.categories).filter((c) => c && typeof c === 'object'), tags = arr(s.tags).filter((t) => t && typeof t === 'object');

  // ---- ids
  const dupes = (list: { id?: unknown }[], where: string) => {
    const seen = new Map<string, number>();
    list.forEach((x, i) => {
      if (typeof x?.id !== 'string') return;
      if (seen.has(x.id)) err(at(where, i, 'id'), `duplicate id "${x.id}" (also ${where}[${seen.get(x.id)}])`);
      else seen.set(x.id, i);
    });
  };
  dupes(s.elements, 'elements'); dupes(links, 'links'); dupes(groups, 'groups'); dupes(steps, 'steps'); dupes(cats, 'categories'); dupes(tags, 'tags');
  const elIds = new Set(s.elements.map((e) => e.id));
  const linkIds = new Set(links.map((l) => l.id));
  const groupIds = new Set(groups.map((g) => g.id));
  const unknownEl = (path: string, id: unknown, what = 'element') => {
    if (typeof id !== 'string' || elIds.has(id)) return false;
    const near = nearest(id, elIds);
    err(path, `unknown ${what} "${id}"`, near ? `did you mean "${near}"?` : `elements: ${[...elIds].slice(0, 12).join(', ')}`);
    return true;
  };

  const catIdList = arr(s.categories).filter((c) => c && typeof c === 'object' && typeof c.id === 'string').map((c) => c.id);
  // ---- components
  const names = Object.keys(lib.components);
  const usedTypes = new Map<string, number>();       // type → first element index
  s.elements.forEach((e, i) => {
    const c = lib.components[e.type];
    if (!c) {
      const near = nearest(e.type, names);
      err(at('elements', i, 'type'), `unknown component "${e.type}"`, near ? `did you mean "${near}"? (or scaffold it: karyo component new ${e.type})` : `available: ${names.join(', ')}; or scaffold one: karyo component new ${e.type}`);
      return;
    }
    if (!usedTypes.has(e.type)) usedTypes.set(e.type, i);
    const props = e.props ?? {};
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const pe of checkSchema(props, c.meta.props as never, at('elements', i, 'props'))) err(pe.path, `${e.type}: ${pe.message}`, pe.hint);
      if (c.template) {
        const merged = withDefaults(c.meta.props, props);
        for (const p of safeTween(c.template)) if (p in merged && typeof merged[p] !== 'number') warn(at('elements', i, 'props', p), `${e.type} counts "${p}" (data-k-num / data-k-scale), but it isn't a number`, 'give a number, or the text is shown as is and nothing counts');
        const kind = chartKindOf(c.template);
        if (kind && !checkSchema(props, c.meta.props as never).length) for (const ci of chartIssues(kind, merged, catIdList)) err(at('elements', i, 'props') + ci.path, `${e.type}: ${ci.message}`, ci.hint);
      }
    }
    if (e.group !== undefined && !groupIds.has(e.group)) {
      const near = nearest(e.group, groupIds);
      err(at('elements', i, 'group'), `unknown group "${e.group}"`, near ? `did you mean "${near}"?` : 'declare it in "groups": [{ "id": …, "label": … }]');
    }
  });
  for (const [type, i] of usedTypes) {
    const c = lib.components[type]!;
    if (c.template !== undefined) {
      try { parseTemplate(c.template); } catch (e) { if (e instanceof TemplateError) err(at('elements', i, 'type'), `component "${type}" has a broken template: ${e.message}`); else throw e; }
    }
    for (const p of cssProblems(c.css ?? '')) warn(at('elements', i, 'type'), `component "${type}" style.css ${p}`);
    const builtin = (BUILTINS as readonly string[]).includes(type);
    if (!builtin && !arr(s.uses).includes(type)) warn(at('uses'), `custom component "${type}" is not listed in "uses"`, `add "${type}" to "uses" so tools know to install it with the explainer`);
  }
  arr(s.uses).forEach((u, i) => {
    if (typeof u !== 'string') return;
    if (!lib.components[u]) { const near = nearest(u, names); err(at('uses', i), `"uses" names an unknown component "${u}"`, near ? `did you mean "${near}"?` : 'install it into a components/ folder next to the spec, $KARYO_COMPONENTS or ~/.adenine/karyo/components'); }
    else if (!usedTypes.has(u)) warn(at('uses', i), `"${u}" is listed in "uses" but no element uses it`);
  });
  groupIds.forEach((g) => { if (!s.elements.some((e) => e.group === g)) warn(at('groups', groups.findIndex((x) => x.id === g)), `group "${g}" has no members`); });

  // ---- legend: categories and tags
  const catIds = new Set(cats.map((c) => c.id)), tagIds = new Set(tags.map((t) => t.id));
  s.elements.forEach((e, i) => {
    if (typeof e.category === 'string' && !catIds.has(e.category)) {
      const near = nearest(e.category, catIds);
      err(at('elements', i, 'category'), `unknown category "${e.category}"`, near ? `did you mean "${near}"?` : catIds.size ? `categories: ${[...catIds].join(', ')}` : 'declare it in "categories": [{ "id": …, "label": … }]');
    }
    if (Array.isArray(e.tags)) e.tags.forEach((t, j) => {
      if (typeof t !== 'string' || tagIds.has(t)) return;
      const near = nearest(t, tagIds);
      err(at('elements', i, 'tags', j), `unknown tag "${t}"`, near ? `did you mean "${near}"?` : tagIds.size ? `tags: ${[...tagIds].join(', ')}` : 'declare it in "tags": [{ "id": …, "label": … }]');
    });
  });
  if (cats.length > 8) warn(at('categories', 7), `${cats.length} categories: the legend has 8 colours, so categories from the 8th on share one "other" swatch`, 'merge categories, or use tags for the finer sets');
  // a chart's series and slices use categories too (their colour and label)
  const chartCats = new Set<string>();
  s.elements.forEach((e) => {
    const kind = chartKindOf(lib.components[e.type]?.template);
    if (!kind) return;
    for (const p of [e.props, ...steps.map((st) => st?.set?.[e.id])]) if (p && typeof p === 'object') { try { for (const x of seriesOf(kind, p as Record<string, unknown>)) if (typeof x?.category === 'string') chartCats.add(x.category); } catch { /* shape errors are reported above */ } }
  });
  cats.forEach((c, i) => { if (typeof c.id === 'string' && !chartCats.has(c.id) && !s.elements.some((e) => e.category === c.id)) warn(at('categories', i), `category "${c.id}" has no elements`); });
  tags.forEach((t, i) => { if (typeof t.id === 'string' && !s.elements.some((e) => Array.isArray(e.tags) && e.tags.includes(t.id))) warn(at('tags', i), `tag "${t.id}" has no elements`); });
  if (s.legend === true && !cats.length && !tags.length) warn(at('legend'), '"legend": true, but there are no categories or tags to show', 'add "categories" / "tags", or drop "legend"');

  // ---- links: one per ordered pair (two links joining a to b draw one wire on top of the other)
  const byPair = new Map<string, number>();
  links.forEach((l, i) => {
    if (typeof l.from !== 'string' || typeof l.to !== 'string' || l.from === l.to) return;
    const k = `${l.from}->${l.to}`, j = byPair.get(k), back = byPair.get(`${l.to}->${l.from}`);
    if (j !== undefined) err(at('links', i), `links "${links[j]!.id}" and "${l.id}" both join "${l.from}" to "${l.to}": one wire drawn over another`, 'keep one link per pair (put both labels in one)');
    else byPair.set(k, i);
    if (back !== undefined) warn(at('links', i), `links "${links[back]!.id}" and "${l.id}" join "${l.from}" and "${l.to}" both ways: their wires overlap`, 'draw one link, or route the two through different elements');
  });
  links.forEach((l, i) => {
    unknownEl(at('links', i, 'from'), l.from);
    unknownEl(at('links', i, 'to'), l.to);
    if (l.from === l.to && typeof l.from === 'string') warn(at('links', i), `link "${l.id}" goes from "${l.from}" to itself (not drawn)`);
  });

  // ---- free layout needs positions
  const layoutsUsed = [s.layout, ...steps.map((st) => st?.layout)].filter(Boolean);
  if (layoutsUsed.some((l) => l!.kind === 'free')) s.elements.forEach((e, i) => {
    if (typeof e.at?.x !== 'number' || typeof e.at?.y !== 'number') warn(at('elements', i, 'at'), `"${e.id}" has no at.x / at.y for the free layout`, 'it is placed in reading order after the positioned ones');
  });

  // ---- steps: references
  steps.forEach((st, i) => {
    if (!st || typeof st !== 'object') return;
    const p = (k: string, j?: number) => (j === undefined ? at('steps', i, k) : at('steps', i, k, j));
    for (const k of ['show', 'add', 'hide', 'emphasize', 'dim'] as const) {
      const v = st[k];
      if (Array.isArray(v)) v.forEach((id, j) => {
        const pp = (k === 'emphasize' || k === 'dim') ? parsePart(id) : null;
        if (!pp) { unknownEl(p(k, j), id); return; }
        if (unknownEl(p(k, j), pp[0])) return;
        const el = s.elements.find((e) => e.id === pp[0])!, c = lib.components[el.type];
        if (c && !chartKindOf(c.template)) err(p(k, j), `"${pp[0]}" is a ${el.type}: only charts have parts ("${id}")`, `${k} the whole element: "${pp[0]}"`);
      });
    }
    if (typeof st.focus === 'string' && !groupIds.has(st.focus)) unknownEl(p('focus'), st.focus, 'element or group');
    if (st.set && typeof st.set === 'object') for (const id of Object.keys(st.set)) unknownEl(at('steps', i, 'set', id), id);
    arr(st.connect).forEach((c, j) => {
      if (typeof c !== 'string' || linkIds.has(c)) return;
      const ab = parseArrow(c);
      if (!ab) { const near = nearest(c, linkIds); err(p('connect', j), `unknown link "${c}"`, near ? `did you mean "${near}"?` : 'name a link id, or connect two elements ad hoc with "a->b"'); return; }
      unknownEl(p('connect', j), ab[0]); unknownEl(p('connect', j), ab[1]);
    });
  });

  // ---- steps: what each one resolves to
  let resolved;
  try { resolved = resolveSteps(s); } catch (e) { err('/steps', `could not resolve steps: ${e instanceof Error ? e.message : String(e)}`); return issues; }
  const everVisible = new Set<string>();
  const everDrawn = new Set<string>();
  const byId = new Map(resolved.links.map((l) => [l.id, l]));
  resolved.steps.forEach((r, i) => {
    r.visible.forEach((x) => everVisible.add(x));
    r.links.forEach((x) => everDrawn.add(x));
    const st = steps[i];
    if (!st) return;
    if (r.visible.size === 0) warn(at('steps', i), `step ${i + 1} shows nothing`);
    arr(st.emphasize).forEach((id, j) => { if (elIds.has(id) && !r.visible.has(id)) warn(at('steps', i, 'emphasize', j), `"${id}" is emphasized but hidden in step ${i + 1}`, `add it: "add": ["${id}"]`); });
    if (Array.isArray(st.dim)) st.dim.forEach((id, j) => { if (elIds.has(id) && !r.visible.has(id)) warn(at('steps', i, 'dim', j), `"${id}" is dimmed but hidden in step ${i + 1}`); });
    if (typeof st.focus === 'string' && elIds.has(st.focus) && !r.visible.has(st.focus)) warn(at('steps', i, 'focus'), `the camera focuses "${st.focus}", which is hidden in step ${i + 1}`);
    arr(st.connect).forEach((c, j) => {
      const ab = typeof c === 'string' ? parseArrow(c) : null;
      const l = byId.get(c) ?? (ab ? resolved.links.find((x) => x.from === ab[0] && x.to === ab[1]) : undefined);
      if (!l) return;
      const gone = [l.from, l.to].filter((x) => elIds.has(x) && !r.visible.has(x));
      if (gone.length) warn(at('steps', i, 'connect', j), `link "${c}" ends at hidden element${gone.length > 1 ? 's' : ''} ${gone.map((g) => `"${g}"`).join(' and ')} in step ${i + 1}`, `show ${gone.length > 1 ? 'them' : 'it'} ("add") or drop the link from "connect"`);
    });
    for (const k of ['emphasize', 'dim'] as const) arr(Array.isArray(st[k]) ? st[k] as string[] : []).forEach((t, j) => {
      const pp = parsePart(t), el = pp && s.elements.find((e) => e.id === pp[0]), c = el && lib.components[el.type], kind = chartKindOf(c?.template);
      if (!pp || !el || !c || !kind) return;
      if (!r.visible.has(el.id)) { warn(at('steps', i, k, j), `"${el.id}" is hidden in step ${i + 1}, so "${t}" does nothing`, `add it: "add": ["${el.id}"]`); return; }
      const why = partProblem(kind, withDefaults(c.meta.props, r.props[el.id]), pp[1]);
      if (why) err(at('steps', i, k, j), `${el.type} "${el.id}" in step ${i + 1}: ${why}`);
    });
    if (st.set && typeof st.set === 'object') for (const [id, ch] of Object.entries(st.set)) {
      const el = s.elements.find((e) => e.id === id), c = el && lib.components[el.type];
      if (!c || !ch || typeof ch !== 'object') continue;
      const kind = chartKindOf(c.template);
      if (kind && !checkSchema(r.props[id], c.meta.props as never).length) {
        const before = new Set(chartIssues(kind, withDefaults(c.meta.props, el.props ?? {}), catIdList).map((x) => x.path + x.message));
        for (const ci of chartIssues(kind, withDefaults(c.meta.props, r.props[id]), catIdList)) if (!before.has(ci.path + ci.message)) err(at('steps', i, 'set', id) + ci.path, `${el.type}: after this step's set, ${ci.message}`, ci.hint);
      }
      for (const pe of checkSchema(r.props[id], c.meta.props as never)) {
        const key = pe.path.split('/')[1];
        err(key && key in ch ? at('steps', i, 'set', id) + pe.path : at('steps', i, 'set', id), `${el.type}: after this step's set, ${pe.path ? `props${pe.path}` : 'props'} ${pe.message}`, pe.hint);
      }
    }
  });
  s.elements.forEach((e, i) => { if (!everVisible.has(e.id)) warn(at('elements', i), `"${e.id}" is never visible in any step`); });
  links.forEach((l, i) => { if (l.from !== l.to && elIds.has(l.from) && elIds.has(l.to) && !everDrawn.has(l.id)) warn(at('links', i), `link "${l.id}" is never drawn (its ends are never visible together, or steps "connect" others)`); });
  return issues;
}

function safeTween(tpl: string) { try { return tweenProps(tpl); } catch { return []; } }
