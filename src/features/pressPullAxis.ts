// Press/pull along a hole's axis: the engine's faceAxis answer read into what
// the tool offers, which way it starts, and where its arrow stands.
//
// Pushing a drilled hole's cone ceiling along its normal widens the cone until
// it breaks out of a thin wall; along the axis the hole just gets deeper. The
// engine decides which faces have an axis (features/axis_push.rs), so the arrow
// and the build cannot disagree about it.

import type { FaceAxisReply, FaceResize } from "../geometry/client";
import type { PressPullDirection, Vec3 } from "../types";
import type { RoundTangent } from "./radialDrag";

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

/** What the engine says about resizing a curved face, exact where the mesh
 *  fit is not. */
export interface OfferedResize {
  kind: FaceResize["kind"];
  /** the radius, the tube radius on a torus, 0 on a cone */
  radius: number;
  full: boolean;
  concave: boolean;
  /** the radius where a neighbour would first be left behind, or null */
  contact: number | null;
  tangent: RoundTangent;
  /** a sphere's centre */
  centre?: Vec3;
}

const LOST_WHEN = new Set([null, "shrink", "grow"]);

/** The resize in a faceAxis reply, or null: none, a kind not asked for, or a
 *  malformed reply. */
export function offeredResize(
  reply: FaceAxisReply | null,
  kinds: readonly FaceResize["kind"][] = ["cylinder"],
): OfferedResize | null {
  const r = reply?.resize;
  if (!r || typeof r !== "object" || !kinds.includes(r.kind)) return null;
  if (typeof r.size !== "number" || !Number.isFinite(r.size)) return null;
  if (r.kind === "cone" ? r.size !== 0 : !(r.size > 0)) return null;
  if (r.kind === "sphere" && !finite(r.centre)) return null;
  if (typeof r.full !== "boolean" || typeof r.concave !== "boolean") return null;
  const contact = r.contact ?? null;
  if (contact !== null && (typeof contact !== "number" || !Number.isFinite(contact) || contact < 0)) return null;
  const t = r.tangent;
  if (!t || typeof t !== "object") return null;
  if (!Number.isInteger(t.faces) || t.faces < 0 || !LOST_WHEN.has(t.lostWhen ?? null)) return null;
  if (!Array.isArray(t.run) || !t.run.every(finite)) return null;
  if (typeof t.closed !== "boolean" || typeof t.followable !== "boolean") return null;
  return {
    kind: r.kind,
    radius: r.size,
    full: r.full,
    concave: r.concave,
    contact,
    tangent: { faces: t.faces, lostWhen: t.lostWhen ?? null, run: t.run, closed: t.closed, followable: t.followable },
    ...(r.kind === "sphere" ? { centre: r.centre } : {}),
  };
}
