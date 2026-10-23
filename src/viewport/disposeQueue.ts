import type * as THREE from "three";
import { disposeBody, type ModelView } from "./render";
import { forgetRaycastIndex } from "./raycastIndex";

type Job = () => void;

/** GPU objects released a few milliseconds per frame, so letting go of a big
 *  model never stalls the frame that shows the empty view. */
export class DisposeQueue {
  private jobs: Job[] = [];
  private head = 0;
  private scheduled = false;

  constructor(
    private schedule: (run: () => void) => void = (run) => requestAnimationFrame(() => run()),
    private budgetMs = 4,
    private now: () => number = () => performance.now(),
  ) {}

  get pending(): number {
    return this.jobs.length - this.head;
  }

  add(jobs: Iterable<Job>) {
    for (const j of jobs) this.jobs.push(j);
    this.kick();
  }

  private kick() {
    if (this.scheduled || this.pending === 0) return;
    this.scheduled = true;
    this.schedule(this.run);
  }

  private run = () => {
    this.scheduled = false;
    const start = this.now();
    while (this.head < this.jobs.length) {
      const job = this.jobs[this.head]!;
      this.jobs[this.head++] = noop;
      try {
        job();
      } catch (e) {
        console.error("[viewport] dispose failed (continuing):", e);
      }
      if (this.now() - start >= this.budgetMs) break;
    }
    if (this.head === this.jobs.length) {
      this.jobs = [];
      this.head = 0;
    }
    this.kick();
  };
}

function noop() {}

/** Take every object of `view` out of `group` in one pass and hand its GPU
 *  objects to `queue`. Nothing of the model draws or picks after this returns. */
export function detachModel(group: THREE.Object3D, view: ModelView, queue: DisposeQueue) {
  const gone = new Set<THREE.Object3D>();
  for (const b of view.bodies) {
    gone.add(b.mesh);
    gone.add(b.edges.object);
    forgetRaycastIndex(b.mesh.geometry);
  }
  if (view.orphanEdges) gone.add(view.orphanEdges.object);
  // Object3D.remove is an indexOf and a splice per object, quadratic on a few
  // thousand bodies, so the children array is filtered once instead.
  const kept: THREE.Object3D[] = [];
  for (const c of group.children) {
    if (!gone.has(c)) {
      kept.push(c);
      continue;
    }
    c.parent = null;
    c.dispatchEvent({ type: "removed" });
    group.dispatchEvent({ type: "childremoved", child: c });
  }
  group.children = kept;
  const orphans = view.orphanEdges;
  queue.add(view.bodies.map((b) => () => disposeBody(b)));
  if (orphans) queue.add([() => orphans.dispose()]);
}
