// A few workers that build the SAH trees, so a big body never stalls a frame.

import { mainThreadBuilder, type BlasBuilder, type BlasJob, type BlasTree } from "./blasCache";

interface Waiting {
  job: BlasJob;
  ok: (t: BlasTree) => void;
  fail: (e: Error) => void;
}

class WorkerPool implements BlasBuilder {
  private idle: Worker[] = [];
  private busy = new Map<number, { worker: Worker; w: Waiting }>();
  private queue: Waiting[] = [];
  private made = 0;
  private next = 0;

  constructor(private size: number) {}

  build(job: BlasJob): Promise<BlasTree> {
    return new Promise((ok, fail) => {
      this.queue.push({ job, ok, fail });
      this.pump();
    });
  }

  private spawn(): Worker {
    const w = new Worker(new URL("./blasWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<{ id: number; tree?: BlasTree; error?: string }>) => {
      const run = this.busy.get(e.data.id);
      if (!run) return;
      this.busy.delete(e.data.id);
      this.idle.push(w);
      if (e.data.tree) run.w.ok(e.data.tree);
      else run.w.fail(new Error(e.data.error ?? "BLAS build failed"));
      this.pump();
    };
    w.onerror = (e) => {
      for (const [id, run] of this.busy) {
        if (run.worker !== w) continue;
        this.busy.delete(id);
        run.w.fail(new Error(e.message || "BLAS worker error"));
      }
      w.terminate();
      this.made--;
      this.pump();
    };
    this.made++;
    return w;
  }

  private pump() {
    while (this.queue.length) {
      const worker = this.idle.pop() ?? (this.made < this.size ? this.spawn() : null);
      if (!worker) return;
      const w = this.queue.shift()!;
      const id = ++this.next;
      this.busy.set(id, { worker, w });
      worker.postMessage({ id, job: w.job }, [w.job.position.buffer, w.job.index.buffer]);
    }
  }

  dispose() {
    for (const w of this.idle) w.terminate();
    for (const { worker, w } of this.busy.values()) {
      worker.terminate();
      w.fail(new Error("BLAS pool closed"));
    }
    this.idle = [];
    this.busy.clear();
    this.queue = [];
    this.made = 0;
  }
}

export function createBlasBuilder(): BlasBuilder {
  if (typeof Worker === "undefined") return mainThreadBuilder;
  const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
  return new WorkerPool(Math.max(1, Math.min(4, Math.floor(cores / 2))));
}
