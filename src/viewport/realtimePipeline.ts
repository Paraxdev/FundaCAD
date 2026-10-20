// The High tier of the realtime frame: the model drawn on its own into the HDR
// target, with a prepass of normals, roughness and depth beside it for the screen
// space effects that read them, and the overlays drawn after the OutputPass on the
// canvas, so they are never bloomed, blurred or tone mapped twice.

import * as THREE from "three";
import type { RealtimeQualityPref, ViewMode } from "../ui/renderPrefs";
import { isGlassAuto } from "./glassThickness";
import { mirror } from "./potato";

export type RealtimeQuality = "standard" | "high";
/** What the machine is: Light and Potato (`lowPower`), a machine detected as weak
 *  (`auto`) and a software renderer. */
export interface QualityTier {
  lowPower: boolean;
  auto: boolean;
  software: boolean;
}

export const HIGH_NEEDS_GPU = "This computer draws with software graphics, which is too slow for High.";
export const HIGH_NEEDS_POWER = "This computer was detected as low powered, so High is off.";
export const HIGH_NEEDS_FULL = "High is off while performance mode or potato mode is on.";

/** Why High is refused on this tier, or null where it is offered. */
export function highRefusal(t: QualityTier): string | null {
  if (t.software) return HIGH_NEEDS_GPU;
  if (t.auto) return HIGH_NEEDS_POWER;
  if (t.lowPower) return HIGH_NEEDS_FULL;
  return null;
}

/** The quality the realtime view runs at for a saved choice. Auto is Standard
 *  until the machine is measured. `reason` is why High is refused on this tier,
 *  whatever was chosen, for the tooltip of the row. */
export function resolveRealtimeQuality(pref: RealtimeQualityPref, t: QualityTier): { quality: RealtimeQuality; reason: string | null } {
  const reason = highRefusal(t);
  return { quality: pref === "high" && reason === null ? "high" : "standard", reason };
}

export type Stage = "prepass" | "model" | "bokeh" | "bloom" | "output" | "compose";

/** What the viewport knows about a frame and PostChain does not. The loop, a
 *  picture and a screenshot pass it; null is a caller that does not say, which
 *  keeps today's path. */
export interface FrameFacts {
  moving: boolean;
  /** X ray, wireframe, stale, peek or a dimmed model behind a sketch. */
  ghosted: boolean;
}

export interface FrameState {
  quality: RealtimeQuality;
  potato: boolean;
  lowPower: boolean;
  viewMode: ViewMode;
  tracing: boolean;
  forceRealtime: boolean;
  motion: boolean;
  facts: FrameFacts | null;
  bloom: boolean;
  blur: boolean;
  perspective: boolean;
  passesReady: boolean;
}

export type FramePlan =
  | { path: "potato" | "matcap" | "overlay" | "motion" | "direct" | "composer" | "loading" }
  | { path: "high"; stages: Stage[] };

export function highAsked(s: FrameState): boolean {
  return s.quality === "high" && !s.lowPower && s.facts !== null && !s.facts.ghosted;
}

/** In the order PostChain.render tries them. */
export function stagesFor(s: FrameState): FramePlan {
  if (s.potato) return { path: "potato" };
  if (s.viewMode === "matcap" && !s.forceRealtime) return { path: "matcap" };
  if (s.tracing && !s.forceRealtime) return { path: "overlay" };
  if (s.motion && s.lowPower) return { path: "motion" };
  if (highAsked(s) && s.passesReady) {
    const stages: Stage[] = [];
    if (!s.facts!.moving) stages.push("prepass");
    stages.push("model");
    if (s.blur && s.perspective) stages.push("bokeh");
    if (s.bloom) stages.push("bloom");
    stages.push("output", "compose");
    return { path: "high", stages };
  }
  if (!s.bloom && !s.blur) return { path: "direct" };
  return { path: s.passesReady ? "composer" : "loading" };
}

const MODEL_MASK = 1;

function isBody(o: THREE.Object3D): o is THREE.Mesh {
  return (o as THREE.Mesh).isMesh === true && o.userData.owner !== undefined;
}

function drawable(o: THREE.Object3D): boolean {
  const d = o as unknown as Record<string, unknown>;
  return d.isMesh === true || d.isLine === true || d.isPoints === true || d.isSprite === true;
}

function onModelLayer(o: THREE.Object3D): boolean {
  return (o.layers.mask & MODEL_MASK) !== 0;
}

function materialsOf(m: THREE.Mesh): THREE.Material[] {
  return Array.isArray(m.material) ? m.material : [m.material];
}

/** Glass, see through and stencil only materials leave nothing a screen space
 *  effect should read as the surface. */
function seenThrough(m: THREE.Material): boolean {
  const p = m as THREE.MeshPhysicalMaterial;
  return isGlassAuto(m) || (p.transmission ?? 0) > 0 || (m.transparent && m.opacity < 1) || m.colorWrite === false;
}

interface Swapped { mesh: THREE.Mesh; material: THREE.Mesh["material"]; hook?: THREE.Object3D["onBeforeRender"] }

const noHook: THREE.Object3D["onBeforeRender"] = () => {};

/** Twins per source material, dropped when their source was not drawn for a frame. */
class Twins<T extends THREE.Material> {
  private map = new Map<THREE.Material, T>();
  private used = new Set<THREE.Material>();
  constructor(private make: () => T) {}

  get(src: THREE.Material): T {
    let t = this.map.get(src);
    if (!t) this.map.set(src, (t = this.make()));
    this.used.add(src);
    return t;
  }

  prune(): void {
    for (const [src, t] of this.map) {
      if (this.used.has(src)) continue;
      t.dispose();
      this.map.delete(src);
    }
    this.used.clear();
  }

  dispose(): void {
    for (const t of this.map.values()) t.dispose();
    this.map.clear();
    this.used.clear();
  }
}

/** One render of the scene with some meshes swapped and some hidden, everything
 *  given back in the finally, whatever the draw throws.
 *
 *  Note: a swapped mesh's own draw hook is off for the render. Hooks write the
 *  uniforms of the material they were made for (a section cap's hatch), which a
 *  twin does not have, and the model pass has already run them this frame. */
function drawSwapped(
  r: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  swap: Swapped[],
  hide: THREE.Object3D[],
  mask: number,
  draw: () => void,
): void {
  const background = scene.background;
  const shadows = r.shadowMap;
  const autoUpdate = shadows.autoUpdate;
  const cameraMask = camera.layers.mask;
  const restore: Swapped[] = swap.map((s) => ({ mesh: s.mesh, material: s.mesh.material, hook: s.mesh.onBeforeRender }));
  try {
    for (const s of swap) {
      s.mesh.material = s.material;
      s.mesh.onBeforeRender = noHook;
    }
    for (const o of hide) o.visible = false;
    scene.background = null;
    shadows.autoUpdate = false;
    camera.layers.mask = mask;
    draw();
  } finally {
    camera.layers.mask = cameraMask;
    shadows.autoUpdate = autoUpdate;
    scene.background = background;
    for (const o of hide) o.visible = true;
    for (const s of restore) {
      s.mesh.material = s.material;
      s.mesh.onBeforeRender = s.hook!;
    }
  }
}

interface PrepassTwin extends THREE.MeshNormalMaterial { userData: { rough: { value: number } } }

function prepassTwin(): PrepassTwin {
  const m = new THREE.MeshNormalMaterial() as PrepassTwin;
  const rough = { value: 1 };
  m.userData = { rough };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRough = rough;
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform float uRough;\nvoid main() {")
      .replace("gl_FragColor = vec4( normalize( normal ) * 0.5 + 0.5, diffuseColor.a );", "gl_FragColor = vec4( normalize( normal ) * 0.5 + 0.5, uRough );");
  };
  m.customProgramCacheKey = () => "rt-prepass";
  return m;
}

/** View space normal in rgb, roughness in alpha, and depth, of the solid bodies only. */
export class ModelPrepass {
  readonly target: THREE.WebGLRenderTarget;
  private twins = new Twins(prepassTwin);
  private clearWas = new THREE.Color();
  private dims = new THREE.Vector2();

  constructor() {
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 0, depthBuffer: true });
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  }

  private swapFor(scene: THREE.Scene): { swap: Swapped[]; hide: THREE.Object3D[] } {
    const swap: Swapped[] = [];
    const hide: THREE.Object3D[] = [];
    scene.traverseVisible((o) => {
      if (!drawable(o) || !onModelLayer(o)) return;
      if (!isBody(o) || materialsOf(o).some(seenThrough)) {
        hide.push(o);
        return;
      }
      const twin = (src: THREE.Material) => {
        const t = this.twins.get(src);
        mirror(t, src);
        t.colorWrite = true;
        t.transparent = false;
        t.blending = THREE.NoBlending;
        t.userData.rough.value = (src as THREE.MeshStandardMaterial).roughness ?? 1;
        return t;
      };
      swap.push({ mesh: o, material: Array.isArray(o.material) ? o.material.map(twin) : twin(o.material) });
    });
    return { swap, hide };
  }

  /** Links the twins' programs for the scene as it is, resolving when they are ready. */
  warm(r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
    const { swap, hide } = this.swapFor(scene);
    const prevTarget = r.getRenderTarget();
    let ready: Promise<unknown> = Promise.resolve();
    try {
      drawSwapped(r, scene, camera, swap, hide, MODEL_MASK, () => {
        r.setRenderTarget(this.target);
        ready = r.compileAsync(scene, camera);
      });
    } finally {
      r.setRenderTarget(prevTarget);
      this.twins.prune();
    }
    return ready.then(() => {});
  }

  render(r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    r.getDrawingBufferSize(this.dims);
    const w = Math.max(1, Math.floor(this.dims.x));
    const h = Math.max(1, Math.floor(this.dims.y));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    const { swap, hide } = this.swapFor(scene);
    const prevTarget = r.getRenderTarget();
    r.getClearColor(this.clearWas);
    const alpha = r.getClearAlpha();
    const auto = r.autoClear;
    const override = scene.overrideMaterial;
    try {
      drawSwapped(r, scene, camera, swap, hide, MODEL_MASK, () => {
        scene.overrideMaterial = null;
        r.autoClear = true;
        r.setClearColor(0x000000, 0);
        r.setRenderTarget(this.target);
        r.render(scene, camera);
      });
    } finally {
      scene.overrideMaterial = override;
      r.autoClear = auto;
      r.setRenderTarget(prevTarget);
      r.setClearColor(this.clearWas, alpha);
    }
    this.twins.prune();
  }

  dispose(): void {
    this.twins.dispose();
    this.target.depthTexture?.dispose();
    this.target.dispose();
  }
}

function depthTwin(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ colorWrite: false });
}

/** The overlays over the finished model picture on the canvas. The model's meshes
 *  are drawn again as depth only twins, with their clipping and stencil, so an
 *  overlay is hidden behind the model exactly as on the direct path.
 *
 *  Note: with the full draw mask on purpose. Lights live on layer 0 and three
 *  culls them by the camera mask, so a mask without layer 0 draws lit gizmos dark
 *  and compiles a second, unlit, program for each of their materials. */
export class OverlayCompose {
  private twins = new Twins(depthTwin);

  private swapFor(scene: THREE.Scene): { swap: Swapped[]; hide: THREE.Object3D[] } {
    const swap: Swapped[] = [];
    const hide: THREE.Object3D[] = [];
    scene.traverseVisible((o) => {
      if (!drawable(o) || !onModelLayer(o)) return;
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh !== true || materialsOf(mesh).some((m) => (m as { isLineMaterial?: boolean }).isLineMaterial === true)) {
        hide.push(o);
        return;
      }
      const twin = (src: THREE.Material) => {
        const t = this.twins.get(src);
        mirror(t, src);
        t.colorWrite = false;
        return t;
      };
      swap.push({ mesh, material: Array.isArray(mesh.material) ? mesh.material.map(twin) : twin(mesh.material) });
    });
    return { swap, hide };
  }

  /** Links the depth twins' programs for the scene as it is, resolving when they are ready. */
  warm(r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
    const { swap, hide } = this.swapFor(scene);
    let ready: Promise<unknown> = Promise.resolve();
    try {
      drawSwapped(r, scene, camera, swap, hide, camera.layers.mask, () => {
        ready = r.compileAsync(scene, camera);
      });
    } finally {
      this.twins.prune();
    }
    return ready.then(() => {});
  }

  render(r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const { swap, hide } = this.swapFor(scene);
    const auto = r.autoClear;
    try {
      drawSwapped(r, scene, camera, swap, hide, camera.layers.mask, () => {
        r.autoClear = false;
        r.setRenderTarget(null);
        r.clearDepth();
        r.clearStencil();
        r.render(scene, camera);
      });
    } finally {
      r.autoClear = auto;
    }
    this.twins.prune();
  }

  dispose(): void {
    this.twins.dispose();
  }
}
