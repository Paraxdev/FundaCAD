// Scene setup: renderer, lights, Z-up grid + axes, sketch planes.
// CAD convention is Z-up (matches build123d), so the ground grid lies
// in the XY plane and cameras use up = +Z.

import * as THREE from "three";
import { stickyFact } from "../diagnostics/breadcrumbs";
import { niceStep } from "../ui/units";
import { glyphWorldScale } from "./gizmoScale";

export interface SceneBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  modelGroup: THREE.Group; // rebuilt geometry lives here
  planes: Record<"XY" | "XZ" | "YZ", THREE.Mesh>;
  grid: AdaptiveGrid;
  triad: OriginTriad;
}

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
   *  gridZ = the height the grid sits at (the model's floor, or 0 when empty). */
  update(targetX: number, targetY: number, worldPerPixel: number, gridZ = 0) {
    this.group.position.z = gridZ; // track the model floor every frame, even if x/y/cell are cached
    const cell = niceStep(worldPerPixel * 64); // ~64px minor cells
    const majorCell = cell * 5;
    const cx = Math.round(targetX / majorCell) * majorCell;
    const cy = Math.round(targetY / majorCell) * majorCell;
    const k = `${cell}:${cx}:${cy}`;
    if (k === this.key) return;
    this.key = k;
    this.step = cell;
    this.rebuild(cell);
    this.group.position.set(cx, cy, gridZ);
  }

  private rebuild(cell: number) {
    this.dispose();
    const cells = 100; // extent = cell*100 (covers several screens)
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
 *  TRUST THIS ONLY ON WINDOWS/macOS. WebKitGTK — the engine a Linux Tauri build
 *  runs on — deliberately SPOOFS WEBGL_debug_renderer_info for fingerprinting
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

export function createScene(canvas: HTMLCanvasElement): SceneBundle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x1a1d21, 1);
  recordGpu(renderer);

  const scene = new THREE.Scene();

  // --- lighting rig (key + fill + ambient) for a clean product look ---
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(40, -60, 80);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-50, 40, 20);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202428, 0.6));

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

  return { renderer, scene, modelGroup, planes, grid, triad };
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
  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];

  constructor(scene: THREE.Scene) {
    const len = TRIAD_LENGTH_PX;
    const head = len * HEAD_FRACTION;
    const dirs: [THREE.Vector3, number][] = [
      [new THREE.Vector3(1, 0, 0), AXIS_COLOR.x],
      [new THREE.Vector3(0, 1, 0), AXIS_COLOR.y],
      [new THREE.Vector3(0, 0, 1), AXIS_COLOR.z],
    ];
    const shaftGeo = new THREE.CylinderGeometry(
      len * SHAFT_RADIUS_FRACTION, len * SHAFT_RADIUS_FRACTION, len - head, 10);
    const coneGeo = new THREE.ConeGeometry(len * HEAD_RADIUS_FRACTION, head, 14);
    this.geometries.push(shaftGeo, coneGeo);
    for (const [dir, color] of dirs) {
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
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      this.group.add(arm);
    }
    scene.add(this.group);
  }

  /** `pixelWorldSize` is the world size of one screen pixel AT THE ORIGIN, which
   *  is where this is drawn — measuring it anywhere else would size the arrows
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
