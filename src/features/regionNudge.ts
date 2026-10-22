// The drag handle on a selected sketch profile: the arrow from selectionNudge.ts along the sketch normal,
// handing over to ExtrudeTool.

import * as THREE from "three";
import type { NudgePlacement } from "./selectionNudge";

/** The part of SketchOverlay's WorldRegion that matters here, narrowed so this file tests without an overlay. */
export interface RegionAnchorSource {
  interior3D: THREE.Vector3;
  plane: { n: THREE.Vector3 };
}

/** Shared with ExtrudeTool, which arms in the same pointerdown and draws its own arrow here, so two derivations
 *  would make the arrow twitch. An empty selection returns the origin. */
export function regionAnchor(regions: readonly RegionAnchorSource[]): THREE.Vector3 {
  const a = new THREE.Vector3();
  for (const wr of regions) a.add(wr.interior3D);
  return a.divideScalar(regions.length || 1);
}

/** Several areas get one handle on their shared normal, the only thing extruding them together can mean. */
export function regionNudgePlacement(
  regions: readonly RegionAnchorSource[],
  onGrab: (clientX: number, clientY: number) => void,
): NudgePlacement | null {
  const first = regions[0];
  if (!first) return null;
  const axis = first.plane.n.clone().normalize();
  if (axis.lengthSq() < 0.5) return null; // degenerate plane, nothing to point along
  return {
    anchor: regionAnchor(regions),
    // Fixed, unlike an edge's: the sketch normal is the one direction a profile grows in. ExtrudeTool flips the arrow
    // when the distance goes negative, which is how a cut reads.
    axis: () => axis,
    grab: onGrab,
  };
}
