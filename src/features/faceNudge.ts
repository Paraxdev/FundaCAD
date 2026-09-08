// Where the drag handle stands on a selected FACE, and what grabbing it does.
//
// The mirror of edgeNudge.ts: same arrow, same loop (selectionNudge.ts), same
// one-press gesture, pointed along the face normal and handing over to
// PressPullTool instead of EdgeFeatureTool.
//
// The anchor and the normal come from viewport.selectedFacesForPressPull(),
// which is the SAME call PressPullTool.start() makes off the same selection.
// That is not laziness, it is the correctness argument: the tool arms inside
// the pointerdown that grabbed this handle, and if the two derived their
// geometry independently the arrow would jump the instant the user committed to
// the drag. One source, no divergence possible.

import * as THREE from "three";
import type { NudgePlacement } from "./selectionNudge";
import type { RoundFace } from "./radialDrag";

/** What selectedFacesForPressPull() gives us, narrowed to what a handle needs. */
export interface FacePreselection {
  normal: THREE.Vector3;
  anchor: THREE.Vector3;
  /** set when the face is a lone cylinder, the drag resizes it instead */
  round?: RoundFace | null;
}

/** The placement for a face selection, or null when there is none.
 *
 *  A multi-face selection gets ONE handle, standing on the first face and
 *  pointing along its normal, again matching the tool, which pushes every
 *  selected face by the one distance measured along that same first normal.
 *
 *  On a round face the arrow points AWAY FROM THE AXIS rather than along the
 *  face normal, because the drag it arms is a resize. Away from the axis on a
 *  bore as well as a boss: pulling the handle outward means a bigger hole and a
 *  bigger shaft alike, and the difference between them is a sign the tool
 *  applies on the way to the kernel, not a direction the user has to think
 *  about. The face normal is not merely unhelpful here, on a closed cylinder it
 *  is the average of normals that cancel, so it is not a direction at all. */
export function faceNudgePlacement(
  pre: FacePreselection | null,
  onGrab: (clientX: number, clientY: number) => void,
): NudgePlacement | null {
  if (!pre) return null;
  const axis = (pre.round?.radial ?? pre.normal).clone().normalize();
  if (axis.lengthSq() < 0.5) return null; // degenerate normal, nothing to point along
  return {
    anchor: pre.anchor.clone(),
    // Fixed, unlike the edge handle's: a face's normal is a property of the
    // geometry, so orbiting must NOT swing the arrow. Pointing outward is also
    // the honest default, the drag starts at zero and pulling material out is
    // what the arrow is inviting; pushing in is the same gesture reversed, and
    // the tool turns the arrow red and flips it when the value goes negative.
    axis: () => axis,
    grab: onGrab,
  };
}
