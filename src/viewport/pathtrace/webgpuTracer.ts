// The WebGPU path tracer (three-gpu-pathtracer, pinned) behind TracerBackend.
// Both modules are imported inside init, so the 330 kB chunk only loads the
// first time Path traced is picked.

import * as THREE from "three";
import type { Denoise } from "../../ui/renderPrefs";
import { SAMPLE_CAP, type PictureOptions, type TraceLook, type TraceScene, type TracerBackend } from "./backend";
import { FrameBudget } from "./budget";
import { repackInPlace, type SwappableBvhData } from "./bvhSwap";
import { traceCameraFor, type TraceLens } from "./camera";
import { backgroundTexture } from "./environment";
import { AtrousFilter, filterMix } from "./atrous";
import { CROSSFADE_MS, FinalDenoise } from "./denoise";
import { OidnPass, type OidnLike } from "./oidnPass";
import { TraceBloom, type FadeQuad, type TraceBloomDeps, type TraceBloomSettings } from "./tracePost";
import smallWeights from "./weights/rt_hdr_calb_cnrm_small.tza?url";
import largeWeights from "./weights/rt_hdr_calb_cnrm_large.tza?url";

type WebGpuModule = typeof import("three/webgpu");
type TracerModule = typeof import("three-gpu-pathtracer/webgpu");
type TslModule = typeof import("three/tsl");

const MAX_BOUNCES = 6;
/** The preview's size against the trace's, the library's 0.1 is a mosaic. */
const PREVIEW_SCALE = 0.25;

interface GpuQueueDevice {
  limits: { maxStorageBufferBindingSize: number; maxBufferSize: number; maxTextureDimension2D: number };
  queue: { onSubmittedWorkDone(): Promise<void> };
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** The WebGPU floor every adapter grants without asking. */
const DEFAULT_STORAGE_BINDING = 128 * 1024 * 1024;

interface TracerInternals {
  _blitQuad: FadeQuad;
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
  private tsl: TslModule | null = null;
  private atrous: AtrousFilter | null = null;
  private guides: THREE.RenderTarget | null = null;
  private guidesStale = true;
  private glassMask: THREE.Material | null = null;
  private gpu: WebGpuModule | null = null;
  /** The screen holds a denoised image that the samples underneath no longer match. */
  private showsDenoise = false;
  private initUNetFromURL: unknown = null;
  private level: Denoise = "standard";
  private oidn: OidnPass | null = null;
  private final = new FinalDenoise(null);
  maxStorageBytes = DEFAULT_STORAGE_BINDING;
  maxTextureSize = 8192;
  private cap = SAMPLE_CAP;
  private preview = false;
  private device: GpuQueueDevice | null = null;
  private picturing = false;
  private post: TraceBloom | null = null;
  private bloomWanted: TraceBloomSettings | null = null;

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
    const [gpu, tracerMod, oidnWeb, tsl, bloomMod] = await Promise.all([
      import("three/webgpu"), import("three-gpu-pathtracer/webgpu"), import("oidn-web"), import("three/tsl"),
      import("three/examples/jsm/tsl/display/BloomNode.js"),
    ]);
    this.tracerMod = tracerMod;
    this.tsl = tsl;
    this.gpu = gpu;
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
    const device = (r.backend as unknown as { device?: GpuQueueDevice }).device;
    if (device) {
      this.device = device;
      this.maxStorageBytes = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
      this.maxTextureSize = device.limits.maxTextureDimension2D;
    }
    const t = new tracerMod.WebGPUPathTracer(r);
    // Mirrors carry what the tracer reads; a generated tangent would cost 16 B
    // per vertex on every body for nothing.
    (t as unknown as TracerInternals).generateMissingAttributes = false;
    t.maxSamples = this.cap;
    t.maxBounces = MAX_BOUNCES;
    t.renderDelay = 0;
    t.minSamples = this.preview ? 1 : 0;
    t.fadeDuration = this.preview ? CROSSFADE_MS : 0;
    t.lowResScale = PREVIEW_SCALE;
    this.tracer = t;
    this.post = new TraceBloom({
      renderer: r as unknown as TraceBloomDeps["renderer"],
      blitQuad: (t as unknown as TracerInternals)._blitQuad,
      bloom: bloomMod.bloom as unknown as TraceBloomDeps["bloom"],
      tsl: tsl as unknown as TraceBloomDeps["tsl"],
      size: new THREE.Vector2(),
    });
    if (this.bloomWanted) this.post.set(this.bloomWanted);
    this.atrous = new AtrousFilter(r as unknown as ConstructorParameters<typeof AtrousFilter>[0], (tex, w, h) => {
      const e = new gpu.ExternalTexture(tex as never) as unknown as THREE.Texture;
      e.image = { width: w, height: h } as never;
      return e;
    });
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

  /** Albedo, and the view normal with view depth in alpha, for the a-trous
   *  stops. Drawn once per restart, the scene is still while it traces. Glass
   *  is drawn over it as no surface, so it stays as traced. */
  private renderGuides(w: number, h: number): THREE.RenderTarget | null {
    const tsl = this.tsl;
    if (!tsl || !this.camera) return null;
    if (!this.guides) {
      this.guides = new THREE.RenderTarget(w, h, {
        count: 2, type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      // The MRT keys are matched against these names.
      this.guides.textures[0]!.name = "output";
      this.guides.textures[1]!.name = "normal";
    }
    const g = this.guides;
    g.setSize(w, h);
    const r = this.renderer as unknown as {
      toneMapping: THREE.ToneMapping; autoClear: boolean;
      getRenderTarget(): unknown; setRenderTarget(t: unknown): void; getMRT(): unknown; setMRT(m: unknown): void;
      render(s: THREE.Scene, c: THREE.Camera): void;
    };
    const meshes: THREE.Mesh[] = [];
    this.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const glassy = (m: THREE.Mesh) => ([] as THREE.Material[]).concat(m.material).some((x) =>
      x.transparent || x.opacity < 1 || ((x as THREE.MeshPhysicalMaterial).transmission ?? 0) > 0);
    const glass = new Set(meshes.filter(glassy));
    const was = { target: r.getRenderTarget(), mrt: r.getMRT(), tone: r.toneMapping, auto: r.autoClear, background: this.scene.background };
    const surfaces = tsl.mrt({
      output: tsl.diffuseColor,
      normal: tsl.vec4(tsl.normalView.mul(0.5).add(0.5), tsl.positionView.z.negate()),
    });
    surfaces.setClearColor("output", 0x000000, 0);
    surfaces.setClearColor("normal", 0x000000, 0);
    r.toneMapping = THREE.NoToneMapping;
    this.scene.background = null;
    r.setRenderTarget(g);
    r.autoClear = true;
    r.setMRT(surfaces);
    const shown = meshes.map((m) => m.visible);
    for (const m of glass) m.visible = false;
    r.render(this.scene, this.camera);
    if (glass.size) {
      meshes.forEach((m, i) => (m.visible = shown[i]! && glass.has(m)));
      this.glassMask ??= new this.gpu!.MeshBasicNodeMaterial();
      this.scene.overrideMaterial = this.glassMask;
      r.autoClear = false;
      r.setMRT(tsl.mrt({ output: tsl.vec4(0), normal: tsl.vec4(0) }));
      r.render(this.scene, this.camera);
      this.scene.overrideMaterial = null;
    }
    meshes.forEach((m, i) => (m.visible = shown[i]!));
    r.setMRT(was.mrt);
    r.setRenderTarget(was.target);
    r.toneMapping = was.tone;
    r.autoClear = was.auto;
    this.scene.background = was.background;
    return g;
  }

  /** Redraws the canvas through the tracer's own blit, so tone mapping and
   *  exposure match its frames; `mix` crossfades from `from` to `to`. */
  private blit(from: THREE.Texture, to: THREE.Texture, mix: number) {
    this.post?.draw(from, to, mix);
  }

  setBloom(b: TraceBloomSettings | null) {
    this.bloomWanted = b;
    if (!this.post) return;
    this.post.set(b);
    if (!this.picturing) this.post.redraw();
  }

  setSize(cssWidth: number, cssHeight: number, pixelRatio: number) {
    this.renderer?.setPixelRatio(pixelRatio);
    this.renderer?.setSize(cssWidth, cssHeight, true);
    this.post?.setViewSize(cssWidth * pixelRatio, cssHeight * pixelRatio);
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
    scene.background = look.environmentBehind ? look.environment : backgroundTexture(look.background);
    scene.backgroundIntensity = look.environmentBehind ? look.brightness : 1;
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
    this.guidesStale = true;
    this.tracer?.reset();
  }

  setFrameBudget(slots: number) {
    if (this.tracer) this.tracer.frameBudget = slots;
  }

  setRenderScale(scale: number) {
    if (this.tracer) this.tracer.renderScale = scale;
  }

  /** The library's own preview: a restart's first frame traced small with
   *  several bounces, shown until every pixel has a sample, then faded out.
   *  Without it a restart shows black, a bounce traced per frame. */
  setMotionPreview(on: boolean) {
    this.preview = on;
    if (!this.tracer) return;
    this.tracer.minSamples = on ? 1 : 0;
    this.tracer.fadeDuration = on ? CROSSFADE_MS : 0;
  }

  setCap(samples: number) {
    this.cap = samples;
    if (this.tracer) this.tracer.maxSamples = samples;
  }

  /** Resolves once the GPU has finished everything submitted so far, with the
   *  ms since `since`. */
  private gpuTime(since: number): Promise<number> {
    const done = this.device?.queue.onSubmittedWorkDone() ?? Promise.resolve();
    return done.then(() => performance.now() - since);
  }

  renderSample(samples: number): Promise<number> {
    const t0 = performance.now();
    this.trace(samples);
    return this.gpuTime(t0);
  }

  private trace(samples: number) {
    if (!this.tracer) return;
    this.tracer.renderSample();
    this.showsDenoise = false;
    const raw = this.internals._pathTracer.outputTarget;
    // The library drew its preview, a redraw of the raw target would be black.
    if (this.preview && samples < 1) return this.post?.drewItself(raw);
    const mix = this.level === "off" || samples < 1 ? 0 : filterMix(samples, this.cap);
    if (mix <= 0 || !this.atrous) return this.drewItself(raw);
    const { width, height } = raw.image as { width: number; height: number };
    if (this.guidesStale || this.guides?.width !== width || this.guides?.height !== height) {
      if (!this.renderGuides(width, height)) return this.drewItself(raw);
      this.guidesStale = false;
    }
    const g = this.guides!;
    const filtered = this.atrous.run(raw, g.textures[0]!, g.textures[1]!, samples);
    if (filtered) this.blit(raw, filtered, mix);
    else this.drewItself(raw);
  }

  /** The tracer's own blit is on the canvas, without bloom. */
  private drewItself(raw: THREE.Texture) {
    if (this.post?.on) this.blit(raw, raw, 0);
    else this.post?.drewItself(raw);
  }

  async picture(o: PictureOptions): Promise<string> {
    const r = this.renderer;
    const t = this.tracer;
    if (!r || !t || !this.camera) throw new Error("Path tracing is not running");
    const was = { ratio: r.getPixelRatio(), size: r.getSize(new THREE.Vector2()), scale: t.renderScale, budget: t.frameBudget, level: this.level };
    const cancelled = () => new DOMException("The picture was cancelled", "AbortError");
    r.setPixelRatio(1);
    r.setSize(o.width, o.height, false);
    this.picturing = true;
    t.renderScale = 1;
    t.maxSamples = o.samples;
    if (this.level !== "high") this.setDenoise("high");
    this.reset();
    const budget = new FrameBudget(o.width * o.height);
    try {
      let n = 0;
      while (n < o.samples) {
        if (o.signal?.aborted) throw cancelled();
        // One frame per display frame, each inside the budget, so the UI keeps
        // drawing and no dispatch runs long enough to trip the driver watchdog.
        await nextFrame();
        if (this.disposed) throw new Error("Path tracing stopped");
        t.frameBudget = budget.budget;
        const t0 = performance.now();
        t.renderSample();
        const ms = await this.gpuTime(t0);
        // The first frames at the picture's size compile and allocate.
        if (n > 0) budget.frame(ms, performance.now());
        n = (await t.getSampleCountsAsync()).min;
        o.onProgress?.(Math.min(n, o.samples));
      }
      const raw = this.internals._pathTracer.outputTarget;
      const pass = this.oidn;
      const clean = pass && (await pass.run()) ? pass.texture : null;
      if (o.signal?.aborted) throw cancelled();
      if (this.disposed) throw new Error("Path tracing stopped");
      // Read in the same task as the draw: a WebGPU canvas is blank to
      // toDataURL once the frame has been presented.
      this.blit(raw, clean ?? raw, clean ? 1 : 0);
      return this.canvas.toDataURL("image/png");
    } finally {
      this.picturing = false;
      if (!this.disposed) {
        t.renderScale = was.scale;
        t.maxSamples = this.cap;
        t.frameBudget = was.budget;
        if (this.level !== was.level) this.setDenoise(was.level);
        r.setPixelRatio(was.ratio);
        r.setSize(was.size.x, was.size.y, false);
        this.reset();
      }
    }
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
    this.atrous?.dispose();
    this.atrous = null;
    this.post?.dispose();
    this.post = null;
    this.guides?.dispose();
    this.guides = null;
    this.glassMask?.dispose();
    this.glassMask = null;
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
