// The project view (project.html, started by `karyo view`): whatever the project has for Karyo to draw, read from
// the dev server's /__karyo/project index (src/project/files.ts):
//   a model   → its structure board (Bench, Splice: splices save to the project's karyo/splices/), each recorded flow
//               as a trace board, each tour as a tour plate
//   explainer → a link to explain.html with that spec
//   kit plates → every plate type the project's kits (and the shared and built-in ones) offer: one per model, flow or
//               tour, as the type says (docs/KITS.md)
// The hash picks what is shown: #board=<model>, #flow=<model>::<flow id>, #tour=<model>::<tour id>,
// #plate=<model>::<plate type>::<flow or tour id, or empty>.
//   ?theme=<id> (src/engine/theme-pick.ts), &mode=dark|light as on the gallery; otherwise the stored pick, else adenine.
import '../kits/boot';   // first: the page's kits (the project's own first, in project mode; docs/KITS.md)
import { mount, type Stage, type SceneClass } from '../engine';
import { boardScene, type TeamLayout } from '../model/board';
import { traceBoard } from '../model/flowboard';
import { tourScene } from '../model/tour';
import { defaultKits } from '../kits/registry';
import { kitPlate } from '../kits/plates';
import type { Model } from '../model/model';
import type { ProjectIndex, ProjectModel } from './files';
import { initTheme, themePicker } from '../engine/theme-pick';

const q = new URLSearchParams(location.search);
initTheme(q);

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const status = (s: string, err = false) => { const e = $('status'); e.textContent = s; e.className = err ? 'err' : ''; };

let stage: Stage | null = null;
const models = new Map<string, { model: Model; layout?: TeamLayout }>();

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  const j = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
  if (!r.ok) throw new Error(j?.error ?? `${r.status}`);
  return j as T;
}

async function loadModel(m: ProjectModel) {
  if (!models.has(m.rel)) {
    const model = await getJson<Model>(`/__karyo/project/json?rel=${encodeURIComponent(m.rel)}`);
    const layout = m.layout ? await getJson<TeamLayout>(`/__karyo/project/json?rel=${encodeURIComponent(m.layout)}`).catch(() => undefined) : undefined;
    models.set(m.rel, { model, layout });
  }
  return models.get(m.rel)!;
}

function items(idx: ProjectIndex): { hash: string; kind: string; title: string; meta: string; href?: string }[] {
  const out: { hash: string; kind: string; title: string; meta: string; href?: string }[] = [];
  const many = idx.models.length > 1;
  for (const m of idx.models) {
    const where = many ? ` · ${m.rel}` : '';
    out.push({ hash: `board=${m.rel}`, kind: 'structure', title: m.title, meta: `${plural(m.nodes, 'node')}, ${plural(m.edges, 'wire')}${m.checks ? `, ${plural(m.checks, 'check')}` : ''}${where}` });
    for (const f of m.flows) if (f.spans) out.push({ hash: `flow=${m.rel}::${f.id}`, kind: 'flow', title: f.title, meta: `${plural(f.spans, 'span')} recorded${where}` });
    // kit plate types (docs/KITS.md): per model, or per recorded flow; per-tour ones are listed with the tours
    for (const p of defaultKits().plates) {
      if (p.from === 'model') out.push({ hash: `plate=${m.rel}::${p.id}::`, kind: p.title.toLowerCase(), title: m.title, meta: `${p.description}${where}` });
      else if (p.from === 'flow') for (const f of m.flows) if (f.spans) out.push({ hash: `plate=${m.rel}::${p.id}::${f.id}`, kind: p.title.toLowerCase(), title: f.title, meta: `${plural(f.spans, 'call')} · kit ${p.kit}${where}` });
    }
    // tours are listed by the model file (their ids live in it); fetched lazily with the model
  }
  for (const e of idx.explainers) out.push({ hash: '', kind: 'explainer', title: e.title, meta: `${plural(e.steps, 'step')} · ${e.rel}`, href: `/explain.html?spec=${encodeURIComponent(e.abs)}` });
  return out;
}

function renderNav(idx: ProjectIndex, current: string) {
  $('items').innerHTML = items(idx).map((it) => {
    const href = it.href ?? `#${encodeURIComponent(it.hash)}`;
    return `<a href="${esc(href)}"${it.hash && it.hash === current ? ' aria-current="true"' : ''}><span class="k">${esc(it.kind)}</span><span class="t">${esc(it.title)}</span><span class="m">${esc(it.meta)}</span></a>`;
  }).join('');
}

function emptyState(idx: ProjectIndex) {
  $('plate').innerHTML = `<div class="empty">
    <h2>Nothing for Karyo to draw yet</h2>
    <p>Karyo draws a project from a model file (<code>karyo.model.json</code>) and from explainer specs (<code>*.explainer.json</code>). This project has neither${idx.fragments.length ? `, but it has ${plural(idx.fragments.length, 'fragment')} in <code>.karyo/</code>` : ''}.</p>
    ${idx.fragments.length ? '<p>Merge the fragments into a model:</p><pre>karyo model build</pre>' : ''}
    <p>Describe the code with <code># karyo:node</code> directives (docs/MODEL.md), then:</p>
    <pre>karyo model scan        # reads the directives, writes karyo.model.json</pre>
    <p>Or start an explainer of anything:</p>
    <pre>karyo new my-topic --title "How X works"</pre>
    <p>Reload this page when the files exist.</p></div>`;
}

async function show(idx: ProjectIndex) {
  const raw = decodeURIComponent(location.hash.slice(1));
  const first = idx.models[0];
  const want = raw || (first ? `board=${first.rel}` : '');
  renderNav(idx, want);
  stage?.dispose();
  stage = null;
  $('plate').innerHTML = '';
  if (!want) { status(''); return emptyState(idx); }
  const [kind, rest = ''] = want.split(/=(.*)/s) as [string, string];
  const [rel, sub = '', sub2 = ''] = rest.split('::');
  const m = idx.models.find((x) => x.rel === rel);
  if (!m) return status(`no model ${rel} in this project`, true);
  status('Loading…');
  try {
    const { model, layout } = await loadModel(m);
    let Cls: SceneClass;
    if (kind === 'flow') Cls = traceBoard(model, sub, { title: model.flows.find((f) => f.id === sub)?.title ?? sub });
    else if (kind === 'plate') {
      const p = defaultKits().plate(sub);
      if (!p) throw new Error(`no plate type "${sub}" in this project's kits`);
      Cls = kitPlate(defaultKits(), sub, model, p.from === 'tour' ? { tour: sub2 } : p.from === 'flow' ? { flow: sub2 } : {}, { key: `project:${idx.name}:${m.rel}:${sub}` });
    }
    else if (kind === 'tour') Cls = tourScene(model, sub);
    else Cls = boardScene(model, {
      title: `How ${m.title} fits together`,
      key: `project:${idx.name}:${m.rel}`,
      layout,
      // project-relative: the dev server saves the team layout and splices inside the project (vite.config.ts)
      layoutFile: m.rel.replace(/[^/]*$/, 'karyo.layout.json'),
      modelFile: m.rel,
    });
    const host = document.createElement('div');
    $('plate').append(host);
    stage = mount(host, Cls);
    await stage.ready;
    status('');
    // tours live in the model: list them once it has loaded
    if (model.tours?.length && !document.querySelector('[data-tours]')) {
      const link = (hash: string, k: string, title: string, meta: string) => `<a href="#${esc(encodeURIComponent(hash))}" data-tours${want === hash ? ' aria-current="true"' : ''}><span class="k">${esc(k)}</span><span class="t">${esc(title)}</span><span class="m">${esc(meta)}</span></a>`;
      const add = model.tours.map((t) => link(`tour=${m.rel}::${t.id}`, 'tour', t.title, plural(t.steps.length, 'step'))
        + defaultKits().plates.filter((p) => p.from === 'tour').map((p) => link(`plate=${m.rel}::${p.id}::${t.id}`, p.title.toLowerCase(), t.title, `kit ${p.kit}`)).join('')).join('');
      $('items').insertAdjacentHTML('beforeend', add);
    }
  } catch (e) {
    status(`couldn't draw ${rel}: ${(e as Error).message}`, true);
    console.error(e);
  }
}

async function boot() {
  let idx: ProjectIndex;
  try { idx = await getJson<ProjectIndex>('/__karyo/project'); }
  catch (e) { $('title').textContent = 'No project'; return status(`${(e as Error).message}`, true); }
  document.title = `${idx.name} · Karyo`;
  $('title').textContent = idx.name;
  $('where').textContent = `Karyo project view · ${idx.dir}`;
  $('foot').innerHTML = `Drawn from the project's own files (${plural(idx.models.length, 'model')}, ${plural(idx.explainers.length, 'explainer')}${idx.fragments.length ? `, ${plural(idx.fragments.length, 'fragment')} in <code>.karyo/</code>` : ''}). Regenerate a model with <code>karyo model scan</code> or <code>karyo model build</code> and reload.${idx.truncated ? ' The folder is large: only part of it was searched.' : ''}`;
  await show(idx);
  addEventListener('hashchange', () => { document.querySelectorAll('[data-tours]').forEach((e) => e.remove()); void show(idx); });
}

// theme picker (as on the gallery)
document.getElementById('theme-slot')?.append(themePicker());

// scripts (the plugin's sandbox test) wait on this
declare global { interface Window { __karyoProject: Promise<void> } }
window.__karyoProject = boot();
