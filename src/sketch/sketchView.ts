// Where a sketch LANDS when you start it on a face, and how far the view is
// allowed to drift off that face once you are drawing on it.
//
// Both are arithmetic, and both are the kind of arithmetic a user notices when
// it is wrong — a basis that spins between two invocations moves every
// coordinate in the sketch, and a normal that points into the solid makes the
// first extrude cut instead of add. So they live here, in plain tuples with no
// THREE.js, no camera and no viewport, where vitest can pin them down (the same
// split features/edgeDragMath.ts makes for the edge gesture).

import type { PlaneDef } from "../types";

export type Vec3 = readonly [number, number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Unit vector, or null when there is no direction to be had. */
function unit(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 1e-12) || !Number.isFinite(len)) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

const WORLD_AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** Fallback normal when the caller hands us nothing usable — +Z, so a degenerate
 *  pick still produces a sketch you can draw on rather than NaNs. */
const FALLBACK_N: Vec3 = [0, 0, 1];

/** Flip `normal` so it points away from `inside` — the material side.
 *
 *  A face's outward direction normally comes for free: the tessellation of a
 *  sewn solid is wound so the triangle normal already points out, and the
 *  derivation below is careful never to invert it. This is the escape hatch for
 *  the cases where that is not true (an imported mesh with reversed winding),
 *  and it is deliberately something the CALLER opts into by supplying a point it
 *  knows to be inside the material — because a naive "centre of the body" test
 *  gets the underside of an overhang exactly backwards, and silently flipping a
 *  correct normal is worse than not flipping a wrong one.
 *
 *  `inside` of null means "trust the normal", which is what the face pick does. */
export function outwardNormal(normal: Vec3, at: Vec3, inside: Vec3 | null): Vec3 {
  if (!inside) return normal;
  const out: Vec3 = [at[0] - inside[0], at[1] - inside[1], at[2] - inside[2]];
  if (dot(out, out) < 1e-18) return normal; // the point IS the reference: no "out"
  return dot(normal, out) < 0 ? [-normal[0], -normal[1], -normal[2]] : normal;
}

/** The sketch's +X axis for a plane with this normal — the one genuinely free
 *  decision in the derivation, and therefore the one to nail down.
 *
 *  Find the world axis the face most nearly FACES (largest normal component), take
 *  the next axis in the cyclic X->Y->Z order, and project the normal out of it. On
 *  the cardinal faces that reproduces the expected bases (+Z gets u=+X, v=+Y; +X
 *  gets u=+Y, v=+Z) and elsewhere it varies smoothly with the normal.
 *
 *  It deliberately does NOT read the camera, the click point, or the previous
 *  invocation: deriving u from anything but the normal is how a sketch ends up
 *  rotated differently each time you open it on the same face, moving every stored
 *  coordinate in it. The only discontinuity left is an exact tie between two
 *  components, and the axis ORDER settles that.
 *
 *  Conditioning is free as a side effect: the chosen axis is never the dominant
 *  one, so |n·axis| <= 1/sqrt(2) and the projection cannot collapse. */
export function sketchXdir(normal: Vec3): Vec3 {
  const n = unit(normal) ?? FALLBACK_N;
  let dominant = 0;
  for (let i = 1; i < 3; i++) {
    if (Math.abs(n[i]!) > Math.abs(n[dominant]!)) dominant = i;
  }
  const axis = WORLD_AXES[(dominant + 1) % 3]!;
  const k = dot(n, axis);
  return (
    unit([axis[0] - n[0] * k, axis[1] - n[1] * k, axis[2] - n[2] * k]) ?? [1, 0, 0]
  );
}

/** The sketch plane for a picked face: its own plane, normal pointing out of the
 *  solid, axes from sketchXdir.
 *
 *  The origin is NOT the face centroid — it is the WORLD origin projected onto
 *  the face's plane, `n·(n·p)`. Grid snapping rounds in plane-local coordinates
 *  (snap.ts), so the origin is what decides where the lattice falls in world
 *  space; anchoring on the face gave every sketch-on-face its own grid, offset
 *  from the model's by a tessellation-dependent fraction of a millimetre.
 *  Viewport.pickFacePlane, planeOffsetTool and the datum planes all project the
 *  world origin for the same reason, so this keeps every route to a plane on one
 *  lattice. */
export function faceSketchPlane(
  normal: Vec3,
  point: Vec3,
  inside: Vec3 | null = null,
): PlaneDef {
  const n = outwardNormal(unit(normal) ?? FALLBACK_N, point, inside);
  const xdir = sketchXdir(n);
  const d = dot(n, point);
  return {
    origin: [n[0] * d, n[1] * d, n[2] * d],
    normal: [n[0], n[1], n[2]],
    xdir: [xdir[0], xdir[1], xdir[2]],
  };
}

/** The in-plane +Y that SketchPlane will derive from a PlaneDef (v = n × u).
 *  Exported for the tests, which have to be able to say "the basis is
 *  right-handed with the normal pointing out" without reconstructing it. */
export function sketchYdir(plane: PlaneDef): Vec3 {
  return cross(plane.normal, plane.xdir);
}

/** How far the view may pull back before the sketch's square-to-the-plane lock
 *  lets go, as a multiple of the framing the sketch opened at.
 *
 *  Roughly "you have zoomed out to look at the part rather than at what you are
 *  drawing". Low enough that one deliberate scroll-out reaches it, high enough
 *  that the nudge of zoom people do while drawing does not. */
export const VIEW_RELEASE_FACTOR = 2.2;

/** Does the straight-on lock still apply at this zoom?
 *
 *  The lock is what makes drawing precise — square to the plane, orthographic,
 *  no orbit — and it is right for as long as you are working at drawing scale.
 *  It is wrong the moment you pull back to see where the sketch sits on the
 *  part, which is exactly what you do on a face at an awkward angle: held rigid,
 *  the model behind the sketch is a flat silhouette with no depth to read.
 *
 *  So the lock is a function of zoom rather than a mode. Scroll out past the
 *  release factor and it lets go — once, and for the rest of the session, since
 *  re-squaring the camera underneath a user who has just taken hold of the view
 *  is the very thing that makes a hard lock feel rigid. Look At (or re-arming
 *  the palette toggle) is how you ask for it back. */
export function sketchLockHolds(entryScale: number, scale: number): boolean {
  if (!(entryScale > 0) || !Number.isFinite(entryScale)) return true; // no baseline yet
  if (!(scale > 0) || !Number.isFinite(scale)) return true;
  return scale <= entryScale * VIEW_RELEASE_FACTOR;
}

/** How far off square the view may drift before a sketch that is NOT locked to
 *  its plane gives up the flat projection, in degrees.
 *
 *  Wide enough that the small parallax of a fit or a pan does not trip it,
 *  narrow enough that a deliberate orbit does on the first few pixels. */
export const SQUARE_TOL_DEG = 8;

/** Is the camera still looking straight down this plane?
 *
 *  With "Lock to Plane" off, entering a sketch still squares the view and still
 *  forces the flat (orthographic) projection, because that is what makes drawing
 *  precise. Both are wrong the moment you turn away to see where the sketch sits
 *  on the part: held flat, an off-axis model is a silhouette with no depth. So
 *  the projection follows the view rather than the mode, and this is the test.
 *
 *  Sign-blind: looking at the plane from behind is just as square as looking at
 *  it from in front, and which side you are on is settled at entry
 *  (viewport/viewFlight.viewSideNormal) rather than re-litigated every frame. */
export function viewSquareToPlane(
  viewDir: Vec3,
  normal: Vec3,
  tolDeg: number = SQUARE_TOL_DEG,
): boolean {
  const d = unit(viewDir);
  const n = unit(normal);
  if (!d || !n) return true; // nothing to measure: assume it still holds
  return Math.abs(dot(d, n)) >= Math.cos((tolDeg * Math.PI) / 180);
}
