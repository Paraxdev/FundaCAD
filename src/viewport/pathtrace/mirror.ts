// The traced copy of the visible bodies. Each mirror mesh shares the viewport's
// position and normal buffers but owns its index: the tracer's BVH build
// reorders the index in place and hangs `boundsTree` on the geometry, and
// neither may land on the geometry the viewport draws and picks with.

import * as THREE from "three";
import { traceMaterialFrom, traceMaterialKey } from "./materials";

/** Trees build in workers, but every edit still repacks the tracer's buffers
 *  on the main thread, about 0.22 us per triangle (0.45 s at 2 M, 0.7 s at 3 M,
 *  1 s at 4 M on a desktop CPU), so past this the mode refuses with a note. */
export const TRIANGLE_BUDGET = 3_000_000;

interface Owned {
  baseColors?: Float32Array;
  baseVersion?: number;
}

export function isTracedBody(o: THREE.Object3D): o is THREE.Mesh {
  return (o as THREE.Mesh).isMesh === true && !!o.userData.owner && o.visible;
}

/** `withIndex` false leaves the index off until the body's tree lands, which
 *  brings the index reordered to match it. */
export function mirrorBody(src: THREE.Mesh, withIndex = true): THREE.Mesh {
  const g = src.geometry;
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", g.getAttribute("position"));
  const normal = g.getAttribute("normal");
  if (normal) out.setAttribute("normal", normal);
  if (withIndex && g.index) out.setIndex(new THREE.BufferAttribute((g.index.array as Uint32Array).slice(), 1));
  for (const gr of g.groups) out.addGroup(gr.start, gr.count, gr.materialIndex);
  const m = new THREE.Mesh(out, []);
  copyMirrorColors(m, src);
  refreshMirrorMaterials(m, src);
  src.updateWorldMatrix(true, false);
  m.matrixAutoUpdate = false;
  m.matrix.copy(src.matrixWorld);
  m.matrixWorld.copy(src.matrixWorld);
  return m;
}

/** A body's procedural surfaces averaged per vertex: `slot` is -1 where no
 *  surface reaches, `tint` and `amount` blend over the base colour like the
 *  Realtime shader does, `rough` is each baked slot's mean roughness offset. */
export interface SurfaceBake {
  slot: Int16Array;
  tint: Float32Array;
  amount: Float32Array;
  rough: Map<number, number>;
}

export type SurfaceBaker = (src: THREE.Mesh) => SurfaceBake | null;

export function copyMirrorColors(mirror: THREE.Mesh, src: THREE.Mesh, bake: SurfaceBake | null = null) {
  const owned = (src.userData.owner as Owned).baseColors;
  const count = src.geometry.getAttribute("position").count;
  const base = owned && owned.length === count * 3 ? owned : null;
  const g = mirror.geometry;
  if (bake && bake.slot.length !== count) bake = null;
  mirror.userData.bake = bake ? bake.rough : undefined;
  if (!base && !bake) {
    if (g.getAttribute("color")) g.deleteAttribute("color");
    return;
  }
  const c = g.getAttribute("color") as THREE.BufferAttribute | undefined;
  const out = c && c.array.length === count * 3 ? (c.array as Float32Array) : new Float32Array(count * 3);
  if (base) out.set(base);
  else out.fill(1);
  if (bake) composeBake(out, bake, Array.isArray(src.material) ? src.material : [src.material]);
  if (c && c.array === out) c.needsUpdate = true;
  else g.setAttribute("color", new THREE.BufferAttribute(out, 3));
}

/** A baked slot's material colour moves into its vertices, so the slot's
 *  traced material is white and mix(colour * base, tint, amount) is exact. */
function composeBake(out: Float32Array, bake: SurfaceBake, mats: THREE.Material[]) {
  for (let v = 0; v < bake.slot.length; v++) {
    const k = bake.slot[v]!;
    if (k < 0) continue;
    const col = (mats[k] as Partial<THREE.MeshStandardMaterial>)?.color;
    const rgb = col ? [col.r, col.g, col.b] : [1, 1, 1];
    const a = bake.amount[v]!;
    for (let i = 0; i < 3; i++) {
      const own = out[v * 3 + i]! * rgb[i]!;
      out[v * 3 + i] = own + (bake.tint[v * 3 + i]! - own) * a;
    }
  }
}

/** In place where the slot count is unchanged, so the tracer's material map
 *  keeps pointing at the same objects. */
export function refreshMirrorMaterials(mirror: THREE.Mesh, src: THREE.Mesh) {
  const colors = !!mirror.geometry.getAttribute("color");
  const from = Array.isArray(src.material) ? src.material : [src.material];
  const had = Array.isArray(mirror.material) ? mirror.material : [mirror.material];
  const baked = mirror.userData.bake as Map<number, number> | undefined;
  const fit = (m: THREE.MeshPhysicalMaterial, i: number) => {
    const off = baked?.get(i);
    if (off === undefined) return m;
    m.color.setRGB(1, 1, 1);
    m.roughness = Math.min(1, Math.max(0.04, m.roughness + off));
    return m;
  };
  if (had.length !== from.length || !had.every((m) => m instanceof THREE.MeshPhysicalMaterial)) {
    had.forEach((m) => m.dispose());
    const made = from.map((m, i) => fit(traceMaterialFrom(m, colors), i));
    mirror.material = Array.isArray(src.material) ? made : made[0]!;
    return;
  }
  had.forEach((m, i) => fit(traceMaterialFrom(from[i]!, colors, m as THREE.MeshPhysicalMaterial), i));
}

export function countTriangles(bodies: THREE.Mesh[]): number {
  let n = 0;
  for (const m of bodies) {
    const g = m.geometry;
    n += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
  }
  return n;
}

export function countVertices(bodies: THREE.Mesh[]): number {
  let n = 0;
  for (const m of bodies) n += m.geometry.getAttribute("position").count;
  return n;
}

/** The largest GPU storage buffer the tracer packs for this much geometry,
 *  measured on three-gpu-pathtracer 0.0.27: 64 B per vertex of interleaved
 *  attributes, about 18 B per triangle of tree nodes. */
export function storageBytes(triangles: number, vertices: number): number {
  return Math.max(vertices * 64, triangles * 18);
}

export function collectBodies(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverseVisible((o) => {
    if (isTracedBody(o)) out.push(o);
  });
  return out;
}

/** Hidden bodies too, whose trees are kept for when they are shown again. */
export function collectAllBodies(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.userData.owner) out.push(o as THREE.Mesh);
  });
  return out;
}

export function transformSignature(bodies: THREE.Mesh[]): string {
  return bodies
    .map((b) => {
      b.updateWorldMatrix(true, false);
      return b.matrixWorld.elements.join(",");
    })
    .join("|");
}

export function materialSignature(bodies: THREE.Mesh[]): string {
  return bodies
    .map((b) => (Array.isArray(b.material) ? b.material : [b.material]).map(traceMaterialKey).join("+"))
    .join("|");
}

/** highlight.setBase bumps baseVersion whenever it rewrites the base colours;
 *  a procedural surface or the colour under it changes the baked colours. */
export function bodyColorKey(b: THREE.Mesh): string {
  const mats = Array.isArray(b.material) ? b.material : [b.material];
  let k = String((b.userData.owner as Owned).baseVersion ?? 0);
  mats.forEach((m, i) => {
    const surf = m.userData.surfKey as string | undefined;
    if (surf) k += `;${i}:${(m as Partial<THREE.MeshStandardMaterial>).color?.getHexString()}:${surf}`;
  });
  return k;
}

export function colorSignature(bodies: THREE.Mesh[]): string {
  return bodies.map(bodyColorKey).join(",");
}

function sampleSum(a: ArrayLike<number> | undefined): number {
  if (!a || a.length === 0) return 0;
  let s = a.length;
  const step = Math.max(1, Math.floor(a.length / 64));
  for (let i = 0; i < a.length; i += step) s = (s * 31 + a[i]! * 1000) % 1e9;
  return s;
}

/** Changes when what the tracer would see changes, and not on a hover: hover
 *  tints the vertex colour buffer, the mirror reads the base colours. */
export function sceneSignature(bodies: THREE.Mesh[]): string {
  const parts: string[] = [];
  for (const b of bodies) {
    const g = b.geometry;
    const mats = Array.isArray(b.material) ? b.material : [b.material];
    b.updateWorldMatrix(true, false);
    parts.push(
      [
        b.id,
        g.id,
        (g.getAttribute("position") as THREE.BufferAttribute).version ?? 0,
        g.index?.version ?? -1,
        mats.map(traceMaterialKey).join("+"),
        sampleSum(b.matrixWorld.elements),
        sampleSum((b.userData.owner as Owned).baseColors),
      ].join(":"),
    );
  }
  return parts.join("|");
}
