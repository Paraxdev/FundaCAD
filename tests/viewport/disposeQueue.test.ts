// New and Open used to free a whole model in one go, a long task that grew with
// the body count. The view now lets go of the model in the same call and the
// GPU objects follow a few at a time over the next frames.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { DisposeQueue, detachModel } from "../../src/viewport/disposeQueue";
import type { BodyMesh, ModelView } from "../../src/viewport/render";

function fakeModel(n: number, disposed: string[]): ModelView {
  const bodies = Array.from({ length: n }, (_, i) => {
    const geo = new THREE.BufferGeometry();
    geo.addEventListener("dispose", () => disposed.push(`b${i}`));
    const edgesObj = new THREE.Object3D();
    return {
      id: `b${i}`,
      mesh: new THREE.Mesh(geo, new THREE.MeshBasicMaterial()),
      edges: { object: edgesObj, dispose: () => disposed.push(`e${i}`) },
    } as unknown as BodyMesh;
  });
  return { bodies, edges: [], orphanEdges: null, box: new THREE.Box3() };
}

function frames() {
  const queued: (() => void)[] = [];
  let clock = 0;
  return {
    schedule: (run: () => void) => queued.push(run),
    // every dispose call "costs" 1 ms of the frame budget
    now: () => clock++,
    frame() {
      const run = queued.shift();
      run?.();
      return !!run;
    },
  };
}

describe("letting go of a model", () => {
  it("takes every body out of the scene at once and disposes nothing inline", () => {
    const disposed: string[] = [];
    const view = fakeModel(50, disposed);
    const group = new THREE.Group();
    const other = new THREE.Object3D();
    group.add(other);
    for (const b of view.bodies) group.add(b.mesh, b.edges.object);
    const f = frames();
    const q = new DisposeQueue(f.schedule, 4, f.now);

    detachModel(group, view, q);

    expect(group.children).toEqual([other]);
    expect(view.bodies.every((b) => b.mesh.parent === null && b.edges.object.parent === null)).toBe(true);
    expect(disposed).toEqual([]);
    expect(q.pending).toBe(50);
  });

  it("disposes over several frames within the budget, then stops asking for frames", () => {
    const disposed: string[] = [];
    const view = fakeModel(50, disposed);
    const group = new THREE.Group();
    for (const b of view.bodies) group.add(b.mesh, b.edges.object);
    const f = frames();
    const q = new DisposeQueue(f.schedule, 4, f.now);
    detachModel(group, view, q);

    let n = 0;
    let last = 0;
    while (f.frame()) {
      n++;
      expect(disposed.length - last).toBeLessThanOrEqual(2 * 4);
      last = disposed.length;
    }
    expect(n).toBeGreaterThan(5);
    expect(q.pending).toBe(0);
    expect(disposed.filter((d) => d.startsWith("b"))).toHaveLength(50);
    expect(disposed.filter((d) => d.startsWith("e"))).toHaveLength(50);
  });

  it("keeps going after a dispose that throws", () => {
    const f = frames();
    const q = new DisposeQueue(f.schedule, 100, f.now);
    const done: number[] = [];
    const err = console.error;
    console.error = () => {};
    try {
      q.add([() => done.push(1), () => { throw new Error("lost context"); }, () => done.push(3)]);
      while (f.frame());
    } finally {
      console.error = err;
    }
    expect(done).toEqual([1, 3]);
  });
});
