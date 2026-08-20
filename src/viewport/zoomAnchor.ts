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
