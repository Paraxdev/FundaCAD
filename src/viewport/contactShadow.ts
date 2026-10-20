// The soft shadow a part leaves on the ground it stands on.
//
// An orthographic depth render of the bodies from below, blurred, is the
// darkness of a catcher plane at the model floor: dark where a body touches it,
// fading as the body rises away. The bodies change rarely next to the camera,
// so it is drawn again only when a key over the casters changes, and a frame
// pays one transparent quad. With Shadows on, a second quad on the same plane
// takes the key light's shadow. Both quads have their own materials, nothing
// here touches a body material.

import * as THREE from "three";
import { HorizontalBlurShader } from "three/examples/jsm/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/examples/jsm/shaders/VerticalBlurShader.js";
import type { Ground, ViewMode } from "../ui/renderPrefs";
import type { TraceState } from "./pathtrace/state";
import { markInPicture } from "./pictureScene";

export const CATCHER_SIZE = 512;
/** The catcher's side over the model footprint's longer side. */
const EXTENT_SCALE = 1.6;
const MIN_EXTENT = 1;
/** How far above the floor a body still darkens it, as a share of the extent. */
const REACH = 0.3;
const DARKNESS = 0.65;
const KEY_SHADOW_OPACITY = 0.3;
const BLUR_TEXELS = 4;
/** A layer no overlay uses, so a bake draws the bodies and nothing under them. */
const BAKE_LAYER = 31;

export interface CatcherPlane {
  z: number;
  centre: [number, number];
  extent: number;
  /** The model's height above the floor. */
  height: number;
}

/** The catcher for a model `box` whose grid sits at `floorZ`, null for no model. */
export function catcherPlane(box: THREE.Box3, floorZ: number): CatcherPlane | null {
  if (box.isEmpty()) return null;
  const dx = box.max.x - box.min.x;
  const dy = box.max.y - box.min.y;
  return {
    z: floorZ,
    centre: [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2],
    extent: Math.max(MIN_EXTENT, Math.max(dx, dy) * EXTENT_SCALE),
    height: Math.max(0, box.max.z - floorZ),
  };
}

export interface CatcherState {
  ground: Ground;
  lowPower: boolean;
  potato: boolean;
  viewMode: ViewMode;
  /** The traced image is on screen. */
  tracing: boolean;
  xray: boolean;
}

/** Light and Potato draw no ground, Matcap and X-ray have no shadows to ground,
 *  and the traced image would show the raster shadow pasted over it. */
export function catcherShown(s: Readonly<CatcherState>): boolean {
  return s.ground === "shadow" && !s.lowPower && !s.potato && !s.xray && s.viewMode !== "matcap" && !s.tracing;
}

/** A bake while the tracer converges would cost it frames for a quad it hides. */
export function bakeAllowed(s: TraceState): boolean {
  return s !== "trace" && s !== "done";
}

function isBody(o: THREE.Object3D): o is THREE.Mesh {
  return (o as THREE.Mesh).isMesh === true && o.userData.owner !== undefined;
}

function materialsOf(m: THREE.Mesh): THREE.Material[] {
  return Array.isArray(m.material) ? m.material : [m.material];
}

/** What the bake is drawn from: the visible bodies, their placement, geometry
 *  and clip planes. Not their colours, and nothing outside `model`. */
export function casterKey(model: THREE.Object3D): number[] {
  const v: number[] = [];
  model.updateMatrixWorld();
  model.traverseVisible((o) => {
    if (!isBody(o)) return;
    const geo = o.geometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
    v.push(o.id, ...o.matrixWorld.elements, geo.id, pos?.version ?? -1, geo.index?.version ?? -1,
      geo.drawRange.start, geo.drawRange.count);
    for (const mat of materialsOf(o)) {
      v.push(mat.side, mat.clipIntersection ? 1 : 0);
      for (const p of mat.clippingPlanes ?? []) v.push(p.normal.x, p.normal.y, p.normal.z, p.constant);
      v.push(-1);
    }
  });
  return v;
}

function sameKey(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function target(): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(CATCHER_SIZE, CATCHER_SIZE);
  t.texture.generateMipmaps = false;
  return t;
}

export interface CatcherFrame {
  renderer: THREE.WebGLRenderer;
  model: THREE.Object3D;
  plane: CatcherPlane | null;
  state: Readonly<CatcherState>;
  traceState: TraceState;
  shadows: boolean;
}

export class ContactShadow {
  /** A direct child of the scene, outside the model so fit boxes never see it. */
  readonly group = new THREE.Group();
  /** How many times the darkness was drawn, read by the browser checks. */
  bakes = 0;
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly keyShadow: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
  private readonly depth = target();
  private readonly spare = target();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
  private readonly blurH = new THREE.ShaderMaterial({ ...HorizontalBlurShader, uniforms: THREE.UniformsUtils.clone(HorizontalBlurShader.uniforms), depthTest: false, depthWrite: false });
  private readonly blurV = new THREE.ShaderMaterial({ ...VerticalBlurShader, uniforms: THREE.UniformsUtils.clone(VerticalBlurShader.uniforms), depthTest: false, depthWrite: false });
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurH);
  private twins = new Map<THREE.Material, THREE.MeshDepthMaterial>();
  private key: number[] = [];
  private placed = "";

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1);
    // The bake camera looks up from below, which mirrors X.
    const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
    const catcher = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, depthWrite: false, opacity: DARKNESS, alphaMap: this.depth.texture,
      toneMapped: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.mesh = new THREE.Mesh(geo, catcher);
    const key = new THREE.ShadowMaterial({ opacity: KEY_SHADOW_OPACITY, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.keyShadow = new THREE.Mesh(geo, key);
    this.keyShadow.receiveShadow = true;
    for (const m of [this.mesh, this.keyShadow]) {
      // Before the grid (-2) in the same transparent list.
      m.renderOrder = -3;
      m.raycast = () => {};
      m.castShadow = false;
      this.group.add(m);
    }
    this.group.visible = false;
    markInPicture(this.group);
    this.quad.frustumCulled = false;
    this.quadCamera.position.z = 1;
    this.camera.layers.set(BAKE_LAYER);
  }

  /** Called before each drawn frame. */
  sync(f: CatcherFrame): void {
    const shown = f.plane !== null && catcherShown(f.state);
    this.group.visible = shown;
    if (!shown || !f.plane) return;
    this.place(f.plane);
    this.keyShadow.visible = f.shadows && f.renderer.shadowMap.enabled;
    if (!bakeAllowed(f.traceState)) return;
    const key = casterKey(f.model);
    key.push(f.plane.z, f.plane.centre[0], f.plane.centre[1], f.plane.extent, f.plane.height);
    if (sameKey(key, this.key)) return;
    this.key = key;
    this.bake(f.renderer, f.model, f.plane);
  }

  private place(p: CatcherPlane): void {
    const id = `${p.z}|${p.centre[0]}|${p.centre[1]}|${p.extent}`;
    if (id === this.placed) return;
    this.placed = id;
    this.group.position.set(p.centre[0], p.centre[1], p.z);
    this.mesh.scale.set(p.extent, p.extent, 1);
    this.keyShadow.scale.set(p.extent, p.extent, 1);
    this.group.updateMatrixWorld(true);
  }

  private twin(src: THREE.Material): THREE.MeshDepthMaterial {
    let t = this.twins.get(src);
    if (!t) {
      t = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking, side: THREE.DoubleSide });
      this.twins.set(src, t);
    }
    t.clippingPlanes = src.clippingPlanes;
    t.clipIntersection = src.clipIntersection;
    return t;
  }

  private bake(r: THREE.WebGLRenderer, model: THREE.Object3D, p: CatcherPlane): void {
    const half = p.extent / 2;
    const cam = this.camera;
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    // Just under the floor, so a bottom face on it is inside the near plane.
    const below = p.extent * 1e-4;
    cam.near = 0;
    cam.far = below + Math.max(1e-3, Math.min(p.height, p.extent * REACH));
    cam.position.set(p.centre[0], p.centre[1], p.z - below);
    cam.up.set(0, 1, 0);
    cam.lookAt(p.centre[0], p.centre[1], p.z);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    const bodies: { mesh: THREE.Mesh; material: THREE.Mesh["material"]; mask: number }[] = [];
    const used = new Set<THREE.Material>();
    model.traverseVisible((o) => {
      if (!isBody(o)) return;
      bodies.push({ mesh: o, material: o.material, mask: o.layers.mask });
    });
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevAuto = r.autoClear;
    const prevShadows = r.shadowMap.autoUpdate;
    try {
      for (const b of bodies) {
        b.mesh.material = Array.isArray(b.material)
          ? b.material.map((m) => { used.add(m); return this.twin(m); })
          : (used.add(b.material), this.twin(b.material));
        b.mesh.layers.set(BAKE_LAYER);
      }
      r.shadowMap.autoUpdate = false;
      r.autoClear = true;
      r.setClearColor(0x000000, 0);
      r.setRenderTarget(this.depth);
      r.render(model, cam);
      for (let i = 0; i < 2; i++) {
        this.pass(r, this.blurH, this.depth, this.spare, "h");
        this.pass(r, this.blurV, this.spare, this.depth, "v");
      }
      this.bakes++;
    } finally {
      for (const b of bodies) {
        b.mesh.material = b.material;
        b.mesh.layers.mask = b.mask;
      }
      r.setRenderTarget(prevTarget);
      r.setClearColor(prevClear, prevAlpha);
      r.autoClear = prevAuto;
      r.shadowMap.autoUpdate = prevShadows;
    }
    for (const [src, t] of this.twins) {
      if (used.has(src)) continue;
      t.dispose();
      this.twins.delete(src);
    }
  }

  private pass(r: THREE.WebGLRenderer, m: THREE.ShaderMaterial, from: THREE.WebGLRenderTarget, to: THREE.WebGLRenderTarget, axis: "h" | "v"): void {
    m.uniforms["tDiffuse"]!.value = from.texture;
    m.uniforms[axis]!.value = BLUR_TEXELS / CATCHER_SIZE;
    this.quad.material = m;
    r.setRenderTarget(to);
    r.render(this.quad, this.quadCamera);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.depth.dispose();
    this.spare.dispose();
    this.blurH.dispose();
    this.blurV.dispose();
    this.quad.geometry.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.keyShadow.material.dispose();
    for (const t of this.twins.values()) t.dispose();
    this.twins.clear();
  }
}
