// A region selection is stored as world-space anchors, re-resolved against re-detected regions each rebuild.

import * as THREE from "three";
import type { SketchPlane } from "./plane";
import { pointInRegion, type Region } from "./region";

// mm. Anchors sit exactly on their plane, a parallel sketch is offset by whole mm.
const PLANE_EPS = 1e-3;

/** On the region's plane AND inside its material. to2D projects orthogonally, so without the plane gate an anchor
 *  fell inside a parallel sketch's region (selecting an upper loft ring also picked the lower disk). */
export function worldPointInRegion(p: THREE.Vector3, plane: SketchPlane, region: Region): boolean {
  if (Math.abs(plane.plane.distanceToPoint(p)) > PLANE_EPS) return false;
  return pointInRegion(plane.to2D(p), region);
}
