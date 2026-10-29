// three's stock raycast scans every triangle: a hover pick on a 50,074 triangle textured cylinder took 2.60ms
// median. Patches THREE.Mesh.prototype on import; render.ts pulls this in at app load, before any pick.
import * as THREE from "three";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import { attachPickTree, PICK_TREE_OPTIONS, type PickTree, type PickTreeJob } from "./pickTree";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** `indirect: true` is load bearing: the default build reorders the index the face model is keyed on, so a
 *  cylinder's faceId 0 got triangles of all three faces. Prefer scheduleRaycastIndex over calling this. */
export function buildRaycastIndex(geo: THREE.BufferGeometry) {
  // A geometry with no index has nothing to accelerate against, and
  // computeBoundsTree would throw rather than no-op.
  if (!geo.getIndex()) return;
  raycastIndexStats.mainBuilds++;
  geo.computeBoundsTree(PICK_TREE_OPTIONS);
}

/** Skipping this leaks the tree's typed arrays on every rebuild, which is every document change. */
export function disposeRaycastIndex(geo: THREE.BufferGeometry) {
  pending.delete(geo); // never build a tree for geometry that is already gone
  dropFromWorker(geo);
  if (geo.boundsTree) geo.disposeBoundsTree();
}

/** A detached model's trees are never needed, so its idle builds stop before its GPU dispose comes round. */
export function forgetRaycastIndex(geo: THREE.BufferGeometry) {
  pending.delete(geo);
  dropFromWorker(geo);
}

// Building every BVH inline in setModel took ~0.7 s of 2.26 s frozen (3,071 bodies), and a lazy build stalls the
// first mouse move, so trees build after the first paint in idle chunks; flushRaycastIndex covers an early pick.
const pending = new Set<THREE.BufferGeometry>();
let scheduled = false;

function drain(hasTime: () => boolean) {
  for (const geo of pending) {
    pending.delete(geo);
    if (forWorker(geo)) {
      waiting.add(geo);
      pump();
    } else buildRaycastIndex(geo);
    if (!hasTime()) break;
  }
  scheduled = false;
  if (pending.size) schedule();
}

// A tree over 3.5M triangles took about a second on the main thread, one long task, so a body this big builds its
// tree in a worker from copies of its arrays. A pick before it lands builds it here instead (flushRaycastIndex).
export const WORKER_TRIS = 100_000;
// One job at a time, copied only as it is posted: a queue of copies held about 1 GB for ten 100 MB bodies.
const waiting = new Set<THREE.BufferGeometry>();
let current: { geo: THREE.BufferGeometry | null; id: number } | null = null;
let worker: Worker | null = null;
let workerBroken = false;
let nextJob = 0;

/** Counters a test reads. */
export const raycastIndexStats = { workerJobs: 0, mainBuilds: 0 };

function pickWorker(): Worker | null {
  if (worker || workerBroken || typeof Worker === "undefined") return worker;
  try {
    worker = new Worker(new URL("./raycastWorker.ts", import.meta.url), { type: "module" });
  } catch {
    workerBroken = true;
    return null;
  }
  worker.onmessage = (e: MessageEvent<{ id: number; tree?: PickTree; error?: string }>) => {
    if (!current || current.id !== e.data.id) return;
    const geo = current.geo;
    current = null;
    if (geo && !geo.boundsTree) {
      if (e.data.tree) attachPickTree(geo, e.data.tree);
      else buildRaycastIndex(geo);
    }
    pump();
  };
  const broken = () => {
    workerBroken = true;
    worker?.terminate();
    worker = null;
    // Whatever was on its way comes back to the idle queue, to be built here.
    if (current?.geo) pending.add(current.geo);
    current = null;
    for (const geo of waiting) pending.add(geo);
    waiting.clear();
    schedule();
  };
  worker.onerror = broken;
  worker.onmessageerror = broken;
  return worker;
}

function forWorker(geo: THREE.BufferGeometry): boolean {
  const index = geo.getIndex();
  const pos = geo.getAttribute("position");
  if (!index || !pos || index.count / 3 < WORKER_TRIS) return false;
  if ((pos as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute || pos.itemSize !== 3) return false;
  if (!(pos.array instanceof Float32Array)) return false;
  if (!(index.array instanceof Uint32Array || index.array instanceof Uint16Array)) return false;
  return pickWorker() !== null;
}

/** Posts the next waiting body when the worker is free. */
function pump() {
  if (current) return;
  const w = pickWorker();
  for (const geo of waiting) {
    waiting.delete(geo);
    if (geo.boundsTree) continue;
    if (!w) {
      buildRaycastIndex(geo);
      continue;
    }
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const job: PickTreeJob = {
      position: (pos.array as Float32Array).slice(),
      index: (geo.getIndex()!.array as Uint32Array | Uint16Array).slice(),
    };
    current = { geo, id: ++nextJob };
    raycastIndexStats.workerJobs++;
    w.postMessage({ id: current.id, job }, [job.position.buffer, job.index.buffer]);
    return;
  }
}

function dropFromWorker(geo: THREE.BufferGeometry) {
  waiting.delete(geo);
  if (current?.geo === geo) current.geo = null;
}

function schedule() {
  if (scheduled || !pending.size) return;
  scheduled = true;
  if (typeof globalThis.requestIdleCallback === "function") {
    // timeout so a permanently busy main thread still gets the trees built
    globalThis.requestIdleCallback((d) => drain(() => d.timeRemaining() > 1), { timeout: 500 });
    return;
  }
  // WebKitGTK has no requestIdleCallback: fall back to a macrotask and bound
  // the chunk by wall clock so one slice can't become its own long task.
  setTimeout(() => {
    const t0 = performance.now();
    drain(() => performance.now() - t0 < 8);
  }, 0);
}

/** Queue a body geometry's BVH to be built after the current frame paints. */
export function scheduleRaycastIndex(geo: THREE.BufferGeometry) {
  if (!geo.getIndex() || geo.boundsTree || waiting.has(geo) || current?.geo === geo) return;
  pending.add(geo);
  if (scheduled) return;
  // One rAF first, so the model paints before any main thread goes to trees. Headless callers (vitest)
  // have no rAF and fall through to the idle path.
  if (typeof globalThis.requestAnimationFrame !== "function") {
    schedule();
    return;
  }
  scheduled = true;
  globalThis.requestAnimationFrame(() => {
    scheduled = false;
    schedule();
  });
}

/** Called before a pick so an interaction never falls back to the brute force raycast. */
export function flushRaycastIndex() {
  // A tree waiting for or in the worker is built here too, the worker's copy is dropped when it lands.
  if (current?.geo && !current.geo.boundsTree) buildRaycastIndex(current.geo);
  for (const geo of waiting) if (!geo.boundsTree) buildRaycastIndex(geo);
  waiting.clear();
  for (const geo of pending) {
    pending.delete(geo);
    buildRaycastIndex(geo);
  }
}
