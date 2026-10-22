// Scene setup: renderer, lights, Z-up grid + axes, origin plane tiles.
// CAD convention is Z-up (matches build123d), so the ground grid lies
// in the XY plane and cameras use up = +Z.

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { stickyFact } from "../diagnostics/breadcrumbs";
import { gridStep } from "../sketch/planeGrid";
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
import { hdrRoom, heldHdr } from "./hdrRegistry";
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
  /** How a frame actually gets drawn: directly, or through the passes. Exposed
   *  as the object rather than as two lambdas so a diagnostic can read back what
   *  the chain is doing, which is the only way to tell that rendering through it
   *  has not quietly given up the multisampling (see PostChain.samples). */
  post: PostChain;
  /** The AUTO hardware detection (see detectLowPower): true on a machine the app
   *  judged too weak for the expensive effects. The EFFECTIVE tier that gates
   *  glass, pixel ratio and light count is this OR the manual performance-mode
   *  pref, and lives in render.isRenderLowPower(); this field is just the
   *  hardware half, for anything that wants to know what the machine is. */
  lowPower: boolean;
  /** Re-read ui/renderPrefs and apply it: lighting, what the model reflects,
   *  and what it is drawn against. Called once at construction and again from
   *  every change; the caller asks for a frame afterwards. */
  applyRenderPrefs: () => void;
  /** Re-aim and re-size the key light's shadow to the current model. Called after
   *  a rebuild (the model moved or grew) and when the shadows setting changes. */
  frameShadows: () => void;
  /** Put the full render back for one still while potato mode is on: the power
   *  tier, the pass chain and the environment. Returns the undo, or null when
   *  potato mode is off and there is nothing to lift. */
  beginFullQuality: () => (() => void) | null;
  /** Multiply the pixel ratio for camera motion on a slow machine (motionQuality.ts);
   *  1 puts it back. True when the drawing buffer changed size. */
  setMotionScale: (scale: number) => boolean;
}

/** How many minor cells the ground grid spans, for a viewport `diagonalPx`
 *  across at `worldPerPixel` and `cell` mm per cell.
 *
 *  It was a flat 100. A constant cannot be right here, because the thing it has
 *  to cover is measured in pixels and the cell is too: a hundred 64px cells is
 *  6400px of grid, which is five screens on a laptop and barely two on a wide
 *  monitor. The same build ran out at one size and paid for lattice nobody could
 *  see at the other. Sized from the view it cannot do either.
 *
 *  Rounded up to a whole number of MAJOR cells, because the two GridHelpers are
 *  built from the same span and the major one divides it by five. */
export function groundGridCells(worldPerPixel: number, diagonalPx: number, cell: number): number {
  const want = (worldPerPixel * diagonalPx * GROUND_COVER) / cell;
  const cells = Number.isFinite(want) && want > 0 ? Math.ceil(want) : MIN_GROUND_CELLS;
  const clamped = Math.min(Math.max(cells, MIN_GROUND_CELLS), MAX_GROUND_CELLS);
  return Math.ceil(clamped / 5) * 5;
}

/** Diagonals of the viewport the ground grid runs, either side of the view
 *  centre. Six diagonals across is well past what a flat-on view can show, which
 *  is the margin the grazing views need: a ground plane is usually looked at
 *  from a low angle, and there the far half of it is compressed into the top of
 *  the frame and a lattice that stops has its edge drawn right across the view.
 *
 *  Deliberately more generous than the sketch plane's (planeGrid.GRID_COVER),
 *  which is looked at square on and has nowhere to run to. */
const GROUND_COVER = 3;
/** Never fewer than this, so a degenerate scale still leaves a grid to orient
 *  by, and never more, so one cannot cost a frame. */
const MIN_GROUND_CELLS = 40;
const MAX_GROUND_CELLS = 600;

/** A ground grid (XY plane) whose spacing snaps to nice 1/2/5x10^n mm values and
 *  rescales with zoom, recentred on the camera target so it always fills the view
 *  with round-number lines. Dim minor lines and brighter major ones every 5th.
 *
 *  Drawn as ONE shader plane, not two GridHelpers. A GL_LINES primitive is a 1px
 *  line with no anti-aliasing of its own, so it shimmered as it reprojected under
 *  an orbit, which was the grid's flicker. The shader derives each line's width
 *  from its own screen-space derivative (fwidth), so a line is a soft one-pixel
 *  band that holds still while the camera turns, at any zoom or angle. The plane
 *  fades out toward its own edge so the finite quad shows no border. */
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

  /** Re-read the grid's line colours from the theme. Minor lines a legible cool
   *  grey so the lattice reads at a glance instead of sinking into the ground;
   *  major lines carry a hint of the theme accent so every fifth line stands out
   *  and the grid belongs to the app rather than being anonymous chrome. The
   *  accent is pulled most of the way back down to the major grey, so a major
   *  line is clearly tinted without glowing over the model. Called at
   *  construction and again on every theme change (viewport wires it), because
   *  the viewport cannot re-cascade CSS the way the chrome does. */
  applyTheme() {
    const minor = new THREE.Color(themeColor("--grid-minor", 0x3a414d));
    const major = new THREE.Color(themeColor("--grid-major", 0x5c6b7a));
    const accent = new THREE.Color(themeColor("--accent", 0x4bf9bc));
    (this.mat.uniforms.uMinor!.value as THREE.Color).copy(minor);
    (this.mat.uniforms.uMajorC!.value as THREE.Color).copy(major.lerp(accent, 0.4));
  }

  /** worldPerPixel = world mm covered by one screen pixel at the target.
   *  diagonalPx = the viewport's own diagonal, which is what decides how far the
   *  lattice has to run. gridZ = the height the grid sits at (the model's floor,
   *  or 0 when empty). */
  update(targetX: number, targetY: number, worldPerPixel: number, diagonalPx: number, gridZ = 0) {
    this.group.position.z = gridZ; // track the model floor every frame, even if x/y/cell are cached
    const cell = gridStep(worldPerPixel, 0);
    const majorCell = cell * 5;
    const cx = Math.round(targetX / majorCell) * majorCell;
    const cy = Math.round(targetY / majorCell) * majorCell;
    const cells = groundGridCells(worldPerPixel, diagonalPx, cell);
    const size = cell * cells;
    const k = `${cell}:${cx}:${cy}:${cells}`;
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

/** Which renderer the webview reports, recorded once at startup.
 *
 *  TRUST THIS ONLY ON WINDOWS/macOS. WebKitGTK, the engine a Linux Tauri build
 *  runs on, deliberately SPOOFS WEBGL_debug_renderer_info for fingerprinting
 *  resistance and reports "Apple GPU / Apple Inc." on any hardware, so neither
 *  the name nor a software-rasteriser guess means anything there. Verified on
 *  this machine: the string said "Apple GPU" while the web process actually had
 *  /dev/dri/renderD128 open with libdrm_amdgpu + libgallium mapped, i.e. a real
 *  Radeon. The reliable Linux check is the process's open DRI fds, not WebGL.
 *
 *  Still worth recording: it is real on the other two platforms, and knowing it
 *  is spoofed is itself the answer when a Linux report blames the GPU. */
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

/** A machine that must not be asked for the expensive effects (transmission, a
 *  high pixel ratio, a pile of lights): a software rasteriser or the basic
 *  fallback adapter, or a device reporting very little RAM. Deliberately narrow,
 *  it only fires on the machines that genuinely can't cope, so a normal
 *  integrated GPU keeps the full look; the cost of guessing WRONG here is a
 *  plainer picture, not a crash. */
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
  // The effective tier is the auto detection OR the manual "performance mode"
  // pref, re-applied on every pref change (the bundle's applyRenderPrefs below):
  // glass falls back to alpha (no transmission pass), and the pixel ratio is
  // capped HARD, a retina panel over a weak GPU is four times the pixels it can
  // draw, the surest way to a dropped context. 2 elsewhere keeps edges crisp
  // without going to native 3x. Applied once here for the frames before the
  // first pref-apply lands.
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
    // Emitter shadows are the one expensive lighting extra; a weak machine drops
    // them (the emitter still lights, it just does not occlude). Flipping this
    // makes the lights and materials recompile, which the pref-apply already does.
    renderer.shadowMap.enabled = !low;
  };
  applyPowerTier();
  // Tone mapping, always, and NEUTRAL of the several on offer.
  //
  // Without any, everything above full brightness clips flat: a specular
  // highlight on polished metal, a light-coloured part under the key light and
  // anything emissive all arrive as the same white, and the shape of the
  // highlight (which is what tells you the surface is curved) is gone with it.
  //
  // Neutral rather than ACES or filmic because this is CAD. The other two are
  // film looks: they shift hue and lift contrast across the whole image, so a
  // part assigned #b06a3b is no longer drawn #b06a3b, which makes the material
  // library lie. Neutral (the Khronos PBR tone mapper) is the identity through
  // the range colours actually live in and only compresses the top end, so the
  // highlight rolls off and the colour is still the colour.
  renderer.toneMapping = THREE.NeutralToneMapping;
  recordGpu(renderer);

  const scene = new THREE.Scene();

  // --- lighting rig (key + fill + ambient) for a clean product look ---
  const rig = buildLightRig(renderPrefs(), isHdrHeld);
  const keyLight = lightOf(rig, "key")!;
  const fillLight = lightOf(rig, "fill")!;
  const key = new THREE.DirectionalLight(keyLight.colour, scaled(rig, keyLight.intensity));
  key.position.set(...keyLight.direction).multiplyScalar(KEY_DISTANCE);
  scene.add(key);
  // The key light can OPTIONALLY cast a grounded shadow (renderPrefs.shadows). Set
  // up its shadow map once; the ortho frustum is framed to the model by
  // frameKeyShadow whenever the model or the setting changes. The target is added
  // so the light can be re-aimed at the model centre without moving its DIRECTION.
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

  // --- Z-up adaptive ground grid in the XY plane (rescales with zoom) ---
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
    key.castShadow = renderPrefs().shadows;
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

/** Aim the key light's shadow camera at the model and size its ortho frustum to
 *  fit, so a small part gets a crisp shadow and a large one is not clipped. The
 *  light's DIRECTION is preserved (it is re-placed along its existing direction,
 *  the target moved to the model centre), so only the shadow changes, not the
 *  lighting. Cheap: it reads each body's cached bounding box, not its vertices. */
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

/** Drawing the frame, with or without the passes.
 *
 *  Two paths on purpose, and the direct one is the default. A composer renders
 *  into an offscreen target and blits it back, which costs a full-screen copy
 *  and, more to the point, gives up the canvas's own multisampling unless the
 *  target asks for it. Everything that is not bloom is better off never leaving
 *  the canvas, so with bloom off this is `renderer.render` and nothing else.
 *
 *  Built LAZILY and kept: the passes are a dynamic import (they are not small)
 *  and a set of render targets, and the setting can be switched off and on
 *  again. Until the import lands, the direct path draws, so the viewport is
 *  never waiting on it for a frame, the model simply gains its bloom a beat
 *  after the setting is switched on. */

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
  /** How far in front of the camera is sharp, in world units. Written by the
   *  viewport once per frame from the orbit distance, because that is the point
   *  the view is ABOUT: whatever you have centred is what stays in focus, which
   *  needs no control of its own and is never wrong. */
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

  /** Moves to `q` once it can be drawn without a hitch: High first loads the passes
   *  and links the programs of its prepass and overlay twins, and until that has
   *  finished the frames keep the stages they had. A later call supersedes an
   *  earlier one still waiting. */
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

  /** How many samples the offscreen buffer takes, or 0 when there is no buffer
   *  because bloom is off and the canvas is being drawn straight to.
   *
   *  For reading BACK. A composer's default render target has no multisampling
   *  at all, so turning bloom on would silently trade the antialiasing the
   *  canvas was created with for a glow, and on a model made of straight edges
   *  that is a bad trade nobody asked for. Cheaper to assert than to notice. */
  get samples(): number {
    return this.composer ? (this.composer.renderTarget1.samples ?? 0) : 0;
  }

  /** Whether the depth-of-field pass is currently drawing.
   *
   *  For reading BACK, like `samples` above. The pass is switched off on an
   *  orthographic camera whatever the setting says, so "the slider is up" and
   *  "the blur is happening" are two different facts and only this one is the
   *  one a diagnostic wants. */
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

  /** Whether anything in the settings needs a pass at all. The direct path is
   *  the default and stays the default: a viewport with no bloom and no blur
   *  never leaves the canvas, and never pays the full-screen copy. */
  private wanted(): { bloom: boolean; blur: boolean } {
    const p = renderPrefs();
    return { bloom: p.bloom > 0 && this.glows, blur: p.focusBlur > 0 };
  }

  /** `motion` is a camera frame on a machine that cannot keep up. On a low power
   *  tier (performance mode included) it draws 1px edge lines and no passes until
   *  the view settles, otherwise the full look stays on while the camera moves. */
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
    // The pass chain is built once and re-aimed, rather than rebuilt whenever
    // the camera object changes (it does: perspective and orthographic are two
    // objects the rig swaps between).
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
      // OFF on an orthographic camera, whatever the setting says. Depth of field
      // is an artefact of a lens, and a parallel projection has none; the pass
      // would still blur by depth, which is a photograph of something no camera
      // could take and is exactly the view chosen for measuring off.
      const lens = want.blur && (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
      this.bokeh.enabled = lens;
      if (lens) {
        const u = this.bokeh.materialBokeh.uniforms;
        u["focus"]!.value = this.focusDistance;
        // The f-stop, inverted: a SMALLER number is a wider hole and less in
        // focus, which is the one thing about aperture everybody already knows
        // and the reason the control is in stops rather than in 0..1.
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
    // The RenderPass does not clear, this does. The OutputPass tone maps the
    // clear, so it is the inverse of the tone mapper. Then the plain colour again
    // with the target still bound: WebGLState caches a clear value converted for
    // the target bound at setClearColor (sRGB for the canvas), and the
    // transmission buffer of any glass clears from that cache, in linear.
    r.setRenderTarget(composer.readBuffer);
    r.setClearColor(this.clearNow, alpha);
    r.clear();
    r.setClearColor(this.clearWas, alpha);
    setComposing(true, this.clearWas);
    // Note: three's shadow pass sets that cached clear to white and leaves it, and
    // the RenderPass never clears after it, so on a frame that redraws the shadow
    // maps (every still, a moved light) glass showed a white buffer through it.
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
    // Our own target, for the `samples`. EffectComposer's default target has
    // none, so rendering through it would silently throw away the antialiasing
    // the canvas was created with, and a CAD model is mostly straight edges:
    // that reads as the whole viewport suddenly going jagged, which is a far
    // worse trade than any glow is worth.
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
    // BEFORE the bloom, deliberately. Blur first and bloom second is a light
    // spilling off an out-of-focus highlight, which is what an open lens
    // actually does; the other way round is a sharp glow pasted over a soft
    // picture, and it reads as a mistake even to somebody who could not say why.
    const bokeh = new BokehPass(this.scene, camera, { focus: 1, aperture: 0.0002, maxblur: 0.01 });
    bokeh.enabled = false;
    composer.addPass(render);
    composer.addPass(bokeh);
    composer.addPass(bloom);
    // LAST, and it is what makes the two paths agree: rendering into a target
    // skips the tone mapping and the colour-space conversion the canvas path
    // does in the material shader, and this pass is where they happen instead.
    // Without it the whole viewport comes back washed out and over-bright.
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

/** The neutral room the model reflects, built once and kept.
 *
 *  Lazily, and cached forever after: it is a render to a cubemap plus a PMREM
 *  pass, tens of milliseconds, and the setting can be switched off and on again.
 *  Never disposed for the same reason, there is exactly one of these per
 *  process and it is a few hundred KiB of texture.
 *
 *  Generated rather than loaded. An HDR file would be a network fetch (or an
 *  asset in the bundle) for something the renderer can produce from a handful of
 *  boxes, and the app deliberately fetches nothing at start-up. */
const envCache = new Map<string, THREE.Texture>();
/** Imported panoramas are keyed by rotation and exposure too, so only the last
 *  few are kept; the built in rooms stay for the session as they always have. */
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
    // three's own, kept as it is: it is a Y-up room, which is a quarter turn
    // from this app's world, and it has looked right since the day materials
    // landed. Turning it upright would be changing what every existing
    // document reflects to fix something nobody can see.
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

/** Put the user's viewport settings on a scene.
 *
 *  ONE writer for all three, because they are one statement about exposure: the
 *  lighting rig and the environment are multiplied by the same brightness, so
 *  they cannot drift into a model lit from one side at one exposure and
 *  reflecting at another.
 *
 *  The environment is built ASYNCHRONOUSLY (a render pass, run a task later)
 *  and the rest is applied at once, so the viewport is never waiting on it
 *  to draw a frame: the model appears flat-lit and gains its reflections a beat
 *  later, which is what it did before this existed. */
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
  // The ground follows the app's palette by default, reading a token off the
  // document root exactly as the stylesheet does (see themeColors.ts), so a
  // theme that wants its own 3D ground gets one. The fixed grounds below are
  // for looking at a PART rather than at the app, so they ignore the theme on
  // purpose: comparing two finishes needs the same ground both times.
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
    // Re-checked, not assumed: the setting may have been changed again while the
    // cubemap was being generated, and writing it then would put back the
    // environment the user has just moved on from.
    const now = renderPrefs();
    if (environmentKey(now) !== want || now.potatoMode) return;
    scene.environment = tex;
    // The lit room itself, so the panorama behind the part is turned and exposed
    // exactly as the light it casts.
    scene.background = behind && now.envBackground ? tex : null;
  });
}
