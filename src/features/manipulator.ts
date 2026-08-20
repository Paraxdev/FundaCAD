// Shared math and glyphs for the interactive 3D manipulators (extrude, fillet,
// chamfer, press-pull): cursor ray -> signed scalar along a drag axis, plus the
// handle you grab to do it. Shared, not copied, because the passive selection
// handle hands its gesture to the fillet/chamfer tool mid-press — the two must
// be provably the same handle.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import { GLYPH_MODEL_FRACTION, glyphScale } from "../viewport/gizmoScale";
import { themeColor } from "../viewport/themeColors";

/** Signed distance along `dir` (unit) of the closest point on the axis
 *  (through `origin`) to the cursor `ray`. Ill-conditioned when the camera
 *  looks down the axis — use axisDragDistance for interactive drags. */
export function distanceAlongAxis(
  ray: THREE.Ray,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
): number {
  const w0 = ray.origin.clone().sub(origin);
  const b = ray.direction.dot(dir);
  const d = ray.direction.dot(w0);
  const e = dir.dot(w0);
  const denom = 1 - b * b; // a=c=1 (unit vectors)
  if (Math.abs(denom) < 1e-6) return -e;
  return (e - b * d) / denom; // signed param along dir
}

/** Drag distance along a world axis, robust at every view angle. The closest-point
 *  solution degenerates when the camera looks down the axis (orthographic top view
 *  returns a CONSTANT), so near the degeneracy this measures the cursor along the
 *  axis's screen projection; with no screen extent at all, vertical mouse motion
 *  drives it, up = toward the viewer. */
export function axisDragDistance(
  viewport: Viewport,
  clientX: number,
  clientY: number,
  anchor: THREE.Vector3,
  axis: THREE.Vector3,
): number {
  const ray = viewport.rayFrom(clientX, clientY).ray;
  if (Math.abs(ray.direction.dot(axis)) < 0.95) {
    return distanceAlongAxis(ray, anchor, axis);
  }
  const px = viewport.pixelWorldSize(anchor); // world units per screen pixel
  const step = px * 40;
  const p0 = viewport.projectToScreen(anchor);
  const p1 = viewport.projectToScreen(anchor.clone().addScaledVector(axis, step));
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  if (len > 6) {
    // cursor offset along the screen-projected axis, mapped back to world
    return (((clientX - p0.x) * dx + (clientY - p0.y) * dy) / len) * (step / len);
  }
  // axis points dead at / away from the camera
  const camDir = viewport.camera.getWorldDirection(new THREE.Vector3());
  const sign = axis.dot(camDir) < 0 ? 1 : -1; // toward the viewer → mouse up = +
  return (p0.y - clientY) * px * sign;
}

/** The Y-up direction the handle glyph below is modelled along; orient a handle
 *  with `quat.setFromUnitVectors(HANDLE_UP, axis)`. */
export const HANDLE_UP = new THREE.Vector3(0, 1, 0);

/** Pick the sign of a drag axis so it points AWAY from the body.
 *
 *  `perp` is only defined up to a sign, so the handle used to stand outward or
 *  bury itself in the solid depending on where the camera happened to be.
 *  Centre-to-anchor settles it: exact for a convex body, and only ambiguous deep
 *  inside a concave pocket. */
export function orientOutward(
  perp: THREE.Vector3,
  anchor: THREE.Vector3 | null,
  centre: THREE.Vector3 | null,
): THREE.Vector3 {
  if (!anchor || !centre) return perp;
  const out = anchor.clone().sub(centre);
  if (out.lengthSq() < 1e-9) return perp; // handle sits ON the centre: no "out"
  return perp.dot(out) < 0 ? perp.negate() : perp;
}

/** Drag axis for a handle sitting ON an edge: perpendicular to the edge, in the
 *  screen plane, pointing out of the material. Falls back to the camera's right
 *  vector when there is no tangent (multi-edge pre-selection) or the edge points
 *  at the camera.
 *
 *  Shared because the passive handle and the armed tool must agree to the last
 *  digit — both are computed inside the SAME pointerdown, and a hair of
 *  difference makes the handle jump as the user commits. */
export function edgeHandleAxis(
  viewport: Viewport,
  tangent: THREE.Vector3 | null,
  anchor?: THREE.Vector3 | null,
  centre?: THREE.Vector3 | null,
): THREE.Vector3 {
  const fwd = viewport.camera.getWorldDirection(new THREE.Vector3());
  if (tangent) {
    const perp = tangent.clone().cross(fwd);
    if (perp.lengthSq() > 1e-6) {
      return orientOutward(perp.normalize(), anchor ?? null, centre ?? null);
    }
  }
  const right = new THREE.Vector3().setFromMatrixColumn(viewport.camera.matrixWorld, 0).normalize();
  return orientOutward(right, anchor ?? null, centre ?? null);
}

/** Orientation for a gizmo drawn FLAT AGAINST THE SCREEN: local +X along `axis`
 *  as the screen sees it, +Y up the screen, +Z out of it. `fallbackRight` covers
 *  an axis pointing dead at the viewer.
 *
 *  Must stay RIGHT-handed. The obvious `up = fwd x right` spelling has
 *  determinant -1, and setFromRotationMatrix on a reflection returns a non-unit
 *  quaternion for an unrelated rotation — Object3D then applies it as a tilt and
 *  a shrink, which is how the profile arc shipped drawn edge-on. Hit tests also
 *  read screen angles with atan2 about +Y, so a mirrored basis would send the
 *  knob one way round its track while the cursor is read the other. */
export function screenPlaneOrientation(
  forward: THREE.Vector3,
  axis: THREE.Vector3,
  fallbackRight: THREE.Vector3,
): THREE.Quaternion {
  const fwd = forward.clone().normalize();
  const back = fwd.clone().negate(); // out of the screen, toward the camera
  const right = axis.clone().projectOnPlane(fwd);
  if (right.lengthSq() < 1e-9) right.copy(fallbackRight).projectOnPlane(fwd);
  // Only reachable if the caller's "right" was itself along the view direction;
  // any perpendicular beats returning a basis that isn't one.
  if (right.lengthSq() < 1e-9) right.set(1, 0, 0).projectOnPlane(fwd);
  if (right.lengthSq() < 1e-9) right.set(0, 1, 0).projectOnPlane(fwd);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(back, right).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, back),
  );
}

/** Smallest share of a handle's length that must survive projection, as the sine
 *  of the angle to the view direction. 0.4 keeps ~21px of the glyph's 52 and
 *  costs at most 24 degrees of lean. */
export const MIN_SCREEN_AXIS = 0.4;

/** The direction to DRAW a handle along when its own axis points at the camera:
 *  tipped back out of the screen until `minScreen` of it survives, keeping its
 *  existing screen direction so an orbit makes it lean rather than snap.
 *  Otherwise the 52px body projects to a 20px disc with no length to read or aim
 *  at.
 *
 *  For DRAWING only. A press/pull distance means nothing unless measured along
 *  the real face normal, and axisDragDistance already handles a steep axis by
 *  falling back to vertical mouse travel. */
export function leanOutOfView(
  axis: THREE.Vector3,
  forward: THREE.Vector3,
  fallbackRight: THREE.Vector3,
  minScreen: number = MIN_SCREEN_AXIS,
): THREE.Vector3 {
  const fwd = forward.clone().normalize();
  const a = axis.clone().normalize();
  const along = a.dot(fwd);
  const flat = a.clone().addScaledVector(fwd, -along); // the part that shows on screen
  if (flat.length() >= minScreen) return a;
  // Dead-on: there is no screen direction to preserve, so borrow the camera's.
  const dir =
    flat.lengthSq() > 1e-12 ? flat.normalize() : fallbackRight.clone().projectOnPlane(fwd);
  if (dir.lengthSq() < 1e-12) return a; // nothing to lean towards; leave it be
  dir.normalize();
  const depth = Math.sqrt(Math.max(0, 1 - minScreen * minScreen)) * (along < 0 ? -1 : 1);
  return dir.multiplyScalar(minScreen).addScaledVector(fwd, depth).normalize();
}

/** What letting go of the handle should do. */
export type FluentRelease = "commit" | "cancel" | "stay";

/** Releasing the handle: commit, throw the gesture away, or stay armed.
 *
 *  A gesture begun on the PASSIVE selection handle is one press and ends done —
 *  leaving the tool armed would strand the user in a mode they never opted into.
 *  A gesture begun on the tool's own gizmo keeps its explicit commit.
 *
 *  `moved`: a press that never travelled must not commit a default value, so it
 *  stays armed — which doubles as the way in to the full tool.
 *  `meaningful`: a drag that ended back at zero cancels, because staying armed
 *  would strand exactly the user who was backing out. */
export function fluentRelease(opts: {
  fluent: boolean;
  moved: boolean;
  meaningful: boolean;
}): FluentRelease {
  if (!opts.fluent || !opts.moved) return "stay";
  return opts.meaningful ? "commit" : "cancel";
}

// --- the grab handle ------------------------------------------------------
// Painted from the app's own accent tokens (styles/_themes.scss), not a private
// palette: this is the most-looked-at thing on screen.

// The literals are FALLBACKS, not the palette: each is read from its theme token
// at paint time (viewport/themeColors.ts) so a manipulator can never be the one
// part of the app still wearing the previous theme. They stay as the answer for
// a headless context with no document to resolve against.

/** `--accent` */
export const HANDLE_IDLE = 0xff7a3c;
/** `--accent-hot`, for hover and grab */
export const HANDLE_HOT = 0xff9a5c;
/** `--error`, for a push that removes material rather than adding it */
export const HANDLE_CUT = 0xff5c5c;
/** `--bg`: the app's deepest surface, so the blob keeps its shape against a
 *  light face — and stays an outline rather than a halo under a light theme. */
const HANDLE_OUTLINE = 0x0e0f12;

function idleColor() {
  return themeColor("--accent", HANDLE_IDLE);
}
function hotColor() {
  return themeColor("--accent-hot", HANDLE_HOT);
}
function cutColor() {
  return themeColor("--error", HANDLE_CUT);
}

/** Which base colour a handle is wearing. */
export type HandleTone = "idle" | "cut";

export interface DragHandle {
  /** Add this to the scene; scale it by pixelWorldSize(anchor) each frame. */
  group: THREE.Group;
  /** Repaint. Omitted fields keep their current value. */
  paint(opts: { hot?: boolean; tone?: HandleTone; opacity?: number }): void;
  /** Free GPU resources. Removing the group from the scene stays the caller's
   *  job — only it knows which scene that is. */
  dispose(): void;
}

/** The lathe profile, as (radius, height) in PIXELS: a slim shaft with a cone at
 *  EACH end.
 *
 *  Double-ended on purpose, and this is the constraint any redesign has to keep.
 *  The edge drag runs a fillet one way and a chamfer the other, through "no
 *  feature" at zero, so a single arrowhead would promise a direction the gesture
 *  does not have. Two heads say what is true: slide me along this line, either
 *  way. The shape this replaced was a fat rounded blob, which avoided the same
 *  problem by pointing nowhere at all.
 *
 *  Lathed as a POLYLINE, not sampled through a spline: the steps at 11 and 34 are
 *  where the shaft meets each cone, and a spline would round exactly those into
 *  the blob this stopped being. The facets are the shape now. */
const PROFILE: [number, number][] = [
  [0.0, 5.0], // lower point, stood off the surface so it never buries in the face
  [4.5, 14.0], // lower head, at its widest
  [1.5, 14.0], // step in to the shaft
  [1.5, 31.0], // shaft
  [4.5, 31.0], // upper head, at its widest
  [0.0, 45.0], // upper point
];

/** How far the outline stands off the body, in the same pixel units.
 *
 *  A constant WIDTH, which is what a cell-shaded edge is, rather than the
 *  uniform scale this used to be. A scale outlines a thin shape thinly: at the
 *  old 1.13 the shaft would carry an edge under half a pixel wide and wash out
 *  over a pale face, which is the one thing the outline exists to prevent. This
 *  is also smaller than what the scale gave the old blob at its widest. */
const OUTLINE_PX = 0.9;

/** The same profile, pushed out by `k` along its own normal: the outline's
 *  shape. The ends extend by `k` as well, so a cone's point is covered rather
 *  than left poking through its own edge. */
function outset(profile: [number, number][], k: number): [number, number][] {
  return profile.map(([r, y], i) => {
    const prev = profile[i - 1] ?? profile[i]!;
    const next = profile[i + 1] ?? profile[i]!;
    // The outward normal of the profile polyline, which for a lathe points away
    // from the axis. Degenerate at a lone point, where it falls back to radial.
    const tx = next[0] - prev[0];
    const ty = next[1] - prev[1];
    const len = Math.hypot(tx, ty) || 1;
    const nx = ty / len;
    const ny = -tx / len;
    const endY = i === 0 ? -k : i === profile.length - 1 ? k : 0;
    return [Math.max(0, r + nx * k), y + ny * k + endY];
  });
}

/** The drawn glyph's height in its own units — the profile's last y. Read by
 *  handleScale, so retuning the profile retunes the size cap with it. */
export const HANDLE_LENGTH = 45;

/** How far off the axis a press still counts as grabbing the handle, in pixels.
 *
 *  The old handle was hit-tested against its own geometry — a 1.6px shaft or a 5px
 *  cone — which is why it took careful aim. These proxies never draw; Three's
 *  raycaster tests layers, not `visible`, so an invisible mesh is still pickable
 *  (locked down by a test, since the affordance rests on it).
 *
 *  Deliberately NOT slimmed with the drawn profile: they never render, so a
 *  smaller one buys no visual restraint and spends the aiming margin. */
const GRAB_HEAD = 17;
const GRAB_STEM = 11;

/** Most of the model's on-screen size the handle may occupy. Lives in
 *  viewport/gizmoScale.ts now, because the origin arrows are sized by the same
 *  rule and two copies of a rule drift. */
export const HANDLE_MODEL_FRACTION = GLYPH_MODEL_FRACTION;

/** How far the handle may be shrunk before it stops being a target worth
 *  aiming at. At 0.45 of a 45-unit glyph it is still ~20px with a ~7px grab
 *  radius, which a hand can hit; below that the cure is worse than the disease
 *  and it is better to let the handle look large than to make it unusable. */
export const MIN_HANDLE_SCALE = 0.45;

/** Multiplier on the constant-pixel scale, so the handle cannot dwarf what it is
 *  attached to.
 *
 *  Constant SCREEN size is right while the model is the bigger of the two; zoom
 *  out until the part is 60px across and a 45px handle is a balloon with an object
 *  hanging off it. So the pixel scale stands until the handle would exceed a
 *  fraction of the model's on-screen size, and from there they shrink together.
 *  Returns 1 when there is nothing to measure against, never 0. */
export function handleScale(
  modelDiagonal: number | null,
  pixelWorldSize: number | null,
): number {
  return glyphScale(HANDLE_LENGTH, modelDiagonal, pixelWorldSize, MIN_HANDLE_SCALE);
}

/** How far the drawn handle reaches from its anchor along its axis, in SCREEN
 *  pixels, at this zoom and model size.
 *
 *  Everything that has to stand clear of the handle needs this number, and the
 *  only alternative is a constant guessed from a screenshot. The selection
 *  toolbar carried exactly that guess — 64px, with a comment saying the two
 *  "must not overlap" — and measured on a fitted 40mm box the bar's bottom edge
 *  and the handle's top landed on the same pixel: no clearance at all, so the
 *  arrow read as a stalk hanging off the toolbar rather than as a control
 *  standing on the face. */
export function handleReachPx(
  modelDiagonal: number | null,
  pixelWorldSize: number | null,
): number {
  return HANDLE_LENGTH * handleScale(modelDiagonal, pixelWorldSize);
}

function lathe(profile: [number, number][]): THREE.LatheGeometry {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 28);
}

export function createDragHandle(tone: HandleTone = "idle"): DragHandle {
  const group = new THREE.Group();
  group.renderOrder = 999;

  // Lit, not flat: the scene's key/fill/hemisphere lights are what make this
  // read as a rounded body rather than a silhouette. The emissive floor keeps it
  // legible when the lights are behind it — and doubles as the "molten" of the
  // theme's molten amber.
  const body = new THREE.MeshLambertMaterial({
    color: idleColor(),
    emissive: idleColor(),
    emissiveIntensity: 0.5,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 1,
  });
  const geo = lathe(PROFILE);
  const blob = new THREE.Mesh(geo, body);
  blob.renderOrder = 999;

  // A back-face shell standing off by a constant width, an outline, so the
  // handle holds its shape over a pale face where amber-on-white would otherwise
  // wash out. Its own geometry rather than a scaled copy of the body's: a scale
  // outlines a 1.3px shaft with a fraction of a pixel and the head with several,
  // so the edge would thin out exactly where the shape is thinnest.
  const outlineMat = new THREE.MeshBasicMaterial({
    color: themeColor("--bg", HANDLE_OUTLINE),
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 1,
  });
  const outlineGeo = lathe(outset(PROFILE, OUTLINE_PX));
  const outline = new THREE.Mesh(outlineGeo, outlineMat);
  outline.renderOrder = 998;

  // Invisible, generous, and DIRECT children of the group: every consumer hit
  // tests with intersectObjects(group.children, false), so widening the target
  // needs no change at any call site.
  const hidden = new THREE.MeshBasicMaterial({ visible: false, depthTest: false });
  const grabHead = new THREE.Mesh(new THREE.SphereGeometry(GRAB_HEAD, 10, 8), hidden);
  grabHead.position.y = 38;
  const grabStem = new THREE.Mesh(
    new THREE.CylinderGeometry(GRAB_STEM, GRAB_STEM, 30, 8),
    hidden,
  );
  grabStem.position.y = 19;

  group.add(outline, blob, grabHead, grabStem);

  let hot = false;
  let currentTone: HandleTone = tone;
  // Resolved on every repaint, not captured once: a theme change has to reach a
  // handle that is already on screen, and repaint is the only moment its colour
  // is allowed to move.
  const apply = () => {
    const base = currentTone === "cut" ? cutColor() : idleColor();
    const c = hot ? hotColor() : base;
    body.color.set(c);
    body.emissive.set(c);
    outlineMat.color.set(themeColor("--bg", HANDLE_OUTLINE));
  };
  apply();

  return {
    group,
    paint(opts) {
      if (opts.hot !== undefined) hot = opts.hot;
      if (opts.tone !== undefined) currentTone = opts.tone;
      if (opts.hot !== undefined || opts.tone !== undefined) apply();
      if (opts.opacity !== undefined) {
        body.opacity = opts.opacity;
        // The outline fades faster than the body: at the passive handle's 55%
        // a full-strength outline reads as the loudest thing on screen, which
        // is backwards for an offer the user has not accepted yet.
        outlineMat.opacity = opts.opacity * 0.8;
      }
    },
    dispose() {
      geo.dispose();
      outlineGeo.dispose(); // its own geometry now, not a scaled share of the body's
      grabHead.geometry.dispose();
      grabStem.geometry.dispose();
      body.dispose();
      outlineMat.dispose();
      hidden.dispose();
    },
  };
}
