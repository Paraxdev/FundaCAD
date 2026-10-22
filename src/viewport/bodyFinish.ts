// The one writer for every material a body draws with (finish, per-face materials, glow lights), so x-ray, the stale
// ghost and an assigned material cannot undo each other depending on which ran last.

import * as THREE from "three";
import { isGlassAuto, registerGlass } from "./glassThickness";
import {
  applyClearcoat,
  applyFinishFields,
  applyGlassLook,
  applyThinFilm,
  isRenderLowPower,
  SCAN_MATTE,
  type BodyMesh,
  type ModelView,
} from "./render";
import type { SceneBundle } from "./scene";
import { type BodyFinish, FINISH, isShiny } from "../document/materials";
import { applySurface, applySurfaceGraph, cloneWithoutSurface, graphKey, surfaceKey } from "./proceduralSurface";
import { MAX_EMISSIVE_INTENSITY } from "../ui/renderPrefs";
import {
  type AreaEmitter,
  areaEmitters,
  emitterLuminance,
  emitterPower,
  emitterPowerBound,
  emitterShadowNear,
  emitterStandoff,
} from "./emitters";
import { installAreaLights } from "./areaLightShadows";
import { markInPicture } from "./pictureScene";
import { copyPatches, getPatch, removePatch, setPatch } from "./shaderPatches";
import {
  RELIEF_PATCH,
  reliefAxis,
  reliefOrigin,
  reliefPatch,
  reliefUniforms,
  writeRelief,
  type ReliefUniforms,
} from "./relief";
import type { ReliefMap } from "../plugins/contrib";

/** Every rectangle light is evaluated for every lit pixel, so this is the budget. */
const MAX_AREA_LIGHTS = 12;
const MAX_AREA_LIGHTS_LOW_POWER = 4;
/** The light count is part of every lit program, so changing it relinks them all. Padding to this or to the cap keeps
 *  that rare while a single glowing panel does not pay for twelve lights. */
const SMALL_AREA_BUCKET = 4;
/** A point-light shadow is a cube map, six renders each. */
const MAX_SHADOW_EMITTERS = 2;
const XRAY_OPACITY = 0.35;
/** Fainter than x-ray: x-ray is a working mode, stale says the part is wrong. */
const STALE_OPACITY = 0.16;
/** A tool looking into a body: fainter than solid so what it previews inside
 *  reads, solid enough that the body's own faces still do. */
const PEEK_OPACITY = 0.4;
const DEFAULT_FINISH: BodyFinish = { ...FINISH };
const WORLD_UP = new THREE.Vector3(0, 0, 1);

interface EmitterPatch {
  e: AreaEmitter;
  glow: number;
  color: THREE.Color;
  power: number;
}

interface GlowingBody {
  b: BodyMesh;
  glow: number;
  fids: number[] | undefined;
  bound: number;
}

/** A fixed set of lights in the scene: real emitters first in rank order, the
 *  rest at intensity zero, so a glow change only ever touches uniforms. */
interface EmitterRig {
  group: THREE.Group;
  area: THREE.RectAreaLight[];
  shadow: THREE.PointLight[];
}

/** Read by the tracer, which leaves such a surface out of its light sampling. */
function markNoLight(m: THREE.Material, on: boolean): void {
  if (on) m.userData.noLight = true;
  else delete m.userData.noLight;
}

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

/** The finish map comparison, the per-face material slots and the swatch cache all key on this, so every field that
 *  changes how a finish is drawn belongs in it. */
export function finishKey(f: BodyFinish): string {
  return [
    f.metalness,
    f.roughness,
    f.opacity,
    f.emissive,
    f.clearcoat,
    f.ior,
    f.thickness,
    f.attenuationColor ?? "",
    f.attenuationDistance,
    f.dispersion,
    f.iridescence,
    f.specularColor ?? "",
    f.sheen,
    f.anisotropy,
    f.flakes,
    f.flakeSize,
    f.scatterDistance,
    f.castsLight,
    surfaceKey(f.surface),
    graphKey(f.surfaceGraph),
  ].join("|");
}

export function sameFinishMap(a: Record<string, BodyFinish>, b: Record<string, BodyFinish>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (!y || !x || finishKey(x) !== finishKey(y)) return false;
  }
  return true;
}

/** Keep a face pickable and depth-free but draw nothing of it. */
function applyWireframe(mat: THREE.Material, on: boolean) {
  // No early return on a matching colorWrite: the opacity block just reset depthWrite, so wireframe must set it again.
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
  /** Run `fn` on a later frame. Without it, emitters are fitted in one go. */
  later?(fn: () => void): void;
  /** Link the programs the scene needs with `show` visible and `hide` hidden,
   *  resolving when they are ready. Without it, a new light structure goes in at once. */
  prepareLights?(show: THREE.Object3D, hide: THREE.Object3D | null): Promise<void>;
  /** How far the glowing bodies' lights have filled in, null when nothing is pending. */
  onEmitterProgress?(p: number | null): void;
  /** Link the programs `obj` draws with in the scene's lights, resolving when they
   *  are ready. Without it, a patch goes on the live materials at once. */
  prepareMaterials?(obj: THREE.Object3D): Promise<void>;
}

interface ReliefBody {
  /** Bound by every program of the body's materials, so only its values change. */
  u: ReliefUniforms;
  geo: THREE.BufferGeometry | null;
  axis: string;
  origin: number;
  /** Drawn with ridges before, so a rebuild's fresh materials find the programs linked. */
  shown: boolean;
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
  /** Something on the model is shiny or glows, so bloom takes the composer. */
  bloomable = false;
  /** A face has an Emission, whether or not it lights its neighbours. Realtime bloom runs on this alone. */
  glows = false;

  /** `sig` covers the base material's identity, because a rebuild hands back a
   *  fresh one and clones of the old one would keep its settings. */
  private faceMatState = new Map<
    string,
    {
      sig: string;
      mats: THREE.MeshStandardMaterial[];
      finishes: BodyFinish[];
      colors: (string | undefined)[];
    }
  >();
  /** Fitted patches per geometry, keyed by which faces glow (never how much),
   *  so a slider step re-weights them instead of fitting every body again. */
  private fitted = new WeakMap<THREE.BufferGeometry, { key: string; emitters: AreaEmitter[] }>();
  private job: { model: ModelView; order: GlowingBody[] } | null = null;
  private jobQueued = false;
  private fitProgress: number | null = null;
  private rig: EmitterRig | null = null;
  private staged: EmitterRig | null = null;
  private stagedGen = 0;
  private ranked: EmitterPatch[] = [];
  private lastProgress: number | null = null;
  /** Time a frame may spend fitting cold bodies before the rest waits a frame. */
  fitBudgetMs = 6;

  private relief: ReliefMap = {};
  private reliefBodies = new Map<string, ReliefBody>();
  /** Materials whose relief programs are linked, and those being linked. */
  private reliefWarm = new WeakSet<THREE.Material>();
  private reliefLinking = new WeakSet<THREE.Material>();
  private warmClones: THREE.Material[] = [];
  private last: FinishOverlays | null = null;

  constructor(private host: FinishHost) {}

  /** Opacity takes the faintest that applies, stale over x-ray because stale is a warning. Runs again after every rebuild,
   *  which hands back materials in the default finish. */
  apply(o: FinishOverlays, only?: ReadonlySet<BodyMesh>) {
    const model = this.host.model();
    if (!model) return;
    if (!only) this.last = o;
    const cold: { b: BodyMesh; u: ReliefUniforms }[] = [];
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
    const glowing: GlowingBody[] = [];
    let shiny = false;
    let glows = false;
    for (const b of model.bodies) {
      if (only && !only.has(b)) continue;
      const own = this.host.savedMats().get(b.id) ?? b.mesh.material;
      const mat = Array.isArray(own) ? own[0] : own;
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
      this.syncFaceMaterials(b, mat, byBody.get(b.id));
      const peeked = o.peek?.has(b.id) === true;
      const ghost = anyGhost || peeked;
      const ghostOpacity = anyGhost ? baseOpacity : PEEK_OPACITY;
      const f = this.bodyFinish[b.id];
      const unset = b.scan ? SCAN_MATTE : FINISH;
      mat.metalness = f ? f.metalness : unset.metalness;
      mat.roughness = f ? f.roughness : unset.roughness;
      if (!ghost && f && isShiny(f)) shiny = true;
      // Colour is baked per vertex, so the glow tint comes off the paint map, white when unpainted since black would not glow.
      // A ghost never glows, or x-ray would light the model up.
      const glow = ghost ? 0 : (f?.emissive ?? FINISH.emissive);
      if (glow > 0) glows = true;
      const paint = this.bodyPaint[b.id] ?? 0xffffff;
      mat.emissive.set(glow > 0 ? paint : 0x000000);
      mat.emissiveIntensity = glow * MAX_EMISSIVE_INTENSITY;
      const bf = f ?? DEFAULT_FINISH;
      const light = bf.castsLight ? glow : 0;
      markNoLight(mat, glow > 0 && !bf.castsLight);
      const rb = this.reliefFor(b);
      const axis = rb ? rb.u.uReliefAxis.value : WORLD_UP;
      applyClearcoat(mat, ghost ? 0 : bf.clearcoat);
      applyThinFilm(mat, bf, ghost);
      if (!ghost && f?.surfaceGraph) applySurfaceGraph(mat, f.surfaceGraph);
      else applySurface(mat, ghost ? undefined : f?.surface);
      if (!applyGlassLook(mat, bf, ghost, b.mesh)) {
        const opacity = ghost ? Math.min(f ? f.opacity : 1, ghostOpacity) : f ? f.opacity : 1;
        mat.transparent = opacity < 1;
        mat.opacity = opacity;
        mat.depthWrite = opacity >= 1;
      }
      applyFinishFields(mat, bf, ghost, paint, axis);

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
          if (fglow > 0) glows = true;
          if (fglow > 0 && ff.castsLight) faceGlow = true;
          markNoLight(fm, fglow > 0 && !ff.castsLight);
          fm.emissive.set(fglow > 0 ? (extra.colors[i] ?? 0xffffff) : 0x000000);
          fm.emissiveIntensity = fglow * MAX_EMISSIVE_INTENSITY;
          applyClearcoat(fm, ghost ? 0 : ff.clearcoat);
          applyThinFilm(fm, ff, ghost);
          if (!ghost && ff.surfaceGraph) applySurfaceGraph(fm, ff.surfaceGraph);
          else applySurface(fm, ghost ? undefined : ff.surface);
          if (!applyGlassLook(fm, ff, ghost, b.mesh)) {
            const fo = ghost ? Math.min(ff.opacity, ghostOpacity) : ff.opacity;
            fm.transparent = fo < 1;
            fm.opacity = fo;
            fm.depthWrite = fo >= 1;
          }
          applyFinishFields(fm, ff, ghost, extra.colors[i] ?? 0xffffff, axis);
          fm.clippingPlanes = mat.clippingPlanes;
          applyWireframe(fm, o.wireframe);
        }
      }
      applyWireframe(mat, o.wireframe);
      const slots = extra ? extra.mats : [mat];
      if (rb && !ghost) {
        if (this.putRelief(slots, rb)) rb.shown = true;
        else cold.push({ b, u: rb.u });
      } else for (const m of slots) removePatch(m, RELIEF_PATCH);
      registerGlass(b.mesh, extra ? extra.mats.map(isGlassAuto) : [isGlassAuto(mat)]);
      if (light > 0 || faceGlow) glowing.push({ b, glow: light, fids: byBody.get(b.id), bound: 0 });
    }
    // The lights and the bloom flag are whole model passes, the commit runs them once.
    if (only) return;
    this.startEmitters(model, glowing);
    this.bloomable = shiny || glowing.length > 0;
    this.glows = glows;
    if (cold.length) this.warmRelief(cold);
  }

  /** Ridges per body. A body's entry is preferred over `all`, a null clears it. */
  setRelief(map: ReliefMap) {
    this.relief = map;
    for (const s of this.reliefBodies.values()) s.geo = null;
  }

  /** A body moved for good, so its ridges restart from its new lowest point.
   *  Not called while a drag moves it, the ridges slide with it until then. */
  refreshReliefOrigins(): boolean {
    for (const s of this.reliefBodies.values()) s.geo = null;
    return this.relief.all !== undefined || Object.values(this.relief.bodies ?? {}).some((r) => r);
  }

  private reliefFor(b: BodyMesh): ReliefBody | null {
    const bodies = this.relief.bodies;
    const r = bodies && b.id in bodies ? bodies[b.id] : this.relief.all;
    const axis = r ? reliefAxis(r) : null;
    let s = this.reliefBodies.get(b.id);
    if (!r || !axis) {
      if (s) s.shown = false;
      return null;
    }
    if (!s) {
      s = { u: reliefUniforms(), geo: null, axis: "", origin: 0, shown: false };
      this.reliefBodies.set(b.id, s);
    }
    const key = axis.toArray().join(",");
    if (s.geo !== b.mesh.geometry || s.axis !== key) {
      s.origin = reliefOrigin(b.mesh, axis);
      s.geo = b.mesh.geometry;
      s.axis = key;
    }
    writeRelief(s.u, r, axis, s.origin);
    return s;
  }

  /** False when the materials' relief programs still have to be linked. */
  private putRelief(mats: THREE.Material[], rb: ReliefBody): boolean {
    const warm =
      !this.host.prepareMaterials || rb.shown || mats.every((m) => getPatch(m, RELIEF_PATCH) || this.reliefWarm.has(m));
    if (!warm) return false;
    for (const m of mats) {
      setPatch(m, reliefPatch(rb.u));
      this.reliefWarm.add(m);
    }
    return true;
  }

  /** Links the programs on stand ins first, so the picture keeps its old look
   *  until the new one can be drawn without a stall. */
  private warmRelief(cold: { b: BodyMesh; u: ReliefUniforms }[]) {
    const group = new THREE.Group();
    const clones: THREE.Material[] = [];
    const live: THREE.Material[] = [];
    for (const { b, u } of cold) {
      const own = this.host.savedMats().get(b.id) ?? b.mesh.material;
      const list = Array.isArray(own) ? own : [own];
      if (list.every((m) => this.reliefWarm.has(m) || this.reliefLinking.has(m))) continue;
      const cl = list.map((m) => {
        const c = m.clone();
        copyPatches(m, c, () => true);
        setPatch(c, reliefPatch(u));
        clones.push(c);
        live.push(m);
        this.reliefLinking.add(m);
        return c;
      });
      const mesh = new THREE.Mesh(b.mesh.geometry, Array.isArray(own) ? cl : cl[0]);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(b.mesh.matrixWorld);
      mesh.matrixWorld.copy(b.mesh.matrixWorld);
      group.add(mesh);
    }
    if (!group.children.length) return;
    const done = () => {
      // A stand in let go before the live material has drawn would free the program.
      for (const c of this.warmClones) c.dispose();
      this.warmClones = clones;
      for (const m of live) {
        this.reliefLinking.delete(m);
        this.reliefWarm.add(m);
      }
      if (this.last) this.apply(this.last);
      this.host.requestRender();
    };
    this.host.prepareMaterials!(group).then(done, (e) => {
      console.warn("[viewport] relief programs could not be linked ahead:", e);
      done();
    });
  }

  /** Model gone: its lights go with it, or they light the next document's first preview. */
  clear() {
    this.dropFaceMaterials(() => true);
    for (const c of this.warmClones) c.dispose();
    this.warmClones = [];
    this.reliefBodies.clear();
    this.job = null;
    this.fitProgress = null;
    this.syncEmitterLights([]);
    this.bloomable = false;
    this.glows = false;
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

  private areaCap(): number {
    return isRenderLowPower() ? MAX_AREA_LIGHTS_LOW_POWER : MAX_AREA_LIGHTS;
  }

  /** Brightest bound first, so a pass stops once no body left could outshine the dimmest light kept. Cold bodies are
   *  fitted within `fitBudgetMs` and the rest wait a frame, the lights found so far showing meanwhile. */
  private startEmitters(model: ModelView, glowing: GlowingBody[]) {
    for (const g of glowing) g.bound = this.boundOf(g);
    glowing.sort((x, y) => y.bound - x.bound);
    this.job = glowing.length ? { model, order: glowing } : null;
    if (!this.job) {
      this.fitProgress = null;
      this.syncEmitterLights([]);
      return;
    }
    this.runEmitters(this.host.later ? this.fitBudgetMs : Infinity);
  }

  private runEmitters(budgetMs: number) {
    const job = this.job;
    if (!job) return;
    if (this.host.model() !== job.model) {
      this.job = null;
      this.fitProgress = null;
      this.reportProgress();
      return;
    }
    const cap = this.areaCap();
    const deadline = performance.now() + budgetMs;
    const patches: EmitterPatch[] = [];
    const top: number[] = [];
    let fittedNow = 0;
    let i = 0;
    let done = true;
    for (; i < job.order.length; i++) {
      const g = job.order[i]!;
      if (top.length >= cap && top[cap - 1]! >= g.bound) break;
      const key = this.glowKey(g);
      let found = this.cachedEmitters(g, key);
      if (!found) {
        if (fittedNow > 0 && performance.now() >= deadline) {
          done = false;
          break;
        }
        found = this.fitEmitters(g, key);
        fittedNow++;
      }
      for (const e of found) {
        const p = this.patchOf(g, e);
        patches.push(p);
        keepTop(top, p.power, cap);
      }
    }
    if (done) {
      this.job = null;
      this.fitProgress = null;
    } else {
      this.fitProgress = i / job.order.length;
      this.queueEmitters();
    }
    this.syncEmitterLights(patches);
  }

  private queueEmitters() {
    if (this.jobQueued || !this.host.later) return;
    this.jobQueued = true;
    this.host.later(() => {
      this.jobQueued = false;
      this.runEmitters(this.fitBudgetMs);
    });
  }

  private glowOf(g: GlowingBody, fid: number): number {
    const ff = this.faceFinish[fid];
    return ff ? (ff.castsLight ? ff.emissive : 0) : g.glow;
  }

  private boundOf(g: GlowingBody): number {
    const geo = g.b.mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    let glow = g.glow;
    if (g.fids) for (const fid of g.fids) glow = Math.max(glow, this.glowOf(g, fid));
    const bound = geo.boundingBox ? emitterPowerBound(glow, geo.boundingBox) : 0;
    return Number.isFinite(bound) ? bound : 0;
  }

  /** Which faces glow and the triangles they glow from, not how brightly. */
  private glowKey(g: GlowingBody): string {
    const geo = g.b.mesh.geometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
    const parts: (string | number)[] = [pos?.version ?? -1, geo.getIndex()?.version ?? -1, g.glow > 0 ? "B" : "-"];
    if (g.fids) for (const fid of g.fids) parts.push(this.glowOf(g, fid) > 0 ? fid : -fid - 1);
    return parts.join(",");
  }

  private cachedEmitters(g: GlowingBody, key: string): AreaEmitter[] | null {
    const hit = this.fitted.get(g.b.mesh.geometry);
    return hit && hit.key === key ? hit.emitters : null;
  }

  private fitEmitters(g: GlowingBody, key: string): AreaEmitter[] {
    const geo = g.b.mesh.geometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
    const found =
      pos && g.b.faceIds
        ? areaEmitters(pos.array, geo.getIndex()?.array ?? null, g.b.faceIds, (fid) => this.glowOf(g, fid) > 0)
        : [];
    this.fitted.set(geo, { key, emitters: found });
    return found;
  }

  private tints = new Map<string, THREE.Color>();
  private tint(hex: string | undefined): THREE.Color {
    const k = hex ?? "#ffffff";
    let c = this.tints.get(k);
    if (!c) {
      if (this.tints.size > 4096) this.tints.clear();
      this.tints.set(k, (c = new THREE.Color(k)));
    }
    return c;
  }

  private patchOf(g: GlowingBody, e: AreaEmitter): EmitterPatch {
    let glow = 0;
    const color = new THREE.Color(0, 0, 0);
    const paint = this.bodyPaint[g.b.id];
    for (const [fid, a] of e.faces) {
      const w = a / e.area;
      glow += this.glowOf(g, fid) * w;
      const tint = this.tint(this.facePaint[fid] ?? paint);
      color.r += tint.r * w;
      color.g += tint.g * w;
      color.b += tint.b * w;
    }
    return { e, glow, color, power: emitterPower(glow, e) };
  }

  private reportProgress() {
    const p = this.fitProgress !== null ? this.fitProgress * 0.8 : this.staged ? 0.9 : null;
    if (p === this.lastProgress) return;
    this.lastProgress = p;
    this.host.onEmitterProgress?.(p);
  }

  /** The brightest patches pair with a zero intensity point light for a shadow (areaLightShadows.ts, hence rank order).
   *  The light counts are part of every lit program, so they are padded and a new size links aside while the old draws. */
  private syncEmitterLights(patches: EmitterPatch[]) {
    const cap = this.areaCap();
    this.ranked = patches.sort((a, b) => b.power - a.power).slice(0, cap);
    if (!this.ranked.length && !this.rig && !this.staged) {
      this.reportProgress();
      return;
    }
    const shadowCap = isRenderLowPower() || !this.host.scene().renderer.shadowMap.enabled ? 0 : MAX_SHADOW_EMITTERS;
    const area = this.ranked.length <= SMALL_AREA_BUCKET ? Math.min(SMALL_AREA_BUCKET, cap) : cap;
    const fits = (r: EmitterRig | null): r is EmitterRig =>
      !!r && r.area.length === area && r.shadow.length === shadowCap;
    if (!this.ranked.length) {
      this.dropStaged();
      if (this.rig) this.disposeRig(this.rig);
      this.rig = null;
    } else if (fits(this.rig)) {
      this.dropStaged();
      this.fillRig(this.rig);
    } else {
      if (this.rig) this.fillRig(this.rig);
      if (!fits(this.staged)) this.stageRig(area, shadowCap);
    }
    this.reportProgress();
    this.host.requestRender();
  }

  private stageRig(area: number, shadow: number) {
    this.dropStaged();
    installAreaLights();
    const rig = buildRig(area, shadow);
    rig.group.visible = false;
    this.host.addToScene(rig.group);
    const gen = ++this.stagedGen;
    this.staged = rig;
    const ready = this.host.prepareLights?.(rig.group, this.rig?.group ?? null);
    if (!ready) {
      this.swapIn(rig);
      return;
    }
    // A failed link still swaps: the render then compiles in line, as it always did.
    const done = () => {
      if (gen === this.stagedGen && this.staged === rig) this.swapIn(rig);
    };
    ready.then(done, done);
  }

  private swapIn(rig: EmitterRig) {
    if (this.rig) this.disposeRig(this.rig);
    this.rig = rig;
    this.staged = null;
    rig.group.visible = true;
    this.fillRig(rig);
    this.reportProgress();
    this.host.requestRender();
  }

  private dropStaged() {
    if (!this.staged) return;
    this.disposeRig(this.staged);
    this.staged = null;
    this.stagedGen++;
  }

  private disposeRig(r: EmitterRig) {
    r.group.removeFromParent();
    for (const l of r.area) l.dispose();
    for (const l of r.shadow) l.dispose();
  }

  private fillRig(rig: EmitterRig) {
    const ranked = this.ranked;
    rig.area.forEach((area, i) => {
      const p = ranked[i];
      if (!p) {
        area.intensity = 0;
        return;
      }
      const { e, glow, color } = p;
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
    });
    rig.shadow.forEach((light, i) => {
      const p = ranked[i];
      const s = light.shadow;
      const cam = s.camera;
      if (!p) {
        // Pairs with an unlit area light: drawn once with a frustum too small
        // to hold anything, then never again.
        if (s.autoUpdate) {
          s.autoUpdate = false;
          s.needsUpdate = true;
          cam.near = 1e-4;
          cam.far = 2e-4;
          cam.updateProjectionMatrix();
        }
        return;
      }
      const { e } = p;
      const n = e.normal;
      const lift = emitterStandoff(e.size);
      const near = emitterShadowNear(e.size);
      const far = Math.max(e.size * 40, near * 10);
      s.autoUpdate = true;
      light.position.set(e.center[0] + n[0] * lift, e.center[1] + n[1] * lift, e.center[2] + n[2] * lift);
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    });
  }

  /** Face materials are geometry groups over the body's one mesh: a second mesh would double vertices, break the hover
   *  and selection colour buffer and give the picker two objects per face. Groups rely on the tessellator emitting a
   *  face's triangles together, so nothing is reordered, which would invalidate `faceTriangles`. */
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
    // to it leaves `sig` equal and is never applied.
    const slotKey = (fid: number) => {
      const f = this.faceFinish[fid]!;
      return `${finishKey(f)}|${this.facePaint[fid] ?? ""}`;
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

/** Insert `v` into `top`, kept sorted high to low and at most `cap` long. */
function keepTop(top: number[], v: number, cap: number) {
  if (top.length >= cap && v <= top[cap - 1]!) return;
  let i = top.length;
  while (i > 0 && top[i - 1]! < v) i--;
  top.splice(i, 0, v);
  if (top.length > cap) top.length = cap;
}

function buildRig(area: number, shadow: number): EmitterRig {
  const group = new THREE.Group();
  group.name = "emitters";
  markInPicture(group);
  const areas = Array.from(
    { length: area },
    () => group.add(new THREE.RectAreaLight(0xffffff, 0, 1e-3, 1e-3)).children.at(-1) as THREE.RectAreaLight,
  );
  // Shadowed area light i and shadow i are one emitter, so these come after.
  const shadows = Array.from({ length: shadow }, () => {
    const l = new THREE.PointLight(0xffffff, 0);
    l.castShadow = true;
    l.shadow.mapSize.set(1024, 1024);
    l.shadow.bias = -0.004; // self-shadow acne on flat CAD faces
    l.shadow.radius = 4;
    group.add(l);
    return l;
  });
  return { group, area: areas, shadow: shadows };
}
