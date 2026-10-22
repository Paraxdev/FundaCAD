// Where the drag handle stands on a selected face, the mirror of edgeNudge.ts handing over to PressPullTool. The
// anchor and normal come from viewport.selectedFacesForPressPull(), the call the tool makes, so the arrow cannot jump.

import * as THREE from "three";
import type { NudgePlacement } from "./selectionNudge";
import type { RoundFace } from "./radialDrag";

/** What selectedFacesForPressPull() gives us, narrowed to what a handle needs. */
export interface FacePreselection {
  normal: THREE.Vector3;
  anchor: THREE.Vector3;
  /** set when the face is a lone cylinder, the drag resizes it instead */
  round?: RoundFace | null;
  /** the first of several faces when it is a cylinder, which may resize them as one */
  lead?: RoundFace | null;
}

/** Several faces get one handle on the first face, as the tool measures along that first normal. On a round face it
 *  points away from the axis, bore or boss alike, since the drag is a resize and a closed cylinder's averaged normal
 *  is not a direction. */
export function faceNudgePlacement(
  pre: FacePreselection | null,
  onGrab: (clientX: number, clientY: number) => void,
): NudgePlacement | null {
  if (!pre) return null;
  const axis = ((pre.round ?? pre.lead)?.radial ?? pre.normal).clone().normalize();
  if (axis.lengthSq() < 0.5) return null; // degenerate normal, nothing to point along
  return {
    anchor: pre.anchor.clone(),
    // Fixed, unlike the edge handle's: a face's normal is geometry, so orbiting must not swing it. The tool turns the
    // arrow red and flips it when the value goes negative.
    axis: () => axis,
    grab: onGrab,
  };
}
