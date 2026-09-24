// Press/pull along a hole's axis: the engine's faceAxis answer read into what
// the tool offers, which way it starts, and where its arrow stands.
//
// Pushing a drilled hole's cone ceiling along its normal widens the cone until
// it breaks out of a thin wall; along the axis the hole just gets deeper. The
// engine decides which faces have an axis (features/axis_push.rs), so the arrow
// and the build cannot disagree about it.

import type { FaceAxisReply } from "../geometry/client";
import type { PressPullDirection, Vec3 } from "../types";

export interface HoleAxis {
  origin: Vec3;
  /** unit, pointing out of the material, the way a positive distance moves */
  dir: Vec3;
  /** the round end of a bore on the bore's own axis */
  hole: boolean;
}

export const DIRECTION_LABEL: Record<PressPullDirection, string> = {
  normal: "Along normal",
  axis: "Along axis",
};

const finite = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === "number" && Number.isFinite(c));

/** The axis worth offering, or null: none, a malformed reply, or a flat face
 *  square to its axis, which moves the same along either. */
export function offeredAxis(reply: FaceAxisReply | null): HoleAxis | null {
  if (!reply || !("axis" in reply) || reply.sameAsNormal) return null;
  const { origin, dir } = reply.axis;
  if (!finite(origin) || !finite(dir)) return null;
  const n = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(n > 1e-9)) return null;
  return { origin, dir: [dir[0] / n, dir[1] / n, dir[2] / n], hole: reply.hole === true };
}

/** A hole's round end starts on its axis, which is almost always what a push
 *  there means; every other face starts along its normal. */
export function initialDirection(axis: HoleAxis | null): PressPullDirection {
  return axis?.hole ? "axis" : "normal";
}

/** `point` dropped onto the axis line, so the arrow runs down the hole's middle. */
export function anchorOnAxis(point: Vec3, axis: HoleAxis): Vec3 {
  const { origin: o, dir: d } = axis;
  const t = (point[0] - o[0]) * d[0] + (point[1] - o[1]) * d[1] + (point[2] - o[2]) * d[2];
  return [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
}
