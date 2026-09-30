// Gallery / preview page.
//   ?scene=id        show one scene (default: all), filling the window (the theater's fit; not in export mode;
//                    &fill=0 keeps it in the page column with its Theater button)
//   &t=2.5           start paused at a time
//   &theme=<id>      plate theme (any id in src/engine/theme-pick.ts); &mode=dark|light forces the neutral theme;
//                    otherwise the choice from the ⚙ theme menu (localStorage karyo:theme), else adenine
//   &export=1        renderer mode: no autoplay, preserved GL buffers, window.__karyo API
import './kits/boot';   // first: the page's kits, before any scene is built (docs/KITS.md)
import { mount, type Stage } from './engine';
import { scenes } from './scenes';
import { initTheme, themePicker } from './engine/theme-pick';

const q = new URLSearchParams(location.search);
const EXPORT = q.has('export');
const only = q.get('scene');
const html = document.documentElement;
initTheme(q, { stored: !EXPORT });   // export (render.ts): URL flags or adenine, never a stored choice
if (EXPORT) html.classList.add('export');

const list = document.getElementById('gallery')!;
const stages: Record<string, Stage> = {};
const ORDER = ['request-flow', 'code-walkthrough', 'ci-pipeline', 'network-stack', 'layers-stack'];
const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
for (const [id, Cls] of Object.entries(scenes).sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))) {
  if (only && id !== only) continue;
  const fig = document.createElement('figure');
  fig.className = 'entry';
  fig.innerHTML = `<figcaption><span class="entry-title">${Cls.title || id}</span><code>${id}</code></figcaption>`;
  const host = document.createElement('div');
  host.dataset.scene = id;
  fig.append(host);
  list.append(fig);
  const t = q.get('t');
  // one scene on its own (`?scene=<id>`, not export): the plate is the page, fitted to the window like the theater
  const fill = !!only && !EXPORT && q.get('fill') !== '0';
  stages[id] = mount(host, Cls, Cls.interactive
    ? { preserve: EXPORT, fill, ...(t !== null ? { start: +t } : {}) }          // interactive plates rest on their end state
    : { autoplay: !EXPORT && t === null, start: t ? +t : 0, preserve: EXPORT, controls: !EXPORT, fill });
}

// theme: the ⚙ settings menu in the header
document.getElementById('theme-slot')?.append(themePicker());

// renderer API (scripts/render.ts)
declare global { interface Window { __karyo: any } }
window.__karyo = {
  ready: Promise.all(Object.values(stages).map((s) => s.ready)).then(() => true),
  ids: Object.keys(stages),
  stages,
  info: (id: string) => { const s = stages[id]!; return { duration: s.duration, W: s.W, H: s.H, title: s.Cls.title, interactive: s.interactive, states: s.scene.states?.().map((x) => x.name) ?? [] }; },
  /** Interactive plates: apply a named example state (from scene.states()) or a raw state object, at rest. */
  setState(id: string, st: unknown) {
    const s = stages[id]!;
    const named = typeof st === 'string' ? s.scene.states?.().find((x) => x.name === st) : undefined;
    if (typeof st === 'string' && !named) throw new Error(`scene ${id} has no state "${st}" (have: ${(s.scene.states?.() ?? []).map((x) => x.name).join(', ')})`);
    s.setState(named ? named.state : st);
    s.pause(); s.t = s.duration; s.render(s.t, 0, true);
    // a state that hosts another plate (a board's stack of splices) is ready once that plate has booted
    const wait = s.scene.settled?.();
    return wait ? wait.then(() => { s.render(s.t, 0, true); return true; }) : true;
  },
  getState: (id: string) => stages[id]!.getState(),
  /** Theater relayout: lay the plate out for a space (CSS px), as the theater would (scene.fit); null = back to the default.
   *  Returns the logical size the plate took. */
  fit(id: string, w: number | null, h?: number) {
    const s = stages[id]!;
    const r = s.scene.fit?.(w === null ? null : { w, h: h ?? w });
    s.resize(r?.w ?? s.Cls.width, r?.h ?? s.Cls.height);
    s.render(s.t, 0, true);
    return { W: s.W, H: s.H };
  },
  errors: () => Object.fromEntries(Object.entries(stages).map(([k, s]) => [k, s.errors])),
  /** Render one scene at time t (paused). */
  still(id: string, t: number) { const s = stages[id]!; s.pause(); s.t = t; s.render(t, 0, true); return true; },
  /** Layout problems at time t: visible elements outside the stage, clipped text. */
  lint(id: string, t: number) {
    const s = stages[id]!;
    this.still(id, t);
    const vp = s.viewport.getBoundingClientRect(), out: string[] = [];
    const name = (e: Element) => e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + [...e.classList].filter((c) => !c.startsWith('plate')).map((c) => `.${c}`).join('');
    const shown = (e: Element) => { for (let a: Element | null = e; a && a !== s.dom; a = a.parentElement) { const cs = getComputedStyle(a); if (+cs.opacity < 0.05 || cs.visibility === 'hidden' || cs.display === 'none') return false; } return true; };
    for (const e of s.dom.querySelectorAll<HTMLElement>('*')) {
      if (e.tagName === 'STYLE' || e.classList.contains('plate-3d') || (e.closest('.plate-3d') && !e.id && !e.className)) continue; // CSS3DRenderer's own wrappers
      if (!shown(e)) continue;
      // inside a declared clip region (a scrolling list): the region's edges are what's visible
      const clip = e.parentElement?.closest('[data-pl-clip]');
      const clipped = !!clip && s.dom.contains(clip);
      const r = e.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (!clipped && (r.left < vp.left - 2 || r.top < vp.top - 2 || r.right > vp.right + 2 || r.bottom > vp.bottom + 2)) out.push(`${name(e)} extends outside the stage`);
      const cs = getComputedStyle(e);
      // an ellipsis or a declared clip region is deliberate clipping
      if (cs.overflow !== 'visible' && cs.textOverflow !== 'ellipsis' && !e.hasAttribute('data-pl-clip') && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)) out.push(`${name(e)} clips its content`);
    }
    return [...new Set(out)];
  },
};
