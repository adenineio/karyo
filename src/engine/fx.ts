// The fx layers: a transparent WebGL canvas under (and optionally over) the scene's HTML.
// Each layer has a background pass (pattern, soft lights, grain) and a batch of GPU capsule
// segments with an optional soft halo — wires, outlines, sparks, dots. Coordinates are stage px
// (the same px the HTML is laid out in); the canvas backing store follows the display scale and
// devicePixelRatio, so hairlines stay crisp at any size.
import * as THREE from 'three';
import type { Theme, RGB, ThemeColor } from './theme';
import { Path, rrectPath, circlePath, type P } from './geom';
import { clamp } from './util';

// Each segment is a quad around a "stadium" (a rectangle with round caps) centred on the
// segment's midpoint, in a local frame where the segment runs along x. The fragment shader
// evaluates the stadium's signed distance for the core, and an exponential falloff for the halo.
const VERT = /* glsl */ `
precision highp float;
in vec3 position;              // unit quad corner in [-1, 1]^2
in vec4 iAB;                   // endpoints A (xy) and B (zw), stage px
in vec4 iColor;                // sRGB + alpha
in vec2 iWG;                   // stroke width, halo radius (stage px)
uniform vec2 res;              // size of the drawn region (stage px): the whole stage, or the visible part when zoomed
uniform vec2 origin;           // the region's top-left (stage px)
uniform float pxScale;         // backing px per stage px
out vec2 vP;                   // fragment position in the segment frame (backing px)
out vec3 vShape;               // half length, radius, halo radius (backing px)
out vec4 vColor;
void main() {
  vec2 a = (iAB.xy - origin) * pxScale, b = (iAB.zw - origin) * pxScale;
  vec2 mid = 0.5 * (a + b), d = b - a;
  float halfLen = 0.5 * length(d);
  vec2 ax = halfLen > 1e-5 ? d / (2.0 * halfLen) : vec2(1.0, 0.0);
  vec2 ay = vec2(-ax.y, ax.x);
  float r = max(0.5 * iWG.x * pxScale, 0.4);          // never thinner than ~0.8 backing px…
  float halo = iWG.y * pxScale;
  float pad = r + 1.5 + 3.0 * halo;                   // room for antialiasing and the halo
  vec2 local = position.xy * vec2(halfLen + pad, pad);
  vec2 world = mid + ax * local.x + ay * local.y;
  vec2 ndc = world / (res * pxScale) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vP = local;
  vShape = vec3(halfLen, r, halo);
  float cover = clamp(iWG.x * pxScale / 0.8, 0.0, 1.0);  // …so a sub-pixel stroke dims instead
  vColor = vec4(iColor.rgb, iColor.a * cover);
}`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vP; in vec3 vShape; in vec4 vColor;
uniform float glowK;
uniform int halo;              // 0: the core; 1: the halo alone (drawn into its own target with MAX blending)
out vec4 fragColor;
void main() {
  vec2 q = abs(vP) - vec2(vShape.x, 0.0);
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - vShape.y; // stadium signed distance
  float a;
  if (halo == 1) {
    if (vShape.z <= 0.0) discard;
    a = min(1.0, 0.55 * glowK * exp(-max(sd, 0.0) / vShape.z)) * vColor.a;
  } else {
    a = smoothstep(0.75, -0.75, sd) * vColor.a;
  }
  if (a < 0.002) discard;
  fragColor = vec4(vColor.rgb * a, a);                  // premultiplied alpha
}`;

export type Col = RGB | ThemeColor;
export interface Stroke {
  /** Width in stage px (default 1.5). */
  width?: number;
  /** Colour: a theme token name ('accent', 'line', …) or sRGB triplet. Default 'line'. */
  color?: Col;
  alpha?: number;
  /** Halo radius in px (scaled by the theme's --pl-glow). */
  glow?: number;
}

/** The dashes along a path, as polylines. A Path never changes once made, so the pieces are kept with it and reused
 *  when the same path is dashed the same way again (a wire redrawn at rest, while zooming or panning). */
const dashMemo = new WeakMap<Path, { k: string; pieces: P[][] }>();
function dashPieces(p: Path, dash: number, gap: number, offset: number, from: number, to: number): P[][] {
  const key = `${dash},${gap},${offset},${from},${to}`, m = dashMemo.get(p);
  if (m && m.k === key) return m.pieces;
  const per = dash + gap, len = p.length, pieces: P[][] = [];
  const s0 = from * len, s1 = to * len;
  let k = Math.floor((s0 - offset) / per);
  for (; ; k++) {
    const a = k * per + offset, b = a + dash;
    if (a > s1) break;
    const ca = Math.max(a, s0), cb = Math.min(b, s1);
    if (cb <= ca) continue;
    pieces.push(p.slice(ca / len, cb / len).pts);
  }
  dashMemo.set(p, { k: key, pieces });
  return pieces;
}

export class LineBatch {
  readonly mesh: THREE.Mesh;
  /** The halos, as one union: a path is many short segments, and halos blended one over another pile
   *  up wherever segments crowd (every rounded corner and bend). Drawn into their own target with MAX
   *  blending, overlapping halos take the stronger one instead of adding, so a corner glows no more
   *  than a straight edge; FxLayer composites the target under the cores. */
  readonly haloMesh: THREE.Mesh;
  hasHalo = false;
  private geo = new THREE.InstancedBufferGeometry();
  readonly mat: THREE.RawShaderMaterial;
  readonly haloMat: THREE.RawShaderMaterial;
  private ab: Float32Array; private col: Float32Array; private wg: Float32Array;
  private attrs: THREE.InstancedBufferAttribute[];
  count = 0;
  theme!: Theme;

  constructor(private capacity = 40000) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.ab = new Float32Array(capacity * 4); this.col = new Float32Array(capacity * 4); this.wg = new Float32Array(capacity * 2);
    this.attrs = [new THREE.InstancedBufferAttribute(this.ab, 4), new THREE.InstancedBufferAttribute(this.col, 4), new THREE.InstancedBufferAttribute(this.wg, 2)];
    this.attrs.forEach((a) => a.setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iAB', this.attrs[0]!); this.geo.setAttribute('iColor', this.attrs[1]!); this.geo.setAttribute('iWG', this.attrs[2]!);
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { res: { value: new THREE.Vector2(1, 1) }, origin: { value: new THREE.Vector2(0, 0) }, pxScale: { value: 1 }, glowK: { value: 1 }, halo: { value: 0 } },
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
      side: THREE.DoubleSide, // y-down px → clip space flips the quad's winding
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.haloMat = this.mat.clone();
    this.haloMat.uniforms = { res: this.mat.uniforms.res!, origin: this.mat.uniforms.origin!, pxScale: this.mat.uniforms.pxScale!, glowK: this.mat.uniforms.glowK!, halo: { value: 1 } };
    this.haloMat.blendEquation = THREE.MaxEquation;
    this.haloMesh = new THREE.Mesh(this.geo, this.haloMat);
    this.haloMesh.frustumCulled = false;
  }

  clear() { this.count = 0; this.hasHalo = false; }
  /** The box the segments drawn since the last clear cover (stage px), or null when there are none. */
  bounds(): { x: number; y: number; w: number; h: number } | null {
    if (!this.count) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const a = this.ab, j = i * 4;
      x0 = Math.min(x0, a[j]!, a[j + 2]!); x1 = Math.max(x1, a[j]!, a[j + 2]!);
      y0 = Math.min(y0, a[j + 1]!, a[j + 3]!); y1 = Math.max(y1, a[j + 1]!, a[j + 3]!);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  rgb(c: Col | undefined): RGB { return c === undefined ? this.theme.line : typeof c === 'string' ? this.theme[c] : c; }

  /** One capsule segment from (ax,ay) to (bx,by). A zero-length segment is a dot of diameter `width`. */
  seg(ax: number, ay: number, bx: number, by: number, s: Stroke = {}) {
    if (this.count >= this.capacity) return;
    const i = this.count++, c = this.rgb(s.color), j = i * 4, ab = this.ab, col = this.col;
    // (element by element: the same values as a .set([…]) of them, without an array per segment)
    ab[j] = ax; ab[j + 1] = ay; ab[j + 2] = bx; ab[j + 3] = by;
    col[j] = c[0]; col[j + 1] = c[1]; col[j + 2] = c[2]; col[j + 3] = clamp(s.alpha ?? 1);
    this.wg[i * 2] = s.width ?? 1.5; this.wg[i * 2 + 1] = s.glow ?? 0;
    if (s.glow) this.hasHalo = true;
  }
  dot(x: number, y: number, d: number, s: Stroke = {}) { this.seg(x, y, x, y, { ...s, width: d }); }
  polyline(pts: P[], s: Stroke = {}) { for (let i = 1; i < pts.length; i++) this.seg(pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y, s); }

  /** Draw a path, optionally only the part between fractions `from` and `to` (a draw-on). */
  path(p: Path, s: Stroke & { from?: number; to?: number } = {}) {
    const f = s.from ?? 0, t = s.to ?? 1;
    this.polyline(f <= 0 && t >= 1 ? p.pts : p.slice(f, t).pts, s);
  }
  /** Dashes along a path; `offset` (px) scrolls them — drive it with time for "flow". */
  dashes(p: Path, s: Stroke & { dash?: number; gap?: number; offset?: number; from?: number; to?: number } = {}) {
    for (const pts of dashPieces(p, s.dash ?? 6, s.gap ?? 6, s.offset ?? 0, s.from ?? 0, s.to ?? 1)) this.polyline(pts, s);
  }
  /** Rounded-rect outline, drawn on from 0 to `progress`. */
  rrect(x: number, y: number, w: number, h: number, r: number, s: Stroke & { progress?: number } = {}) {
    this.path(rrectPath(x, y, w, h, r), { ...s, to: s.progress ?? 1 });
  }
  ring(cx: number, cy: number, r: number, s: Stroke & { progress?: number } = {}) {
    this.path(circlePath(cx, cy, r), { ...s, to: s.progress ?? 1 });
  }
  /** An arrowhead at p pointing along `angle`. */
  arrow(p: { x: number; y: number }, angle: number, size = 8, s: Stroke = {}) {
    for (const k of [-1, 1]) {
      const a = angle + Math.PI + k * 0.5;
      this.seg(p.x, p.y, p.x + Math.cos(a) * size, p.y + Math.sin(a) * size, s);
    }
  }

  upload(res: THREE.Vector2, pxScale: number, origin: THREE.Vector2) {
    for (const a of this.attrs) { a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, this.count * a.itemSize); }
    this.geo.instanceCount = this.count;
    (this.mat.uniforms.res!.value as THREE.Vector2).copy(res);
    (this.mat.uniforms.origin!.value as THREE.Vector2).copy(origin);
    this.mat.uniforms.pxScale!.value = pxScale;
    this.mat.uniforms.glowK!.value = this.theme.glow;
  }
}

// ------------------------------------------------------------------ background pass

const MAX_LIGHTS = 8;
const BG_FRAG = /* glsl */ `
precision highp float;
uniform vec2 res; uniform vec2 origin; uniform float pxScale; uniform float t; uniform int pattern; uniform float patternAlpha; uniform float spacing;
uniform vec3 lineCol; uniform float grain; uniform bool dark;
uniform vec4 lights[${MAX_LIGHTS}]; uniform vec4 lightCol[${MAX_LIGHTS}]; uniform int nLights;
out vec4 fragColor;
float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
void main() {
  vec2 px = vec2(gl_FragCoord.x, res.y * pxScale - gl_FragCoord.y) / pxScale + origin; // stage px, y down
  vec4 acc = vec4(0.0);
  // soft lights: premultiplied, additive-ish on the transparent canvas
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= nLights) break;
    float d = length(px - lights[i].xy) / lights[i].z;
    float k = exp(-d * d * 2.5) * lights[i].w;
    acc += vec4(lightCol[i].rgb * k, k) * (1.0 - acc.a);
  }
  // pattern
  float pa = 0.0;
  if (pattern == 1) { // dots
    vec2 g = mod(px + spacing * 0.5, spacing) - spacing * 0.5;
    pa = clamp((1.25 - length(g)) * pxScale, 0.0, 1.0);
  } else if (pattern == 2) { // grid hairlines
    vec2 g = abs(mod(px + 0.5, spacing) - 0.5) * pxScale;
    pa = clamp(1.0 - min(g.x, g.y), 0.0, 1.0) * 0.6;
  }
  pa *= patternAlpha;
  acc += vec4(lineCol * pa, pa) * (1.0 - acc.a);
  // grain: signed noise as a faint tint, keyed to 1/24 s so it reads as film, not static
  if (grain > 0.0) {
    float n = hash(floor(gl_FragCoord.xy) + floor(t * 24.0) * 17.0) - 0.5;
    float ga = abs(n) * grain * 0.25;
    vec3 gc = n > 0.0 ? vec3(1.0) : vec3(0.0);
    acc += vec4(gc * ga, ga) * (1.0 - acc.a);
  }
  fragColor = acc;
}`;

export type Pattern = 'none' | 'dots' | 'grid';

export class Background {
  pattern: Pattern = 'none';
  /** The theme's film grain (off for a layer drawn over another, which already has it). */
  grain = true;
  patternAlpha = 0.5;
  spacing = 24;
  private lights: { x: number; y: number; r: number; k: number; c: RGB }[] = [];
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.RawShaderMaterial;
  constructor() {
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: /* glsl */ `precision highp float; in vec3 position; void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: BG_FRAG,
      uniforms: {
        res: { value: new THREE.Vector2() }, origin: { value: new THREE.Vector2() }, pxScale: { value: 1 }, t: { value: 0 }, pattern: { value: 0 }, patternAlpha: { value: 0.5 }, spacing: { value: 24 },
        lineCol: { value: new THREE.Vector3() }, grain: { value: 0 }, dark: { value: true },
        lights: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) },
        lightCol: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) }, nLights: { value: 0 },
      },
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
  }
  clear() { this.lights.length = 0; }
  /** The box the lights added since the last clear cover (stage px), or null when there are none. */
  bounds(): { x: number; y: number; w: number; h: number } | null {
    if (!this.lights.length) return null;
    const x0 = Math.min(...this.lights.map((l) => l.x - l.r)), y0 = Math.min(...this.lights.map((l) => l.y - l.r));
    return { x: x0, y: y0, w: Math.max(...this.lights.map((l) => l.x + l.r)) - x0, h: Math.max(...this.lights.map((l) => l.y + l.r)) - y0 };
  }
  /** A soft pool of light under the HTML at (x,y), radius r px, intensity k (0..1). */
  light(x: number, y: number, r: number, k: number, color: RGB) { if (this.lights.length < MAX_LIGHTS && k > 0.001) this.lights.push({ x, y, r, k, c: color }); }
  upload(res: THREE.Vector2, pxScale: number, t: number, theme: Theme, origin: THREE.Vector2) {
    const u = this.mat.uniforms;
    (u.res!.value as THREE.Vector2).copy(res);
    (u.origin!.value as THREE.Vector2).copy(origin);
    u.pxScale!.value = pxScale; u.t!.value = t;
    u.pattern!.value = { none: 0, dots: 1, grid: 2 }[this.pattern];
    u.patternAlpha!.value = this.patternAlpha; u.spacing!.value = this.spacing;
    (u.lineCol!.value as THREE.Vector3).set(...theme.line);
    u.grain!.value = this.grain ? theme.grain : 0; u.dark!.value = theme.dark;
    this.lights.forEach((l, i) => {
      (u.lights!.value as THREE.Vector4[])[i]!.set(l.x, l.y, l.r, theme.light === 1 ? l.k : l.k * theme.light);
      (u.lightCol!.value as THREE.Vector4[])[i]!.set(l.c[0], l.c[1], l.c[2], 1);
    });
    u.nLights!.value = this.lights.length;
  }
}

// ------------------------------------------------------------------ layer

/** One transparent WebGL canvas in the stage (under or over the HTML). */
export class FxLayer {
  /** The canvas (a fresh one replaces it after a release: a context once forced lost can't be had again from its canvas). */
  canvas = document.createElement('canvas');
  private lost = false;
  /** Called when the browser takes the context back (the stage draws its frame again). */
  onLost: (() => void) | null = null;
  renderer: THREE.WebGLRenderer | null = null;
  readonly lines = new LineBatch();
  readonly bg = new Background();
  private scene = new THREE.Scene();
  private haloScene = new THREE.Scene();
  private haloRT: THREE.WebGLRenderTarget | null = null;
  private haloQuad: THREE.Mesh;
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  private res = new THREE.Vector2();
  private origin = new THREE.Vector2();
  private pxScale = 1;

  constructor(readonly name: 'under' | 'over' | 'front', private preserve: boolean) {
    this.canvas.className = `plate-fx plate-fx-${name}`;
    this.scene.add(this.bg.mesh);
    this.bg.mesh.renderOrder = 0;
    this.lines.mesh.renderOrder = 2;
    this.scene.add(this.lines.mesh);
    this.haloScene.add(this.lines.haloMesh);
    // the halo target, composited between the background and the cores (premultiplied, as drawn)
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.haloQuad = new THREE.Mesh(g, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: /* glsl */ `precision highp float; in vec3 position; out vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `precision highp float; uniform sampler2D tex; in vec2 vUv; out vec4 fragColor; void main(){ fragColor = texture(tex, vUv); }`,
      uniforms: { tex: { value: null } },
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    }));
    this.haloQuad.frustumCulled = false;
    this.haloQuad.renderOrder = 1;
    this.haloQuad.visible = false;
    this.scene.add(this.haloQuad);
  }
  /** Create the GL context (lazily: a page may hold many plates; browsers cap live contexts). */
  ensure() {
    if (this.renderer) return this.renderer;
    if (this.lost) {
      const c = document.createElement('canvas');
      c.className = this.canvas.className; c.style.cssText = this.canvas.style.cssText; c.width = this.canvas.width; c.height = this.canvas.height;
      this.canvas.replaceWith(c);
      this.canvas = c; this.lost = false;
    }
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: this.preserve });
    // the browser may take the context back (past its cap of live contexts): drop it, so the next frame that draws
    // makes a fresh canvas and context instead of drawing into a dead one
    const r = this.renderer;
    this.canvas.addEventListener('webglcontextlost', () => { if (this.renderer !== r) return; this.haloRT = null; this.renderer = null; this.lost = true; this.onLost?.(); }, { once: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = true;
    return this.renderer;
  }
  release() { this.haloRT?.dispose(); this.haloRT = null; if (this.renderer) { this.renderer.dispose(); this.renderer.forceContextLoss(); this.lost = true; } this.renderer = null; }
  /** Size the canvas for a W×H stage at `pxScale` backing px per stage px. With `view` (the viewer zoomed in: docs/ENGINE.md
   *  "Zoom and pan"), the canvas covers only that visible part of the stage, so its backing store stays the size of the
   *  viewport however far in, and everything is drawn at the zoomed density (sharp hairlines and halos, not a stretched bitmap).
   *  With `box` instead (the chrome's layer, `fx.front`, while zoomed), the whole W×H stage is drawn at `pxScale` and the
   *  canvas is shown over `box` (stage px): fit coordinates, displayed where the chrome is. */
  resize(W: number, H: number, pxScale: number, view: { x: number; y: number; w: number; h: number } | null = null, box: { x: number; y: number; w: number; h: number } | null = null) {
    this.pxScale = pxScale;
    const st = this.canvas.style;
    let w: number, h: number;
    if (box) {
      this.res.set(W, H); this.origin.set(0, 0);
      w = Math.max(1, Math.round(W * pxScale)); h = Math.max(1, Math.round(H * pxScale));
      Object.assign(st, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px`, right: 'auto', bottom: 'auto' });
    } else if (!view) {
      this.res.set(W, H); this.origin.set(0, 0);
      w = Math.max(1, Math.round(W * pxScale)); h = Math.max(1, Math.round(H * pxScale));
      if (st.width) { st.left = st.top = st.width = st.height = st.right = st.bottom = ''; }
    } else {
      w = Math.max(1, Math.round(view.w * pxScale)); h = Math.max(1, Math.round(view.h * pxScale));
      this.res.set(w / pxScale, h / pxScale); this.origin.set(view.x, view.y);
      Object.assign(st, { left: `${view.x}px`, top: `${view.y}px`, width: `${w / pxScale}px`, height: `${h / pxScale}px`, right: 'auto', bottom: 'auto' });
    }
    this.setBacking(w, h);
  }
  /** Show a `box`-sized canvas (the chrome's layer) over another box (stage px), keeping what it draws. */
  place(box: { x: number; y: number; w: number; h: number }) {
    Object.assign(this.canvas.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px`, right: 'auto', bottom: 'auto' });
  }
  /** The box what was drawn since `begin` covers (stage px): its lines, else its lights; null when nothing was. */
  bounds() { return this.lines.bounds() ?? this.bg.bounds(); }
  private setBacking(w: number, h: number) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.renderer?.setViewport(0, 0, w, h);
  }
  begin(theme: Theme) { this.lines.theme = theme; this.lines.clear(); this.bg.clear(); }
  render(t: number, theme: Theme) {
    const r = this.renderer;
    if (!r) return;
    this.bg.upload(this.res, this.pxScale, t, theme, this.origin);
    this.lines.upload(this.res, this.pxScale, this.origin);
    const w = this.canvas.width, h = this.canvas.height;
    this.haloQuad.visible = this.lines.hasHalo;
    if (this.lines.hasHalo) {
      if (!this.haloRT || this.haloRT.width !== w || this.haloRT.height !== h) {
        this.haloRT?.dispose();
        this.haloRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, stencilBuffer: false });
      }
      r.setRenderTarget(this.haloRT);
      r.setViewport(0, 0, w, h);
      r.clear();
      r.render(this.haloScene, this.cam);
      r.setRenderTarget(null);
      ((this.haloQuad.material as THREE.RawShaderMaterial).uniforms.tex!).value = this.haloRT.texture;
    }
    r.setViewport(0, 0, w, h);
    r.render(this.scene, this.cam);
  }
}
