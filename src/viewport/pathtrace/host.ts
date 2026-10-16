// Runs the tracer from the viewport's own loop: starts it the first time Path
// traced is drawn, keeps its canvas under the WebGL one, feeds it the mirror
// scene and the camera, and traces only while traceState says so.

import type * as THREE from "three";
import { SAMPLE_CAP, type TraceLook, type TracerBackend } from "./backend";
import type { TraceLens } from "./camera";
import { armGuard, clearGuard } from "./guard";
import { BlasCache, type BlasBuilder } from "./blasCache";
import { createBlasBuilder } from "./blasPool";
import {
  colorSignature, collectAllBodies, collectBodies, countTriangles, countVertices, materialSignature, sceneSignature,
  storageBytes, transformSignature, TRIANGLE_BUDGET,
} from "./mirror";
import { TraceGeneration, traceState, type TraceInputs, type TraceState } from "./state";

/** No sample this long after the tracer started reads as a hung GPU. */
export const FIRST_SAMPLE_TIMEOUT_MS = 10_000;

/** Out of Path traced this long frees the WebGPU device and the mirrored scene. */
export const IDLE_DISPOSE_MS = 60_000;

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
  look: () => TraceLook;
  lens: () => TraceLens | null;
}

export function lookSignature(l: TraceLook): string {
  const lights = l.lights.map((x) => [x.color.getHex(), x.intensity, ...x.position.toArray(), ...x.target.toArray()].join(","));
  return [
    lights.join(";"), l.background.toArray().join(","), l.environment.uuid, l.environment.version,
    l.brightness, l.toneMapping, l.exposure,
  ].join("|");
}

function lensSignature(l: TraceLens | null): string {
  return l ? `${l.focusDistance}:${l.apertureRadius}` : "";
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
  private cache: BlasCache;
  private hasScene = false;
  private geometryKey = "";
  private transforms = "";
  private materials = "";
  private colors = "";
  private look = "";
  private lens = "";
  private sceneDirty = true;
  private cameraDirty = true;
  private polling = false;
  private traceSince = 0;
  private sawSample = false;
  private size = { w: 0, h: 0, ratio: 0 };
  private refusedSig = "";
  private offSince = 0;
  /** The pending arm write, so a clear always lands after it. */
  private guardWrite: Promise<void> | null = null;

  constructor(
    private webglCanvas: HTMLCanvasElement,
    private create: CreateTracer = async () => (await import("./webgpuTracer")).createWebGpuTracer(),
    private guard: CrashGuard = { arm: armGuard, clear: clearGuard },
    builder: BlasBuilder = createBlasBuilder(),
  ) {
    this.cache = new BlasCache(builder);
  }

  /** Trees built so far, for the timing log. */
  get blasBuilds(): number {
    return this.cache.builds;
  }

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
    if (s === "off") {
      this.refusedSig = "";
      this.idle(f.now);
    } else this.offSince = 0;
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
    const lens = f.lens();
    const lensKey = lensSignature(lens);
    if (lensKey !== this.lens) this.cameraDirty = true;
    if (this.cameraDirty) {
      b.updateCamera(f.camera, lens);
      this.lens = lensKey;
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

  private idle(now: number) {
    if (!this.backend) return;
    if (!this.offSince) this.offSince = now;
    else if (now - this.offSince > IDLE_DISPOSE_MS) {
      this.offSince = 0;
      this.dispose();
    }
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
    const limit = this.backend?.maxStorageBytes ?? Infinity;
    const overDevice = storageBytes(tris, countVertices(bodies)) > limit;
    if (tris <= TRIANGLE_BUDGET && !overDevice) return false;
    const sig = sceneSignature(bodies);
    if (sig === this.refusedSig) return true;
    this.refusedSig = sig;
    this.hasScene = false;
    const has = (tris / 1e6).toFixed(1);
    this.note = overDevice
      ? `Path tracing needs more GPU memory than this device allows for a model of ${has} million triangles`
      : `Path tracing is limited to ${TRIANGLE_BUDGET / 1e6} million triangles for now, this model has ${has} million`;
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
        this.hasScene = false;
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

  /** False while the scene is refused or a tree is still building, so the
   *  Realtime frame stays up. Each kind of change takes the cheapest tracer
   *  call that covers it. */
  private syncScene(b: TracerBackend, f: TraceFrame): boolean {
    const bodies = collectBodies(f.root);
    if (this.refuseIfOver(bodies)) return false;
    const sync = this.cache.sync(bodies, collectAllBodies(f.root));
    if (!sync.meshes) return false;
    this.sceneDirty = false;
    const transforms = transformSignature(bodies);
    const materials = materialSignature(bodies);
    const colors = colorSignature(bodies);
    const geometry = !this.hasScene || sync.key !== this.geometryKey;
    const moved = transforms !== this.transforms;
    const restyled = materials !== this.materials;
    const painted = colors !== this.colors;
    const look = f.look();
    const lookKey = lookSignature(look);
    const relit = lookKey !== this.look;
    if (!geometry && !moved && !restyled && !painted && !relit) return true;
    if (geometry || moved) this.cache.syncTransforms();
    if (geometry || restyled) this.cache.syncMaterials();
    if (geometry || painted) this.cache.syncColors();
    if (!this.hasScene) {
      const lens = f.lens();
      b.setScene({ ...look, meshes: sync.meshes, lens }, f.camera);
      this.lens = lensSignature(lens);
      this.cameraDirty = false;
      this.hasScene = true;
    } else {
      if (geometry || painted) b.updateGeometry(sync.meshes);
      else {
        if (moved) b.updateTransforms();
        if (restyled) b.updateMaterials();
      }
      if (relit) b.updateLook(look);
    }
    this.look = lookKey;
    this.geometryKey = sync.key;
    this.transforms = transforms;
    this.materials = materials;
    this.colors = colors;
    this.note = "";
    this.refusedSig = "";
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
    this.hasScene = false;
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
    const b = this.backend;
    this.backend = null;
    this.samples = 0;
    this.hasScene = false;
    this.show(false);
    b?.dispose();
  }
}
