// Wheel zoom is a similarity about the cursor point, which pins it to its pixel. Projecting that point onto the
// view axis first gains nothing (every anchor keeps the view angle), it drops the lateral part and the aim slides off.

import * as THREE from "three";

export interface Dolly {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/** A multiple of the target distance, past it the view grazes the plane and the hit is on the horizon. */
export const GROUND_ANCHOR_REACH = 20;

/** The zoom anchor over empty space. A point on the ray at target distance walked the camera through z = 0
 *  in eight notches (measured), blanking the view. Null for a parallel, receding or too distant hit. */
export function groundAnchor(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  planeZ: number,
  targetDist: number,
  out = new THREE.Vector3(),
): THREE.Vector3 | null {
  if (!Number.isFinite(planeZ) || !Number.isFinite(targetDist) || targetDist <= 0) return null;
  const dz = dir.z;
  // The reach test would refuse a near parallel ray too, but the division comes first and can give an infinity.
  if (!Number.isFinite(dz) || Math.abs(dz) < 1e-6) return null;
  const t = (planeZ - origin.z) / dz;
  if (!(t > 0) || t > targetDist * GROUND_ANCHOR_REACH) return null;
  return out.copy(dir).multiplyScalar(t).add(origin);
}

/** `factor` < 1 zooms in. Null refuses the move, the view is already as close as `minDist` allows,
 *  which keeps geometry off the near plane. */
export function anchorDolly(
  cam: THREE.Vector3,
  target: THREE.Vector3,
  pivot: THREE.Vector3,
  factor: number,
  minDist: number,
): Dolly | null {
  // A pivot at or behind the camera is a degenerate raycast, the orbit target is always in front.
  const forward = target.clone().sub(cam).normalize();
  const depth = pivot.clone().sub(cam).dot(forward);
  const anchor = depth > minDist ? pivot : target;

  let f = factor;
  if (f < 1) {
    // Clamp against the nearer of target and cursor surface, and only zooming in: the pivot is often already
    // inside minDist, so an ungated clamp would refuse to zoom back out and wedge the view.
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

/** At the 100mm base frustum this is a ten metre view. */
export const ORTHO_ZOOM_FLOOR = 1e-4;

export interface OrthoZoom {
  /** Already inside the controls' limits, so it is what the camera ends up with. */
  zoom: number;
  /** Fraction of the target to cursor offset. Exactly 0 when the zoom did not change. */
  truck: number;
}

/** Zoom and truck come from the zoom the camera really wears: a truck from one past camera-controls' minZoom
 *  slid the view sideways forever (measured x=60 to 4697 at zoom 0.01). `factor` > 1 zooms out. */
export function orthoZoomStep(current: number, factor: number, minZoom: number, maxZoom: number): OrthoZoom {
  const lo = Math.max(ORTHO_ZOOM_FLOOR, Number.isFinite(minZoom) && minZoom > 0 ? minZoom : ORTHO_ZOOM_FLOOR);
  const hi = Number.isFinite(maxZoom) && maxZoom > lo ? maxZoom : Infinity;
  if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(factor) || factor <= 0) {
    return { zoom: Math.min(hi, Math.max(lo, 1)), truck: 0 };
  }
  const zoom = Math.min(hi, Math.max(lo, current / factor));
  return { zoom, truck: 1 - current / zoom };
}
