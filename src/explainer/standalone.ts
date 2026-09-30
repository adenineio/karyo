// Entry of the prebuilt explainer runtime (build.ts bundles it as one IIFE with the engine, three.js
// and the CSS): `KaryoExplainer.mount(el, bundle)` mounts an explainer with a Theater button and
// exposes window.__karyo (the renderer API) so a built file can be checked like the dev host.
import { mount, setMotion, type Stage, type StageOpts } from '../engine';
import { explainerScene, type ExplainerApi } from './scene';
import { karyoApi } from './api';
import type { ExplainerBundle } from './types';

declare global { interface Window { __karyo: any } }

export { setMotion };

/** Mount an explainer bundle into `el`. The stage's scene implements ExplainerApi (go, next, prev, play). */
export function mountExplainer(el: HTMLElement, bundle: ExplainerBundle, opts: StageOpts = {}): Stage {
  el.dataset.scene = 'explainer';
  const stage = mount(el, explainerScene(bundle), { theater: true, ...opts });
  window.__karyo = karyoApi({ explainer: stage });
  return stage;
}
export { mountExplainer as mount };

/** The mounted plate's step API. */
export const api = (stage: Stage) => stage.scene as unknown as ExplainerApi;
