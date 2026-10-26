// A big body's pick tree is built in a worker: on the main thread a 3.5M triangle tree was one task of about a
// second. A stand in Worker runs the real worker build, so these check the hand off, not the threading.
import { afterAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildPickTree, type PickTreeJob } from "../../src/viewport/pickTree";

// Replies only when the test says, so a test decides what lands first.
const held: (() => void)[] = [];
const deliver = () => {
  for (const f of held.splice(0)) f();
};
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage(data: { id: number; job: PickTreeJob }) {
    held.push(() => this.onmessage?.({ data: { id: data.id, tree: buildPickTree(data.job) } } as MessageEvent));
  }
  terminate() {}
}
const had = (globalThis as { Worker?: unknown }).Worker;
(globalThis as { Worker?: unknown }).Worker = FakeWorker;
afterAll(() => {
  (globalThis as { Worker?: unknown }).Worker = had;
});

const { WORKER_TRIS, flushRaycastIndex, raycastIndexStats, scheduleRaycastIndex } =
  await import("../../src/viewport/raycastIndex");

const big = () => {
  const g = new THREE.TorusGeometry(60, 20, 200, 300);
  expect(g.index!.count / 3).toBeGreaterThan(WORKER_TRIS);
  return g;
};
const settle = async (done: () => boolean) => {
  for (let i = 0; i < 500 && !done(); i++) await new Promise((r) => setTimeout(r, 2));
};
const hitOf = (g: THREE.BufferGeometry) => {
  const rc = new THREE.Raycaster(new THREE.Vector3(0, -200, 3), new THREE.Vector3(0, 1, 0));
  return rc.intersectObject(new THREE.Mesh(g))[0];
};

describe("the pick tree of a big body", () => {
  it("is built in the worker, not on the main thread, and picks what a main thread tree picks", async () => {
    const g = big();
    const index = Array.from(g.index!.array);
    const main = raycastIndexStats.mainBuilds;
    const jobs = raycastIndexStats.workerJobs;
    scheduleRaycastIndex(g);
    await settle(() => raycastIndexStats.workerJobs > jobs);
    expect(g.boundsTree).toBeUndefined();
    deliver();
    expect(g.boundsTree).toBeDefined();
    expect(raycastIndexStats.mainBuilds).toBe(main);
    expect(Array.from(g.index!.array)).toEqual(index);

    const ref = big();
    ref.computeBoundsTree({ indirect: true, targetLeafSize: 8 });
    const a = hitOf(g)!;
    const b = hitOf(ref)!;
    expect(a.faceIndex).toBe(b.faceIndex);
    expect(a.distance).toBeCloseTo(b.distance, 9);
  });

  it("is built at once for a pick that comes first, and the worker's late copy is dropped", async () => {
    const g = big();
    const jobs = raycastIndexStats.workerJobs;
    scheduleRaycastIndex(g);
    await settle(() => raycastIndexStats.workerJobs > jobs);
    expect(g.boundsTree).toBeUndefined();
    flushRaycastIndex();
    const tree = g.boundsTree;
    expect(tree).toBeDefined();
    deliver();
    expect(g.boundsTree).toBe(tree);
  });
});
