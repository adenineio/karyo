// Explainer core (src/explainer/): template language, validator, library resolution/shadowing,
// bundling (images inlined), step resolution and layouts. Run: `just explainer-test`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderTemplate, parseTemplate, tweenProps, scopeCss, sanitizeSvg, mdLite, cssProblems } from '../src/explainer/template';
import { validateSpec } from '../src/explainer/validate';
import { loadLibrary, scaffoldComponent, BUILTIN_DIR } from '../src/explainer/library';
import { bundleSpec } from '../src/explainer/bundle';
import { resolveSteps } from '../src/explainer/resolve';
import { layoutBoard } from '../src/explainer/layout';
import { BUILTINS, type ExplainerSpec, type Issue } from '../src/explainer/types';
import { highlight } from '../src/model/tour';

// a tiny spec over four built-ins (card, metric, bar, callout), written to the temp folder for bundling
const SAMPLE_SPEC = {
  karyo: 'explainer/1', id: 'sample', title: 'A queue drains', summary: 'Jobs arrive, a worker takes them, the backlog shrinks.',
  layout: { kind: 'flow', direction: 'right', gap: 48 },
  elements: [
    { id: 'jobs', type: 'card', props: { kicker: 'In', title: 'Jobs arrive', body: 'Ten a minute.' } },
    { id: 'worker', type: 'metric', props: { label: 'Handled per minute', value: 12 } },
    { id: 'backlog', type: 'bar', props: { label: 'Backlog', value: 40, max: 100 } },
    { id: 'note', type: 'callout', props: { tone: 'note', title: 'Why it drains', md: 'The worker is faster than the arrivals.' } },
  ],
  links: [{ id: 'jobs-worker', from: 'jobs', to: 'worker' }, { id: 'worker-backlog', from: 'worker', to: 'backlog' }],
  steps: [
    { title: 'Jobs arrive', text: 'Ten a minute.', show: ['jobs'] },
    { title: 'A worker takes them', text: 'Twelve a minute.', add: ['worker'] },
    { title: 'The backlog shrinks', text: 'Two a minute, net.', add: ['backlog'], set: { backlog: { value: 20 } } },
    { title: 'Why', text: 'Faster out than in.', show: '*' },
  ],
};
let tmp = '', SAMPLE = '';
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'karyo-explainer-'));
  SAMPLE = join(tmp, 'sample.explainer.json');
  await writeFile(SAMPLE, JSON.stringify(SAMPLE_SPEC));
});
afterAll(async () => { if (tmp) await rm(tmp, { recursive: true, force: true }); });

const lib = await loadLibrary({ env: '', adenineDir: '/nonexistent-karyo-adenine' });
const base = (over: Partial<ExplainerSpec> = {}): ExplainerSpec => ({
  karyo: 'explainer/1', id: 't', title: 'T',
  elements: [
    { id: 'a', type: 'card', props: { title: 'A' } },
    { id: 'b', type: 'metric', props: { label: 'B', value: 1 } },
  ],
  ...over,
});
const find = (issues: Issue[], level: 'error' | 'warn', path: string, re: RegExp) => issues.find((i) => i.level === level && i.path === path && re.test(i.message));

// ------------------------------------------------------------------ template
describe('template', () => {
  test('escapes {{x}}, formats {{{x}}} as markdown-lite', () => {
    expect(renderTemplate('<b>{{t}}</b>', { t: '<i>&"x"' })).toBe('<b>&lt;i&gt;&amp;&quot;x&quot;</b>');
    expect(renderTemplate('{{{m}}}', { m: 'a **b** `<c>`\n\n- one\n- *two*' })).toBe('<p>a <b>b</b> <code>&lt;c&gt;</code></p><ul><li>one</li><li><i>two</i></li></ul>');
    expect(renderTemplate('{{{m}}}', { m: '<script>x</script>' })).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>');
    expect(mdLite('[ok](https://x.dev) [bad](javascript:alert(1))')).toContain('<a href="https://x.dev">ok</a>');
    expect(mdLite('[bad](javascript:alert(1))')).not.toContain('<a');
  });
  test('each with this, this.x, @index, @number, nested and outer lookup', () => {
    expect(renderTemplate('{{#each xs}}[{{@index}}{{this}}]{{/each}}', { xs: ['a', 'b'] })).toBe('[0a][1b]');
    expect(renderTemplate('{{#each ps}}{{this.k}}={{v}}{{sep}};{{/each}}', { sep: '!', ps: [{ k: 'x', v: 1 }, { k: 'y', v: 2 }] })).toBe('x=1!;y=2!;');
    expect(renderTemplate('{{#each rows}}<tr>{{#each this}}<td>{{this}}</td>{{/each}}</tr>{{/each}}', { rows: [[1, 2], [3]] })).toBe('<tr><td>1</td><td>2</td></tr><tr><td>3</td></tr>');
    expect(renderTemplate('{{#each xs}}{{@number}}{{/each}}', { xs: [0, 0, 0] })).toBe('123');
  });
  test('if / else / unless, truthiness', () => {
    const t = '{{#if x}}yes{{else}}no{{/if}}';
    expect(renderTemplate(t, { x: 1 })).toBe('yes');
    for (const x of [0, '', null, undefined, false, []]) expect(renderTemplate(t, { x })).toBe('no');
    expect(renderTemplate('{{#unless x}}u{{/unless}}', {})).toBe('u');
    expect(renderTemplate('{{a.b}}|{{xs}}|{{o}}', { a: { b: 'deep' }, xs: [1, 2], o: { z: 1 } })).toBe('deep|1, 2|');
  });
  test('malformed templates throw with a line number', () => {
    expect(() => parseTemplate('{{#if x}}\nopen')).toThrow(/line 1: .*never closed/);
    expect(() => parseTemplate('a\n{{else}}')).toThrow(/line 2: \{\{else\}\} outside/);
    expect(() => parseTemplate('{{#each x}}{{/if}}')).toThrow(/without a matching/);
    expect(() => parseTemplate('{{foo bar}}')).toThrow(/unknown tag/);
  });
  test('svg is sanitized', () => {
    const s = sanitizeSvg('<svg onload="x()"><script>bad()</script><a href="javascript:x"><path data-k-draw d="M0 0"/></a><foreignObject><div/></foreignObject></svg>');
    expect(s).not.toMatch(/onload|script|foreignObject|javascript:/);
    expect(s).toContain('data-k-draw');
    expect(sanitizeSvg('<img src=x onerror=alert(1)>')).toBe('');
    expect(renderTemplate('{{svg s}}', { s: '<svg><circle r="1"/></svg>' })).toBe('<svg><circle r="1"/></svg>');
  });
  test('tweened props and scoped css', () => {
    expect(tweenProps('<b data-k-num="value">{{value}}</b><i data-k-scale="value/max"></i><i data-k-scale="n/100"></i>').sort()).toEqual(['max', 'n', 'value']);
    const css = scopeCss(':host { display: block }\n.a, p > b { color: var(--pl-fg) }\n:host(.is-lit) .a { x: 1 }\n&:hover .b { y: 2 }\n@media (min-width: 1px) { .c { z: 3 } }\n@keyframes k { from { a: 1 } }\n@import "x.css";', 'gauge');
    expect(css).toContain('.kc-gauge {');
    expect(css).toContain('.kc-gauge .a, .kc-gauge p > b {');
    expect(css).toContain('.kc-gauge.is-lit .a {');
    expect(css).toContain('.kc-gauge:hover .b {');
    expect(css).toMatch(/@media \(min-width: 1px\) \{\n\.kc-gauge \.c \{/);
    expect(css).not.toContain('keyframes');
    expect(css).not.toContain('@import');
    expect(cssProblems('.a { transition: all 1s; color: #fff }')).toHaveLength(2);
  });
  test('every built-in renders its example', () => {
    for (const name of BUILTINS) {
      const c = lib.components[name];
      expect(c, name).toBeDefined();
      expect(c!.source).toBe('builtin');
      expect(() => renderTemplate(c!.template, (c!.meta.example ?? {}) as Record<string, unknown>)).not.toThrow();
      expect(cssProblems(c!.css), name).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------ validator
describe('validateSpec', () => {
  test('the sample is clean', async () => {
    expect(validateSpec(JSON.parse(await readFile(SAMPLE, 'utf8')), lib)).toEqual([]);
  });
  test('not an object / schema errors (JSON pointers, hints)', () => {
    expect(validateSpec([], lib)[0]!.level).toBe('error');
    const issues = validateSpec({ ...base(), karyo: 'explainer/2', narration: 'sid', extra: 1 } as unknown, lib);
    expect(find(issues, 'error', '/karyo', /must be "explainer\/1"/)).toBeDefined();
    expect(find(issues, 'error', '/narration', /one of/)?.hint).toContain('side');
    expect(find(issues, 'error', '/extra', /unknown property/)).toBeDefined();
    expect(find(validateSpec({ karyo: 'explainer/1', id: 't', title: 'T' }, lib), 'error', '/elements', /required/)).toBeDefined();
  });
  test('unknown component type, with a did-you-mean', () => {
    const i = validateSpec(base({ elements: [{ id: 'a', type: 'crad', props: { title: 'x' } }] }), lib);
    expect(find(i, 'error', '/elements/0/type', /unknown component "crad"/)?.hint).toContain('"card"');
  });
  test('props invalid against the component schema', () => {
    const i = validateSpec(base({ elements: [{ id: 'a', type: 'card', props: { body: 'x', titel: 'y' } }, { id: 'b', type: 'metric', props: { label: 'x', value: 'no' } }] }), lib);
    expect(find(i, 'error', '/elements/0/props/title', /required/)).toBeDefined();
    expect(find(i, 'error', '/elements/0/props/titel', /unknown property/)?.hint).toContain('"title"');
    expect(find(i, 'error', '/elements/1/props/value', /must be number/)).toBeDefined();
    expect(find(i, 'warn', '/elements/1/props/value', /counts "value"/)).toBeDefined();
  });
  test('duplicate ids', () => {
    const i = validateSpec(base({ elements: [{ id: 'a', type: 'card', props: { title: 'x' } }, { id: 'a', type: 'card', props: { title: 'y' } }], links: [{ id: 'l', from: 'a', to: 'a' }, { id: 'l', from: 'a', to: 'a' }] }), lib);
    expect(find(i, 'error', '/elements/1/id', /duplicate id "a"/)).toBeDefined();
    expect(find(i, 'error', '/links/1/id', /duplicate id "l"/)).toBeDefined();
  });
  test('unknown ids in steps, links, groups, focus, set, connect', () => {
    const i = validateSpec(base({
      links: [{ id: 'l1', from: 'a', to: 'zz' }],
      elements: [{ id: 'a', type: 'card', group: 'gx', props: { title: 'A' } }, { id: 'b', type: 'metric', props: { label: 'B', value: 1 } }],
      steps: [{ show: ['a', 'q'], emphasize: ['bb'], focus: 'nope', set: { ghost: { value: 2 } }, connect: ['l9', 'a->x'] }],
    }), lib);
    expect(find(i, 'error', '/links/0/to', /unknown element "zz"/)).toBeDefined();
    expect(find(i, 'error', '/elements/0/group', /unknown group "gx"/)).toBeDefined();
    expect(find(i, 'error', '/steps/0/show/1', /unknown element "q"/)).toBeDefined();
    expect(find(i, 'error', '/steps/0/emphasize/0', /unknown element "bb"/)?.hint).toContain('"b"');
    expect(find(i, 'error', '/steps/0/focus', /unknown element or group "nope"/)).toBeDefined();
    expect(find(i, 'error', '/steps/0/set/ghost', /unknown element "ghost"/)).toBeDefined();
    expect(find(i, 'error', '/steps/0/connect/0', /unknown link "l9"/)).toBeDefined();
    expect(find(i, 'error', '/steps/0/connect/1', /unknown element "x"/)).toBeDefined();
  });
  test('set is checked against the component schema', () => {
    const i = validateSpec(base({ steps: [{}, { set: { b: { value: 'lots' } } }] }), lib);
    expect(find(i, 'error', '/steps/1/set/b/value', /must be number/)).toBeDefined();
  });
  test('links to hidden elements, emphasized hidden, never visible, never drawn', () => {
    const i = validateSpec(base({
      elements: [{ id: 'a', type: 'card', props: { title: 'A' } }, { id: 'b', type: 'card', props: { title: 'B' } }, { id: 'c', type: 'card', props: { title: 'C' } }],
      links: [{ id: 'ab', from: 'a', to: 'b' }, { id: 'ac', from: 'a', to: 'c' }],
      steps: [{ show: ['a'], emphasize: ['b'], connect: ['ab'] }, { add: ['b'] }],
    }), lib);
    expect(find(i, 'warn', '/steps/0/connect/0', /ends at hidden element "b"/)).toBeDefined();
    expect(find(i, 'warn', '/steps/0/emphasize/0', /hidden in step 1/)).toBeDefined();
    expect(find(i, 'warn', '/elements/2', /never visible/)).toBeDefined();
    expect(find(i, 'warn', '/links/1', /never drawn/)).toBeDefined();
  });
  test('uses: missing custom component, unknown and unused entries', () => {
    const custom = { components: { ...lib.components, gauge: { meta: { name: 'gauge', description: '', version: '1', props: { type: 'object' } }, template: '<i></i>', css: '', source: 'project' as const } } };
    const i = validateSpec(base({ elements: [{ id: 'g', type: 'gauge' }], uses: ['card', 'nothing'] }), custom);
    expect(find(i, 'warn', '/uses', /"gauge" is not listed in "uses"/)).toBeDefined();
    expect(find(i, 'error', '/uses/1', /unknown component "nothing"/)).toBeDefined();
    expect(find(i, 'warn', '/uses/0', /no element uses it/)).toBeDefined();
    expect(validateSpec(base({ elements: [{ id: 'g', type: 'gauge' }], uses: ['gauge'] }), custom)).toEqual([]);
  });
  test('a broken component template is reported', () => {
    const custom = { components: { bad: { meta: { name: 'bad', description: '', version: '1', props: { type: 'object' } }, template: '{{#if x}}', css: '.a { transition: none }' } } };
    const i = validateSpec(base({ elements: [{ id: 'x', type: 'bad' }], uses: ['bad'] }), custom);
    expect(find(i, 'error', '/elements/0/type', /broken template/)).toBeDefined();
    expect(find(i, 'warn', '/elements/0/type', /transition/)).toBeDefined();
  });
});

// ------------------------------------------------------------------ library
describe('library', () => {
  test('resolution order and shadowing: project → extra → env → adenine → builtin', async () => {
    const mk = async (dir: string, name: string, desc: string) => {
      await mkdir(join(dir, name), { recursive: true });
      await writeFile(join(dir, name, 'component.json'), JSON.stringify({ name, description: desc, version: '1.0.0', props: { type: 'object' } }));
      await writeFile(join(dir, name, 'template.html'), `<b>${desc}</b>`);
    };
    const spec = join(tmp, 'lib/spec'), extra = join(tmp, 'lib/extra'), env1 = join(tmp, 'lib/env1'), env2 = join(tmp, 'lib/env2'), ad = join(tmp, 'lib/adenine');
    await mk(join(spec, 'components'), 'card', 'project card');
    await mk(extra, 'pill', 'extra pill');
    await mk(env1, 'gauge', 'env1 gauge');
    await mk(env2, 'gauge', 'env2 gauge');
    await mk(env2, 'meter', 'env2 meter');
    await mk(ad, 'meter', 'adenine meter');
    await mk(ad, 'dial', 'adenine dial');
    await mkdir(join(ad, 'broken'), { recursive: true });
    await writeFile(join(ad, 'broken', 'component.json'), '{ nope');
    const l = await loadLibrary({ specDir: spec, extra: [extra], env: `${env1}:${env2}`, adenineDir: ad });
    expect(l.components.card!.source).toBe('project');
    expect(l.components.card!.meta.description).toBe('project card');
    expect(l.components.pill!.source).toBe('project');
    expect(l.components.gauge!.meta.description).toBe('env1 gauge');
    expect(l.components.meter!.source).toBe('env');
    expect(l.components.dial!.source).toBe('adenine');
    expect(l.components.metric!.source).toBe('builtin');
    expect(l.components.broken).toBeUndefined();
    expect(l.problems.some((p) => p.dir.endsWith('broken') && /component.json/.test(p.message))).toBe(true);
    const sh = Object.fromEntries(l.shadowed.map((s) => [s.name, s]));
    expect(sh.card!.used.source).toBe('project');
    expect(sh.card!.hidden.map((h) => h.source)).toEqual(['builtin']);
    expect(sh.gauge!.hidden.map((h) => h.dir)).toEqual([join(env2, 'gauge')]);
    expect(sh.meter!.hidden.map((h) => h.source)).toEqual(['adenine']);
    expect(l.searched.map((s) => s.source)).toEqual(['project', 'project', 'env', 'env', 'adenine', 'builtin']);
    expect(l.searched.at(-1)!.dir).toBe(BUILTIN_DIR);
  });
  test('scaffoldComponent writes a working starter', async () => {
    const dir = join(tmp, 'scaffold');
    const at = await scaffoldComponent(dir, 'rate-dial');
    const l = await loadLibrary({ extra: [dir], env: '', adenineDir: '/nonexistent-karyo-adenine' });
    const c = l.components['rate-dial']!;
    expect(c.dir).toBe(at);
    expect(renderTemplate(c.template, c.meta.example as Record<string, unknown>)).toContain('data-k-num="value"');
    expect(cssProblems(c.css)).toEqual([]);
    const spec = base({ uses: ['rate-dial'], elements: [{ id: 'g', type: 'rate-dial', props: c.meta.example as Record<string, unknown> }] });
    expect(validateSpec(spec, l)).toEqual([]);
    await expect(scaffoldComponent(dir, 'rate-dial')).rejects.toThrow(/exists/);
    await expect(scaffoldComponent(dir, 'Bad Name')).rejects.toThrow(/lowercase/);
  });
});

// ------------------------------------------------------------------ bundle
describe('bundleSpec', () => {
  test('inlines images under the spec folder, only used components, reports image problems', async () => {
    const dir = join(tmp, 'bundle');
    await mkdir(join(dir, 'img'), { recursive: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    await writeFile(join(dir, 'img', 'dot.png'), png);
    await writeFile(join(tmp, 'outside.png'), png);
    const spec: ExplainerSpec = base({
      elements: [
        { id: 'pic', type: 'image', props: { src: 'img/dot.png', alt: 'a dot' } },
        { id: 'fig', type: 'figure', props: { src: 'img/missing.png' } },
        { id: 'out', type: 'image', props: { src: '../outside.png', alt: 'x' } },
      ],
      steps: [{}, { set: { pic: { src: 'img/dot.png' } } }],
    });
    await writeFile(join(dir, 'x.explainer.json'), JSON.stringify(spec));
    const b = await bundleSpec(join(dir, 'x.explainer.json'), { env: '', adenineDir: '/nonexistent-karyo-adenine' });
    expect(Object.keys(b.components).sort()).toEqual(['figure', 'image']);
    const src = b.spec.elements[0]!.props!.src as string;
    expect(src.startsWith('data:image/png;base64,')).toBe(true);
    expect(Buffer.from(src.split(',')[1]!, 'base64').equals(png)).toBe(true);
    expect((b.spec.steps![1]!.set!.pic!.src as string).startsWith('data:image/png')).toBe(true);
    expect(find(b.issues, 'error', '/elements/1/props/src', /file not found/)).toBeDefined();
    expect(find(b.issues, 'error', '/elements/2/props/src', /outside the spec's folder/)).toBeDefined();
  });
  test('a file name in text is text: only props a component declares as images are inlined', async () => {
    const dir = join(tmp, 'bundle-text');
    await mkdir(dir, { recursive: true });
    const spec: ExplainerSpec = base({
      elements: [
        { id: 'c', type: 'card', props: { title: 'IMG_2207.png', body: 'holiday.jpg' } },
        { id: 'l', type: 'list', props: { items: ['photo.png', 'notes.txt'] } },
      ],
      steps: [{}, { set: { c: { title: 'scan.webp' } } }],
    });
    await writeFile(join(dir, 'x.explainer.json'), JSON.stringify(spec));
    const b = await bundleSpec(join(dir, 'x.explainer.json'), { env: '', adenineDir: '/nonexistent-karyo-adenine' });
    expect(b.issues.filter((i) => /image/.test(i.message))).toEqual([]);
    expect(b.spec.elements[0]!.props!.title).toBe('IMG_2207.png');
    expect(b.spec.elements[1]!.props!.items).toEqual(['photo.png', 'notes.txt']);
    expect(b.spec.steps![1]!.set!.c!.title).toBe('scan.webp');
  });
  test('the sample bundles clean; bad JSON is an issue, not a throw', async () => {
    const b = await bundleSpec(SAMPLE);
    expect(b.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(Object.keys(b.components).sort()).toEqual(['bar', 'callout', 'card', 'metric']);
    await writeFile(join(tmp, 'bad.json'), '{ nope');
    expect((await bundleSpec(join(tmp, 'bad.json'))).issues[0]!.message).toMatch(/not valid JSON/);
  });
});

// ------------------------------------------------------------------ steps & layout
describe('resolveSteps and layoutBoard', () => {
  test('visible sets inherit, set is cumulative, default links, ad-hoc links', () => {
    const r = resolveSteps(base({
      elements: [{ id: 'a', type: 'card' }, { id: 'b', type: 'metric', props: { value: 1 } }, { id: 'c', type: 'card' }],
      links: [{ id: 'ab', from: 'a', to: 'b' }, { id: 'bc', from: 'b', to: 'c' }],
      steps: [{ show: ['a', 'b'], set: { b: { value: 2 } } }, { add: ['c'], dim: 'others', emphasize: ['c'] }, { hide: ['a'], connect: ['c->a'], focus: 'c' }],
    }));
    expect([...r.steps[0]!.visible]).toEqual(['a', 'b']);
    expect(r.steps[0]!.links).toEqual(['ab']);
    expect([...r.steps[1]!.visible].sort()).toEqual(['a', 'b', 'c']);
    expect([...r.steps[1]!.dim].sort()).toEqual(['a', 'b']);
    expect(r.steps[1]!.links).toEqual(['ab', 'bc']);
    expect(r.steps[1]!.props.b!.value).toBe(2);
    expect([...r.steps[2]!.visible].sort()).toEqual(['b', 'c']);
    expect(r.steps[2]!.links).toEqual(['c->a']);
    expect(r.links.find((l) => l.id === 'c->a')).toEqual({ id: 'c->a', from: 'c', to: 'a' });
    expect(r.steps[2]!.focus).toBe('c');
  });
  test('a link is its ordered pair: ad-hoc "a->b" is the spec link on that pair, any spacing, never a second wire', () => {
    const r = resolveSteps(base({
      links: [{ id: 'ab', from: 'a', to: 'b', label: 'asks' }],
      steps: [{ connect: ['a->b'] }, { connect: ['a -> b', 'ab'] }, { connect: ['b->a'] }, { connect: ['b -> a'] }],
    }));
    expect(r.steps.map((s) => s.links)).toEqual([['ab'], ['ab'], ['b->a'], ['b->a']]);
    expect(r.links.map((l) => l.id)).toEqual(['ab', 'b->a']);
  });
  test('two links on one pair are an error; both directions a warning', () => {
    const issues = validateSpec(base({ links: [{ id: 'x', from: 'a', to: 'b' }, { id: 'y', from: 'a', to: 'b' }, { id: 'z', from: 'b', to: 'a' }] }), lib);
    expect(find(issues, 'error', '/links/1', /both join "a" to "b"/)).toBeTruthy();
    expect(find(issues, 'warn', '/links/2', /both ways/)).toBeTruthy();
  });
  test('no steps: one step showing everything', () => {
    const r = resolveSteps(base());
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.visible.size).toBe(2);
  });
  test('grid, stack, graph and free layouts place without overlaps', () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => ({ id, w: 100, h: 50 }));
    const overlaps = (p: Map<string, { x: number; y: number }>) => items.some((i, k) => items.slice(k + 1).some((j) => {
      const a = p.get(i.id)!, b = p.get(j.id)!;
      return a.x < b.x + j.w && b.x < a.x + i.w && a.y < b.y + j.h && b.y < a.y + i.h;
    }));
    const view = { w: 1000, h: 600 };
    const g = layoutBoard(items, { kind: 'grid', columns: 2, gap: 10 }, [], view);
    expect(g.get('b')).toEqual({ x: 110, y: 0 });
    expect(g.get('c')).toEqual({ x: 0, y: 60 });
    const s = layoutBoard(items, { kind: 'stack', direction: 'down', gap: 10 }, [], view);
    expect(s.get('d')!.y).toBe(180);
    const gr = layoutBoard(items, { kind: 'graph' }, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'd' }], view);
    expect(gr.get('a')!.x).toBeLessThan(gr.get('b')!.x);
    expect(gr.get('b')!.x).toBeLessThan(gr.get('c')!.x);
    expect(gr.get('b')!.x).toBe(gr.get('d')!.x);
    const fl = layoutBoard(items, { kind: 'flow', gap: 10 }, [], { w: 250, h: 600 });
    for (const p of [g, s, gr, fl]) expect(overlaps(p)).toBe(false);
    const fr = layoutBoard([{ id: 'x', w: 10, h: 10, at: { x: 5, y: 7 } }, { id: 'y', w: 10, h: 10 }], { kind: 'free' }, [], view);
    expect(fr.get('x')).toEqual({ x: 5, y: 7 });
    expect(fr.get('y')!.y).toBeGreaterThan(17);
  });
});

// ------------------------------------------------------------------ footer note
describe('note', () => {
  test('an optional string, checked by the validator', () => {
    expect(validateSpec(base({ note: 'Names here are **made-up examples**.' }), lib).filter((i) => i.level === 'error')).toEqual([]);
    expect(validateSpec(base({ note: 3 as unknown as string }), lib).some((i) => i.path === '/note')).toBe(true);
  });
});

// ------------------------------------------------------------------ code tint
describe('highlight', () => {
  const spans = (h: string, cls: string) => [...h.matchAll(new RegExp(`<span class="${cls}">([^<]*)</span>`, 'g'))].map((m) => m[1]);
  test('sh: # comments at a word start, quotes, $variables and {{just}} variables, reserved words only as words', () => {
    const [a, b, c, d] = highlight(['# this one isn\'t code', 'for f in *.txt; do echo "$f" ${#f} $1; done # n', 'out=dist/x#y {{target}}', 'make-it done-ish'], 'just');
    expect(a!.startsWith('<span class="tok-c">#')).toBe(true);
    expect(a).not.toContain('tok-k');
    expect(spans(b!, 'tok-k')).toEqual(['for', 'in', 'do', 'done']);
    expect(spans(b!, 'tok-v')).toEqual(['${#f}', '$1']);
    expect(spans(b!, 'tok-c')).toEqual(['# n']);
    expect(c).not.toContain('tok-c');
    expect(spans(c!, 'tok-v')).toEqual(['{{target}}']);
    expect(d).not.toContain('tok-k');
  });
  test('text: no tint at all', () => {
    expect(highlight(['const x = "a" // this'], 'text')).toEqual(['const x = &quot;a&quot; // this']);
  });
});
