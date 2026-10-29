// The pick tree build shared by the main thread and raycastWorker.ts: a MeshBVH over plain arrays, serialised so it
// crosses to a worker and back without copying, and put on the real geometry with its index untouched.
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

/** `indirect: true` is load bearing: the default build reorders the index the face model is keyed on. */
export const PICK_TREE_OPTIONS = { indirect: true, targetLeafSize: 8 } as const;

export interface PickTreeJob {
  position: Float32Array;
  index: Uint32Array | Uint16Array;
}

export interface PickTree {
  roots: ArrayBuffer[];
  indirectBuffer: Uint32Array | Uint16Array | null;
}

export function buildPickTree(job: PickTreeJob): PickTree {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(job.position, 3));
  g.setIndex(new THREE.BufferAttribute(job.index, 1));
  const s = MeshBVH.serialize(new MeshBVH(g, PICK_TREE_OPTIONS), { cloneBuffers: false });
  return { roots: s.roots as ArrayBuffer[], indirectBuffer: (s.indirectBuffer as PickTree["indirectBuffer"]) ?? null };
}

/** The tree on `geo`, whose index it reads and never changes. */
export function attachPickTree(geo: THREE.BufferGeometry, tree: PickTree) {
  geo.boundsTree = MeshBVH.deserialize(
    {
      version: 1,
      roots: tree.roots,
      index: geo.getIndex()!.array,
      indirectBuffer: tree.indirectBuffer,
    } as unknown as Parameters<typeof MeshBVH.deserialize>[0],
    geo,
    { setIndex: false },
  );
}
