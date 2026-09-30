// window.__karyo for pages that host explainers (explain.html, the standalone HTML): the same
// renderer API as the gallery (src/main.ts) so scripts/render.ts can drive them (stills, lint,
// states), plus the plate's own at-rest checks (camera cut-offs, overlaps, narration overflow).
import type { Stage } from '../engine';

export function karyoApi(stages: Record<string, Stage>, extra: Record<string, unknown> = {}) {
  const api = {
    ready: Promise.all(Object.values(stages).map((s) => s.ready)).then(() => true),
    ids: Object.keys(stages),
    stages,
    info: (id: string) => { const s = stages[id]!; return { duration: s.duration, W: s.W, H: s.H, title: s.Cls.title, interactive: s.interactive, states: s.scene.states?.().map((x) => x.name) ?? [] }; },
    /** Apply a named example state (from scene.states()) or a raw state object, at rest. */
    setState(id: string, st: unknown) {
      const s = stages[id]!;
      const named = typeof st === 'string' ? s.scene.states?.().find((x) => x.name === st) : undefined;
      if (typeof st === 'string' && !named) throw new Error(`scene ${id} has no state "${st}" (have: ${(s.scene.states?.() ?? []).map((x) => x.name).join(', ')})`);
      s.setState(named ? named.state : st);
      s.pause(); s.t = s.duration; s.render(s.t, 0, true);
      return true;
    },
    getState: (id: string) => stages[id]!.getState(),
    errors: () => Object.fromEntries(Object.entries(stages).map(([k, s]) => [k, s.errors])),
    /** Render one scene at time t (paused). */
    still(id: string, t: number) { const s = stages[id]!; s.pause(); s.t = t; s.render(t, 0, true); return true; },
    /** Layout problems at time t: visible elements outside the stage, clipped text; at rest, the plate's own checks. */
    lint(id: string, t: number) {
      const s = stages[id]!;
      api.still(id, t);
      const vp = s.viewport.getBoundingClientRect(), out: string[] = [];
      const name = (e: Element) => e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + [...e.classList].filter((c) => !c.startsWith('plate')).map((c) => `.${c}`).join('');
      const shown = (e: Element) => { for (let a: Element | null = e; a && a !== s.dom; a = a.parentElement) { const cs = getComputedStyle(a); if (+cs.opacity < 0.05 || cs.visibility === 'hidden' || cs.display === 'none') return false; } return true; };
      for (const e of s.dom.querySelectorAll<HTMLElement>('*')) {
        if (e.tagName === 'STYLE' || e.classList.contains('plate-3d') || (e.closest('.plate-3d') && !e.id && !e.className)) continue;
        if (!shown(e)) continue;
        const clip = e.parentElement?.closest('[data-pl-clip]');
        const clipped = !!clip && s.dom.contains(clip);
        const r = e.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (!clipped && (r.left < vp.left - 2 || r.top < vp.top - 2 || r.right > vp.right + 2 || r.bottom > vp.bottom + 2)) out.push(`${name(e)} extends outside the stage`);
        const cs = getComputedStyle(e);
        if (cs.overflow !== 'visible' && cs.textOverflow !== 'ellipsis' && !e.hasAttribute('data-pl-clip') && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)) out.push(`${name(e)} clips its content`);
      }
      const own = (s.scene as unknown as { lint?: () => string[] }).lint;
      if (t >= s.duration && typeof own === 'function') out.push(...own.call(s.scene));
      return [...new Set(out)];
    },
    ...extra,
  };
  return api;
}
