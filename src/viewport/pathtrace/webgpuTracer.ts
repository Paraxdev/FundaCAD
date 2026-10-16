// The WebGPU path tracer (three-gpu-pathtracer, pinned) behind TracerBackend.
// Both modules are imported inside init, so the 330 kB chunk only loads the
// first time Path traced is picked.

import * as THREE from "three";
import { SAMPLE_CAP, type TraceScene, type TracerBackend } from "./backend";
import { repackInPlace, type SwappableBvhData } from "./bvhSwap";
import { traceCameraFor } from "./camera";

type WebGpuModule = typeof import("three/webgpu");
type TracerModule = typeof import("three-gpu-pathtracer/webgpu");

const MAX_BOUNCES = 6;

interface TracerInternals {
  _bvhData?: SwappableBvhData & { textureAtlas: { setTextures(r: unknown, t: unknown): void }; textures: unknown };
  _renderer: unknown;
  scene: THREE.Scene;
  generateMissingAttributes: boolean;
}

/** A soft studio sky, Z up, as half floats: Float32 data with a nearest filter
 *  makes the tracer gather zero samples without any error. */
function skyTexture(): THREE.DataTexture {
  const w = 64;
  const h = 32;
  const data = new Uint16Array(w * h * 4);
  const top = new THREE.Color(0.9, 0.93, 1);
  const horizon = new THREE.Color(0.75, 0.75, 0.78);
  const ground = new THREE.Color(0.22, 0.22, 0.24);
  const c = new THREE.Color();
  for (let y = 0; y < h; y++) {
    const v = 1 - (y + 0.5) / h;
    if (v > 0.5) c.lerpColors(horizon, top, Math.min(1, (v - 0.5) * 2.5));
    else c.lerpColors(ground, horizon, Math.pow(v * 2, 4));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = THREE.DataUtils.toHalfFloat(c.r);
      data[i + 1] = THREE.DataUtils.toHalfFloat(c.g);
      data[i + 2] = THREE.DataUtils.toHalfFloat(c.b);
      data[i + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export class WebGpuTracer implements TracerBackend {
  readonly name = "three-gpu-pathtracer 0.0.27 (WebGPU)";
  readonly canvas: HTMLCanvasElement;
  private renderer: InstanceType<WebGpuModule["WebGPURenderer"]> | null = null;
  private tracer: InstanceType<TracerModule["WebGPUPathTracer"]> | null = null;
  private scene = new THREE.Scene();
  private camera: THREE.Camera | null = null;
  private sky: THREE.DataTexture | null = null;
  private faultCbs: ((why: string) => void)[] = [];
  private disposed = false;

  constructor() {
    this.canvas = document.createElement("canvas");
  }

  onFault(cb: (why: string) => void) {
    this.faultCbs.push(cb);
  }

  private fault(why: string) {
    if (this.disposed) return;
    for (const cb of this.faultCbs) cb(why);
  }

  async init() {
    const [gpu, tracerMod] = await Promise.all([import("three/webgpu"), import("three-gpu-pathtracer/webgpu")]);
    const r = new gpu.WebGPURenderer({ canvas: this.canvas, antialias: false });
    r.setPixelRatio(1);
    await r.init();
    const backend = r.backend as unknown as { isWebGPUBackend?: boolean };
    if (!backend.isWebGPUBackend) {
      r.dispose();
      throw new Error("WebGPU backend unavailable, the renderer fell back to WebGL");
    }
    const hooks = r as unknown as {
      onDeviceLost: (info: { message?: string; reason?: string }) => void;
      onError: (e: { type?: string; message?: string }) => void;
    };
    hooks.onDeviceLost = (info) => this.fault(`GPU device lost: ${info.message ?? info.reason ?? "unknown"}`);
    hooks.onError = (e) => this.fault(`GPU ${e.type ?? "error"}: ${e.message ?? ""}`);
    this.renderer = r;
    const t = new tracerMod.WebGPUPathTracer(r);
    // Mirrors carry what the tracer reads; a generated tangent would cost 16 B
    // per vertex on every body for nothing.
    (t as unknown as TracerInternals).generateMissingAttributes = false;
    t.maxSamples = SAMPLE_CAP;
    t.maxBounces = MAX_BOUNCES;
    t.renderDelay = 0;
    t.minSamples = 0;
    t.fadeDuration = 0;
    this.tracer = t;
  }

  setSize(cssWidth: number, cssHeight: number, pixelRatio: number) {
    this.renderer?.setPixelRatio(pixelRatio);
    this.renderer?.setSize(cssWidth, cssHeight, true);
  }

  setScene(ts: TraceScene, camera: THREE.Camera) {
    if (!this.renderer || !this.tracer) return;
    this.renderer.toneMapping = ts.toneMapping;
    this.renderer.toneMappingExposure = ts.exposure;
    const scene = new THREE.Scene();
    scene.background = ts.background.clone();
    scene.environment = (this.sky ??= skyTexture());
    scene.environmentIntensity = ts.brightness;
    // The sky is drawn Y up, the model is Z up.
    scene.environmentRotation.set(Math.PI / 2, 0, 0);
    for (const m of ts.meshes) scene.add(m);
    for (const l of ts.lights) {
      const d = new THREE.DirectionalLight(l.color, l.intensity);
      d.position.copy(l.position);
      d.target.position.copy(l.target);
      scene.add(d, d.target);
    }
    scene.updateMatrixWorld(true);
    this.disposeLights();
    this.scene = scene;
    this.camera = traceCameraFor(camera, this.camera);
    this.tracer.setScene(scene, this.camera);
  }

  updateGeometry(meshes: THREE.Mesh[]) {
    if (!this.tracer || !this.camera) return;
    const scene = this.scene;
    const want = new Set(meshes);
    for (const o of [...scene.children]) if ((o as THREE.Mesh).isMesh && !want.has(o as THREE.Mesh)) scene.remove(o);
    for (const m of meshes) if (m.parent !== scene) scene.add(m);
    scene.updateMatrixWorld(true);
    const t = this.tracer as unknown as TracerInternals;
    const d = t._bvhData;
    if (!d || !repackInPlace(d)) {
      this.tracer.setScene(scene, this.camera);
      return;
    }
    d.textureAtlas.setTextures(t._renderer, d.textures);
    this.tracer.reset();
  }

  updateTransforms() {
    this.tracer?.updateTransforms();
  }

  updateMaterials() {
    this.tracer?.updateMaterials();
  }

  updateCamera(camera: THREE.Camera) {
    if (!this.tracer) return;
    const prev = this.camera;
    this.camera = traceCameraFor(camera, prev);
    if (this.camera !== prev) this.tracer.setCamera(this.camera);
    else this.tracer.updateCamera();
    this.tracer.reset();
  }

  reset() {
    this.tracer?.reset();
  }

  renderSample() {
    this.tracer?.renderSample();
  }

  async samples(): Promise<number> {
    if (!this.tracer) return 0;
    const c = await this.tracer.getSampleCountsAsync();
    return c.min;
  }

  /** The meshes are the host's cached mirrors and outlive this tracer. */
  private disposeLights() {
    for (const o of [...this.scene.children]) {
      if ((o as THREE.DirectionalLight).isDirectionalLight) (o as THREE.DirectionalLight).dispose();
      this.scene.remove(o);
    }
  }

  dispose() {
    this.disposed = true;
    this.disposeLights();
    this.tracer?.dispose();
    this.renderer?.dispose();
    this.sky?.dispose();
    this.tracer = null;
    this.renderer = null;
    this.canvas.remove();
  }
}

export async function createWebGpuTracer(): Promise<TracerBackend> {
  const t = new WebGpuTracer();
  await t.init();
  return t;
}
