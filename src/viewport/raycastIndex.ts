// three's stock raycast scans every triangle: a hover pick on a 50,074 triangle textured cylinder took 2.60ms
// median. Patches THREE.Mesh.prototype on import; render.ts pulls this in at app load, before any pick.
import * as THREE from "three";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** `indirect: true` is load bearing: the default build reorders the index the face model is keyed on, so a
 *  cylinder's faceId 0 got triangles of all three faces. Prefer scheduleRaycastIndex over calling this. */
export function buildRaycastIndex(geo: THREE.BufferGeometry) {
  // A geometry with no index has nothing to accelerate against, and
  // computeBoundsTree would throw rather than no-op.
  if (!geo.getIndex()) return;
  geo.computeBoundsTree({ indirect: true, targetLeafSize: 8 });
}

/** Skipping this leaks the tree's typed arrays on every rebuild, which is every document change. */
export function disposeRaycastIndex(geo: THREE.BufferGeometry) {
  pending.delete(geo); // never build a tree for geometry that is already gone
  if (geo.boundsTree) geo.disposeBoundsTree();
}

/** A detached model's trees are never needed, so its idle builds stop before its GPU dispose comes round. */
export function forgetRaycastIndex(geo: THREE.BufferGeometry) {
  pending.delete(geo);
}

// Building every BVH inline in setModel took ~0.7 s of 2.26 s frozen (3,071 bodies), and a lazy build stalls the
// first mouse move, so trees build after the first paint in idle chunks; flushRaycastIndex covers an early pick.
const pending = new Set<THREE.BufferGeometry>();
let scheduled = false;

function drain(hasTime: () => boolean) {
  for (const geo of pending) {
    pending.delete(geo);
    buildRaycastIndex(geo);
    if (!hasTime()) break;
  }
  scheduled = false;
  if (pending.size) schedule();
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
  if (!geo.getIndex() || geo.boundsTree) return;
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
  if (!pending.size) return;
  drain(() => true);
}
