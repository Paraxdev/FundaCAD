// What each body looks like it is made of: its finish, the per-face materials
// dropped on single faces, and the lights that glowing surfaces throw. One writer
// for every material a body draws with, so x-ray, the stale ghost and an assigned
// material cannot undo each other depending on which ran last.

import * as THREE from "three";
import { applyClearcoat, applyGlassLook, isRenderLowPower, type BodyMesh, type ModelView } from "./render";
import type { SceneBundle } from "./scene";
import { type BodyFinish, FINISH, isShiny } from "../document/materials";
import { applySurface, applySurfaceGraph, cloneWithoutSurface, graphKey, surfaceKey } from "./proceduralSurface";
import { MAX_EMISSIVE_INTENSITY } from "../ui/renderPrefs";
import { type AreaEmitter, areaEmitters, emitterLuminance, emitterShadowNear, emitterStandoff } from "./emitters";
import { installAreaLights } from "./areaLightShadows";

/** Every rectangle light is evaluated for every lit pixel, so this is the budget. */
const MAX_AREA_LIGHTS = 12;
const MAX_AREA_LIGHTS_LOW_POWER = 4;
/** A point-light shadow is a cube map, six renders each. */
const MAX_SHADOW_EMITTERS = 2;
const XRAY_OPACITY = 0.35;
/** Fainter than x-ray: x-ray is a working mode, stale says the part is wrong. */
const STALE_OPACITY = 0.16;
/** A tool looking into a body: fainter than solid so what it previews inside
 *  reads, solid enough that the body's own faces still do. */
const PEEK_OPACITY = 0.4;

interface EmitterPatch { key: string; e: AreaEmitter; glow: number; color: THREE.Color }

export function sameStringMap(
  a: Record<string, string> | Record<number, string>,
  b: Record<string, string> | Record<number, string>,
): boolean {
  const av = a as Record<string, string>;
  const bv = b as Record<string, string>;
  const ka = Object.keys(av);
  if (ka.length !== Object.keys(bv).length) return false;
  for (const k of ka) if (av[k] !== bv[k]) return false;
  return true;
}

export function sameFinishMap(a: Record<string, BodyFinish>, b: Record<string, BodyFinish>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (
      !y || !x || x.metalness !== y.metalness || x.roughness !== y.roughness
      || x.opacity !== y.opacity || x.emissive !== y.emissive
      || x.clearcoat !== y.clearcoat || surfaceKey(x.surface) !== surfaceKey(y.surface)
      || graphKey(x.surfaceGraph) !== graphKey(y.surfaceGraph)
    ) {
      return false;
    }
  }
  return true;
}

/** Keep a face pickable and depth-free but draw nothing of it. */
function applyWireframe(mat: THREE.Material, on: boolean) {
  if (mat.colorWrite === !on) return;
  mat.colorWrite = !on;
  if (on) mat.depthWrite = false;
}

export interface FinishHost {
  model(): ModelView | null;
  scene(): SceneBundle;
  faceIdToBodyId(faceId: number): string | null;
  addToScene(obj: THREE.Object3D): void;
  requestRender(): void;
  /** Each body's own material while the zebra overlay has swapped in a shared one. */
  savedMats(): Map<string, THREE.Material | THREE.Material[]>;
}

export interface FinishOverlays {
  xray: boolean;
  stale: boolean;
  wireframe: boolean;
  /** Bodies a tool is previewing into, ghosted for the length of its gesture. */
  peek?: ReadonlySet<string>;
}

export class BodyFinishLayer {
  /** body id → hex. Also the tint a glowing body glows in. */
  bodyPaint: Record<string, string> = {};
  /** Only bodies that differ from the default finish. */
  bodyFinish: Record<string, BodyFinish> = {};
  /** global face id → hex, sparse: a face wearing its body's colour is absent. */
  facePaint: Record<number, string> = {};
  /** global face id → finish, sparse like facePaint. */
  faceFinish: Record<number, BodyFinish> = {};
  /** Something on the model is shiny or glows, so bloom is worth running. */
  bloomable = false;

  /** `sig` covers the base material's identity, because a rebuild hands back a
   *  fresh one and clones of the old one would keep its settings. */
  private faceMatState = new Map<string, {
    sig: string;
    mats: THREE.MeshStandardMaterial[];
    finishes: BodyFinish[];
    colors: (string | undefined)[];
  }>();
  private emitterLights = new Map<string, { area: THREE.RectAreaLight; shadow: THREE.PointLight | null }>();
  private emitterGroup: THREE.Group | null = null;

  constructor(private host: FinishHost) {}

  /** Opacity takes the faintest of what applies, and stale wins over x-ray
   *  because stale carries a warning. Runs again after every rebuild, which
   *  hands back materials wearing the default finish. */
  apply(o: FinishOverlays) {
    const model = this.host.model();
    if (!model) return;
    const anyGhost = o.xray || o.stale;
    const baseOpacity = o.stale ? STALE_OPACITY : XRAY_OPACITY;
    const byBody = new Map<string, number[]>();
    for (const k of Object.keys(this.faceFinish)) {
      const fid = Number(k);
      const bid = this.host.faceIdToBodyId(fid);
      if (!bid) continue;
      const list = byBody.get(bid);
      if (list) list.push(fid);
      else byBody.set(bid, [fid]);
    }
    const emitters: EmitterPatch[] = [];
    let shiny = false;
    for (const b of model.bodies) {
      const own = this.host.savedMats().get(b.id) ?? b.mesh.material;
      const mat = (Array.isArray(own) ? own[0] : own);
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
      this.syncFaceMaterials(b, mat, byBody.get(b.id));
      const peeked = o.peek?.has(b.id) === true;
      const ghost = anyGhost || peeked;
      const ghostOpacity = anyGhost ? baseOpacity : PEEK_OPACITY;
      const f = this.bodyFinish[b.id];
      mat.metalness = f ? f.metalness : FINISH.metalness;
      mat.roughness = f ? f.roughness : FINISH.roughness;
      if (!ghost && f && isShiny(f)) shiny = true;
      // Colour is baked per vertex, so the emissive tint comes off the paint map.
      // White for an unpainted body: emissive black would make the glow do nothing.
      // A ghost never glows, or x-ray would light the model up instead of fading it.
      const glow = ghost ? 0 : (f?.emissive ?? FINISH.emissive);
      mat.emissive.set(glow > 0 ? (this.bodyPaint[b.id] ?? 0xffffff) : 0x000000);
      mat.emissiveIntensity = glow * MAX_EMISSIVE_INTENSITY;
      applyClearcoat(mat, ghost ? 0 : (f?.clearcoat ?? FINISH.clearcoat));
      if (!ghost && f?.surfaceGraph) applySurfaceGraph(mat, f.surfaceGraph);
      else applySurface(mat, ghost ? undefined : f?.surface);
      if (!applyGlassLook(mat, f ? f.opacity : 1, f ? f.metalness : FINISH.metalness, ghost)) {
        const opacity = ghost ? Math.min(f ? f.opacity : 1, ghostOpacity) : f ? f.opacity : 1;
        mat.transparent = opacity < 1;
        mat.opacity = opacity;
        mat.depthWrite = opacity >= 1;
      }

      const extra = this.faceMatState.get(b.id);
      let faceGlow = false;
      if (extra) {
        for (let i = 1; i < extra.mats.length; i++) {
          const fm = extra.mats[i]!;
          const ff = extra.finishes[i]!;
          fm.metalness = ff.metalness;
          fm.roughness = ff.roughness;
          if (!ghost && isShiny(ff)) shiny = true;
          const fglow = ghost ? 0 : ff.emissive;
          if (fglow > 0) faceGlow = true;
          fm.emissive.set(fglow > 0 ? (extra.colors[i] ?? 0xffffff) : 0x000000);
          fm.emissiveIntensity = fglow * MAX_EMISSIVE_INTENSITY;
          applyClearcoat(fm, ghost ? 0 : ff.clearcoat);
          if (!ghost && ff.surfaceGraph) applySurfaceGraph(fm, ff.surfaceGraph);
          else applySurface(fm, ghost ? undefined : ff.surface);
          if (!applyGlassLook(fm, ff.opacity, ff.metalness, ghost)) {
            const fo = ghost ? Math.min(ff.opacity, ghostOpacity) : ff.opacity;
            fm.transparent = fo < 1;
            fm.opacity = fo;
            fm.depthWrite = fo >= 1;
          }
          fm.clippingPlanes = mat.clippingPlanes;
          applyWireframe(fm, o.wireframe);
        }
      }
      applyWireframe(mat, o.wireframe);
      if (glow > 0 || faceGlow) this.collectEmitters(b, glow, ghost, emitters);
    }
    this.syncEmitterLights(emitters);
    this.bloomable = shiny || emitters.length > 0;
  }

  /** Model gone: its lights go with it, or they light the next document's first preview. */
  clear() {
    this.dropFaceMaterials(() => true);
    this.syncEmitterLights([]);
    this.bloomable = false;
  }

  /** Let go of the per-face materials of every body `gone` says is gone. They are
   *  GPU programs, so a long session would otherwise leak one per deleted body. */
  dropFaceMaterials(gone: (bodyId: string) => boolean) {
    for (const [id, held] of [...this.faceMatState]) {
      if (!gone(id)) continue;
      for (let i = 1; i < held.mats.length; i++) held.mats[i]!.dispose();
      this.faceMatState.delete(id);
    }
  }

  /** Each glowing patch becomes a rectangle light its own shape, and the
   *  brightest few pair with a zero-intensity point light for a shadow
   *  (areaLightShadows.ts, which is why lights are re-added in rank order).
   *  Reconciled rather than rebuilt so nudging a slider does not churn the scene. */
  private syncEmitterLights(patches: EmitterPatch[]) {
    const low = isRenderLowPower();
    const ranked = patches
      .map((p) => ({ p, power: emitterLuminance(p.glow, p.e) * p.e.width * p.e.height }))
      .sort((a, b) => b.power - a.power)
      .slice(0, low ? MAX_AREA_LIGHTS_LOW_POWER : MAX_AREA_LIGHTS)
      .map((r) => r.p);
    const keep = new Set(ranked.map((p) => p.key));
    for (const [key, held] of this.emitterLights) {
      if (keep.has(key)) continue;
      held.area.dispose();
      held.shadow?.dispose();
      this.emitterLights.delete(key);
    }
    if (!ranked.length && !this.emitterGroup) return;
    if (!this.emitterGroup) {
      installAreaLights();
      this.emitterGroup = new THREE.Group();
      this.emitterGroup.name = "emitters";
      this.host.addToScene(this.emitterGroup);
    }
    const group = this.emitterGroup;
    group.clear();

    const shadowCap = low || !this.host.scene().renderer.shadowMap.enabled ? 0 : MAX_SHADOW_EMITTERS;
    const shadows: THREE.PointLight[] = [];
    ranked.forEach(({ key, e, glow, color }, rank) => {
      let held = this.emitterLights.get(key);
      if (!held) {
        held = { area: new THREE.RectAreaLight(), shadow: null };
        this.emitterLights.set(key, held);
      }
      const { area } = held;
      area.color.copy(color);
      area.intensity = emitterLuminance(glow, e);
      area.width = e.width;
      area.height = e.height;
      area.position.set(...e.center);
      // The light shines down its local -Z with its width along X.
      const x = new THREE.Vector3(...e.xAxis);
      const z = new THREE.Vector3(...e.normal).negate();
      const y = new THREE.Vector3().crossVectors(z, x);
      area.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      group.add(area);

      if (rank < shadowCap) {
        if (!held.shadow) {
          held.shadow = new THREE.PointLight(0xffffff, 0);
          held.shadow.castShadow = true;
          held.shadow.shadow.mapSize.set(1024, 1024);
          held.shadow.shadow.bias = -0.004; // self-shadow acne on flat CAD faces
          held.shadow.shadow.radius = 4;
        }
        const n = e.normal;
        const lift = emitterStandoff(e.size);
        held.shadow.position.set(e.center[0] + n[0] * lift, e.center[1] + n[1] * lift, e.center[2] + n[2] * lift);
        const cam = held.shadow.shadow.camera;
        cam.near = emitterShadowNear(e.size);
        cam.far = Math.max(e.size * 40, cam.near * 10);
        cam.updateProjectionMatrix();
        shadows.push(held.shadow);
      } else if (held.shadow) {
        held.shadow.dispose();
        held.shadow = null;
      }
    });
    // Shadowed area light i and shadow i are one emitter, so the order matters.
    for (const light of shadows) group.add(light);
    this.host.requestRender();
  }

  private collectEmitters(b: { id: string; mesh: THREE.Mesh; faceIds: number[] }, bodyGlow: number, ghost: boolean, out: EmitterPatch[]) {
    const geo = b.mesh.geometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!b.faceIds || !pos) return;
    const glowOf = (fid: number) => {
      const ff = this.faceFinish[fid];
      return ff ? (ghost ? 0 : ff.emissive) : bodyGlow;
    };
    const tint = new THREE.Color();
    for (const e of areaEmitters(pos.array, geo.getIndex()?.array ?? null, b.faceIds, (fid) => glowOf(fid) > 0)) {
      let glow = 0;
      const color = new THREE.Color(0, 0, 0);
      for (const [fid, a] of e.faces) {
        const w = a / e.area;
        glow += glowOf(fid) * w;
        tint.set(this.facePaint[fid] ?? this.bodyPaint[b.id] ?? 0xffffff);
        color.r += tint.r * w;
        color.g += tint.g * w;
        color.b += tint.b * w;
      }
      out.push({ key: `${b.id}:${e.key}`, e, glow, color });
    }
  }

  /** Per-face materials as geometry GROUPS over the body's one mesh, not a second
   *  mesh: that would double vertices, break the per-vertex colour buffer hover
   *  and selection paint into, and give the picker two objects per face. The
   *  tessellator emits a face's triangles together, so nothing is reordered,
   *  which would invalidate `faceTriangles`. */
  private syncFaceMaterials(b: BodyMesh, base: THREE.MeshStandardMaterial, fids: number[] | undefined) {
    const held = this.faceMatState.get(b.id);
    if (!fids?.length) {
      if (!held) return;
      for (let i = 1; i < held.mats.length; i++) held.mats[i]!.dispose();
      this.faceMatState.delete(b.id);
      b.mesh.geometry.clearGroups();
      this.setOwnMaterial(b, base);
      return;
    }
    const sorted = [...fids].sort((x, y) => x - y);
    // Every field that changes how a face is drawn must be in the key, or an edit
    // to it leaves `sig` equal and is never applied. Mirror sameFinishMap.
    const slotKey = (fid: number) => {
      const f = this.faceFinish[fid]!;
      return [
        f.metalness, f.roughness, f.opacity, f.emissive, f.clearcoat,
        surfaceKey(f.surface), graphKey(f.surfaceGraph), this.facePaint[fid] ?? "",
      ].join("|");
    };
    const sig = `${base.uuid};${sorted.map((f) => `${f}:${slotKey(f)}`).join(",")}`;
    if (held?.sig === sig) return;
    if (held) for (let i = 1; i < held.mats.length; i++) held.mats[i]!.dispose();

    const mats: THREE.MeshStandardMaterial[] = [base];
    const finishes: BodyFinish[] = [{ ...FINISH }];
    const colors: (string | undefined)[] = [undefined];
    const slotOf = new Map<string, number>();
    const faceSlot = new Map<number, number>();
    for (const fid of sorted) {
      const k = slotKey(fid);
      let slot = slotOf.get(k);
      if (slot === undefined) {
        slot = mats.length;
        slotOf.set(k, slot);
        mats.push(cloneWithoutSurface(base));
        finishes.push(this.faceFinish[fid]!);
        colors.push(this.facePaint[fid]);
      }
      faceSlot.set(fid, slot);
    }

    const geo = b.mesh.geometry;
    geo.clearGroups();
    const tri = b.faceIds;
    let runStart = 0;
    let runSlot = faceSlot.get(tri[0] ?? -1) ?? 0;
    for (let t = 1; t <= tri.length; t++) {
      const slot = t < tri.length ? (faceSlot.get(tri[t]!) ?? 0) : -1;
      if (slot === runSlot) continue;
      geo.addGroup(runStart * 3, (t - runStart) * 3, runSlot);
      runStart = t;
      runSlot = slot;
    }
    this.faceMatState.set(b.id, { sig, mats, finishes, colors });
    this.setOwnMaterial(b, mats);
  }

  /** While zebra is on, mesh.material is shared by every body and the body's own is parked. */
  private setOwnMaterial(b: BodyMesh, m: THREE.Material | THREE.Material[]) {
    if (this.host.savedMats().has(b.id)) this.host.savedMats().set(b.id, m);
    else b.mesh.material = m;
  }
}
