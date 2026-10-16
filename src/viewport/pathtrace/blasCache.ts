// One mirror mesh per traced body, kept across edits and across the tracer's
// idle disposal. The key changes exactly when the body's triangles do, so an
// edit to one body builds one SAH tree, off the main thread, while every other
// body keeps the tree it has.

import * as THREE from "three";
import { MeshBVH, SAH } from "three-mesh-bvh";
import { bodyColorKey, copyMirrorColors, mirrorBody, refreshMirrorMaterials, type SurfaceBaker } from "./mirror";

export interface BlasJob {
  position: Float32Array;
  index: Uint32Array;
  groups: { start: number; count: number }[];
}

export interface BlasTree {
  roots: ArrayBuffer[];
  index: Uint32Array;
}

export interface BlasBuilder {
  build(job: BlasJob): BlasTree | Promise<BlasTree>;
  dispose(): void;
}

/** The options three-gpu-pathtracer builds a missing tree with, so ours is the
 *  same tree it would have made. */
export const BLAS_OPTIONS = { strategy: SAH, targetLeafSize: 5 } as const;

export function buildBlas(job: BlasJob): BlasTree {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(job.position, 3));
  g.setIndex(new THREE.BufferAttribute(job.index, 1));
  for (const gr of job.groups) g.addGroup(gr.start, gr.count);
  const s = MeshBVH.serialize(new MeshBVH(g, BLAS_OPTIONS), { cloneBuffers: false });
  return { roots: s.roots as ArrayBuffer[], index: s.index as Uint32Array };
}

export const mainThreadBuilder: BlasBuilder = { build: buildBlas, dispose() {} };

interface Owner {
  id?: string;
  etag?: string;
}

export function blasKey(m: THREE.Mesh): string {
  const o = m.userData.owner as Owner;
  const g = m.geometry;
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  return `${o.id ?? m.id}:${o.etag ?? ""}:${g.id}:${pos.version}:${g.index?.version ?? -1}`;
}

function positionCopy(g: THREE.BufferGeometry): Float32Array {
  const a = g.getAttribute("position");
  if (a instanceof THREE.BufferAttribute && a.array instanceof Float32Array && a.itemSize === 3) return a.array.slice();
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) {
    out[i * 3] = a.getX(i);
    out[i * 3 + 1] = a.getY(i);
    out[i * 3 + 2] = a.getZ(i);
  }
  return out;
}

function indexCopy(g: THREE.BufferGeometry): Uint32Array {
  if (g.index) return Uint32Array.from(g.index.array as ArrayLike<number>);
  const out = new Uint32Array(g.getAttribute("position").count);
  for (let i = 0; i < out.length; i++) out[i] = i;
  return out;
}

interface Entry {
  src: THREE.Mesh;
  mirror: THREE.Mesh;
  ready: boolean;
  colorKey: string;
}

export interface CacheSync {
  /** The visible bodies' mirrors in order, null while a tree is still building. */
  meshes: THREE.Mesh[] | null;
  /** Changes when the set of traced triangles does. */
  key: string;
}

export class BlasCache {
  /** Trees asked for, for the tests and the timing log. */
  builds = 0;
  private entries = new Map<string, Entry>();

  constructor(private builder: BlasBuilder) {}

  /** `all` keeps hidden bodies' trees for when they are shown again. */
  sync(visible: THREE.Mesh[], all: THREE.Mesh[]): CacheSync {
    const keep = new Set<string>();
    for (const m of all) keep.add(blasKey(m));
    const keys: string[] = [];
    const meshes: THREE.Mesh[] = [];
    let pending = false;
    for (const m of visible) {
      const k = blasKey(m);
      keep.add(k);
      keys.push(k);
      let e = this.entries.get(k);
      if (!e) e = this.add(k, m);
      e.src = m;
      if (!e.ready) pending = true;
      meshes.push(e.mirror);
    }
    for (const [k, e] of this.entries) {
      if (keep.has(k)) continue;
      this.entries.delete(k);
      disposeMirror(e.mirror);
    }
    return { meshes: pending ? null : meshes, key: keys.join("|") };
  }

  /** Copies each body's placement onto its mirror. */
  syncTransforms() {
    for (const e of this.entries.values()) {
      e.src.updateWorldMatrix(true, false);
      e.mirror.matrix.copy(e.src.matrixWorld);
      e.mirror.matrixWorld.copy(e.src.matrixWorld);
    }
  }

  syncMaterials() {
    for (const e of this.entries.values()) refreshMirrorMaterials(e.mirror, e.src);
  }

  /** Only bodies whose base colours or surfaces changed since their copy was
   *  made; a new body with a surface is baked here, mirrorBody has no renderer. */
  syncColors(bake?: SurfaceBaker) {
    for (const e of this.entries.values()) {
      const k = bodyColorKey(e.src);
      if (k === e.colorKey) continue;
      e.colorKey = k;
      const mats = Array.isArray(e.src.material) ? e.src.material : [e.src.material];
      const surfaced = mats.some((m) => m.userData.surfKey);
      copyMirrorColors(e.mirror, e.src, bake && surfaced ? bake(e.src) : null);
      refreshMirrorMaterials(e.mirror, e.src);
    }
  }

  private add(key: string, src: THREE.Mesh): Entry {
    const mirror = mirrorBody(src, false);
    const e: Entry = { src, mirror, ready: false, colorKey: "" };
    this.entries.set(key, e);
    const g = src.geometry;
    const job: BlasJob = {
      position: positionCopy(g),
      index: indexCopy(g),
      groups: g.groups.map((gr) => ({ start: gr.start, count: gr.count })),
    };
    this.builds++;
    const land = (t: BlasTree) => {
      if (this.entries.get(key) !== e) return;
      const geo = mirror.geometry;
      geo.setIndex(new THREE.BufferAttribute(t.index, 1));
      (geo as unknown as { boundsTree: MeshBVH }).boundsTree = MeshBVH.deserialize(
        { version: 1, roots: t.roots, index: t.index, indirectBuffer: null } as unknown as Parameters<typeof MeshBVH.deserialize>[0],
        geo,
        { setIndex: false },
      );
      e.ready = true;
    };
    const out = this.builder.build(job);
    if (out instanceof Promise) {
      out.then(
        land,
        (err) => {
          if (this.entries.get(key) !== e) return;
          console.warn("BLAS worker build failed, building on the main thread", err);
          land(buildBlas({ ...job, position: positionCopy(g), index: indexCopy(g) }));
        },
      );
    } else land(out);
    return e;
  }

  dispose() {
    for (const e of this.entries.values()) disposeMirror(e.mirror);
    this.entries.clear();
    this.builder.dispose();
  }
}

function disposeMirror(m: THREE.Mesh) {
  m.geometry.dispose();
  (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
}
