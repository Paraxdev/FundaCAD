// Scene setup: renderer, lights, Z-up grid + axes, sketch planes.
// CAD convention is Z-up (matches build123d), so the ground grid lies
// in the XY plane and cameras use up = +Z.

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { stickyFact } from "../diagnostics/breadcrumbs";
import { gridStep } from "../sketch/planeGrid";
import { setRenderLowPower } from "./render";
import { BACKGROUND_COLOR, bloomSettings, renderPrefs } from "../ui/renderPrefs";
import { POTATO_PIXEL_RATIO, PotatoDraw } from "./potato";
import { buildRoom, disposeRoom } from "./environments";
import type { Environment } from "../ui/renderPrefs";
import { themeColor } from "./themeColors";
import { keyDirection } from "./keyLight";
import { AXIS_COLOR, OriginTriad } from "./originTriad";

export interface SceneBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  modelGroup: THREE.Group; // rebuilt geometry lives here
  planes: Record<"XY" | "XZ" | "YZ", THREE.Mesh>;
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
  const want = worldPerPixel * diagonalPx * GROUND_COVER / cell;
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
      },
      vertexShader: /* glsl */ `
        varying vec2 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xy;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
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
          gl_FragColor = vec4(col, a);
        }
      `,
    });
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

/** The lighting rig at brightness 1, i.e. the light level this app has always
 *  had. The brightness setting scales all three together, so these stay the one
 *  definition of the look rather than three numbers a slider replaced. */
const KEY_INTENSITY = 2.0;
const FILL_INTENSITY = 0.6;
const HEMI_INTENSITY = 0.6;

/** A machine that must not be asked for the expensive effects (transmission, a
 *  high pixel ratio, a pile of lights): a software rasteriser or the basic
 *  fallback adapter, or a device reporting very little RAM. Deliberately narrow,
 *  it only fires on the machines that genuinely can't cope, so a normal
 *  integrated GPU keeps the full look; the cost of guessing WRONG here is a
 *  plainer picture, not a crash. */
function detectLowPower(renderer: THREE.WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
    if (/swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(name)) return true;
  } catch {
    /* no debug-info extension: fall through to the RAM check */
  }
  const mem = (navigator as { deviceMemory?: number }).deviceMemory;
  return typeof mem === "number" && mem <= 2;
}

export function createScene(canvas: HTMLCanvasElement): SceneBundle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true });
  const autoLowPower = detectLowPower(renderer);
  // The effective tier is the auto detection OR the manual "performance mode"
  // pref, re-applied on every pref change (the bundle's applyRenderPrefs below):
  // glass falls back to alpha (no transmission pass), and the pixel ratio is
  // capped HARD, a retina panel over a weak GPU is four times the pixels it can
  // draw, the surest way to a dropped context. 2 elsewhere keeps edges crisp
  // without going to native 3x. Applied once here for the frames before the
  // first pref-apply lands.
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  let fullQuality = false;
  const potatoOn = () => renderPrefs().potatoMode && !fullQuality;
  const applyPowerTier = () => {
    const p = renderPrefs();
    const low = autoLowPower || p.performanceMode || potatoOn();
    setRenderLowPower(low);
    const cap = potatoOn() ? POTATO_PIXEL_RATIO : low ? 1 : 2;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
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
  const key = new THREE.DirectionalLight(0xffffff, KEY_INTENSITY);
  key.position.set(40, -60, 80);
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
  const fill = new THREE.DirectionalLight(0xffffff, FILL_INTENSITY);
  fill.position.set(-50, 40, 20);
  scene.add(fill);
  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x202428, HEMI_INTENSITY);
  scene.add(hemi);

  // --- Z-up adaptive ground grid in the XY plane (rescales with zoom) ---
  const grid = new AdaptiveGrid(scene);

  const triad = new OriginTriad(scene);

  // --- sketch planes (semi-transparent, toggled per active sketch) ---
  // Coloured by their NORMAL axis, which is the convention the triad above is
  // read through and the only one that makes the two agree: XY is normal to Z so
  // it is blue, XZ is normal to Y so it is green, and YZ is normal to X so it is
  // RED. Two of the three already followed the rule; YZ was orange, which named
  // no axis at all.
  const planes = {
    XY: makePlane(AXIS_COLOR.z, "XY"),
    XZ: makePlane(AXIS_COLOR.y, "XZ"),
    YZ: makePlane(AXIS_COLOR.x, "YZ"),
  };
  for (const p of Object.values(planes)) {
    p.visible = false;
    scene.add(p);
  }

  const modelGroup = new THREE.Group();
  scene.add(modelGroup);

  const post = new PostChain(renderer, scene, potatoOn);

  const frameShadows = () => {
    key.castShadow = renderPrefs().shadows;
    if (key.castShadow) frameKeyShadow(key, modelGroup);
  };

  return {
    renderer, scene, modelGroup, planes, grid, triad, post, lowPower: autoLowPower,
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
      if (p.environment !== "none") {
        scene.environment = environmentMapNow(renderer, p.environment);
        scene.environmentIntensity = p.brightness;
      }
      frameShadows();
      return () => {
        fullQuality = false;
        applyPowerTier();
        scene.environment = null;
      };
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
  cam.left = -r * 1.25; cam.right = r * 1.25;
  cam.top = r * 1.25; cam.bottom = -r * 1.25;
  cam.near = r * 0.5; cam.far = r * 6;
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
/** A threshold above 1 only lets through what is brighter than a fully lit white
 *  surface, so with nothing glowing or shiny on screen the whole pass would draw
 *  the image unchanged. */
export function bloomWanted(amount: number, bloomable: boolean): boolean {
  if (!(amount > 0)) return false;
  return bloomable || bloomSettings(amount).threshold < 1;
}

export class PostChain {
  private composer: import("three/examples/jsm/postprocessing/EffectComposer.js").EffectComposer | null = null;
  private bloom: import("three/examples/jsm/postprocessing/UnrealBloomPass.js").UnrealBloomPass | null = null;
  private bokeh: import("three/examples/jsm/postprocessing/BokehPass.js").BokehPass | null = null;
  private loading = false;
  private passes: {
    EffectComposer: typeof import("three/examples/jsm/postprocessing/EffectComposer.js").EffectComposer;
    RenderPass: typeof import("three/examples/jsm/postprocessing/RenderPass.js").RenderPass;
    UnrealBloomPass: typeof import("three/examples/jsm/postprocessing/UnrealBloomPass.js").UnrealBloomPass;
    BokehPass: typeof import("three/examples/jsm/postprocessing/BokehPass.js").BokehPass;
    OutputPass: typeof import("three/examples/jsm/postprocessing/OutputPass.js").OutputPass;
  } | null = null;
  private potato: PotatoDraw | null = null;
  private size = new THREE.Vector2(1, 1);
  private camera: THREE.Camera | null = null;
  /** How far in front of the camera is sharp, in world units. Written by the
   *  viewport once per frame from the orbit distance, because that is the point
   *  the view is ABOUT: whatever you have centred is what stays in focus, which
   *  needs no control of its own and is never wrong. */
  focusDistance = 1;
  /** Whether anything on screen can reach the bloom threshold: something that
   *  glows, or a shiny finish that throws a hot highlight. Written by the viewport
   *  with each finish pass. */
  bloomable = true;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private potatoOn: () => boolean = () => renderPrefs().potatoMode,
  ) {}

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

  setSize(w: number, h: number) {
    this.size.set(Math.max(1, w), Math.max(1, h));
    this.composer?.setSize(this.size.x, this.size.y);
    this.bloom?.setSize(this.size.x, this.size.y);
  }

  /** Whether anything in the settings needs a pass at all. The direct path is
   *  the default and stays the default: a viewport with no bloom and no blur
   *  never leaves the canvas, and never pays the full-screen copy. */
  private wanted(): { bloom: boolean; blur: boolean } {
    const p = renderPrefs();
    return { bloom: bloomWanted(p.bloom, this.bloomable), blur: p.focusBlur > 0 };
  }

  render(camera: THREE.Camera) {
    if (this.potatoOn()) {
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
    const want = this.wanted();
    if (!want.bloom && !want.blur) {
      this.renderer.render(this.scene, camera);
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
    if (this.bloom) {
      this.bloom.enabled = want.bloom;
      if (want.bloom) {
        const b = bloomSettings(p.bloom);
        this.bloom.strength = b.strength;
        this.bloom.radius = b.radius;
        this.bloom.threshold = b.threshold;
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
    composer.render();
  }

  private async loadPasses() {
    if (this.loading) return;
    this.loading = true;
    const [
      { EffectComposer }, { RenderPass }, { UnrealBloomPass }, { BokehPass }, { OutputPass },
    ] = await Promise.all([
      import("three/examples/jsm/postprocessing/EffectComposer.js"),
      import("three/examples/jsm/postprocessing/RenderPass.js"),
      import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
      import("three/examples/jsm/postprocessing/BokehPass.js"),
      import("three/examples/jsm/postprocessing/OutputPass.js"),
    ]);
    this.passes = { EffectComposer, RenderPass, UnrealBloomPass, BokehPass, OutputPass };
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
    composer.setSize(this.size.x, this.size.y);
    const camera = this.camera ?? new THREE.PerspectiveCamera();
    const render = new RenderPass(this.scene, camera);
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
    this.bloom = bloom;
    this.bokeh = bokeh;
    this.composer = composer;
    this.camera = null; // force the re-aim above on the next frame
    return composer;
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
const envCache = new Map<Environment, THREE.Texture>();

/** The room for `id`, built now if it is not cached yet. A still taken in potato
 *  mode needs it synchronously, the live viewport goes through environmentMap. */
function environmentMapNow(renderer: THREE.WebGLRenderer, id: Environment): THREE.Texture {
  const held = envCache.get(id);
  if (held) return held;
  const pmrem = new THREE.PMREMGenerator(renderer);
  let tex: THREE.Texture;
  if (id === "studio") {
    // three's own, kept as it is: it is a Y-up room, which is a quarter turn
    // from this app's world, and it has looked right since the day materials
    // landed. Turning it upright would be changing what every existing
    // document reflects to fix something nobody can see.
    const room = new RoomEnvironment();
    tex = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
  } else {
    const room = buildRoom(id as Exclude<Environment, "studio" | "none">);
    tex = pmrem.fromScene(room, 0.04).texture;
    disposeRoom(room);
  }
  pmrem.dispose();
  envCache.set(id, tex);
  return tex;
}

async function environmentMap(renderer: THREE.WebGLRenderer, id: Environment): Promise<THREE.Texture> {
  // A task later, so a frame is drawn flat-lit first instead of waiting on the PMREM pass.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return environmentMapNow(renderer, id);
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
  _shadowDir.set(...keyDirection(p.keyAzimuth, p.keyElevation));
  lights.key.position.copy(lights.key.target.position).addScaledVector(_shadowDir, KEY_DISTANCE);
  lights.key.intensity = KEY_INTENSITY * p.brightness;
  lights.fill.intensity = FILL_INTENSITY * p.brightness;
  lights.hemi.intensity = HEMI_INTENSITY * p.brightness;
  // The ground follows the app's palette by default, reading a token off the
  // document root exactly as the stylesheet does (see themeColors.ts), so a
  // theme that wants its own 3D ground gets one. The fixed grounds below are
  // for looking at a PART rather than at the app, so they ignore the theme on
  // purpose: comparing two finishes needs the same ground both times.
  renderer.setClearColor(
    p.background === "theme" ? themeColor("--viewport-bg", 0x1a1d21) : BACKGROUND_COLOR[p.background],
    1,
  );
  if (p.environment === "none" || p.potatoMode) {
    scene.environment = null;
    return;
  }
  scene.environmentIntensity = p.brightness;
  const want = p.environment;
  void environmentMap(renderer, want).then((tex) => {
    // Re-checked, not assumed: the setting may have been changed again while the
    // cubemap was being generated, and writing it then would put back the
    // environment the user has just moved on from.
    if (renderPrefs().environment === want && !renderPrefs().potatoMode) scene.environment = tex;
  });
}

function makePlane(color: number, kind: "XY" | "XZ" | "YZ"): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(60, 60);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.08,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // PlaneGeometry is in XY by default.
  if (kind === "XZ") mesh.rotateX(Math.PI / 2);
  if (kind === "YZ") mesh.rotateY(Math.PI / 2);
  mesh.renderOrder = -1;
  mesh.userData.plane = kind;
  // Which plane this is, said on the plane itself. Three tinted squares at 8%
  // opacity are told apart only by their colour, and that asks the reader to
  // hold a colour-to-plane table in their head; the label carries it for them.
  mesh.add(planeLabel(kind, color));
  return mesh;
}

/** The plane's name, at one corner of its quad, in the plane's own colour.
 *
 *  A Sprite rather than a textured quad: the plane is DoubleSide and gets looked
 *  at from behind as often as not, where flat text reads mirrored. A sprite
 *  faces the camera, so it is the right way round from everywhere. The canvas
 *  precedent is viewCube.ts, which already draws text into the scene this way. */
function planeLabel(kind: "XY" | "XZ" | "YZ", color: number): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    ctx.font = "700 44px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(kind, 64, 34);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    // Same reason the quad does not: these sit under the model, and a label that
    // fought the depth buffer would flicker against the grid it lies on.
    depthWrite: false,
    depthTest: false,
  }));
  sprite.scale.set(11, 5.5, 1);
  // A corner of the 60x60 quad, in the quad's own local axes, so it lands on the
  // plane's edge whichever way the plane was turned.
  sprite.position.set(24, -25.5, 0);
  sprite.renderOrder = -1;
  return sprite;
}
