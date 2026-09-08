// Where the drag handle stands on a selected EDGE, and what grabbing it does.
//
// The handle itself, its hover behaviour and its per-frame loop live in
// features/selectionNudge.ts, shared with faces. This file is only the two
// edge-specific answers: the placement, and the hand-off to EdgeFeatureTool.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { EdgeRef } from "../viewport/edgeLines";
import { polylineMid } from "../viewport/edgeMatch";
import { edgeHandleAxis } from "./manipulator";
import type { NudgePlacement } from "./selectionNudge";

type Vec3 = [number, number, number];

/** The placement for an edge selection, or null when there is nothing to stand
 *  on. Several edges get ONE handle, see handlePlacement for where it lands.
 *
 *  `onGrab` receives the handle's own tangent so the tool can adopt it rather
 *  than recompute it: the tool arms inside the SAME pointerdown, and an axis
 *  that differed by a hair would make the handle jump at the exact moment the
 *  user commits to the gesture. `centre` is what "outward" is measured against
 *  and must come from the same place the tool reads it, for the same reason. */
export function edgeNudgePlacement(
  edges: EdgeRef[],
  onGrab: (clientX: number, clientY: number, tangent: THREE.Vector3 | null) => void,
  centre?: THREE.Vector3 | null,
): NudgePlacement | null {
  const place = handlePlacement(edges.map((e) => e.points as Vec3[]));
  if (!place) return null;
  const tangent = place.tangent && new THREE.Vector3(...place.tangent);
  const anchor = new THREE.Vector3(...place.anchor);
  return {
    anchor,
    axis: (viewport: Viewport) => edgeHandleAxis(viewport, tangent, anchor, centre ?? null),
    grab: (x, y) => onGrab(x, y, tangent),
  };
}

/** Where the handle stands and which way it lies, from the selected edges'
 *  polylines. Null when there is nothing to stand on.
 *
 *  Kept pure (plain tuples in, plain tuples out, no viewport, no camera, no
 *  scene) because it is the part of this file a headless test can hold: the
 *  hit-testing and the projection around it need a real canvas and a real
 *  camera, which vitest does not have.
 *
 *  The anchor is the mean of the ARC-LENGTH midpoints, matching where
 *  EdgeFeatureTool anchors the same selection, the handle must not shift when
 *  the tool takes over. The tangent comes from the FIRST usable edge: with
 *  several edges there is no single right perpendicular, and one that at least
 *  lies across a real member reads better than the camera-right fallback.
 *  A null tangent means "no usable direction" and leaves that fallback to the
 *  caller, which is the only party that knows where the camera is. */
export function handlePlacement(
  polylines: Vec3[][],
): { anchor: Vec3; tangent: Vec3 | null } | null {
  const mids: Vec3[] = [];
  let tangent: Vec3 | null = null;
  for (const pts of polylines) {
    const mid = polylineMid(pts);
    if (!mid) continue;
    tangent ??= edgeTangent(pts);
    mids.push(mid);
  }
  if (!mids.length) return null;
  const anchor: Vec3 = [0, 0, 0];
  for (const m of mids) {
    anchor[0] += m[0];
    anchor[1] += m[1];
    anchor[2] += m[2];
  }
  return {
    anchor: [anchor[0] / mids.length, anchor[1] / mids.length, anchor[2] / mids.length],
    tangent,
  };
}

/** Unit direction first sample → last sample of an edge polyline, or null when
 *  there isn't one. Good enough for "which way is across this edge" even on a
 *  curve, where the chord and the true tangent at the midpoint diverge: the
 *  handle only has to stand clear of the edge, not measure it. A closed edge
 *  (a full circle: first sample === last) has no chord at all, hence null. */
function edgeTangent(points: Vec3[]): Vec3 | null {
  const a = points[0];
  const b = points[points.length - 1];
  if (!a || !b) return null;
  const t: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(t[0], t[1], t[2]);
  if (len < 1e-9) return null;
  return [t[0] / len, t[1] / len, t[2] / len];
}
