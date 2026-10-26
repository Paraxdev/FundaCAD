// Z is up (as in build123d), so the ground grid lies in the XY plane and cameras use up = +Z.

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { stickyFact } from "../diagnostics/breadcrumbs";
import { gridStep } from "../sketch/planeGrid";
import { gridMajorEvery } from "../../src/ui/units";
import { isRenderLowPower, setRenderLowPower } from "./render";
import {
  composerClearColor,
  DISPLAY_COLOR_GLSL,
  displayColorUniforms,
  followComposer,
  setComposing,
  thresholdAboveGround,
} from "./composerColor";
import { BACKGROUND_COLOR, bloomSettings, renderPrefs } from "../ui/renderPrefs";
import { GlassBackPass, glassBodyCount } from "./glassThickness";
import { POTATO_PIXEL_RATIO, PotatoDraw } from "./potato";
import { EdgeBatches, type EdgeFrame } from "./edgeBatches";
import { MatcapDraw } from "./matcap";
import { GpuTimer } from "./gpuTimer";
import { OverlayDraw } from "./pathtrace/overlayDraw";
import { viewCamera, type FrameView } from "./pathtrace/frameCamera";
import {
  GlowMask,
  maskHighPass,
  ModelPrepass,
  OverlayCompose,
  highAsked,
  stagesFor,
  type FrameFacts,
  type FrameState,
  type RealtimeQuality,
  type Stage,
} from "./realtimePipeline";
import type { ViewMode } from "../ui/renderPrefs";
import { isSoftwareRendererName, setSoftwareRenderer } from "../ui/glassBlur";
import { buildRoom, disposeRoom } from "./environments";
import { hdrHashOf, type Environment, type RenderPrefs } from "../ui/renderPrefs";
import { hdrRoom, heldHdr, setHdrTextureMax } from "./hdrRegistry";
import { themeColor } from "./themeColors";
import { buildLightRig, environmentKeyOf, lightOf, scaled } from "./lightRig";
import { OriginTriad } from "./originTriad";
import { OriginTiles } from "./originTiles";
import { markOverlay } from "./overlayKinds";

export interface SceneBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  modelGroup: THREE.Group; // rebuilt geometry lives here
  /** The tiles' fill meshes, the pick targets, tagged `userData.plane`. */
  planes: Record<"XY" | "XZ" | "YZ", THREE.Mesh>;
  originTiles: OriginTiles;
  grid: AdaptiveGrid;
  triad: OriginTriad;
  /** The object rather than two lambdas, so a diagnostic can read back whether rendering through it gave up
   *  the multisampling (see PostChain.samples). */
  post: PostChain;
  /** The hardware half only (detectLowPower). The effective tier that gates glass, pixel ratio and light count
   *  also counts the performance mode pref, see render.isRenderLowPower(). */
  lowPower: boolean;
  /** Re-reads ui/renderPrefs; the caller asks for a frame afterwards. */
  applyRenderPrefs: () => void;
  /** Called after a rebuild (the model moved or grew) and when the shadows setting changes. */
  frameShadows: () => void;
  /** The full render for one still while potato mode is on. Returns the undo, or null when potato mode is off. */
  beginFullQuality: () => (() => void) | null;
  /** Multiply the pixel ratio for camera motion on a slow machine (motionQuality.ts);
   *  1 puts it back. True when the drawing buffer changed size. */
  setMotionScale: (scale: number) => boolean;
}

/** Cells and view are both measured in pixels, so no constant fits: 100 cells of 64px is five laptop screens but
 *  barely two on a wide monitor. Rounded up to whole major cells of `every` minor cells. */
export function groundGridCells(worldPerPixel: number, diagonalPx: number, cell: number, every = 5): number {
  const want = (worldPerPixel * diagonalPx * GROUND_COVER) / cell;
  const cells = Number.isFinite(want) && want > 0 ? Math.ceil(want) : MIN_GROUND_CELLS;
  const clamped = Math.min(Math.max(cells, MIN_GROUND_CELLS), MAX_GROUND_CELLS);
  return Math.ceil(clamped / every) * every;
}

/** A grazing view compresses the far half into the top of the frame, where a lattice that stops draws its edge
 *  across the view. More than planeGrid.GRID_COVER, which is looked at square on. */
const GROUND_COVER = 3;
/** Never fewer than this, so a degenerate scale still leaves a grid to orient
 *  by, and never more, so one cannot cost a frame. */
const MIN_GROUND_CELLS = 40;
const MAX_GROUND_CELLS = 600;

/** One shader plane, not GridHelpers: GL_LINES are unantialiased 1px lines that shimmered under an orbit. fwidth
 *  makes each line a soft one pixel band at any zoom, and the plane fades out toward its edge. */
export class AdaptiveGrid {
  readonly group = new THREE.Group();
  step = 1; // current minor-line spacing in mm
  private mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private key = "";

  constructor(scene: THREE.Scene) {
    this.mat = new THREE.ShaderMaterial({
      // fwidth is core in the WebGL2 GLSL this renderer targets, no extension.
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uCell: { value: 1 },
        uMajor: { value: 5 },
        uHalf: { value: 1 },
        uCenter: { value: new THREE.Vector2() },
        uMinor: { value: new THREE.Color(0x3a414d) },
        uMajorC: { value: new THREE.Color(0x5c6b7a) },
        ...displayColorUniforms(),
      },
      vertexShader: /* glsl */ `
        varying vec2 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xy;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader:
        DISPLAY_COLOR_GLSL +
        /* glsl */ `
        varying vec2 vWorld;
        uniform float uCell;
        uniform float uMajor;
        uniform float uHalf;
        uniform vec2 uCenter;
        uniform vec3 uMinor;
        uniform vec3 uMajorC;
        // Coverage of the nearest line of the given spacing: 1 on the line,
        // falling to 0 one pixel off it, measured in the fragment's own units.
        float gridLine(vec2 p, float cell) {
          vec2 c = p / cell;
          vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
          return 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
        }
        void main() {
          float mn = gridLine(vWorld, uCell);
          float mj = gridLine(vWorld, uMajor);
          vec3 col = mix(uMinor, uMajorC, mj);
          float a = max(mn, mj);
          if (a <= 0.002) discard;
          // radial fade to the plane edge, so the quad has no hard border
          float d = length(vWorld - uCenter);
          a *= 1.0 - smoothstep(uHalf * 0.6, uHalf * 0.98, d);
          if (a <= 0.002) discard;
          gl_FragColor = displayOverGround(col, a);
        }
      `,
    });
    followComposer(this.mat);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.renderOrder = -2;
    this.mesh.frustumCulled = false; // recentred on the target every frame, always in view
    this.group.add(this.mesh);
    scene.add(this.group);
    this.applyTheme();
  }

  /** Majors take a hint of the accent, pulled back toward the major grey so they never glow over the model.
   *  Called on every theme change, since the viewport cannot re-cascade CSS the way the chrome does. */
  applyTheme() {
    const minor = new THREE.Color(themeColor("--grid-minor", 0x3a414d));
    const major = new THREE.Color(themeColor("--grid-major", 0x5c6b7a));
    const accent = new THREE.Color(themeColor("--accent", 0x51d6a8));
    (this.mat.uniforms.uMinor!.value as THREE.Color).copy(minor);
    (this.mat.uniforms.uMajorC!.value as THREE.Color).copy(major.lerp(accent, 0.4));
  }

  /** worldPerPixel is world mm per screen pixel at the target, diagonalPx decides how far the lattice runs,
   *  gridZ is the model's floor or 0 when empty. */
  update(targetX: number, targetY: number, worldPerPixel: number, diagonalPx: number, gridZ = 0) {
    this.group.position.z = gridZ; // track the model floor every frame, even if x/y/cell are cached
    const cell = gridStep(worldPerPixel, 0);
    const every = gridMajorEvery(cell);
    const majorCell = cell * every;
    const cx = Math.round(targetX / majorCell) * majorCell;
    const cy = Math.round(targetY / majorCell) * majorCell;
    const cells = groundGridCells(worldPerPixel, diagonalPx, cell, every);
    const size = cell * cells;
    const k = `${cell}:${every}:${cx}:${cy}:${cells}`;
    if (k === this.key) return;
    this.key = k;
    this.step = cell;
    this.group.position.set(cx, cy, gridZ);
    this.mesh.scale.set(size, size, 1);
    this.mat.uniforms.uCell!.value = cell;
    this.mat.uniforms.uMajor!.value = majorCell;
    this.mat.uniforms.uHalf!.value = size / 2;
    (this.mat.uniforms.uCenter!.value as THREE.Vector2).set(cx, cy);
  }
}

/** Trust it only on Windows and macOS: WebKitGTK spoofs WEBGL_debug_renderer_info as "Apple GPU" on any hardware
 *  (seen on a Radeon). On Linux the process's open DRI fds tell the truth. */
function recordGpu(renderer: THREE.WebGLRenderer) {
  let desc = "unknown";
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const v = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    desc = `${r} (${v})`;
  } catch {
    /* querying the renderer must never break startup */
  }
  const spoofed = /apple/i.test(desc) && !/mac/i.test(navigator.platform ?? "");
  const note = spoofed ? ", reported by WebKitGTK, which spoofs this; not the real GPU" : "";
  (window as { __gpu?: string }).__gpu = desc + note;
  stickyFact(`[gpu] ${desc}${note}`);
}

function unmaskedRendererName(renderer: THREE.WebGLRenderer): string {
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
  } catch {
    return "";
  }
}

/** Deliberately narrow: a software rasteriser, the basic fallback adapter or very little RAM. A wrong guess
 *  costs a plainer picture, not a crash. */
function detectLowPower(rendererName: string): boolean {
  if (isSoftwareRendererName(rendererName)) return true;
  const mem = (navigator as { deviceMemory?: number }).deviceMemory;
  return typeof mem === "number" && mem <= 2;
}

/** The floor under a motion frame's pixel ratio, potato mode's included. */
const MIN_MOTION_PIXEL_RATIO = 0.35;

// three r186 dropped PCFSoftShadowMap and rewrites it to PCFShadowMap on the first
// shadowed frame, the softness comes from each light's shadow.radius.
export const SHADOW_MAP_TYPE: THREE.ShadowMapType = THREE.PCFShadowMap;

export function createScene(canvas: HTMLCanvasElement): SceneBundle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true });
  const name = unmaskedRendererName(renderer);
  const autoLowPower = detectLowPower(name);
  setSoftwareRenderer(isSoftwareRendererName(name));
  // On a weak tier the pixel ratio is capped hard, since a retina panel over a weak GPU is the surest way to a
  // dropped context. Applied here for the frames before the first pref apply lands.
  renderer.shadowMap.type = SHADOW_MAP_TYPE;
  let fullQuality = false;
  let motionScale = 1;
  const potatoOn = () => renderPrefs().potatoMode && !fullQuality;
  const pixelRatio = (low: boolean) => {
    const base = Math.min(window.devicePixelRatio, potatoOn() ? POTATO_PIXEL_RATIO : low ? 1 : 2);
    if (motionScale >= 1 || fullQuality) return base;
    return Math.min(base, Math.max(MIN_MOTION_PIXEL_RATIO, base * motionScale));
  };
  const applyPowerTier = () => {
    const p = renderPrefs();
    const low = autoLowPower || p.performanceMode || potatoOn();
    setRenderLowPower(low);
    renderer.setPixelRatio(pixelRatio(low));
    // A weak machine drops emitter shadows, the one expensive lighting extra; the emitter still lights.
    // Flipping this recompiles lights and materials, which the pref apply already does.
    renderer.shadowMap.enabled = !low;
  };
  applyPowerTier();
  // Neutral tone mapping: without any, highlights clip flat and lose the shape that shows curvature, and ACES or
  // filmic shift hue, so a part's assigned colour would no longer be drawn as itself.
  renderer.toneMapping = THREE.NeutralToneMapping;
  recordGpu(renderer);
  setHdrTextureMax(renderer.capabilities.maxTextureSize);

  const scene = new THREE.Scene();

  const rig = buildLightRig(renderPrefs(), isHdrHeld);
  const keyLight = lightOf(rig, "key")!;
  const fillLight = lightOf(rig, "fill")!;
  const key = new THREE.DirectionalLight(keyLight.colour, scaled(rig, keyLight.intensity));
  key.position.set(...keyLight.direction).multiplyScalar(KEY_DISTANCE);
  scene.add(key);
  // frameKeyShadow frames the ortho frustum to the model. The target is in the scene so the light can be
  // re-aimed at the model centre without moving its direction.
  scene.add(key.target);
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.6; // CAD faces are flat and large; a world-space nudge avoids acne
  key.shadow.radius = 3;
  const fill = new THREE.DirectionalLight(fillLight.colour, scaled(rig, fillLight.intensity));
  fill.position.set(...fillLight.direction);
  scene.add(fill);
  const hemi = new THREE.HemisphereLight(
    rig.hemisphere.sky,
    rig.hemisphere.ground,
    scaled(rig, rig.hemisphere.intensity),
  );
  scene.add(hemi);

  const grid = new AdaptiveGrid(scene);
  markOverlay(grid.group, "grid");

  const triad = new OriginTriad(scene);
  markOverlay(triad.group, "origin");

  const originTiles = new OriginTiles(scene);
  markOverlay(originTiles.group, "origin");
  const planes = originTiles.planes;

  const modelGroup = new THREE.Group();
  scene.add(modelGroup);

  const post = new PostChain(renderer, scene, potatoOn);

  const frameShadows = () => {
    // With no key light (an imported panorama lights alone) a shadow map would still darken the catcher.
    key.castShadow = renderPrefs().shadows && key.intensity > 0;
    if (key.castShadow) frameKeyShadow(key, modelGroup);
  };

  return {
    renderer,
    scene,
    modelGroup,
    planes,
    originTiles,
    grid,
    triad,
    post,
    lowPower: autoLowPower,
    applyRenderPrefs: () => {
      applyPowerTier(); // pick up a toggled performance-mode pref
      applyRenderPrefs(renderer, scene, { key, fill, hemi });
      frameShadows();
    },
    frameShadows,
    beginFullQuality: () => {
      if (!potatoOn()) return null;
      fullQuality = true;
      applyPowerTier();
      const p = renderPrefs();
      const tex = environmentMapNow(renderer, p);
      if (tex) {
        scene.environment = tex;
        scene.environmentIntensity = p.brightness;
      }
      frameShadows();
      return () => {
        fullQuality = false;
        applyPowerTier();
        scene.environment = null;
      };
    },
    setMotionScale: (scale) => {
      motionScale = scale;
      const pr = pixelRatio(isRenderLowPower());
      if (pr === renderer.getPixelRatio()) return false;
      renderer.setPixelRatio(pr);
      return true;
    },
  };
}

/** frameShadows keeps the key light's direction and sizes the ortho frustum to the model, so a small part gets a
 *  crisp shadow and a large one is not clipped. It reads cached bounding boxes only. */
const _shadowBox = new THREE.Box3();
const _shadowSphere = new THREE.Sphere();
/** The key light's direction, from renderPrefs, set by applyRenderPrefs. */
const _shadowDir = new THREE.Vector3(40, -60, 80).normalize();
const KEY_DISTANCE = Math.hypot(40, -60, 80);
function frameKeyShadow(key: THREE.DirectionalLight, modelGroup: THREE.Group): void {
  _shadowBox.setFromObject(modelGroup);
  if (_shadowBox.isEmpty()) return;
  _shadowBox.getBoundingSphere(_shadowSphere);
  const r = Math.max(_shadowSphere.radius, 1);
  key.position.copy(_shadowSphere.center).addScaledVector(_shadowDir, r * 3);
  key.target.position.copy(_shadowSphere.center);
  key.target.updateMatrixWorld();
  const cam = key.shadow.camera;
  cam.left = -r * 1.25;
  cam.right = r * 1.25;
  cam.top = r * 1.25;
  cam.bottom = -r * 1.25;
  cam.near = r * 0.5;
  cam.far = r * 6;
  cam.updateProjectionMatrix();
}

/** Direct by default: a composer's offscreen target costs a full screen copy and gives up the canvas's
 *  multisampling. The passes are a lazy dynamic import, and until they land the direct path draws. */

export class PostChain {
  private composer: import("three/examples/jsm/postprocessing/EffectComposer.js").EffectComposer | null = null;
  private bloom: import("three/examples/jsm/postprocessing/UnrealBloomPass.js").UnrealBloomPass | null = null;
  private bokeh: import("three/examples/jsm/postprocessing/BokehPass.js").BokehPass | null = null;
  private glowMask: GlowMask | null = null;
  private passesLoading: Promise<void> | null = null;
  private passes: {
    EffectComposer: typeof import("three/examples/jsm/postprocessing/EffectComposer.js").EffectComposer;
    RenderPass: typeof import("three/examples/jsm/postprocessing/RenderPass.js").RenderPass;
    UnrealBloomPass: typeof import("three/examples/jsm/postprocessing/UnrealBloomPass.js").UnrealBloomPass;
    BokehPass: typeof import("three/examples/jsm/postprocessing/BokehPass.js").BokehPass;
    OutputPass: typeof import("three/examples/jsm/postprocessing/OutputPass.js").OutputPass;
  } | null = null;
  private potato: PotatoDraw | null = null;
  private glassPass: GlassBackPass | null = null;
  private motionDraw: PotatoDraw | null = null;
  private matcap: MatcapDraw | null = null;
  private overlay: OverlayDraw | null = null;
  /** Written by the viewport. Potato mode is preferred over it. */
  viewMode: ViewMode = "realtime";
  /** Set by the viewport around its loop's draw: the idle edges drawn cheaper
   *  while the camera moves (edgeMotion.ts), null for the full set. */
  edgeFrame: EdgeFrame | null = null;
  private edgeBatches: EdgeBatches | null = null;
  /** What the last frame drew the idle edges as, for diagnostics and the harness. */
  edgesDrawn: { merged: number; segments: number; thin: boolean; weight: number; builtMs: number } | null = null;
  /** Written by the viewport: the traced canvas under this one has an image to
   *  show, so this frame draws only what sits on top of it. */
  traceShown = false;
  /** Written by the viewport: where the trace on screen was traced from, when
   *  that is not the live camera. */
  traceView: FrameView | null = null;
  /** Frames drawn with the Realtime look in Realtime or Path traced, for the e2e. */
  realtimeFrames = 0;
  private size = new THREE.Vector2(1, 1);
  private glowSize = new THREE.Vector2(1, 1);
  private composerRatio = 0;
  private clearWas = new THREE.Color();
  private clearNow = new THREE.Color();
  private camera: THREE.Camera | null = null;
  /** In world units, from the orbit distance once per frame: whatever you have centred stays in focus. */
  focusDistance = 1;
  /** Something on the model glows or is shiny, which the path tracer's bloom reads.
   *  Written by the viewport with each finish pass. */
  bloomable = true;
  /** Something on the model glows, which is all Realtime bloom reads. */
  glows = true;
  private quality: RealtimeQuality = "standard";
  private prepass: ModelPrepass | null = null;
  private overlayCompose: OverlayCompose | null = null;
  private lastStages: Stage[] | null = null;

  /** Written by the viewport. High draws only for a frame of the viewport's own
   *  loop, on a machine that is not on a low power tier, with nothing ghosted. */
  get realtimeQuality(): RealtimeQuality {
    return this.quality;
  }

  set realtimeQuality(q: RealtimeQuality) {
    this.quality = q;
    if (q === "high") return;
    this.prepass?.dispose();
    this.prepass = null;
    this.overlayCompose?.dispose();
    this.overlayCompose = null;
  }

  private switching: RealtimeQuality | null = null;

  /** High first loads the passes and links its twins' programs, and until then frames keep their stages.
   *  A later call supersedes one still waiting. */
  async switchRealtimeQuality(q: RealtimeQuality, camera: THREE.Camera): Promise<void> {
    if (q === this.switching || (this.switching === null && q === this.quality)) return;
    this.switching = q;
    if (q === "standard") {
      this.realtimeQuality = q;
      this.switching = null;
      return;
    }
    try {
      await Promise.all([
        this.loadPasses(),
        (this.prepass ??= new ModelPrepass()).warm(this.renderer, this.scene, camera),
        (this.overlayCompose ??= new OverlayCompose()).warm(this.renderer, this.scene, camera),
      ]);
    } catch (e) {
      console.warn("[viewport] the High realtime programs could not be linked ahead:", e);
    }
    if (this.switching !== q) return;
    this.switching = null;
    this.realtimeQuality = q;
  }

  /** The stages of the last frame drawn at High, or null when it was not, for reading back. */
  get highStages(): readonly Stage[] | null {
    return this.lastStages;
  }

  /** For reading back: the prepass of the last still High frame. */
  get prepassTarget(): THREE.WebGLRenderTarget | null {
    return this.prepass?.target ?? null;
  }

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private potatoOn: () => boolean = () => renderPrefs().potatoMode,
    private lowPower: () => boolean = isRenderLowPower,
  ) {}

  private timerRef: GpuTimer | null = null;
  /** GPU time per pass of the realtime frame. Made on first use because the
   *  extension lookup needs a live context. */
  get timer(): GpuTimer {
    if (this.timerRef) return this.timerRef;
    const r = this.renderer;
    const timer = (this.timerRef = new GpuTimer(
      typeof r.getContext === "function" ? (r.getContext() as WebGL2RenderingContext) : null,
    ));
    return timer;
  }

  /** Times the shadow maps for the length of one frame, and returns the undo. */
  private timeShadows(timer: GpuTimer): () => void {
    const r = this.renderer;
    const shadows = r.shadowMap as THREE.WebGLShadowMap | undefined;
    const draw = shadows?.render;
    if (!shadows || typeof draw !== "function") return () => {};
    shadows.render = (lights, scene, camera) => {
      const calls = r.info?.render?.calls ?? 0;
      timer.begin("shadow");
      try {
        draw.call(shadows, lights, scene, camera);
      } finally {
        // Three skips the maps on a frame where nothing changed, which would read as 0 ms.
        timer.end("shadow", (r.info?.render?.calls ?? 0) !== calls);
      }
    };
    return () => {
      shadows.render = draw;
    };
  }

  /** Whether this frame draws shadow maps at all. While it does not, the
   *  viewport stops recording caster changes, so the maps are redrawn on return. */
  get drawsShadows(): boolean {
    return this.potatoOn() || (this.viewMode !== "matcap" && !this.tracing);
  }

  private get tracing(): boolean {
    return this.viewMode === "pathtraced" && this.traceShown;
  }

  /** Asked for a frame once the passes have loaded, so bloom does not wait on the next input. */
  onReady: () => void = () => {};

  /** For reading back: a composer's default target has no multisampling, so bloom would silently trade the
   *  canvas's antialiasing for a glow. 0 when drawing straight to the canvas. */
  get samples(): number {
    return this.composer ? (this.composer.renderTarget1.samples ?? 0) : 0;
  }

  /** For reading back: the pass is off on an orthographic camera whatever the setting says. */
  get bokehOn(): boolean {
    return this.bokeh?.enabled ?? false;
  }

  /** `scale` is how many times the view's size this frame is, for a picture. */
  setSize(w: number, h: number, scale = 1) {
    this.size.set(Math.max(1, w), Math.max(1, h));
    this.glowSize.set(Math.max(1, Math.round(this.size.x / scale)), Math.max(1, Math.round(this.size.y / scale)));
    this.composer?.setSize(this.size.x, this.size.y);
    // At the view's CSS size on purpose, a picture included: the glow's width is
    // in texels and was tuned there.
    this.bloom?.setSize(this.glowSize.x, this.glowSize.y);
  }

  /** A viewport with no bloom and no blur never leaves the canvas, so it never pays the full screen copy. */
  private wanted(): { bloom: boolean; blur: boolean } {
    const p = renderPrefs();
    return { bloom: p.bloom > 0 && this.glows, blur: p.focusBlur > 0 };
  }

  /** `motion` is a camera frame on a machine that cannot keep up: a low power tier draws 1px edges and no
   *  passes until the view settles, otherwise the full look stays on. */
  render(camera: THREE.Camera, motion = false, forceRealtime = false, facts: FrameFacts | null = null) {
    if (this.matcap && (this.viewMode !== "matcap" || this.potatoOn())) {
      this.matcap.dispose();
      this.matcap = null;
    }
    const plan = stagesFor(this.frameState(camera, motion, forceRealtime, facts));
    this.lastStages = plan.path === "high" ? plan.stages : null;
    // Potato mode and the low power motion path draw every line thin already.
    const edges = this.edgeFrame && plan.path !== "potato" && plan.path !== "motion" ? this.edgeFrame : null;
    this.edgesDrawn = null;
    try {
      if (edges) {
        const b = (this.edgeBatches ??= new EdgeBatches());
        b.begin(edges);
        this.edgesDrawn = {
          merged: b.drawn.members,
          segments: b.drawn.segments,
          thin: edges.thin,
          weight: edges.weight,
          builtMs: b.builtMs,
        };
      }
      this.renderPlan(plan, camera);
    } finally {
      if (edges) this.edgeBatches!.end();
    }
  }

  /** Drop the merged copy of the edges, an old model's included. */
  releaseEdges() {
    this.edgeBatches?.dispose();
    this.edgeBatches = null;
  }

  get edgesHeld(): boolean {
    return this.edgeBatches?.held === true;
  }

  private renderPlan(plan: ReturnType<typeof stagesFor>, camera: THREE.Camera) {
    if (plan.path === "potato") {
      (this.potato ??= new PotatoDraw()).render(this.renderer, this.scene, camera, renderPrefs().brightness);
      // Only the modules, so a still taken in potato mode can build its passes at once.
      const want = this.wanted();
      if (want.bloom || want.blur) void this.loadPasses();
      return;
    }
    if (this.potato) {
      this.potato.dispose();
      this.potato = null;
    }
    if (plan.path === "matcap") {
      (this.matcap ??= new MatcapDraw()).render(this.renderer, this.scene, camera, renderPrefs().brightness, {
        style: renderPrefs().matcapStyle,
        tint: renderPrefs().matcapTint,
      });
      return;
    }
    if (this.overlay && !this.tracing) {
      this.overlay.dispose();
      this.overlay = null;
    }
    if (plan.path === "overlay") {
      const view = this.traceView ? viewCamera(camera, this.traceView) : camera;
      (this.overlay ??= new OverlayDraw()).render(this.renderer, this.scene, view);
      return;
    }
    this.realtimeFrames++;
    if (plan.path === "motion") {
      (this.motionDraw ??= new PotatoDraw(true)).render(this.renderer, this.scene, camera);
      return;
    }
    const timer = this.timer;
    timer.frame();
    const untimeShadows = this.timeShadows(timer);
    let glass = false;
    if (glassBodyCount() > 0) {
      timer.begin("glassBack");
      try {
        glass = (this.glassPass ??= new GlassBackPass()).begin(this.renderer, camera);
      } finally {
        timer.end("glassBack");
      }
    } else if (this.glassPass) {
      this.glassPass.dispose();
      this.glassPass = null;
    }
    try {
      if (plan.path === "high") this.renderHigh(camera, plan.stages);
      else this.renderFull(camera);
    } finally {
      if (glass) this.glassPass!.end();
      untimeShadows();
      timer.endFrame();
    }
  }

  private frameState(
    camera: THREE.Camera,
    motion: boolean,
    forceRealtime: boolean,
    facts: FrameFacts | null,
  ): FrameState {
    const want = this.wanted();
    const s: FrameState = {
      quality: this.quality,
      potato: this.potatoOn(),
      lowPower: this.lowPower(),
      viewMode: this.viewMode,
      tracing: this.tracing,
      forceRealtime,
      motion,
      facts,
      bloom: want.bloom,
      blur: want.blur,
      perspective: (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true,
      passesReady: this.passes !== null,
    };
    if (highAsked(s) && !s.passesReady) void this.loadPasses();
    return s;
  }

  private renderFull(camera: THREE.Camera) {
    const want = this.wanted();
    if (!want.bloom && !want.blur) {
      this.timed("main", () => this.renderer.render(this.scene, camera));
      return;
    }
    let composer = this.composer;
    if (!composer) {
      if (!this.passes) {
        void this.loadPasses();
        this.renderer.render(this.scene, camera);
        return;
      }
      composer = this.build();
    }
    this.renderComposer(camera, composer, want, false);
  }

  /** The model alone through the passes, then the overlays drawn over it on the canvas. */
  private renderHigh(camera: THREE.Camera, stages: readonly Stage[]) {
    const composer = this.composer ?? this.build();
    if (stages.includes("prepass")) {
      const prepass = (this.prepass ??= new ModelPrepass());
      this.timed("prepass", () => prepass.render(this.renderer, this.scene, camera));
    }
    this.renderComposer(camera, composer, this.wanted(), true);
    const compose = (this.overlayCompose ??= new OverlayCompose());
    this.timed("compose", () => compose.render(this.renderer, this.scene, camera));
  }

  private renderComposer(
    camera: THREE.Camera,
    composer: import("three/examples/jsm/postprocessing/EffectComposer.js").EffectComposer,
    want: { bloom: boolean; blur: boolean },
    modelOnly: boolean,
  ) {
    // Built once and re-aimed, since the rig swaps between a perspective and an orthographic camera object.
    if (this.camera !== camera) {
      this.camera = camera;
      for (const pass of composer.passes) {
        const aimed = pass as { camera?: THREE.Camera };
        if (aimed.camera) aimed.camera = camera;
      }
    }
    const p = renderPrefs();
    const r = this.renderer;
    r.getClearColor(this.clearWas);
    const alpha = r.getClearAlpha();
    composerClearColor(this.clearWas, r.toneMapping, r.toneMappingExposure, this.clearNow);
    if (this.bloom) {
      this.bloom.enabled = want.bloom;
      if (want.bloom) {
        const b = bloomSettings(p.bloom);
        this.bloom.strength = b.strength;
        this.bloom.radius = b.radius;
        this.bloom.threshold = thresholdAboveGround(b.threshold, this.clearNow);
      }
    }
    if (this.bokeh) {
      // Off on an orthographic camera whatever the setting says: a parallel projection has no lens, and it is
      // the view chosen for measuring off.
      const lens = want.blur && (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
      this.bokeh.enabled = lens;
      if (lens) {
        const u = this.bokeh.materialBokeh.uniforms;
        u["focus"]!.value = this.focusDistance;
        // The f-stop inverted: a smaller number is a wider hole and less in focus.
        u["aperture"]!.value = (1 / p.aperture) * 0.006;
        u["maxblur"]!.value = p.focusBlur * 0.012;
      }
    }
    const pr = this.renderer.getPixelRatio();
    if (pr !== this.composerRatio) {
      this.composerRatio = pr;
      composer.setPixelRatio(pr);
      this.bloom?.setSize(this.glowSize.x, this.glowSize.y);
    }
    // The OutputPass tone maps the clear, so this clears with the inverse. Then the plain colour again with the
    // target bound, since glass's transmission buffer clears from WebGLState's cached value, in linear.
    r.setRenderTarget(composer.readBuffer);
    r.setClearColor(this.clearNow, alpha);
    r.clear();
    r.setClearColor(this.clearWas, alpha);
    setComposing(true, this.clearWas);
    // Note: three's shadow pass leaves that cached clear white, so a frame that redraws the shadow maps
    // showed a white buffer through glass.
    const shadows = r.shadowMap as THREE.WebGLShadowMap | undefined;
    const drawShadows = shadows?.render;
    if (shadows && drawShadows) {
      shadows.render = (lights, scene, camera) => {
        drawShadows.call(shadows, lights, scene, camera);
        r.setClearColor(this.clearWas, alpha);
      };
    }
    const mask = camera.layers.mask;
    try {
      if (modelOnly) camera.layers.mask = mask & 1;
      this.timed("composer", () => composer.render());
    } finally {
      camera.layers.mask = mask;
      // Note: BokehPass clears its depth override without a finally, so a throw mid
      // pass left every later frame, and the overlay over a trace, drawn as packed depth.
      this.scene.overrideMaterial = null;
      if (shadows && drawShadows) shadows.render = drawShadows;
      setComposing(false);
      r.setRenderTarget(null);
      r.setClearColor(this.clearWas, alpha);
    }
  }

  private timed(name: string, draw: () => void): void {
    const timer = this.timer;
    timer.begin(name);
    try {
      draw();
    } finally {
      timer.end(name);
    }
  }

  private loadPasses(): Promise<void> {
    return (this.passesLoading ??= this.fetchPasses());
  }

  private async fetchPasses() {
    const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { BokehPass }, { OutputPass }] = await Promise.all([
      import("three/examples/jsm/postprocessing/EffectComposer.js"),
      import("three/examples/jsm/postprocessing/RenderPass.js"),
      import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
      import("three/examples/jsm/postprocessing/BokehPass.js"),
      import("three/examples/jsm/postprocessing/OutputPass.js"),
    ]);
    this.passes = { EffectComposer, RenderPass, UnrealBloomPass, BokehPass, OutputPass };
    this.onReady();
  }

  /** Synchronous once the modules are in, so a still can build the chain on the spot. */
  private build(): import("three/examples/jsm/postprocessing/EffectComposer.js").EffectComposer {
    const { EffectComposer, RenderPass, UnrealBloomPass, BokehPass, OutputPass } = this.passes!;
    // Our own target, for its `samples`: EffectComposer's default has none, which would turn a viewport of
    // straight CAD edges jagged.
    const buffer = new THREE.WebGLRenderTarget(this.size.x, this.size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
      stencilBuffer: true,
    });
    const composer = new EffectComposer(this.renderer, buffer);
    this.composerRatio = this.renderer.getPixelRatio();
    composer.setSize(this.size.x, this.size.y);
    const camera = this.camera ?? new THREE.PerspectiveCamera();
    const render = new RenderPass(this.scene, camera);
    render.clear = false;
    const drawModel = render.render.bind(render);
    render.render = (...args) => this.timed("main", () => drawModel(...args));
    const b = bloomSettings(renderPrefs().bloom);
    const bloom = new UnrealBloomPass(this.size.clone(), b.strength, b.radius, b.threshold);
    // Before the bloom: light spilling off an out of focus highlight is what an open lens does, the other
    // order pastes a sharp glow over a soft picture.
    const bokeh = new BokehPass(this.scene, camera, { focus: 1, aperture: 0.0002, maxblur: 0.01 });
    bokeh.enabled = false;
    composer.addPass(render);
    composer.addPass(bokeh);
    composer.addPass(bloom);
    // Last: a target skips the tone mapping and colour space conversion the canvas path does in the shader,
    // and this pass does them instead, or the viewport comes back washed out.
    composer.addPass(new OutputPass());
    // addPass sized the glow in device pixels, setSize keeps it at CSS size.
    bloom.setSize(this.glowSize.x, this.glowSize.y);
    this.maskBloom(bloom);
    this.bloom = bloom;
    this.bokeh = bokeh;
    this.composer = composer;
    this.camera = null; // force the re-aim above on the next frame
    return composer;
  }

  /** Only glowing faces bloom: the bright pass reads the glow mask, and is skipped
   *  on a frame where nothing on screen glows. */
  private maskBloom(bloom: import("three/examples/jsm/postprocessing/UnrealBloomPass.js").UnrealBloomPass) {
    const glow = (this.glowMask ??= new GlowMask());
    if (!maskHighPass(bloom.materialHighPassFilter, glow.target.texture)) {
      console.warn("[viewport] three's bloom high pass changed, bloom is not limited to glowing faces");
      return;
    }
    const spill = bloom.render.bind(bloom);
    bloom.render = (r, write, read, dt, stencil) => {
      const camera = this.camera;
      let lit = false;
      this.timed("glowMask", () => {
        const bright = bloom.renderTargetBright;
        lit = camera !== null && glow.render(r, this.scene, camera, bright.width, bright.height);
      });
      if (lit) spill(r, write, read, dt, stencil);
    };
  }
}

/** Generated, not loaded, since the app fetches nothing at start up. Built lazily (a cubemap render plus PMREM,
 *  tens of ms) and never disposed, one per process. */
const envCache = new Map<string, THREE.Texture>();
/** Imported panoramas are keyed by rotation and exposure too, so only the last few are kept. */
const KEEP_CUSTOM = 2;

/** What `p` lights with as a cache key, or null for none, which includes an
 *  imported panorama whose pixels have not loaded yet. */
export function environmentKey(p: Readonly<RenderPrefs>): string | null {
  return environmentKeyOf(p, isHdrHeld);
}

export function isHdrHeld(hash: string): boolean {
  return heldHdr(hash) !== null;
}

/** The room for `p`, built now if it is not cached yet. A still taken in potato
 *  mode needs it synchronously, the live viewport goes through environmentMap. */
function environmentMapNow(renderer: THREE.WebGLRenderer, p: Readonly<RenderPrefs>): THREE.Texture | null {
  const key = environmentKey(p);
  if (!key) return null;
  const held = envCache.get(key);
  if (held) return held;
  const room = environmentRoomFor(p);
  if (!room) return null;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(room.scene, 0.04).texture;
  room.dispose();
  pmrem.dispose();
  envCache.set(key, tex);
  const custom = [...envCache.keys()].filter((k) => k.startsWith("hdr:"));
  for (const k of custom.slice(0, Math.max(0, custom.length - KEEP_CUSTOM))) {
    envCache.get(k)?.dispose();
    envCache.delete(k);
  }
  return tex;
}

/** The scene for what `p` lights with, for one render; the caller disposes it. */
export function environmentRoomFor(p: Readonly<RenderPrefs>): { scene: THREE.Scene; dispose(): void } | null {
  if (p.environment === "none") return null;
  const hash = hdrHashOf(p.environment);
  if (hash) {
    const h = heldHdr(hash);
    return h ? hdrRoom(h, p.envRotation, p.envExposure) : null;
  }
  return environmentRoom(p.environment as Exclude<Environment, "none">);
}

export function environmentRoom(id: Exclude<Environment, "none">): { scene: THREE.Scene; dispose(): void } {
  if (id === "studio") {
    // three's own Y up room, a quarter turn from this world, kept as it is: turning it upright would change
    // what every existing document reflects.
    const room = new RoomEnvironment();
    return { scene: room, dispose: () => room.dispose() };
  }
  const room = buildRoom(id);
  return { scene: room, dispose: () => disposeRoom(room) };
}

async function environmentMap(renderer: THREE.WebGLRenderer, p: Readonly<RenderPrefs>): Promise<THREE.Texture | null> {
  // A task later, so a frame is drawn flat-lit first instead of waiting on the PMREM pass.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return environmentMapNow(renderer, p);
}

/** One writer, because the rig and the environment share one brightness and must not drift apart. The
 *  environment builds a task later, so the model appears flat lit first and gains reflections a beat later. */
function applyRenderPrefs(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  lights: { key: THREE.DirectionalLight; fill: THREE.DirectionalLight; hemi: THREE.HemisphereLight },
) {
  const p = renderPrefs();
  const rig = buildLightRig(p, isHdrHeld);
  const keyLight = lightOf(rig, "key")!;
  const fillLight = lightOf(rig, "fill")!;
  _shadowDir.set(...keyLight.direction);
  lights.key.position.copy(lights.key.target.position).addScaledVector(_shadowDir, KEY_DISTANCE);
  lights.key.intensity = scaled(rig, keyLight.intensity);
  lights.fill.intensity = scaled(rig, fillLight.intensity);
  lights.hemi.intensity = scaled(rig, rig.hemisphere.intensity);
  // The default ground reads a theme token as the stylesheet does (themeColors.ts). The fixed grounds ignore the
  // theme on purpose, so two finishes compare on the same ground.
  renderer.setClearColor(
    p.background === "theme" ? themeColor("--viewport-bg", 0x1a1d21) : BACKGROUND_COLOR[p.background],
    1,
  );
  const want = environmentKey(p);
  if (!want || p.potatoMode) {
    scene.environment = null;
    scene.background = null;
    return;
  }
  scene.environmentIntensity = p.brightness;
  scene.backgroundIntensity = p.brightness;
  const behind = p.envBackground && hdrHashOf(p.environment) !== null;
  if (!behind) scene.background = null;
  void environmentMap(renderer, p).then((tex) => {
    // Re-checked: the setting may have changed again while the cubemap was being generated.
    const now = renderPrefs();
    if (environmentKey(now) !== want || now.potatoMode) return;
    scene.environment = tex;
    // The lit room itself, so the panorama behind the part is turned and exposed
    // exactly as the light it casts.
    scene.background = behind && now.envBackground ? tex : null;
  });
}
