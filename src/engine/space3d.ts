// Real HTML elements placed in 3D with three.js's CSS3DRenderer, sharing one perspective camera
// with the fx layer: the elements stay live DOM (selectable text, links, CSS) while the camera
// orbits, dollies or explodes them into layers, and wires drawn on the fx canvas follow their
// projected corners exactly.
//
// World units are CSS px; the origin is the centre of the stage; +y is up, +z toward the viewer.
// At z = 0 with the rest camera, 1 unit = 1 stage px.
//
// An element posed `flat` (face-on at z = 0, scale 1, camera at rest) leaves the 3D renderer for that
// frame: it is plain DOM in a layer above the 3D one, placed exactly where its pose projects, so its
// text is rasterized crisply instead of through the perspective. It goes back into 3D (same place, no
// jump) the first frame its pose is anything else.
import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import type { Stage } from './stage';
import type { P } from './geom';

export interface Pose {
  x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number; scale?: number; opacity?: number;
  /** Draw as plain, untransformed DOM when the pose is face-on (z = 0, no rotation, scale 1) and the camera is at
   *  rest; ignored otherwise. For a sheet whose text is read at rest ("text is never read in perspective"). */
  flat?: boolean;
}

const EPS = 1e-6;

export class Space3D {
  readonly camera: THREE.PerspectiveCamera;
  readonly scene = new THREE.Scene();
  readonly renderer = new CSS3DRenderer();
  readonly host: HTMLElement;
  /** Plain DOM above the 3D layer: where `flat` elements sit. */
  readonly flatHost: HTMLElement;
  private objs = new Map<HTMLElement, { obj: CSS3DObject; rest: Required<Pose>; q: Required<Pose>; flat: boolean }>();
  private dist = 0;
  private fov: number;
  /** The logical size the space projects to (stage px): the stage's, kept in step by resize(). */
  W: number;
  H: number;
  /** Camera pose for this frame (reset to rest every frame): orbit angles in degrees, dolly, pan. */
  cam = { yaw: 0, pitch: 0, roll: 0, dolly: 0, panX: 0, panY: 0 };

  constructor(readonly stage: Stage, o: { fov?: number; host?: HTMLElement } = {}) {
    this.W = stage.W; this.H = stage.H; this.fov = o.fov ?? 40;
    this.camera = new THREE.PerspectiveCamera(this.fov, this.W / this.H, 1, 20000);
    this.host = o.host ?? stage.dom;
    const de = this.renderer.domElement;
    de.classList.add('plate-3d');
    Object.assign(de.style, { position: 'absolute', left: '0', top: '0' });
    this.host.appendChild(de);
    this.flatHost = document.createElement('div');
    this.flatHost.className = 'plate-3d-flat';
    Object.assign(this.flatHost.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
    de.after(this.flatHost);
    this.resize(this.W, this.H);
    stage.plugins.push({ reset: () => this.reset(), flush: () => this.render() });
  }

  /** Follow a new logical size (the theater's relayout: `stage.resize`). Called on its own before each frame when the
   *  stage's size changed; call it yourself when you measure projections for a size the stage hasn't taken yet. */
  resize(w: number, h: number) {
    this.W = w; this.H = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dist = (0.5 * h) / Math.tan(THREE.MathUtils.degToRad(this.fov / 2));
    this.renderer.setSize(w, h);
    Object.assign(this.flatHost.style, { width: `${w}px`, height: `${h}px` });
  }

  /** Put an element into the 3D scene at a rest pose. */
  add(el: HTMLElement, rest: Pose = {}) {
    const obj = new CSS3DObject(el);
    const r: Required<Pose> = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1, opacity: 1, flat: false, ...rest };
    this.scene.add(obj);
    this.objs.set(el, { obj, rest: r, q: r, flat: false });
    this.apply(el, {});
    return obj;
  }

  /** Set an element's pose for this frame (unset fields keep the rest pose). */
  pose(el: HTMLElement, p: Pose) { this.apply(el, p); }

  private apply(el: HTMLElement, p: Pose) {
    const o = this.objs.get(el);
    if (!o) throw new Error('karyo: element not in Space3D (call add() first)');
    const q = { ...o.rest, ...p }, d = THREE.MathUtils.degToRad;
    o.q = q;
    o.obj.position.set(q.x, q.y, q.z);
    o.obj.rotation.set(d(q.rx), d(q.ry), d(q.rz));
    o.obj.scale.setScalar(q.scale);
    const op = q.opacity >= 1 ? '' : String(Math.max(0, Math.round(q.opacity * 1e4) / 1e4));
    if (el.style.opacity !== op) el.style.opacity = op;
  }

  private reset() {
    if (this.stage.W !== this.W || this.stage.H !== this.H) this.resize(this.stage.W, this.stage.H);
    for (const el of this.objs.keys()) this.apply(el, {});
    this.cam = { yaw: 0, pitch: 0, roll: 0, dolly: 0, panX: 0, panY: 0 };
  }

  private placeCamera() {
    const d = THREE.MathUtils.degToRad, c = this.cam, r = this.dist - c.dolly;
    const yaw = d(c.yaw), pitch = d(c.pitch);
    this.camera.position.set(c.panX + r * Math.sin(yaw) * Math.cos(pitch), c.panY + r * Math.sin(pitch), r * Math.cos(yaw) * Math.cos(pitch));
    this.camera.up.set(Math.sin(d(c.roll)), Math.cos(d(c.roll)), 0);
    this.camera.lookAt(c.panX, c.panY, 0);
  }

  /** Move elements between the 3D renderer and the flat layer as their poses ask (see `Pose.flat`). */
  private sortFlat() {
    const c = this.cam;
    const camRest = [c.yaw, c.pitch, c.roll, c.dolly, c.panX, c.panY].every((v) => Math.abs(v) < EPS);
    for (const [el, o] of this.objs) {
      const q = o.q;
      const want = q.flat && camRest && Math.abs(q.z) < EPS && Math.abs(q.rx) < EPS && Math.abs(q.ry) < EPS && Math.abs(q.rz) < EPS && Math.abs(q.scale - 1) < EPS;
      if (want === o.flat) continue;
      if (want) {
        this.scene.remove(o.obj);                    // the CSS3DObject takes its element out of the DOM
        el.style.transform = '';
        this.flatHost.appendChild(el);
      } else {
        el.style.left = el.style.top = '';
        // a new object: the renderer caches the transform it last wrote per object, and the flat layer overwrote it
        const obj = new CSS3DObject(el);
        obj.position.copy(o.obj.position); obj.rotation.copy(o.obj.rotation); obj.scale.copy(o.obj.scale);
        this.scene.add(obj);
        o.obj = obj;
      }
      o.flat = want;
    }
  }

  render() {
    this.placeCamera();
    this.sortFlat();
    this.scene.updateMatrixWorld();
    this.camera.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);
    // flat elements: exactly where the face-on pose projects (centre at world x, y), whole px when it lands on them
    const px = (v: number) => (Math.abs(v - Math.round(v)) < 0.01 ? Math.round(v) : Math.round(v * 100) / 100);
    for (const [el, o] of this.objs) {
      if (!o.flat) continue;
      o.obj.updateMatrixWorld();                     // out of the scene graph, but at() and quad() still read it
      const l = `${px(this.W / 2 + o.q.x - el.offsetWidth / 2)}px`, t = `${px(this.H / 2 - o.q.y - el.offsetHeight / 2)}px`;
      if (el.style.left !== l) el.style.left = l;
      if (el.style.top !== t) el.style.top = t;
    }
  }

  /** Is the element drawn flat this frame (plain DOM, no 3D transform)? */
  isFlat(el: HTMLElement) { return !!this.objs.get(el)?.flat; }

  /** Project a world point to stage px. */
  project(x: number, y: number, z: number): P & { behind: boolean } {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.W, y: ((1 - v.y) / 2) * this.H, behind: v.z > 1 };
  }

  /** A point on a 3D element (u, v in 0..1 of its box) in stage px. */
  at(el: HTMLElement, u = 0.5, v = 0.5): P {
    const o = this.objs.get(el)!;
    const w = el.offsetWidth, h = el.offsetHeight;
    const p = new THREE.Vector3((u - 0.5) * w, (0.5 - v) * h, 0).applyMatrix4(o.obj.matrixWorld);
    return this.project(p.x, p.y, p.z);
  }

  /** The element's four projected corners (clockwise from top-left), for outlines. */
  quad(el: HTMLElement): P[] { return [this.at(el, 0, 0), this.at(el, 1, 0), this.at(el, 1, 1), this.at(el, 0, 1)]; }
}
