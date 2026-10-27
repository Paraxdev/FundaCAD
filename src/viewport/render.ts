// One Mesh per body with per triangle faceIds, plus fat edge lines. Bodies are keyed by id so an unchanged body
// (same etag) reuses its GPU objects, see Viewport.setModel().

import * as THREE from "three";
import type { RebuildResult } from "../types";
import { disposeObject } from "./dispose";
import { scheduleRaycastIndex } from "./raycastIndex";
import { forgetAreaIndex, scheduleAreaIndex } from "./areaIndex";
import { BodyEdges, EDGE_IDLE_COLOR, EDGE_IDLE_WIDTH, type EdgeRef } from "./edgeLines";
import { type BodyFinish, FINISH } from "../document/materials";
import { meanThickness, setGlassAuto } from "./glassThickness";
import { removePatch, setPatch, type ShaderPatch } from "./shaderPatches";
import { removeSelectionGlows } from "./selectionGlow";
import { weldByFace } from "./weld";

export { BodyEdges, EDGE_IDLE_COLOR, EDGE_IDLE_WIDTH };
export type { EdgeRef };

/** `faceIds` are not remapped, so a faceId stays global while vertex indices are local to this body's buffers.
 *  `etag` is the engine's content fingerprint (undefined if the reply had none), which setModel diffs on. */
export interface BodyMesh {
  id: string;
  name: string;
  faceStart: number;
  faceCount: number;
  etag?: string | undefined;
  mesh: THREE.Mesh;
  faceIds: number[]; // one B-rep faceId per triangle, index = local faceIndex
  /** every edge of this body, merged into ONE object with ONE material */
  edges: BodyEdges;
  // Base colours the highlighter restores to; component and draft analysis overwrite them.
  baseColors: Float32Array;
  /** Bumped on every rewrite of baseColors, so the traced copy knows to follow. */
  baseVersion?: number;
  /** What the base colours were last painted from, so a repaint skips a body whose inputs are the same. */
  paintKey?: string | undefined;
  // faceId to LOCAL triangle indices, so hover, select and measure touch one face without scanning the body.
  faceTriangles: Map<number, number[]>;
  /** A read-only reference scan: picked as a whole body, never face by face. */
  scan?: true;
}

export interface ModelView {
  bodies: BodyMesh[];
  // Every body's edges plus the orphans, as refs; the drawable is the owning body's BodyEdges (ref.draw).
  edges: EdgeRef[];
  // Edges whose `body` names no live body. Empty in practice since the backend tags every edge; kept so a
  // body less edge cannot silently vanish if that ever lapses.
  orphanEdges: BodyEdges | null;
  box: THREE.Box3;
}

// Base albedo is baked into vertex colors (material.color stays white) so
// highlight.ts can recolor a single face's vertices without touching lighting.
export const BASE_COLOR = new THREE.Color(0x9aa7b4);
/** A reference scan is matte and sand coloured, so it never reads as a solid. */
export const SCAN_COLOR = new THREE.Color(0xc9b48f);
export const SCAN_MATTE = { metalness: 0, roughness: 1 } as const;

/** A `body` not in `bodyIds`, a body that is gone, falls to the orphans too. */
export function groupEdgesByBody(
  edges: RebuildResult["edges"],
  bodyIds: Set<string>,
): { byBody: Map<string, RebuildResult["edges"]>; orphans: RebuildResult["edges"] } {
  const byBody = new Map<string, RebuildResult["edges"]>();
  const orphans: RebuildResult["edges"] = [];
  for (const e of edges) {
    if (e.body && bodyIds.has(e.body)) {
      let list = byBody.get(e.body);
      if (!list) byBody.set(e.body, (list = []));
      list.push(e);
    } else {
      orphans.push(e);
    }
  }
  return { byBody, orphans };
}

function buildEdgeLines(edges: RebuildResult["edges"], resolution: THREE.Vector2): BodyEdges {
  return new BodyEdges(edges, resolution);
}

/** Without it buildBodyMesh is O(bodies x model triangles): 38.1s to build a 3,000 body assembly, 2.1s with it.
 *  The whole model is walked twice, however many bodies. */
export interface MeshPartition {
  /** body id -> indices into `result.mesh.faceIds` of the triangles it owns */
  trisByBody: Map<string, Int32Array>;
  /** Global vertex index to body local, -1 between bodies. Handed back clean by buildBodyMesh, since
   *  refilling it per body is the very cost being removed. */
  remap: Int32Array;
}

/** Only `rebuilding` bodies get a list. On a progressive load `range` is required, since unwritten zeros read
 *  as face 0, and `remap` is a caller owned scratch buffer handed back clean. */
export function partitionMesh(
  result: RebuildResult,
  rebuilding: Iterable<string>,
  opts?: { range?: { triStart: number; triEnd: number }; remap?: Int32Array },
): MeshPartition {
  const metas = result.bodies ?? [];
  const wanted = rebuilding instanceof Set ? rebuilding : new Set(rebuilding);
  const { faceIds, positions } = result.mesh;

  // faceId to slot, -1 for a face nobody is rebuilding. Bounds come from the wanted bodies only, so on a
  // chunk this stays chunk sized.
  let faceBase = Infinity;
  let faceLimit = 0;
  for (const m of metas) {
    if (!wanted.has(m.id)) continue;
    faceBase = Math.min(faceBase, m.faceStart);
    faceLimit = Math.max(faceLimit, m.faceStart + m.faceCount);
  }
  if (!Number.isFinite(faceBase)) faceBase = 0;
  const slotOfFace = new Int32Array(Math.max(0, faceLimit - faceBase)).fill(-1);
  const slotBodies: string[] = [];
  for (const m of metas) {
    if (!wanted.has(m.id)) continue;
    const slot = slotBodies.length;
    slotBodies.push(m.id);
    slotOfFace.fill(slot, m.faceStart - faceBase, Math.min(m.faceStart + m.faceCount, faceLimit) - faceBase);
  }

  const tFrom = opts?.range ? Math.max(0, opts.range.triStart) : 0;
  const tTo = opts?.range ? Math.min(faceIds.length, opts.range.triEnd) : faceIds.length;

  // pass 1: count, so each body's list is exactly sized (no growing arrays)
  const counts = new Int32Array(slotBodies.length);
  for (let t = tFrom; t < tTo; t++) {
    const fid = faceIds[t];
    if (fid === undefined || fid < faceBase || fid >= faceLimit) continue;
    const slot = slotOfFace[fid - faceBase]!;
    if (slot >= 0) counts[slot]!++;
  }

  // Ascending t within a body keeps localFaceIds and faceTriangles identical to the scan every triangle path.
  const lists = slotBodies.map((_, i) => new Int32Array(counts[i]!));
  const cursor = new Int32Array(slotBodies.length);
  for (let t = tFrom; t < tTo; t++) {
    const fid = faceIds[t];
    if (fid === undefined || fid < faceBase || fid >= faceLimit) continue;
    const slot = slotOfFace[fid - faceBase]!;
    if (slot < 0) continue;
    lists[slot]![cursor[slot]!++] = t;
  }

  const trisByBody = new Map<string, Int32Array>();
  for (let i = 0; i < slotBodies.length; i++) trisByBody.set(slotBodies[i]!, lists[i]!);
  return { trisByBody, remap: opts?.remap ?? new Int32Array(positions.length / 3).fill(-1) };
}

/** Remapped to a dense local vertex range, so each body owns GPU buffers no other rebuild touches; faceIds
 *  stay global. `partition` is only a speed path for many bodies of one reply. */
export function buildBodyMesh(
  result: RebuildResult,
  meta: { id: string; name: string; faceStart: number; faceCount: number; scan?: true | undefined },
  bodyEdges: RebuildResult["edges"],
  resolution: THREE.Vector2,
  etag: string | undefined,
  partition?: MeshPartition,
): BodyMesh {
  const { positions, indices, faceIds } = result.mesh;
  const meshNormals = result.mesh.normals;
  const { faceStart, faceCount } = meta;
  const faceEnd = faceStart + faceCount;

  // Without a partition (the single body live preview drag) a scan costs the same, so none is needed.
  const shared = partition?.trisByBody.get(meta.id);
  let owned: Int32Array;
  if (shared) {
    owned = shared;
  } else {
    const scan: number[] = [];
    for (let t = 0; t < faceIds.length; t++) {
      const fid = faceIds[t];
      if (fid !== undefined && fid >= faceStart && fid < faceEnd) scan.push(t);
    }
    owned = Int32Array.from(scan);
  }

  // A flat typed array, not a Map: this runs per changed body on every live preview drag tick.
  const remap = shared ? partition!.remap : new Int32Array(positions.length / 3).fill(-1);
  // Preallocated: growing plain arrays one number at a time cost ~11 s of main thread on a 7M triangle assembly.
  const indexed = new Uint32Array(owned.length * 3);
  const firstUse: number[] = [];
  const localFaceIds: number[] = new Array(owned.length);
  let nTri = 0;
  for (let k = 0; k < owned.length; k++) {
    const t = owned[k]!;
    const fid = faceIds[t];
    if (fid === undefined) continue;
    const i0 = indices[t * 3],
      i1 = indices[t * 3 + 1],
      i2 = indices[t * 3 + 2];
    if (i0 === undefined || i1 === undefined || i2 === undefined) continue;
    const at = nTri * 3;
    for (let c = 0; c < 3; c++) {
      const gi = c === 0 ? i0 : c === 1 ? i1 : i2;
      let li = remap[gi] ?? -1;
      if (li === -1) {
        li = firstUse.length;
        firstUse.push(gi);
        remap[gi] = li;
      }
      indexed[at + c] = li;
    }
    localFaceIds[nTri++] = fid;
  }
  localFaceIds.length = nTri;
  const localIndices = nTri * 3 === indexed.length ? indexed : indexed.slice(0, nTri * 3);
  const nLocal = firstUse.length;
  const localPositions = new Float32Array(nLocal * 3);
  const localNormals = new Float32Array(meshNormals ? nLocal * 3 : 0);
  let anyNormal = false; // an all-zero slice = "engine sent none for this body"
  for (let li = 0; li < nLocal; li++) {
    const base = firstUse[li]! * 3;
    localPositions[li * 3] = positions[base] ?? 0;
    localPositions[li * 3 + 1] = positions[base + 1] ?? 0;
    localPositions[li * 3 + 2] = positions[base + 2] ?? 0;
    if (meshNormals) {
      const nx = meshNormals[base] ?? 0,
        ny = meshNormals[base + 1] ?? 0,
        nz = meshNormals[base + 2] ?? 0;
      localNormals[li * 3] = nx;
      localNormals[li * 3 + 1] = ny;
      localNormals[li * 3 + 2] = nz;
      if (nx !== 0 || ny !== 0 || nz !== 0) anyNormal = true;
    }
  }

  // Clears only the entries this body touched, O(body) rather than O(model).
  if (shared) {
    for (let k = 0; k < owned.length; k++) {
      const t = owned[k]!;
      const i0 = indices[t * 3],
        i1 = indices[t * 3 + 1],
        i2 = indices[t * 3 + 2];
      if (i0 !== undefined) remap[i0] = -1;
      if (i1 !== undefined) remap[i1] = -1;
      if (i2 !== undefined) remap[i2] = -1;
    }
  }

  // A textured face arrives de-indexed (2.99 verts/tri), so duplicates are welded. The key includes the faceId,
  // or hover paint would bleed into a coplanar neighbour. An indexed body has nothing to merge and skips this.
  let posOut: ArrayLike<number> = localPositions;
  let nrmOut: ArrayLike<number> = localNormals;
  if (anyNormal && localIndices.length && localPositions.length > localIndices.length * 1.5) {
    ({ positions: posOut, normals: nrmOut } = weldByFace(localPositions, localNormals, localIndices, localFaceIds));
  }

  const geo = new THREE.BufferGeometry();
  const f32 = (a: ArrayLike<number>) => (a instanceof Float32Array ? a : Float32Array.from(a));
  geo.setAttribute("position", new THREE.BufferAttribute(f32(posOut), 3));
  // The same index width three picks for a plain array: 16 bits while every
  // vertex number fits.
  const vertsOut = posOut.length / 3;
  geo.setIndex(new THREE.BufferAttribute(vertsOut > 65535 ? localIndices : Uint16Array.from(localIndices), 1));
  // True surface normals keep shading independent of mesh fineness; a large document's coarsened tier has
  // none and keeps the client side accumulation.
  if (anyNormal) geo.setAttribute("normal", new THREE.BufferAttribute(f32(nrmOut), 3));
  else geo.computeVertexNormals();

  const vcount = posOut.length / 3;
  const colors = new Float32Array(vcount * 3);
  const base = meta.scan ? SCAN_COLOR : BASE_COLOR;
  for (let i = 0; i < vcount; i++) {
    colors[i * 3] = base.r;
    colors[i * 3 + 1] = base.g;
    colors[i * 3 + 2] = base.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  // Physical so glass can refract; a weak machine gets Standard and alpha glass. applyGlassLook no-ops on a
  // non physical material, so both are safe.
  const mat = renderLowPower
    ? new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        metalness: FINISH.metalness,
        roughness: FINISH.roughness,
        flatShading: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        side: THREE.DoubleSide,
      })
    : new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        vertexColors: true,
        // Shared with materials, so "no material" and one silent on its finish are the same picture.
        metalness: FINISH.metalness,
        roughness: FINISH.roughness,
        flatShading: false,
        // push faces back so edge lines stay crisp on top (no z-fighting)
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        side: THREE.DoubleSide,
      });

  if (meta.scan) Object.assign(mat, SCAN_MATTE);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "model";
  // So an emissive body lights and shadows its neighbours. Free unless the shadow map is on and a light
  // casts (syncEmitterLights, only the brightest emitters).
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scheduleRaycastIndex(geo); // built after the first paint, see raycastIndex.ts

  const edges = buildEdgeLines(bodyEdges, resolution);

  // A scan's one face is every triangle, a list nothing reads since a scan is never painted face by face,
  // and at a few million triangles it is not small.
  const faceTriangles = new Map<number, number[]>();
  for (let t = 0; t < (meta.scan ? 0 : localFaceIds.length); t++) {
    const fid = localFaceIds[t];
    if (fid === undefined) continue;
    let tris = faceTriangles.get(fid);
    if (!tris) faceTriangles.set(fid, (tris = []));
    tris.push(t);
  }

  const body: BodyMesh = {
    id: meta.id,
    name: meta.name,
    faceStart,
    faceCount,
    etag,
    mesh,
    faceIds: localFaceIds,
    edges,
    baseColors: colors.slice(),
    faceTriangles,
    ...(meta.scan ? { scan: true as const } : {}),
  };
  // Maps a raycast hit's object back to its BodyMesh, see faceIdOfHit().
  mesh.userData.owner = body;
  scheduleAreaIndex(body);
  return body;
}

/** three's Raycaster tests `layers` but not `.visible`, and a hidden body is only `mesh.visible = false`, so
 *  every raycast against the model must filter. */
export function visibleBodyMeshes(view: ModelView): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const b of view.bodies) if (b.mesh.visible) out.push(b.mesh);
  return out;
}

/** `hit.faceIndex` is a LOCAL triangle index into whichever body mesh was hit. */
export function faceIdOfHit(hit: THREE.Intersection): number {
  const owner = hit.object.userData.owner as BodyMesh | undefined;
  return owner?.faceIds[hit.faceIndex ?? 0] ?? 0;
}

/** depthWrite off so ghosts read through each other, DoubleSide since a cut leaves open shells, and a new
 *  material per mount since disposeBody disposes whatever it finds. Nothing is built at alpha 0. */
export function buildSectionGhosts(
  bodies: BodyMesh[],
  plane: THREE.Plane,
  alpha: number,
): { meshes: THREE.Mesh[]; material: THREE.MeshLambertMaterial | null } {
  if (!(alpha > 0)) return { meshes: [], material: null };
  const material = new THREE.MeshLambertMaterial({
    color: BASE_COLOR,
    transparent: true,
    opacity: alpha,
    depthWrite: false,
    side: THREE.DoubleSide,
    clippingPlanes: [plane],
  });
  const meshes = bodies.map((b) => {
    const g = new THREE.Mesh(b.mesh.geometry, material);
    g.renderOrder = -1; // behind the solid half and behind every gizmo
    b.mesh.add(g);
    return g;
  });
  return { meshes, material };
}

/** Per ModelView, which a new reply always replaces, so it never goes stale. Bodies own contiguous faceId
 *  ranges, so a binary search keeps every hover at log(bodies) on a big assembly. */
const faceIndexCache = new WeakMap<ModelView, { starts: Int32Array; bodies: BodyMesh[] }>();

function faceIndexOf(view: ModelView) {
  let idx = faceIndexCache.get(view);
  if (!idx) {
    const bodies = [...view.bodies].sort((a, b) => a.faceStart - b.faceStart);
    const starts = new Int32Array(bodies.length);
    for (let i = 0; i < bodies.length; i++) starts[i] = bodies[i]!.faceStart;
    idx = { starts, bodies };
    faceIndexCache.set(view, idx);
  }
  return idx;
}

/** Undefined for a stale id from before a rebuild. The one range lookup viewport.ts and highlight.ts share. */
export function bodyOfFace(view: ModelView, faceId: number): BodyMesh | undefined {
  const { starts, bodies } = faceIndexOf(view);
  // rightmost body whose faceStart <= faceId
  let lo = 0,
    hi = starts.length - 1,
    found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= faceId) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return undefined;
  const b = bodies[found]!;
  // ranges can have gaps (a body dropped between replies), so still bounds-check
  return faceId < b.faceStart + b.faceCount ? b : undefined;
}

/** `prev` moved to this reply's global face ids when the reply repeats its etag,
 *  else undefined. The etag hashes local ids, so a body after one that gained a
 *  face comes back unchanged at a later faceStart. */
export function reuseUnchanged(
  prev: BodyMesh | undefined,
  meta: { etag?: string | undefined; faceStart: number },
): BodyMesh | undefined {
  if (!prev || meta.etag === undefined || prev.etag !== meta.etag) return undefined;
  const delta = meta.faceStart - prev.faceStart;
  if (delta === 0) return prev;
  const ids = prev.faceIds;
  for (let t = 0; t < ids.length; t++) ids[t] = ids[t]! + delta;
  prev.faceTriangles = new Map([...prev.faceTriangles].map(([fid, tris]) => [fid + delta, tris]));
  prev.faceStart = meta.faceStart;
  return prev;
}

/** A reused body's objects are never recreated, so without this they keep the clip, dim and edge styling from
 *  before the reply. Skips a material not its own, such as the shared zebra shader. */
export function resetBodyAppearance(body: BodyMesh) {
  // A reused body's vertices already encode its position, so a leftover move ghost pose (it turns and scales
  // too) would draw the part transformed twice with nothing on screen to say why.
  body.mesh.position.set(0, 0, 0);
  body.mesh.quaternion.identity();
  body.mesh.scale.set(1, 1, 1);
  body.mesh.updateMatrixWorld();
  removeSelectionGlows(body.mesh);
  for (const mat of bodyMaterials(body)) {
    mat.clippingPlanes = null;
    mat.transparent = false;
    mat.opacity = 1;
    mat.depthWrite = true;
    mat.colorWrite = true;
  }
  body.edges.resetAppearance();
}

/** Its own material plus one per finish dropped on a face. A cast at each call site quietly does nothing on an
 *  array, so x-ray, dim, clip and reset would stop applying. Skips the shared zebra shader. */
export function bodyMaterials(body: BodyMesh): THREE.MeshStandardMaterial[] {
  const m = body.mesh.material;
  const list = Array.isArray(m) ? m : [m];
  return list.filter((x): x is THREE.MeshStandardMaterial => x instanceof THREE.MeshStandardMaterial);
}

// The lacquer's own roughness; low is a wet, hard, freshly waxed coat.
export const CLEARCOAT_ROUGHNESS = 0.08;

/** Physical PBR only, so it no-ops on the Standard material a weak machine draws with. Crossing zero flips
 *  USE_CLEARCOAT, so it recompiles only on the crossing. */
export function applyClearcoat(mat: THREE.MeshStandardMaterial, amount: number): void {
  const phys = mat as THREE.MeshPhysicalMaterial;
  if (!(phys as { isMeshPhysicalMaterial?: boolean }).isMeshPhysicalMaterial) return;
  const was = phys.clearcoat > 0;
  phys.clearcoat = amount;
  phys.clearcoatRoughness = CLEARCOAT_ROUGHNESS;
  if (was !== amount > 0) phys.needsUpdate = true;
}

// Transmission re-renders the scene per glass draw, where a low end GPU stalls or drops the context, so a
// weak machine gets plain alpha glass. Set once at renderer creation (scene.detectLowPower).
let renderLowPower = false;
export function setRenderLowPower(v: boolean): void {
  renderLowPower = v;
}
export function isRenderLowPower(): boolean {
  return renderLowPower;
}

/** True when it took. Ghosts (x-ray, stale preview) keep the plain fade and a metal is never glass. Crossing zero
 *  flips USE_TRANSMISSION, a recompile only on material changes. Auto thickness needs the mesh. */
export function applyGlassLook(
  mat: THREE.MeshStandardMaterial,
  f: BodyFinish,
  ghost: boolean,
  mesh?: THREE.Mesh,
): boolean {
  const phys = mat as THREE.MeshPhysicalMaterial;
  if (!(phys as { isMeshPhysicalMaterial?: boolean }).isMeshPhysicalMaterial) return false;
  const glassy = !ghost && !renderLowPower && f.opacity < 1 && f.metalness < 0.5;
  const was = phys.transmission > 0;
  phys.ior = f.ior;
  if (glassy) {
    // The +0.25 keeps even a frosted 0.6 visibly glassy, so transmission never looks less clear than the
    // alpha fade it replaces.
    phys.transmission = Math.min(1, 1 - f.opacity + 0.25);
    const auto = f.thickness === "auto";
    phys.thickness = auto ? meanThickness(mesh?.geometry) : (f.thickness as number);
    setGlassAuto(phys, auto && mesh ? mesh : null);
    phys.attenuationColor.set(f.attenuationColor ?? 0xffffff);
    // The document keeps 0 for "never", three wants Infinity, which JSON cannot hold.
    phys.attenuationDistance = f.attenuationDistance > 0 ? f.attenuationDistance : Infinity;
    phys.dispersion = f.dispersion;
    phys.transparent = false; // transmission carries the see-through, not alpha
    phys.opacity = 1;
    phys.depthWrite = true;
  } else {
    phys.transmission = 0;
    phys.thickness = 0;
    setGlassAuto(phys, null);
    phys.attenuationColor.set(0xffffff);
    phys.attenuationDistance = Infinity;
    phys.dispersion = 0;
  }
  if (was !== glassy) phys.needsUpdate = true;
  return glassy;
}

/** A soap-bubble film and a tinted highlight. Physical-PBR only, like clearcoat,
 *  and the film is dropped on a weak machine and on a ghost. */
export function applyThinFilm(mat: THREE.MeshStandardMaterial, f: BodyFinish, ghost: boolean): void {
  const phys = mat as THREE.MeshPhysicalMaterial;
  if (!(phys as { isMeshPhysicalMaterial?: boolean }).isMeshPhysicalMaterial) return;
  phys.iridescence = ghost || renderLowPower ? 0 : f.iridescence;
  phys.specularColor.set(!ghost && f.specularColor ? f.specularColor : 0xffffff);
}

export const ANISOTROPY_PATCH = "anisotropy";
export const SCATTER_PATCH = "scatter";

// Bodies have no uv, so three's derivative tangent frame is zero and anisotropy turns NaN. The frame is rebuilt
// from the axis projected on the surface, fading the stretch where the axis meets the surface head on.
const ANISOTROPY: Omit<ShaderPatch, "uniforms"> = {
  name: ANISOTROPY_PATCH,
  key: "aniso1",
  after: {
    common: "uniform vec3 uAnisoAxis;",
    normal_fragment_begin: /* glsl */ `
#ifdef USE_ANISOTROPY
vec3 aAxis = normalize((viewMatrix * vec4(uAnisoAxis, 0.0)).xyz);
vec3 aT = aAxis - dot(aAxis, normal) * normal;
float aLen = length(aT);
float aFade = smoothstep(0.05, 0.3, aLen);
aT = aLen > 1e-4 ? aT / aLen
  : normalize(cross(normal, abs(normal.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
tbn = mat3(aT, cross(normal, aT), normal);
#endif`,
    lights_physical_fragment: /* glsl */ `
#ifdef USE_ANISOTROPY
material.anisotropy *= aFade;
material.alphaT = mix(pow2(material.roughness), 1.0, pow2(material.anisotropy));
#endif`,
  },
};

// The lights are summed before aomap_fragment, so the highlight stays sharp while what is seen through blurs.
// Not a replace, since glassAuto already replaces transmission_fragment.
const SCATTER: Omit<ShaderPatch, "uniforms"> = {
  name: SCATTER_PATCH,
  key: "scatter1",
  after: {
    common: "uniform float uScatter;",
    aomap_fragment: /* glsl */ `
#ifdef USE_TRANSMISSION
float scKeep = material.roughness;
material.roughness = max(material.roughness, 1.0 - exp(-thickness / max(uScatter, 1e-3)));
#endif`,
    transmission_fragment: /* glsl */ `
#ifdef USE_TRANSMISSION
material.roughness = scKeep;
#endif`,
  },
};

const WHITE = new THREE.Color(1, 1, 1);

/** Physical PBR only, dropped on a weak machine and on a ghost. Call after applyGlassLook, since scatter only
 *  takes on a finish that turned out see through. Flakes are drawn by their own patch. */
export function applyFinishFields(
  mat: THREE.MeshStandardMaterial,
  f: BodyFinish,
  ghost: boolean,
  tint: THREE.ColorRepresentation,
  axis: THREE.Vector3,
): void {
  const phys = mat as THREE.MeshPhysicalMaterial;
  if (!(phys as { isMeshPhysicalMaterial?: boolean }).isMeshPhysicalMaterial) return;
  const off = ghost || renderLowPower;
  phys.sheen = off ? 0 : f.sheen;
  phys.sheenColor.set(tint).lerp(WHITE, 0.5);
  phys.sheenRoughness = 0.8;
  phys.anisotropy = off ? 0 : f.anisotropy;
  phys.anisotropyRotation = 0;
  if (phys.anisotropy > 0) setPatch(phys, { ...ANISOTROPY, uniforms: { uAnisoAxis: { value: axis.clone() } } });
  else removePatch(phys, ANISOTROPY_PATCH);
  if (!off && f.scatterDistance > 0 && phys.transmission > 0) {
    setPatch(phys, { ...SCATTER, uniforms: { uScatter: { value: f.scatterDistance } } });
  } else removePatch(phys, SCATTER_PATCH);
}

function disposeBody(body: BodyMesh) {
  forgetAreaIndex(body);
  disposeObject(body.mesh);
  body.edges.dispose();
}

export { disposeBody, buildEdgeLines };

export function setEdgeResolution(view: ModelView | null, res: THREE.Vector2) {
  if (!view) return;
  for (const b of view.bodies) b.edges.setResolution(res);
  view.orphanEdges?.setResolution(res);
}

/** Every merged edge object in the model, the things that actually live in the
 *  scene graph and get raycast, as opposed to ModelView.edges (references). */
export function edgeObjects(view: ModelView): BodyEdges[] {
  const out = view.bodies.map((b) => b.edges);
  if (view.orphanEdges) out.push(view.orphanEdges);
  return out;
}
