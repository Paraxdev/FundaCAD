// When 'auto' projection is orthographic, shared by both camera rigs.

import * as THREE from "three";

/** 'auto' projection is orthographic within this of a world axis. */
export const AXIS_SNAP_COS = Math.cos((0.5 * Math.PI) / 180);

/** A perspective view stays until the eye is this far clear of the content box, in box diagonals, so an eye on the box
 *  wall never flips the projection back and forth. Never more than a tenth of the distance to the target, so a deep
 *  zoom onto a part still snaps from just outside it. */
export const EDGE_HYSTERESIS = 0.02;
export const EDGE_HYSTERESIS_OF_DISTANCE = 0.1;

export function onWorldAxis(x: number, y: number, z: number): boolean {
  const len = Math.hypot(x, y, z);
  if (!(len > 1e-9)) return false;
  return Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) / len >= AXIS_SNAP_COS;
}

const grown = new THREE.Box3();

/** Whether 'auto' wants orthographic: a view along a world axis, unless the eye is inside the content box, where the
 *  frustum would start outside the walls. An orthographic view stays until the eye is inside the box, a perspective one
 *  until it is clear of it by the hysteresis. `dir` runs from the eye to the target. The navigator's orthographic eye is
 *  only scale over lens, so it asks this just when a view is set by its eye. */
export function autoWantsOrtho(
  dir: THREE.Vector3,
  eye: THREE.Vector3,
  box: THREE.Box3 | null,
  orthoNow: boolean,
): boolean {
  if (!onWorldAxis(dir.x, dir.y, dir.z)) return false;
  if (!box || box.isEmpty()) return true;
  if (orthoNow) return !box.containsPoint(eye);
  grown
    .copy(box)
    .expandByScalar(
      Math.min(EDGE_HYSTERESIS * box.min.distanceTo(box.max), EDGE_HYSTERESIS_OF_DISTANCE * dir.length()),
    );
  return !grown.containsPoint(eye);
}
