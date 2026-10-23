// Box bodies built as the engine's rebuild reply, for picking tests with real body meshes and edge lines.
import * as THREE from "three";
import { buildBodyMesh, type ModelView } from "../../src/viewport/render";
import type { RebuildResult } from "../../src/types";

export interface Lump {
  id: string;
  body: string;
  size: readonly [number, number, number];
  m: THREE.Matrix4;
}

// Six faces and twelve edges per lump, numbered in order; a body's lumps are listed together.
export function boxReply(lumps: readonly Lump[]): RebuildResult {
  const positions: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const edges: RebuildResult["edges"] = [];
  const box = new THREE.Box3();
  const bodies: NonNullable<RebuildResult["bodies"]> = [];
  lumps.forEach((p, n) => {
    const g = new THREE.BoxGeometry(...p.size).applyMatrix4(p.m);
    const base = positions.length / 3;
    positions.push(...g.getAttribute("position").array);
    const idx = g.getIndex()!.array;
    for (let i = 0; i < idx.length; i++) indices.push(base + idx[i]!);
    for (let t = 0; t < idx.length / 3; t++) faceIds.push(n * 6 + Math.floor(t / 2));
    const lines = new THREE.EdgesGeometry(g).getAttribute("position");
    for (let i = 0; i < lines.count; i += 2) {
      const a = new THREE.Vector3().fromBufferAttribute(lines, i);
      const c = new THREE.Vector3().fromBufferAttribute(lines, i + 1);
      edges.push({ id: `${p.id}-e${i / 2}`, points: [a.toArray(), c.toArray()], body: p.body });
    }
    g.computeBoundingBox();
    box.union(g.boundingBox!);
    const last = bodies[bodies.length - 1];
    if (last?.id === p.body) last.faceCount += 6;
    else bodies.push({ id: p.body, name: p.body, faceStart: n * 6, faceCount: 6 });
  });
  return {
    mesh: { positions, indices, faceIds },
    edges,
    bbox: { min: box.min.toArray(), max: box.max.toArray() },
    bodies,
  };
}

// An open sheet of one face, a quad whose corners wind round its front, as a surface body is.
export function withSheet(r: RebuildResult, body: string, corners: readonly THREE.Vector3[]): RebuildResult {
  const base = r.mesh.positions.length / 3;
  const face = r.mesh.faceIds.length ? Math.max(...r.mesh.faceIds) + 1 : 0;
  const box = new THREE.Box3(new THREE.Vector3(...r.bbox.min), new THREE.Vector3(...r.bbox.max)).union(
    new THREE.Box3().setFromPoints([...corners]),
  );
  return {
    ...r,
    mesh: {
      positions: [...r.mesh.positions, ...corners.flatMap((c) => c.toArray())],
      indices: [...r.mesh.indices, base, base + 1, base + 2, base, base + 2, base + 3],
      faceIds: [...r.mesh.faceIds, face, face],
    },
    bbox: { min: box.min.toArray(), max: box.max.toArray() },
    bodies: [...(r.bodies ?? []), { id: body, name: body, faceStart: face, faceCount: 1 }],
  };
}

export function boxView(lumps: readonly Lump[], w: number, h: number): ModelView {
  return replyView(boxReply(lumps), w, h);
}

export function replyView(r: RebuildResult, w: number, h: number): ModelView {
  const res = new THREE.Vector2(w, h);
  const bodies = r.bodies!.map((b) =>
    buildBodyMesh(
      r,
      b,
      r.edges.filter((e) => e.body === b.id),
      res,
      undefined,
    ),
  );
  return {
    bodies,
    edges: [],
    orphanEdges: null,
    box: new THREE.Box3(new THREE.Vector3(...r.bbox.min), new THREE.Vector3(...r.bbox.max)),
  };
}

export const placed = (at: THREE.Vector3, rot: THREE.Euler) =>
  new THREE.Matrix4().compose(at, new THREE.Quaternion().setFromEuler(rot), new THREE.Vector3(1, 1, 1));

// One body of two lumps off the origin and turned: a tall block, and a low step beside it whose top lies below a cut
// through the tall block's middle, as a pocket floor seen past the cap does. Faces: tall 0 to 5, low 6 to 11, in
// BoxGeometry's order (+x, -x, +y, -y, +z, -z).
export const STEP_FRAME = placed(new THREE.Vector3(63, -21, 14), new THREE.Euler(0.15, -0.1, 0.35));
export const STEP: Lump[] = [
  {
    id: "tall",
    body: "step",
    size: [40, 30, 36],
    m: STEP_FRAME.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, 18)),
  },
  {
    id: "low",
    body: "step",
    size: [24, 30, 10],
    m: STEP_FRAME.clone().multiply(new THREE.Matrix4().makeTranslation(36, 0, 5)),
  },
];
export const STEP_FACES = { tallTop: 4, tallBottom: 5, lowTop: 10 };
export const stepPoint = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(STEP_FRAME);
/** Keeps the step's bottom, cutting the tall block at 20 of its 36. */
export const STEP_CUT = new THREE.Plane(new THREE.Vector3(0, 0, -1), 20).applyMatrix4(STEP_FRAME);

/** Above the step, looking down on it a little slanted. */
export function stepCamera(w: number, h: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
  c.position.copy(stepPoint(-10, 25, 160));
  c.lookAt(stepPoint(0, 0, 10));
  c.updateMatrixWorld(true);
  c.updateProjectionMatrix();
  return c;
}
