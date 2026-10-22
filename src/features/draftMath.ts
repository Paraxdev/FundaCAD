// Reads a face drag as a draft angle. The pull axis is the world axis the face is most parallel to, and the face
// pivots where it meets the neutral plane (the body's near end along that axis, builder._draft), so a drag of
// d mm along the face normal at lever L means atan(d / L).

export type Axis3 = "X" | "Y" | "Z";

/** Past this OCCT starts returning self-intersecting walls, and no mould or print wants more. */
export const MAX_DRAFT_DEG = 60;

/** A shorter lever maps every angle to a zero swing and the drag feels dead. */
const MIN_LEVER = 1e-3;

/** The axis the normal is least aligned with. Ties break X, Y, Z so the choice stays stable as the mesh moves. */
export function pullAxisFor(normal: readonly [number, number, number]): Axis3 {
  const [nx, ny, nz] = normal;
  const ax = Math.abs(nx),
    ay = Math.abs(ny),
    az = Math.abs(nz);
  if (ax <= ay && ax <= az) return "X";
  if (ay <= az) return "Y";
  return "Z";
}

export function alongAxis(v: readonly [number, number, number], axis: Axis3): number {
  return axis === "X" ? v[0] : axis === "Y" ? v[1] : v[2];
}

/** The engine puts the neutral plane at the body's minimum along the pull axis, so this is the grab's height above
 *  the bottom of the part. */
export function draftLever(
  anchor: readonly [number, number, number],
  bboxMin: readonly [number, number, number],
  axis: Axis3,
): number {
  const lever = alongAxis(anchor, axis) - alongAxis(bboxMin, axis);
  return Number.isFinite(lever) ? Math.abs(lever) : 0;
}

/** Degrees for a drag of `delta` mm along the face normal at `lever` mm, 0 with no lever. An extrude taper has no
 *  neutral line to outswing and passes its own higher `maxDeg`. */
export function draftAngle(delta: number, lever: number, maxDeg: number = MAX_DRAFT_DEG): number {
  if (!Number.isFinite(delta) || !(lever > MIN_LEVER)) return 0;
  const deg = (Math.atan2(delta, lever) * 180) / Math.PI;
  return Math.max(-maxDeg, Math.min(maxDeg, deg));
}

/** The inverse of draftAngle, so the heads-up field and the drag drive the same number. */
export function draftDelta(angleDeg: number, lever: number, maxDeg: number = MAX_DRAFT_DEG): number {
  if (!Number.isFinite(angleDeg) || !(lever > MIN_LEVER)) return 0;
  const clamped = Math.max(-maxDeg, Math.min(maxDeg, angleDeg));
  return Math.tan((clamped * Math.PI) / 180) * lever;
}
