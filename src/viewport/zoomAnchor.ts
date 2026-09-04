// Wheel zoom that leaves the point under the cursor under the cursor.
//
// Dollying toward the cursor is a SIMILARITY about the cursor point: scale the
// camera and the orbit target about it by the same factor. That pins the point
// to its pixel by construction rather than by correction, because a similarity
// centred on a point fixes that point, and every other point keeps its bearing
// from it.
//
// The tempting simplification is to project the cursor onto the view axis first
// and scale about that, on the grounds that moving the camera sideways would
// re-angle the model. It does not, and the reason is worth stating because the
// mistake is easy to make twice: the camera-to-target offset comes out as
//
//     [A + (cam - A) * f] - [A + (target - A) * f]  =  (cam - target) * f
//
// for ANY anchor A. The offset is scaled, never rotated, so the view direction
// is bit-identical whichever anchor is used, and only the target translates.
// What the projection actually does is throw the cursor's LATERAL component
// away: the camera dives forward while nothing tracks sideways, so what you
// aimed at slides off screen within a handful of notches and the view fills with
// geometry you did not ask for.
//
// Kept apart from cameras.ts so the property can be measured rather than
// eyeballed: `tests/viewport/zoomAnchor.test.ts` projects the anchor through a
// real camera after every notch of a long zoom and watches its pixel.

import * as THREE from "three";

export interface Dolly {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/** How far along the cursor ray the ground plane may be and still be worth
 *  aiming at, as a multiple of the current target distance. Past this the view
 *  is grazing the plane and the "point under the cursor" is out on the horizon,
 *  which is somewhere nobody meant to zoom to. */
export const GROUND_ANCHOR_REACH = 20;

/** Where the cursor ray meets the ground plane, or null when that is not a
 *  sensible place to aim.
 *
 *  This is the zoom anchor whenever the cursor is over empty space, and it
 *  replaces a point on the ray at the current target distance — a point on a
 *  SPHERE around the camera rather than on any surface. That distinction is not
 *  academic. Zooming toward it converges the orbit target onto a point off the
 *  grid plane, so the camera walks steadily toward that plane and eventually
 *  through it: measured on an empty document, eight notches of wheel put the
 *  target 0.38mm below z = 0 and the camera 0.07mm below it, at which point the
 *  entire lattice is behind the eye and the viewport is blank while the readout
 *  still says "Grid 0.02 mm".
 *
 *  Aiming at the plane the grid is drawn on keeps the target on it, so the grid
 *  stays under the cursor however far in the wheel goes. It is also what the
 *  user is looking at: over empty space, the ground IS the surface on screen.
 *
 *  Returns null for a ray parallel to the plane, one pointing away from it, and
 *  one whose hit is absurdly far off (see GROUND_ANCHOR_REACH) — the caller
 *  keeps its old fallback for all three.
 */
export function groundAnchor(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  planeZ: number,
  targetDist: number,
  out = new THREE.Vector3(),
): THREE.Vector3 | null {
  if (!Number.isFinite(planeZ) || !Number.isFinite(targetDist) || targetDist <= 0) return null;
  const dz = dir.z;
  // A ray within about 3 degrees of the plane hits it thousands of distances
  // away, if at all; the reach test below would refuse those anyway, but the
  // division comes first and it is the one that can produce an infinity.
  if (!Number.isFinite(dz) || Math.abs(dz) < 1e-6) return null;
  const t = (planeZ - origin.z) / dz;
  if (!(t > 0) || t > targetDist * GROUND_ANCHOR_REACH) return null;
  return out.copy(dir).multiplyScalar(t).add(origin);
}

/** Camera and target after one wheel notch of `factor` toward `pivot`.
 *
 *  `null` means the move is refused because the view is already as close as
 *  `minDist` allows; the caller should leave the camera alone.
 *
 *  `factor` < 1 zooms in. `minDist` is the closest the camera may come to what
 *  it is looking at, which is what keeps geometry off the near plane.
 */
export function anchorDolly(
  cam: THREE.Vector3,
  target: THREE.Vector3,
  pivot: THREE.Vector3,
  factor: number,
  minDist: number,
): Dolly | null {
  // A cursor point at or behind the camera is a degenerate raycast, not a place
  // to zoom toward. Fall back to the orbit target, which is always in front.
  const forward = target.clone().sub(cam).normalize();
  const depth = pivot.clone().sub(cam).dot(forward);
  const anchor = depth > minDist ? pivot : target;

  let f = factor;
  if (f < 1) {
    // Zooming IN only, and against whichever is nearer: the surface under the
    // cursor is often much closer than the orbit target, and guarding only the
    // target lets an extreme zoom push that surface through the near plane.
    //
    // The `f < 1` gate is load-bearing. |cam - pivot| is routinely already
    // inside minDist when the cursor rests on a near face, so an ungated clamp
    // would take the refusal below and decline to zoom back OUT, wedging the
    // view with no way to recover except a view reset.
    const near = Math.min(cam.distanceTo(target), cam.distanceTo(anchor));
    if (near * f < minDist) {
      if (near <= minDist) return null;
      f = minDist / near; // land exactly on the limit this step
    }
  }

  return {
    position: anchor.clone().add(cam.clone().sub(anchor).multiplyScalar(f)),
    target: anchor.clone().add(target.clone().sub(anchor).multiplyScalar(f)),
  };
}

/** Absolute floor on the orthographic zoom, whatever the controls allow. At the
 *  100mm base frustum this is a ten-metre view; below it the numbers stop
 *  meaning anything for a part. */
export const ORTHO_ZOOM_FLOOR = 1e-4;

export interface OrthoZoom {
  /** The zoom to apply. Already inside the limits the controls will enforce, so
   *  it is what the camera will actually end up with. */
  zoom: number;
  /** How far to move camera and target toward the cursor point, as a fraction
   *  of the offset from the target to it. Exactly 0 when the zoom did not
   *  change, which is the whole reason this returns both together. */
  truck: number;
}

/** One notch of orthographic wheel zoom: the new zoom, and the truck that keeps
 *  the point under the cursor under the cursor.
 *
 *  The two MUST be computed from the same number, and the number has to be the
 *  one the camera will really wear. Orthographic zoom has a hard stop
 *  (camera-controls clamps to its own minZoom, 0.01 by default), and a caller
 *  that clamped to a floor of its own below that one got a truck derived from a
 *  zoom nothing would apply: past the stop, `1 - current/zoom` went negative and
 *  kept growing, so every further notch slid the view sideways while the zoom
 *  itself never moved again. Measured by wheeling out at a fixed cursor, the
 *  camera walked from x=60 to x=4697 with the zoom reading 0.01 throughout —
 *  scrolling that leaves the part behind instead of showing more of it.
 *
 *  `factor` > 1 zooms out. `minZoom`/`maxZoom` are the controls' own limits.
 */
export function orthoZoomStep(
  current: number,
  factor: number,
  minZoom: number,
  maxZoom: number,
): OrthoZoom {
  const lo = Math.max(
    ORTHO_ZOOM_FLOOR,
    Number.isFinite(minZoom) && minZoom > 0 ? minZoom : ORTHO_ZOOM_FLOOR,
  );
  const hi = Number.isFinite(maxZoom) && maxZoom > lo ? maxZoom : Infinity;
  if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(factor) || factor <= 0) {
    return { zoom: Math.min(hi, Math.max(lo, 1)), truck: 0 };
  }
  const zoom = Math.min(hi, Math.max(lo, current / factor));
  return { zoom, truck: 1 - current / zoom };
}
