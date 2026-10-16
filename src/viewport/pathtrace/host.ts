// Runs the tracer from the viewport's own loop: starts it the first time Path
// traced is drawn, keeps its canvas under the WebGL one, feeds it the mirror
// scene and the camera, and traces only while traceState says so.

import type * as THREE from "three";
import { SAMPLE_CAP, type TraceScene, type TracerBackend } from "./backend";
import { armGuard, clearGuard } from "./guard";
import { collectBodies, countTriangles, mirrorBodies, sceneSignature, TRIANGLE_BUDGET } from "./mirror";
import { TraceGeneration, traceState, type TraceInputs, type TraceState } from "./state";

/** No sample this long after the tracer started reads as a hung GPU. */
export const FIRST_SAMPLE_TIMEOUT_MS = 10_000;

export interface CrashGuard {
  arm(): Promise<void>;
  clear(): void;
}

export interface TraceFrame {
  now: number;
  inputs: Omit<TraceInputs, "samples" | "cap">;
  camera: THREE.Camera;
  /** The camera moved or the canvas was resized since the last tick. */
  cameraChanged: boolean;
  /** Something asked for a redraw; the scene is compared and re-mirrored only
   *  when what the tracer sees differs. */
  sceneMaybeChanged: boolean;
  root: THREE.Object3D;
  look: () => Omit<TraceScene, "meshes">;
}

export type CreateTracer = () => Promise<TracerBackend>;

export class PathTraceHost {
  state: TraceState = "off";
  shown = false;
  samples = 0;
  /** Set after a second GPU fault; Path traced stays off until restart. */
  disabled = false;
  note = "";
  onShownChange: ((shown: boolean) => void) | null = null;
  onStateChange: ((s: TraceState) => void) | null = null;
  onFault: ((why: string, disabled: boolean) => void) | null = null;
  /** The model is too big to trace; not a fault, Path traced stays available. */
  onRefuse: ((why: string) => void) | null = null;

  private backend: TracerBackend | null = null;
  private starting = false;
  private faults = 0;
  private gen = new TraceGeneration();
  private signature = "";
  private sceneDirty = true;
  private cameraDirty = true;
  private polling = false;
  private traceSince = 0;
  private sawSample = false;
  private size = { w: 0, h: 0, ratio: 0 };
  private refusedSig = "";
  /** The pending arm write, so a clear always lands after it. */
  private guardWrite: Promise<void> | null = null;

  constructor(
    private webglCanvas: HTMLCanvasElement,
    private create: CreateTracer = async () => (await import("./webgpuTracer")).createWebGpuTracer(),
    private guard: CrashGuard = { arm: armGuard, clear: clearGuard },
  ) {}

  get backendName(): string {
    return this.backend?.name ?? "";
  }

  tick(f: TraceFrame) {
    if (f.cameraChanged) this.cameraDirty = true;
    if (f.sceneMaybeChanged) this.sceneDirty = true;
    const s = this.disabled ? "off" : traceState({ ...f.inputs, samples: this.samples, cap: SAMPLE_CAP });
    if (s !== this.state) {
      this.state = s;
      this.onStateChange?.(s);
    }
    if (s === "off") this.refusedSig = "";
    if (s !== "trace" && s !== "done") {
      this.traceSince = 0;
      if (!this.sawSample) this.disarm();
      return this.show(false);
    }
    const b = this.backend;
    if (!b) {
      if (!this.starting && this.refuseIfOver(collectBodies(f.root))) return this.show(false);
      this.start();
      return this.show(false);
    }
    if (s === "trace" && !this.sawSample) this.arm();
    this.syncCanvas(b);
    if (this.sceneDirty && !this.syncScene(b, f)) return this.show(false);
    this.watchdog(f.now, s);
    if (this.cameraDirty) {
      b.updateCamera(f.camera);
      this.restart();
      this.cameraDirty = false;
    }
    if (s === "trace") {
      b.renderSample();
      this.poll(b);
    }
    this.show(this.samples > 0);
  }

  private show(on: boolean) {
    if (on === this.shown) return;
    this.shown = on;
    this.onShownChange?.(on);
  }

  private restart() {
    this.samples = 0;
    this.gen.bump();
    this.backend?.reset();
  }

  private arm(): Promise<void> {
    this.guardWrite ??= this.guard.arm();
    return this.guardWrite;
  }

  private disarm() {
    const w = this.guardWrite;
    if (!w) return;
    this.guardWrite = null;
    const clear = () => this.guard.clear();
    void w.then(clear, clear);
  }

  /** Over the budget the tracer is never fed; said once per model, as a note. */
  private refuseIfOver(bodies: THREE.Mesh[]): boolean {
    const tris = countTriangles(bodies);
    if (tris <= TRIANGLE_BUDGET) return false;
    const sig = sceneSignature(bodies);
    if (sig === this.refusedSig) return true;
    this.refusedSig = sig;
    this.signature = "";
    this.note = `Path tracing is limited to 2 million triangles for now, this model has ${(tris / 1e6).toFixed(1)} million`;
    this.samples = 0;
    this.traceSince = 0;
    this.disarm();
    this.onRefuse?.(this.note);
    return true;
  }

  private start() {
    if (this.starting) return;
    this.starting = true;
    this.sawSample = false;
    void (async () => {
      try {
        await this.arm();
        const b = await this.create();
        b.onFault((why) => this.fault(why));
        this.webglCanvas.parentElement?.insertBefore(b.canvas, this.webglCanvas);
        const st = b.canvas.style;
        st.position = "absolute";
        st.pointerEvents = "none";
        this.webglCanvas.style.position = "relative";
        this.backend = b;
        this.sceneDirty = this.cameraDirty = true;
        this.signature = "";
        this.size = { w: 0, h: 0, ratio: 0 };
      } catch (e) {
        this.fault(`Path tracing could not start: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.starting = false;
      }
    })();
  }

  private syncCanvas(b: TracerBackend) {
    const c = this.webglCanvas;
    const w = c.clientWidth;
    const h = c.clientHeight;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 1);
    const st = b.canvas.style;
    st.left = `${c.offsetLeft}px`;
    st.top = `${c.offsetTop}px`;
    if (w === this.size.w && h === this.size.h && ratio === this.size.ratio) return;
    this.size = { w, h, ratio };
    b.setSize(Math.max(1, w), Math.max(1, h), ratio);
    this.cameraDirty = true;
  }

  /** False while the scene is refused, so nothing is traced. */
  private syncScene(b: TracerBackend, f: TraceFrame): boolean {
    const bodies = collectBodies(f.root);
    if (this.refuseIfOver(bodies)) return false;
    this.sceneDirty = false;
    const sig = sceneSignature(bodies);
    if (sig === this.signature) return true;
    this.signature = sig;
    this.note = "";
    this.refusedSig = "";
    b.setScene({ ...f.look(), meshes: mirrorBodies(bodies) }, f.camera);
    this.cameraDirty = false;
    this.restart();
    return true;
  }

  private poll(b: TracerBackend) {
    if (this.polling) return;
    this.polling = true;
    const gen = this.gen.current;
    b.samples().then(
      (n) => {
        this.polling = false;
        if (!this.gen.isCurrent(gen) || this.backend !== b) return;
        this.samples = n;
        if (n > 0 && !this.sawSample) {
          this.sawSample = true;
          this.disarm();
        }
      },
      () => {
        this.polling = false;
      },
    );
  }

  private watchdog(now: number, s: TraceState) {
    if (this.sawSample || s !== "trace") {
      this.traceSince = 0;
      return;
    }
    if (!this.traceSince) this.traceSince = now;
    else if (now - this.traceSince > FIRST_SAMPLE_TIMEOUT_MS) this.fault("Path tracing gathered no sample in 10 seconds");
  }

  private fault(why: string) {
    this.faults++;
    this.disabled = this.faults >= 2;
    const b = this.backend;
    this.backend = null;
    this.samples = 0;
    this.traceSince = 0;
    this.show(false);
    try {
      b?.dispose();
    } catch { /* already gone with the device */ }
    this.disarm();
    this.onFault?.(why, this.disabled);
  }

  dispose() {
    this.backend?.dispose();
    this.backend = null;
  }
}
