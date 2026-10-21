// Runs the tracer from the viewport's own loop: starts it the first time Path
// traced is drawn, keeps its canvas under the WebGL one, feeds it the mirror
// scene and the camera, and traces only while traceState says so.

import type * as THREE from "three";
import type { Denoise } from "../../ui/renderPrefs";
import { SAMPLE_CAP, type TraceLook, type TracerBackend } from "./backend";
import { costProfile, FrameBudget, renderScaleFor, tracedPictureScale } from "./budget";
import type { TraceLens } from "./camera";
import { armGuard, clearGuard } from "./guard";
import { BlasCache, type BlasBuilder } from "./blasCache";
import { createBlasBuilder } from "./blasPool";
import {
  colorSignature, collectAllBodies, collectBodies, countTriangles, countVertices, materialSignature, sceneSignature,
  storageBytes, transformSignature, TRIANGLE_BUDGET, type SurfaceBaker,
} from "./mirror";
import { STILL_MS, TraceGeneration, traceState, type TraceInputs, type TraceState } from "./state";
import { bloomKey, traceBloom } from "./tracePost";

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
  inputs: Omit<TraceInputs, "samples" | "cap" | "editing">;
  camera: THREE.Camera;
  /** The camera moved or the canvas was resized since the last tick. */
  cameraChanged: boolean;
  /** Something asked for a redraw; the scene is compared and re-mirrored only
   *  when what the tracer sees differs. */
  sceneMaybeChanged: boolean;
  root: THREE.Object3D;
  look: () => TraceLook;
  lens: () => TraceLens | null;
  /** Evaluates procedural surfaces for the mirror's vertex colours. */
  bake?: SurfaceBaker;
  denoise?: Denoise;
  /** The Bloom slider, 0..1. */
  bloom?: number;
  /** Something on screen can reach the bloom threshold, as for Realtime. */
  bloomable?: boolean;
}

export function lookSignature(l: TraceLook): string {
  const lights = l.lights.map((x) => [x.color.getHex(), x.intensity, ...x.position.toArray(), ...x.target.toArray()].join(","));
  const rig = (l.rig?.lights ?? []).map((x) => [...x.direction, x.colour, x.intensity, x.angularRadius, x.realtimeOnly ? 1 : 0].join(","));
  const g = l.rig?.ground;
  const ground = g ? [g.mode, g.z, ...g.centre, g.extent, g.albedo].join(",") : "";
  return [
    lights.join(";"), rig.join(";"), ground, l.background.toArray().join(","), l.environment.uuid, l.environment.version, l.environmentBehind ? 1 : 0,
    l.brightness, l.toneMapping, l.exposure,
  ].join("|");
}

function lensSignature(l: TraceLens | null): string {
  return l ? `${l.focusDistance}:${l.apertureRadius}` : "";
}

export type CreateTracer = () => Promise<TracerBackend>;

export interface Power {
  /** On battery and not charging. */
  discharging: boolean;
}

export interface PictureRequest {
  /** Multiple of the viewport's size, lowered to what the GPU can hold. */
  scale: number;
  samples: number;
  signal?: AbortSignal;
  onProgress?: (samples: number) => void;
}

export class PathTraceHost {
  state: TraceState = "off";
  shown = false;
  samples = 0;
  /** A traced picture holds the tracer. */
  picturing = false;
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
  /** At the cap the final denoise and its crossfade are drawn, then nothing. */
  private settled = false;
  private denoiseLevel: Denoise | "" = "";
  private bloom = "";
  private background: THREE.Color | null = null;
  /** The pending arm write, so a clear always lands after it. */
  private guardWrite: Promise<void> | null = null;
  private power: Power = { discharging: false };
  private cap = SAMPLE_CAP;
  private renderScale = 0;
  private budget = new FrameBudget(Infinity);
  /** The last frame is still on the GPU; the next waits for it, so a slow GPU
   *  is never queued more work than it finishes. */
  private inFlight = false;
  private measured: number | null = null;
  private budgetSent = false;
  /** When the traced scene last changed under an edit, a rebuild or a tool drag. */
  private editedAt = -Infinity;
  private preview = false;

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

  get denoised(): boolean {
    return this.shown && (this.backend?.denoised ?? false);
  }

  tick(f: TraceFrame) {
    if (f.cameraChanged) this.cameraDirty = true;
    if (f.sceneMaybeChanged) this.sceneDirty = true;
    const editing = f.now - this.editedAt < STILL_MS;
    const s = this.disabled ? "off" : traceState({ ...f.inputs, editing, samples: this.samples, cap: this.cap });
    // Realtime while moving off: the last traced picture stays up through a
    // restart, the tracer's canvas keeps it until the first new sample lands.
    const hold = f.inputs.realtimeWhileMoving === false;
    if (s !== this.state) {
      this.state = s;
      this.onStateChange?.(s);
    }
    if (this.picturing) {
      this.offSince = 0;
      return this.show(false);
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
    if (hold !== this.preview) {
      this.preview = hold;
      b.setMotionPreview?.(hold);
    }
    this.syncCanvas(b);
    if (this.sceneDirty && !this.syncScene(b, f)) return this.show(hold && this.shown && this.hasScene);
    if (!hold && f.now - this.editedAt < STILL_MS) {
      this.traceSince = 0;
      return this.show(false);
    }
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
    const level = f.denoise ?? "standard";
    if (level !== this.denoiseLevel) {
      b.setDenoise(level);
      this.denoiseLevel = level;
      this.settled = false;
    }
    this.syncBloom(b, f);
    if (this.measured !== null) {
      if (this.budget.frame(this.measured, f.now)) b.setFrameBudget(this.budget.budget);
      this.measured = null;
    }
    if (s === "trace") {
      if (!this.inFlight) this.traceFrame(b);
      this.poll(b);
    } else if (!this.settled && this.samples >= this.cap) this.settled = !b.present(f.now);
    this.show(this.samples > 0 || (hold && this.shown));
  }

  private syncBloom(b: TracerBackend, f: TraceFrame) {
    if (!this.background) return;
    const bloom = traceBloom(f.bloom ?? 0, this.background, f.bloomable ?? true);
    const key = bloomKey(bloom);
    if (key === this.bloom) return;
    this.bloom = key;
    b.setBloom(bloom);
  }

  private traceFrame(b: TracerBackend) {
    const gen = this.gen.current;
    // Frames before the first sample of a restart carry the pipeline compiles
    // and uploads, seconds long, which say nothing about what a frame costs.
    const timed = this.samples > 0;
    const land = (ms: number | null) => {
      if (this.backend !== b) return;
      this.inFlight = false;
      if (ms !== null && timed && this.gen.isCurrent(gen)) this.measured = ms;
    };
    const done = b.renderSample(this.samples);
    this.inFlight = true;
    done.then(land, () => land(null));
  }

  /** Battery lowers the cap, the work per frame and the resolution. */
  setPower(p: Power) {
    if (p.discharging === this.power.discharging) return;
    this.power = { ...p };
    this.cap = costProfile(p).cap;
    this.backend?.setCap(this.cap);
    this.size = { w: 0, h: 0, ratio: 0 };
    this.cameraDirty = true;
  }

  /** The size a traced picture at `scale` comes out at, or null while none can be taken. */
  pictureSize(scale: number): { width: number; height: number } | null {
    const b = this.backend;
    if (!b || !this.hasScene || this.state === "off") return null;
    const w = Math.max(1, this.webglCanvas.clientWidth);
    const h = Math.max(1, this.webglCanvas.clientHeight);
    const k = tracedPictureScale(w, h, scale, b.maxTextureSize);
    return { width: Math.round(w * k), height: Math.round(h * k) };
  }

  /** A traced still of the view as the tracer has it, or null when Path traced
   *  is not running. Holds the tracer until done, then restarts the viewport's trace. */
  async picture(o: PictureRequest): Promise<string | null> {
    const b = this.backend;
    const size = this.pictureSize(o.scale);
    if (!b || !size || this.picturing) return null;
    this.picturing = true;
    this.show(false);
    try {
      const { scale: _, ...rest } = o;
      return await b.picture({ ...rest, ...size });
    } finally {
      this.picturing = false;
      if (this.backend === b) {
        this.size = { w: 0, h: 0, ratio: 0 };
        this.cameraDirty = true;
      }
    }
  }

  private show(on: boolean) {
    if (on === this.shown) return;
    this.shown = on;
    this.onShownChange?.(on);
  }

  private restart() {
    this.samples = 0;
    this.settled = false;
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
        b.setCap(this.cap);
        this.backend = b;
        this.inFlight = false;
        this.measured = null;
        this.renderScale = 0;
        this.budget = new FrameBudget(Infinity);
        this.budgetSent = false;
        this.preview = false;
        this.denoiseLevel = "";
        this.bloom = "";
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
    // A resized canvas is blank, nothing traced is left to hold up.
    this.show(false);
    this.size = { w, h, ratio };
    b.setSize(Math.max(1, w), Math.max(1, h), ratio);
    const scale = renderScaleFor({ cssHeight: h, dpr: globalThis.devicePixelRatio || 1, discharging: this.power.discharging });
    if (scale !== this.renderScale) {
      this.renderScale = scale;
      b.setRenderScale(scale);
    }
    const before = this.budget.budget;
    const px = Math.floor(Math.max(1, w) * ratio * scale) * Math.floor(Math.max(1, h) * ratio * scale);
    this.budget.setLimit(px, costProfile(this.power).budgetScale);
    if (this.budget.budget !== before || !this.budgetSent) {
      b.setFrameBudget(this.budget.budget);
      this.budgetSent = true;
    }
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
    if (this.hasScene) this.editedAt = f.now;
    if (geometry || moved) this.cache.syncTransforms();
    if (geometry || restyled) this.cache.syncMaterials();
    if (geometry || painted) this.cache.syncColors(f.bake);
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
    this.background = look.background.clone();
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
