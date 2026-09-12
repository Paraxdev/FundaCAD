// Scene setup: renderer, lights, Z-up grid + axes, sketch planes.
// CAD convention is Z-up (matches build123d), so the ground grid lies
// in the XY plane and cameras use up = +Z.

import * as THREE from "three";
import { stickyFact } from "../diagnostics/breadcrumbs";
import { niceStep } from "../ui/units";
import { glyphWorldScale } from "./gizmoScale";
import { EDGE_HOVER_COLOR } from "./highlight";
import { setRenderLowPower } from "./render";
import { BACKGROUND_COLOR, BLOOM_SETTINGS, renderPrefs } from "../ui/renderPrefs";
import { buildRoom, disposeRoom } from "./environments";
import type { Environment } from "../ui/renderPrefs";
import { themeColor } from "./themeColors";
import type { Axis3 } from "../types";

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
  /** True on a machine too weak for the expensive effects (see detectLowPower):
   *  glass has already been dropped to plain alpha and the pixel ratio capped,
   *  and the viewport reads this to keep the emitter-light count small. */
  lowPower: boolean;
  /** Re-read ui/renderPrefs and apply it: lighting, what the model reflects,
   *  and what it is drawn against. Called once at construction and again from
   *  every change; the caller asks for a frame afterwards. */
  applyRenderPrefs: () => void;
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

/** A ground grid (XY plane) whose spacing snaps to nice 1/2/5×10ⁿ mm values and
 *  rescales with zoom, recentred on the camera target so it always fills the view
 *  with round-number lines. Two layers: dim minor + brighter major (every 5th). */
export class AdaptiveGrid {
  readonly group = new THREE.Group();
  step = 1; // current minor-line spacing in mm
  private minor: THREE.GridHelper | null = null;
  private major: THREE.GridHelper | null = null;
  private key = "";

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** worldPerPixel = world mm covered by one screen pixel at the target.
   *  diagonalPx = the viewport's own diagonal, which is what decides how far the
   *  lattice has to run. gridZ = the height the grid sits at (the model's floor,
   *  or 0 when empty). */
  update(targetX: number, targetY: number, worldPerPixel: number, diagonalPx: number, gridZ = 0) {
    this.group.position.z = gridZ; // track the model floor every frame, even if x/y/cell are cached
    const cell = niceStep(worldPerPixel * 64); // ~64px minor cells
    const majorCell = cell * 5;
    const cx = Math.round(targetX / majorCell) * majorCell;
    const cy = Math.round(targetY / majorCell) * majorCell;
    const cells = groundGridCells(worldPerPixel, diagonalPx, cell);
    const k = `${cell}:${cx}:${cy}:${cells}`;
    if (k === this.key) return;
    this.key = k;
    this.step = cell;
    this.rebuild(cell, cells);
    this.group.position.set(cx, cy, gridZ);
  }

  private rebuild(cell: number, cells: number) {
    this.dispose();
    // center-line color == grid color so GridHelper draws no misplaced axes
    // (the world AxesHelper shows the real origin axes).
    this.minor = new THREE.GridHelper(cell * cells, cells, 0x23272e, 0x23272e);
    this.major = new THREE.GridHelper(cell * cells, cells / 5, 0x3a4048, 0x3a4048);
    for (const g of [this.minor, this.major]) {
      g.rotateX(Math.PI / 2); // GridHelper is XZ by default → lay flat on XY
      (g.material as THREE.Material).depthWrite = false;
      g.renderOrder = -2;
      this.group.add(g);
    }
  }

  private dispose() {
    for (const g of [this.minor, this.major]) {
      if (!g) continue;
      this.group.remove(g);
      g.geometry.dispose();
      (g.material as THREE.Material).dispose();
    }
    this.minor = this.major = null;
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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const lowPower = detectLowPower(renderer);
  setRenderLowPower(lowPower); // glass falls back to alpha on a weak machine
  // Cap the pixel ratio HARD on a weak machine: a retina panel over a software
  // rasteriser is four times the pixels it can draw, the surest way to a dropped
  // context. 2 elsewhere keeps text and edges crisp without going to native 3x.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, lowPower ? 1 : 2));
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
  const fill = new THREE.DirectionalLight(0xffffff, FILL_INTENSITY);
  fill.position.set(-50, 40, 20);
  scene.add(fill);
  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x202428, HEMI_INTENSITY);
  scene.add(hemi);

  // --- Z-up adaptive ground grid in the XY plane (rescales with zoom) ---
  const grid = new AdaptiveGrid(scene);

  // axes: X red, Y green, Z blue
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

  const post = new PostChain(renderer, scene);

  return {
    renderer, scene, modelGroup, planes, grid, triad, post, lowPower,
    applyRenderPrefs: () => applyRenderPrefs(renderer, scene, { key, fill, hemi }),
  };
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
  private loading = false;
  private size = new THREE.Vector2(1, 1);
  private camera: THREE.Camera | null = null;
  /** How far in front of the camera is sharp, in world units. Written by the
   *  viewport once per frame from the orbit distance, because that is the point
   *  the view is ABOUT: whatever you have centred is what stays in focus, which
   *  needs no control of its own and is never wrong. */
  focusDistance = 1;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
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
    return { bloom: p.bloom !== "off", blur: p.focusBlur > 0 };
  }

  render(camera: THREE.Camera) {
    const want = this.wanted();
    if (!want.bloom && !want.blur) {
      this.renderer.render(this.scene, camera);
      return;
    }
    if (!this.composer) {
      void this.build();
      this.renderer.render(this.scene, camera);
      return;
    }
    // The pass chain is built once and re-aimed, rather than rebuilt whenever
    // the camera object changes (it does: perspective and orthographic are two
    // objects the rig swaps between).
    if (this.camera !== camera) {
      this.camera = camera;
      for (const pass of this.composer.passes) {
        const aimed = pass as { camera?: THREE.Camera };
        if (aimed.camera) aimed.camera = camera;
      }
    }
    const p = renderPrefs();
    if (this.bloom) {
      this.bloom.enabled = want.bloom;
      if (want.bloom) {
        const b = BLOOM_SETTINGS[p.bloom as Exclude<typeof p.bloom, "off">];
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
    this.composer.render();
  }

  private async build() {
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
    // Our own target, for the `samples`. EffectComposer's default target has
    // none, so rendering through it would silently throw away the antialiasing
    // the canvas was created with, and a CAD model is mostly straight edges:
    // that reads as the whole viewport suddenly going jagged, which is a far
    // worse trade than any glow is worth.
    const buffer = new THREE.WebGLRenderTarget(this.size.x, this.size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    const composer = new EffectComposer(this.renderer, buffer);
    composer.setSize(this.size.x, this.size.y);
    const camera = this.camera ?? new THREE.PerspectiveCamera();
    const render = new RenderPass(this.scene, camera);
    const b = BLOOM_SETTINGS.subtle;
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
const envPending = new Map<Environment, Promise<THREE.Texture>>();

async function environmentMap(
  renderer: THREE.WebGLRenderer,
  id: Environment,
): Promise<THREE.Texture> {
  const held = envCache.get(id);
  if (held) return held;
  // De-duplicated, not merely cached. Switching back and forth between two
  // environments faster than a cubemap generates would otherwise start a second
  // PMREM pass for one already in flight, and the loser's texture is leaked.
  const inFlight = envPending.get(id);
  if (inFlight) return inFlight;

  const job = (async () => {
    const pmrem = new THREE.PMREMGenerator(renderer);
    let tex: THREE.Texture;
    if (id === "studio") {
      // three's own, kept as it is: it is a Y-up room, which is a quarter turn
      // from this app's world, and it has looked right since the day materials
      // landed. Turning it upright would be changing what every existing
      // document reflects to fix something nobody can see.
      const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js");
      tex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    } else {
      const room = buildRoom(id as Exclude<Environment, "studio" | "none">);
      tex = pmrem.fromScene(room, 0.04).texture;
      disposeRoom(room);
    }
    pmrem.dispose();
    envCache.set(id, tex);
    envPending.delete(id);
    return tex;
  })();
  envPending.set(id, job);
  return job;
}

/** Put the user's viewport settings on a scene.
 *
 *  ONE writer for all three, because they are one statement about exposure: the
 *  lighting rig and the environment are multiplied by the same brightness, so
 *  they cannot drift into a model lit from one side at one exposure and
 *  reflecting at another.
 *
 *  The environment is loaded ASYNCHRONOUSLY (it is a dynamic import and a render
 *  pass) and the rest is applied at once, so the viewport is never waiting on it
 *  to draw a frame: the model appears flat-lit and gains its reflections a beat
 *  later, which is what it did before this existed. */
function applyRenderPrefs(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  lights: { key: THREE.DirectionalLight; fill: THREE.DirectionalLight; hemi: THREE.HemisphereLight },
) {
  const p = renderPrefs();
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
  if (p.environment === "none") {
    scene.environment = null;
    return;
  }
  scene.environmentIntensity = p.brightness;
  const want = p.environment;
  void environmentMap(renderer, want).then((tex) => {
    // Re-checked, not assumed: the setting may have been changed again while the
    // cubemap was being generated, and writing it then would put back the
    // environment the user has just moved on from.
    if (renderPrefs().environment === want) scene.environment = tex;
  });
}

/** The one axis-to-colour table in the scene. RGB for XYZ is the convention
 *  every CAD package draws, so it is hard-coded rather than themed: a theme that
 *  recoloured the axes would be lying about which one is which. */
const AXIS_COLOR = { x: 0xff5a5a, y: 0x46d97a, z: 0x4d8dff } as const;

/** The origin arrows' arm length, in SCREEN PIXELS.
 *
 *  Pixels, not millimetres, and that is the whole point of this number. The arms
 *  were 20mm: a fixed size in the world is only ever the right size at one zoom,
 *  and measured on a fitted 6mm block those 20mm arms came out 1253px long with
 *  263px arrowheads, on a 900px canvas. Zooming in made it worse in proportion,
 *  reaching 82,000px at the bottom of the zoom range.
 *
 *  88px sits between the two things it is read against: a little shorter than
 *  the ViewCube in the opposite corner, about twice the drag handle. */
export const TRIAD_LENGTH_PX = 88;

/** How far the arrows may be shrunk when the model itself is small on screen.
 *
 *  Lower than a handle's floor, because the two fail differently: a handle
 *  shrunk past aiming is unusable, while a marker only has to stay visible, and
 *  at 0.3 of 88px it is still 26px with a readable head. */
export const MIN_TRIAD_SCALE = 0.3;

/** Proportions of the arrow, as fractions of its length, so the shape stays
 *  itself at every size and one constant above sets how big it is. */
const HEAD_FRACTION = 0.21;
const SHAFT_RADIUS_FRACTION = 0.017;
const HEAD_RADIUS_FRACTION = 0.055;
/** The arm's HIT radius, which is not its drawn one. A shaft a pixel and a
 *  half wide is a fine thing to look at and a poor thing to aim at, so each
 *  arm carries an undrawn sleeve about a fingertip across. */
const SLEEVE_RADIUS_FRACTION = 0.075;

/** How strongly the part of an arrow that is INSIDE the model still shows.
 *
 *  Not a flourish, a consequence. At 20mm the arrows escaped every small part by
 *  brute length; at 88px they no longer do, and a primitive box is centred on
 *  the origin, so the first thing the new size did was make the origin marker
 *  vanish completely inside a 6mm block. Faint is the answer that keeps both
 *  facts: full strength where the arrow is genuinely in front, a ghost where it
 *  is buried, so the origin is always findable and still reads as being behind
 *  something. */
const OCCLUDED_OPACITY = 0.28;

/** Drawn after the model (which sits at 0) so the ghost pass can paint over it,
 *  and the solid pass after the ghost so it wins wherever it is really visible.
 *  Below the manipulators at 998-999: an origin marker must never cover the
 *  handle the user is dragging. */
const GHOST_ORDER = 1;
const SOLID_ORDER = 2;

/** The world origin: three real arrows, held at a constant size on screen.
 *
 *  This was a stock THREE.AxesHelper, which is three LineSegments, and a line is
 *  one device pixel however close the camera gets. Three thin strands crossing at
 *  a point read as a scratch on the grid rather than as the origin, and there is
 *  no head to say which end is positive. A shaft and a cone say both.
 *
 *  Modelled in PIXELS and scaled by the world size of a pixel every frame, the
 *  same way every manipulator in features/ already is. Class rather than a bare
 *  Group for the same reason AdaptiveGrid above is one: it has to be told the
 *  zoom on every frame that draws, and an object that needs updating should own
 *  the method that does it. */
export class OriginTriad {
  readonly group = new THREE.Group();
  /** The three arms, each tagged with the axis it stands for. A tool that asks
   *  "which axis was clicked" raycasts these and reads `userData.axis`, rather
   *  than deducing the answer from the order they were added in. */
  readonly arms: THREE.Object3D[] = [];
  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private repaint: ((hot: boolean) => void)[] = [];

  constructor(scene: THREE.Scene) {
    const len = TRIAD_LENGTH_PX;
    const head = len * HEAD_FRACTION;
    const dirs: [THREE.Vector3, number, Axis3][] = [
      [new THREE.Vector3(1, 0, 0), AXIS_COLOR.x, "X"],
      [new THREE.Vector3(0, 1, 0), AXIS_COLOR.y, "Y"],
      [new THREE.Vector3(0, 0, 1), AXIS_COLOR.z, "Z"],
    ];
    const shaftGeo = new THREE.CylinderGeometry(
      len * SHAFT_RADIUS_FRACTION, len * SHAFT_RADIUS_FRACTION, len - head, 10);
    const coneGeo = new THREE.ConeGeometry(len * HEAD_RADIUS_FRACTION, head, 14);
    const sleeveGeo = new THREE.CylinderGeometry(
      len * SLEEVE_RADIUS_FRACTION, len * SLEEVE_RADIUS_FRACTION, len, 8);
    this.geometries.push(shaftGeo, coneGeo, sleeveGeo);
    // Never drawn, always hit. `material.visible` keeps the sleeve out of the
    // render list while leaving it in the raycast, which `object.visible` would
    // not: this widens the target without widening the arrow.
    const sleeveMat = new THREE.MeshBasicMaterial({ visible: false });
    this.materials.push(sleeveMat);
    for (const [dir, color, axis] of dirs) {
      // Unlit on purpose. An axis marker states a fact, and a Lambert surface
      // would hand half of it to wherever the key light happens to be, so the
      // "red" axis would read differently on each side of the scene.
      const solid = new THREE.MeshBasicMaterial({ color });
      const ghost = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: OCCLUDED_OPACITY,
        depthTest: false,
        depthWrite: false,
      });
      this.materials.push(solid, ghost);
      // Built along +Y (which is how three's cylinders and cones are born) and
      // turned onto the axis, so all three come from one description. Both
      // passes share ONE geometry per part: they are the same arrow drawn twice,
      // and two copies of it could drift.
      const arm = new THREE.Group();
      for (const mat of [ghost, solid]) {
        const order = mat === ghost ? GHOST_ORDER : SOLID_ORDER;
        const shaft = new THREE.Mesh(shaftGeo, mat);
        shaft.position.y = (len - head) / 2;
        shaft.renderOrder = order;
        const cone = new THREE.Mesh(coneGeo, mat);
        cone.position.y = len - head / 2;
        cone.renderOrder = order;
        arm.add(shaft, cone);
      }
      const sleeve = new THREE.Mesh(sleeveGeo, sleeveMat);
      sleeve.position.y = len / 2;
      arm.add(sleeve);
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      arm.userData.axis = axis;
      this.group.add(arm);
      this.arms.push(arm);
      this.repaint.push((hot) => {
        solid.color.setHex(hot ? EDGE_HOVER_COLOR : color);
        ghost.color.setHex(hot ? EDGE_HOVER_COLOR : color);
      });
    }
    scene.add(this.group);
  }

  /** Light the arm standing for `axis`, or put all three back to their own
   *  colours. It borrows the colour an edge takes under the cursor, because an
   *  arrow and an edge are the two things an axis can be picked from and the
   *  two should answer a hover the same way. */
  highlight(axis: Axis3 | null) {
    this.arms.forEach((arm, i) => this.repaint[i]?.(arm.userData.axis === axis));
  }

  /** `pixelWorldSize` is the world size of one screen pixel AT THE ORIGIN, which
   *  is where this is drawn, measuring it anywhere else would size the arrows
   *  for a place they are not. */
  update(pixelWorldSize: number | null, modelDiagonal: number | null) {
    this.group.scale.setScalar(
      glyphWorldScale(TRIAD_LENGTH_PX, modelDiagonal, pixelWorldSize, MIN_TRIAD_SCALE),
    );
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
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
