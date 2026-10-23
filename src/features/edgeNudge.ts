// Where the drag handle stands on a selected edge, and the hand-off to EdgeFeatureTool. The handle itself is
// features/selectionNudge.ts, shared with faces.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { EdgeRef } from "../viewport/edgeLines";
import { polylineMid } from "../viewport/edgeMatch";
import { edgeHandleAxis } from "./manipulator";
import type { NudgePlacement } from "./selectionNudge";

type Vec3 = [number, number, number];

/** Several edges get one handle (handlePlacement). `onGrab` gets the handle's own tangent and `centre` must match the
 *  tool's, since the tool arms in the same pointerdown and a hair's difference makes the handle jump. */
export function edgeNudgePlacement(
  edges: EdgeRef[],
  onGrab: (clientX: number, clientY: number, tangent: THREE.Vector3 | null, anchor: THREE.Vector3) => void,
  centre?: THREE.Vector3 | null,
  /** Where the one selected edge was clicked; the handle stands there instead of mid-edge. */
  clickedAt?: Vec3 | null,
): NudgePlacement | null {
  const only = edges.length === 1 ? edges[0] : undefined;
  const local = only && clickedAt ? pointOnEdge(only.points as Vec3[], clickedAt) : null;
  const place = local ?? handlePlacement(edges.map((e) => e.points as Vec3[]));
  if (!place) return null;
  const tangent = place.tangent && new THREE.Vector3(...place.tangent);
  const anchor = new THREE.Vector3(...place.anchor);
  return {
    anchor,
    axis: (viewport: Viewport) => edgeHandleAxis(viewport, tangent, anchor, centre ?? null),
    grab: (x, y) => onGrab(x, y, tangent, anchor),
  };
}

/** With the direction of the segment it lies on, so a handle on a curve lies across the curve rather than its chord.
 *  Null for a polyline with no segment. */
export function pointOnEdge(points: Vec3[], at: Vec3): { anchor: Vec3; tangent: Vec3 | null } | null {
  let best: { anchor: Vec3; tangent: Vec3 | null; d: number } | null = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    if (len2 < 1e-18) continue;
    const t = Math.max(
      0,
      Math.min(1, ((at[0] - a[0]) * ab[0] + (at[1] - a[1]) * ab[1] + (at[2] - a[2]) * ab[2]) / len2),
    );
    const p: Vec3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    const d = Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]);
    if (!best || d < best.d) {
      const len = Math.sqrt(len2);
      best = { anchor: p, tangent: [ab[0] / len, ab[1] / len, ab[2] / len], d };
    }
  }
  return best && { anchor: best.anchor, tangent: best.tangent };
}

/** The anchor is the mean of the arc length midpoints, where EdgeFeatureTool anchors the same selection. The tangent
 *  comes from the first usable edge; null leaves the camera right fallback to the caller, which knows the camera. */
export function handlePlacement(polylines: Vec3[][]): { anchor: Vec3; tangent: Vec3 | null } | null {
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

/** First sample to last, enough for which way is across the edge even on a curve. Null for a closed edge, which has
 *  no chord. */
function edgeTangent(points: Vec3[]): Vec3 | null {
  const a = points[0];
  const b = points[points.length - 1];
  if (!a || !b) return null;
  const t: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(t[0], t[1], t[2]);
  if (len < 1e-9) return null;
  return [t[0] / len, t[1] / len, t[2] / len];
}
