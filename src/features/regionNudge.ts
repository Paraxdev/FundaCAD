// Where the drag handle stands on a selected sketch PROFILE, and what grabbing
// it does.
//
// The third of the three (edgeNudge.ts, faceNudge.ts), and the one that closes
// the loop the app is actually built around: draw a closed shape, pull it into
// a solid. Until now that middle step was "and then find Extrude", the sketch
// told you so in a prompt line, which is the app naming an operation instead of
// showing you one.
//
// Same arrow, same loop (selectionNudge.ts), pointed along the sketch plane's
// normal and handing over to ExtrudeTool.

import * as THREE from "three";
import type { NudgePlacement } from "./selectionNudge";

/** What a selected profile area contributes to the handle. The full
 *  SketchOverlay WorldRegion carries far more; this is the part that matters
 *  here, and narrowing it keeps this file testable without an overlay. */
export interface RegionAnchorSource {
  interior3D: THREE.Vector3;
  plane: { n: THREE.Vector3 };
}

/** The point the arrow stands on and the extrude grows from: the mean of the
 *  selected areas' interior points.
 *
 *  Shared with ExtrudeTool rather than reimplemented, for the reason the whole
 *  fluent flow keeps coming back to, the tool arms inside the pointerdown that
 *  grabbed this handle and immediately draws its own arrow here. Two derivations
 *  of "the middle of the selection" that agreed to within a millimetre would
 *  still make the arrow twitch at the moment the user commits to the drag.
 *
 *  An empty selection returns the origin; callers that care check first. */
export function regionAnchor(regions: readonly RegionAnchorSource[]): THREE.Vector3 {
  const a = new THREE.Vector3();
  for (const wr of regions) a.add(wr.interior3D);
  return a.divideScalar(regions.length || 1);
}

/** The placement for a profile selection, or null when there is none.
 *
 *  Several areas get ONE handle, on their shared normal, which is also the
 *  only thing extruding them together can mean. */
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
    // Fixed, like a face's and unlike an edge's: the sketch plane's normal is
    // the one direction the profile can grow in, so an orbit must not re-aim
    // it. Positive is "out of the sketch"; ExtrudeTool flips the arrow and
    // recolours the preview when the drag takes the distance negative, which is
    // how a cut reads.
    axis: () => axis,
    grab: onGrab,
  };
}
