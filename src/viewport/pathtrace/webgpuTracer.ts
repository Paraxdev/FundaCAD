// The WebGPU path tracer (three-gpu-pathtracer, pinned) behind TracerBackend.
// Both modules are imported inside init, so the 330 kB chunk only loads the
// first time Path traced is picked.

import * as THREE from "three";
import type { Denoise } from "../../ui/renderPrefs";
import { SAMPLE_CAP, type TraceLook, type TraceScene, type TracerBackend } from "./backend";
import { repackInPlace, type SwappableBvhData } from "./bvhSwap";
import { traceCameraFor, type TraceLens } from "./camera";
import { backgroundTexture } from "./environment";
import { FinalDenoise } from "./denoise";
import { OidnPass, type OidnLike } from "./oidnPass";
import smallWeights from "./weights/rt_hdr_calb_cnrm_small.tza?url";
import largeWeights from "./weights/rt_hdr_calb_cnrm_large.tza?url";

type WebGpuModule = typeof import("three/webgpu");
type TracerModule = typeof import("three-gpu-pathtracer/webgpu");

const MAX_BOUNCES = 6;

/** The WebGPU floor every adapter grants without asking. */
const DEFAULT_STORAGE_BINDING = 128 * 1024 * 1024;

interface BlitMaterial { opacity: number; transition: number; fromTexture: THREE.Texture | null; texture: THREE.Texture | null }

interface TracerInternals {
  _blitQuad: { material: BlitMaterial; render(r: unknown): void };
  _pathTracer: { outputTarget: THREE.Texture };
  _bvhData?: SwappableBvhData & { textureAtlas: { setTextures(r: unknown, t: unknown): void }; textures: unknown };
  _renderer: unknown;
  scene: THREE.Scene;
  generateMissingAttributes: boolean;
}

export class WebGpuTracer implements TracerBackend {
  readonly name = "three-gpu-pathtracer 0.0.27 (WebGPU)";
  readonly canvas: HTMLCanvasElement;
  private renderer: InstanceType<WebGpuModule["WebGPURenderer"]> | null = null;
  private tracer: InstanceType<TracerModule["WebGPUPathTracer"]> | null = null;
  private scene = new THREE.Scene();
  private camera: THREE.Camera | null = null;
  private faultCbs: ((why: string) => void)[] = [];
  private disposed = false;
  private tracerMod: TracerModule | null = null;
  /** The screen holds a denoised image that the samples underneath no longer match. */
  private showsDenoise = false;
  private initUNetFromURL: unknown = null;
  private level: Denoise = "standard";
  private oidn: OidnPass | null = null;
  private final = new FinalDenoise(null);
  maxStorageBytes = DEFAULT_STORAGE_BINDING;

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
    const [gpu, tracerMod, oidnWeb] = await Promise.all([import("three/webgpu"), import("three-gpu-pathtracer/webgpu"), import("oidn-web")]);
    this.tracerMod = tracerMod;
    this.initUNetFromURL = oidnWeb.initUNetFromURL;
    // Above the 128 MiB floor when the adapter offers more, so a model of a few
    // million triangles fits its attribute buffer.
    const nav = globalThis.navigator as unknown as { gpu?: { requestAdapter(): Promise<{ limits: Record<string, number> } | null> } };
    const adapter = await nav.gpu?.requestAdapter();
    const offered = adapter?.limits;
    const requiredLimits = offered
      ? { maxStorageBufferBindingSize: offered.maxStorageBufferBindingSize, maxBufferSize: offered.maxBufferSize }
      : undefined;
    const r = new gpu.WebGPURenderer({ canvas: this.canvas, antialias: false, requiredLimits } as ConstructorParameters<typeof gpu.WebGPURenderer>[0]);
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
    const device = (r.backend as unknown as { device?: { limits: { maxStorageBufferBindingSize: number; maxBufferSize: number } } }).device;
    if (device) this.maxStorageBytes = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
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
    this.setDenoise(this.level);
  }

  private get internals(): TracerInternals {
    return this.tracer as unknown as TracerInternals;
  }

  setDenoise(level: Denoise) {
    this.level = level;
    if (!this.tracer || !this.tracerMod) return;
    this.oidn?.dispose();
    this.oidn = null;
    if (level !== "off") {
      const d = new this.tracerMod.OIDNDenoiser({
        initUNetFromURL: this.initUNetFromURL,
        auxWeightsUrl: level === "high" ? largeWeights : smallWeights,
      });
      d.init(this.renderer);
      this.oidn = new OidnPass(d as unknown as OidnLike, () => ({
        scene: this.scene,
        camera: this.camera,
        color: this.internals._pathTracer.outputTarget,
      }));
    }
    this.final.setPass(this.oidn);
  }

  get denoised(): boolean {
    return this.final.denoised;
  }

  present(now: number): boolean {
    const step = this.final.step(now);
    const raw = this.internals._pathTracer.outputTarget;
    const to = this.oidn?.texture;
    if (step.mix !== null && to) {
      this.blit(raw, to, step.mix);
      this.showsDenoise = true;
    } else if (this.showsDenoise && !this.final.denoised) {
      this.blit(raw, raw, 0);
      this.showsDenoise = false;
    }
    return step.more;
  }

  /** Redraws the canvas through the tracer's own blit, so tone mapping and
   *  exposure match its frames; `mix` crossfades from `from` to `to`. */
  private blit(from: THREE.Texture, to: THREE.Texture, mix: number) {
    const r = this.renderer as unknown as { autoClear: boolean; setRenderTarget(t: null): void };
    const q = this.internals._blitQuad;
    const autoClear = r.autoClear;
    r.setRenderTarget(null);
    r.autoClear = true;
    q.material.opacity = 1;
    q.material.transition = mix;
    q.material.fromTexture = from;
    q.material.texture = to;
    q.render(r);
    r.autoClear = autoClear;
  }

  setSize(cssWidth: number, cssHeight: number, pixelRatio: number) {
    this.renderer?.setPixelRatio(pixelRatio);
    this.renderer?.setSize(cssWidth, cssHeight, true);
  }

  setScene(ts: TraceScene, camera: THREE.Camera) {
    if (!this.renderer || !this.tracer) return;
    this.disposeLights();
    const scene = new THREE.Scene();
    for (const m of ts.meshes) scene.add(m);
    this.scene = scene;
    this.applyLook(ts);
    this.camera = traceCameraFor(camera, this.camera, ts.lens);
    this.tracer.setScene(scene, this.camera);
  }

  private applyLook(look: TraceLook) {
    const r = this.renderer!;
    r.toneMapping = look.toneMapping;
    r.toneMappingExposure = look.exposure;
    const scene = this.scene;
    this.disposeLights();
    scene.background = backgroundTexture(look.background);
    scene.environment = look.environment;
    scene.environmentIntensity = look.brightness;
    for (const l of look.lights) {
      const d = new THREE.DirectionalLight(l.color, l.intensity);
      d.position.copy(l.position);
      d.target.position.copy(l.target);
      scene.add(d, d.target);
    }
    scene.updateMatrixWorld(true);
  }

  updateLook(look: TraceLook) {
    if (!this.tracer || !this.camera) return;
    this.applyLook(look);
    this.tracer.updateEnvironment();
    this.tracer.updateLights();
    this.tracer.reset();
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

  updateCamera(camera: THREE.Camera, lens: TraceLens | null) {
    if (!this.tracer) return;
    const prev = this.camera;
    this.camera = traceCameraFor(camera, prev, lens);
    if (this.camera !== prev) this.tracer.setCamera(this.camera);
    else this.tracer.updateCamera();
    this.tracer.reset();
  }

  reset() {
    this.final.reset();
    this.tracer?.reset();
  }

  renderSample(_samples: number) {
    this.tracer?.renderSample();
    this.showsDenoise = false;
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
      if (!(o as THREE.Mesh).isMesh) this.scene.remove(o);
    }
  }

  dispose() {
    this.disposed = true;
    this.disposeLights();
    this.oidn?.dispose();
    this.oidn = null;
    this.tracer?.dispose();
    this.renderer?.dispose();
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
