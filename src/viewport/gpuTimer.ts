// Per pass GPU time, read back a few frames late so it never stalls the frame.
//
// EXT_disjoint_timer_query_webgl2 allows one TIME_ELAPSED query at a time, so a
// pass inside another (the shadow maps inside the main render) pauses the outer
// one: every name reports its own time without its children.
// Without the extension only the period of the whole frame is known, from a
// GpuFence, and it is an upper bound at the polling granularity.

import { GpuFence } from "./gpuFence";

export type TimerKind = "timer-query" | "fence" | "none";

interface Pending {
  q: WebGLQuery;
  name: string;
  frame: number;
  epoch: number;
}

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

const MAX_PENDING = 64;

export class GpuTimer {
  readonly kind: TimerKind;
  private readonly gl: WebGL2RenderingContext | null;
  private readonly ext: TimerExt | null;
  private readonly fence: GpuFence | null;
  private pending: Pending[] = [];
  private stack: string[] = [];
  private active: { q: WebGLQuery; name: string } | null = null;
  private frameId = 0;
  private epoch = 0;
  private acc = new Map<string, number>();
  private accFrame = -1;
  private samples = new Map<string, number[]>();
  private marked = false;
  private markedAt = 0;

  constructor(
    gl: WebGL2RenderingContext | null,
    private readonly now: () => number = () => performance.now(),
    private readonly window = 31,
  ) {
    this.gl = gl;
    this.ext = (gl?.getExtension?.("EXT_disjoint_timer_query_webgl2") as TimerExt | null | undefined) ?? null;
    this.fence = !this.ext && gl ? new GpuFence(gl) : null;
    this.kind = this.ext ? "timer-query" : this.fence ? "fence" : "none";
  }

  /** Call once at the start of a frame: reads back what has finished. */
  frame(): void {
    this.frameId++;
    if (this.ext) this.poll();
    else if (this.fence && this.marked && this.fence.idle()) {
      this.marked = false;
      this.push("frame", this.now() - this.markedAt);
    }
  }

  /** Call once after the last command of a frame; only the fence fallback uses it. */
  endFrame(): void {
    if (!this.fence || this.marked) return;
    this.fence.mark();
    this.marked = true;
    this.markedAt = this.now();
  }

  begin(name: string): void {
    if (!this.ext) return;
    this.pause();
    this.stack.push(name);
    this.start(name);
  }

  /** `keep` false throws this segment away, for a pass that turned out to draw nothing. */
  end(name: string, keep = true): void {
    if (!this.ext || this.stack[this.stack.length - 1] !== name) return;
    this.pause(keep);
    this.stack.pop();
    const outer = this.stack[this.stack.length - 1];
    if (outer) this.start(outer);
  }

  /** Rolling median in ms per name, over the last `window` frames. */
  medians(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, xs] of this.samples) out[name] = median(xs);
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    if (gl && this.ext) {
      if (this.active) {
        gl.endQuery(this.ext.TIME_ELAPSED_EXT);
        gl.deleteQuery(this.active.q);
      }
      for (const p of this.pending) gl.deleteQuery(p.q);
    }
    this.active = null;
    this.pending = [];
    this.stack = [];
  }

  private start(name: string): void {
    const gl = this.gl!;
    const q = gl.createQuery();
    if (!q) return;
    gl.beginQuery(this.ext!.TIME_ELAPSED_EXT, q);
    this.active = { q, name };
  }

  private pause(keep = true): void {
    const a = this.active;
    if (!a) return;
    const gl = this.gl!;
    gl.endQuery(this.ext!.TIME_ELAPSED_EXT);
    this.active = null;
    if (!keep) {
      gl.deleteQuery(a.q);
      return;
    }
    this.pending.push({ q: a.q, name: a.name, frame: this.frameId, epoch: this.epoch });
    if (this.pending.length > MAX_PENDING) gl.deleteQuery(this.pending.shift()!.q);
  }

  private poll(): void {
    const gl = this.gl!;
    if (gl.getParameter(this.ext!.GPU_DISJOINT_EXT)) {
      // Every result in flight is invalid after a disjoint event.
      this.epoch++;
      for (const p of this.pending) gl.deleteQuery(p.q);
      this.pending = [];
      this.acc.clear();
      this.accFrame = -1;
      return;
    }
    while (this.pending.length) {
      const p = this.pending[0]!;
      if (p.epoch !== this.epoch) {
        gl.deleteQuery(p.q);
        this.pending.shift();
        continue;
      }
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT) as number;
      gl.deleteQuery(p.q);
      this.pending.shift();
      if (this.accFrame !== p.frame) this.commit();
      this.accFrame = p.frame;
      this.acc.set(p.name, (this.acc.get(p.name) ?? 0) + ns / 1e6);
    }
    const next = this.pending[0]?.frame ?? this.frameId;
    if (this.accFrame >= 0 && this.accFrame < next) this.commit();
  }

  private commit(): void {
    for (const [name, ms] of this.acc) this.push(name, ms);
    this.acc.clear();
    this.accFrame = -1;
  }

  private push(name: string, ms: number): void {
    let xs = this.samples.get(name);
    if (!xs) this.samples.set(name, (xs = []));
    xs.push(ms);
    if (xs.length > this.window) xs.shift();
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
