// Dev host for explainers (explain.html):
//   ?spec=<absolute or repo-relative path to a .json spec>   loaded through the dev server's /__karyo/bundle
//   ?bundle=<url of a bundle JSON>                           (a built site: { spec, components })
//   &theme=<id>  &mode=dark|light (else the ⚙ menu's stored choice, else adenine)  &export=1 (renderer mode: preserved GL buffers, no chrome)  &step=3
// Mounts the plate with id `explainer` and exposes window.__karyo like the gallery (scripts/render.ts --spec).
import { mount, type Stage } from '../engine';
import { initTheme, themePicker, themeFontsReady } from '../engine/theme-pick';
import { explainerScene, type ExplainerApi } from './scene';
import { karyoApi } from './api';
import type { ExplainerBundle, Issue } from './types';

const q = new URLSearchParams(location.search);
const EXPORT = q.has('export');
const html = document.documentElement;
initTheme(q, { stored: !EXPORT });
if (EXPORT) html.classList.add('export');
else document.getElementById('theme-slot')?.append(themePicker());

declare global { interface Window { __karyo: any } }

const status = document.getElementById('status')!;
const issuesEl = document.getElementById('issues')!;
const host = document.getElementById('plate')!;

function showIssues(issues: Issue[]) {
  if (!issues.length) { issuesEl.hidden = true; return; }
  issuesEl.hidden = false;
  issuesEl.innerHTML = `<summary>${issues.filter((i) => i.level === 'error').length} error(s), ${issues.filter((i) => i.level === 'warn').length} warning(s)</summary><ul>${issues.map((i) => `<li class="${i.level}"><code>${i.path || '/'}</code> ${i.message.replace(/</g, '&lt;')}${i.hint ? ` <em>${i.hint.replace(/</g, '&lt;')}</em>` : ''}</li>`).join('')}</ul>`;
  for (const i of issues) console.warn(`[karyo] ${i.level} ${i.path || '/'}: ${i.message}${i.hint ? ` (${i.hint})` : ''}`);
}

async function load(): Promise<ExplainerBundle & { issues?: Issue[] }> {
  const spec = q.get('spec'), bundle = q.get('bundle');
  const url = spec ? `/__karyo/bundle?spec=${encodeURIComponent(spec)}` : bundle;
  if (!url) throw new Error('add ?spec=<path to a .explainer.json> (dev server) or ?bundle=<url>');
  const r = await fetch(url);
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

const stages: Record<string, Stage> = {};
if (!q.get('spec') && !q.get('bundle')) {
  // nothing to open yet: say how, rather than failing
  status.innerHTML = 'No explainer open. Add <code>?spec=&lt;path to a .explainer.json&gt;</code> to this address (absolute, or relative to the folder the dev server runs in), or <code>?bundle=&lt;url of a bundle JSON&gt;</code>. Start one with <code>karyo new &lt;dir&gt;</code>.';
} else try {
  const [b] = await Promise.all([load(), themeFontsReady()]);   // a theme's web fonts in before the plate measures
  showIssues(b.issues ?? []);
  document.title = `${b.spec.title} · Karyo`;
  status.textContent = b.spec.title;
  host.dataset.scene = 'explainer';
  const Cls = explainerScene(b);
  const stage = mount(host, Cls, { preserve: EXPORT });
  stages.explainer = stage;
  const step = q.get('step');
  if (step) stage.ready.then(() => (stage.scene as unknown as ExplainerApi).go(+step - 1));
} catch (e) {
  status.textContent = `Could not load the explainer: ${e instanceof Error ? e.message : String(e)}`;
  status.classList.add('err');
  console.error(e);
}
window.__karyo = karyoApi(stages);
