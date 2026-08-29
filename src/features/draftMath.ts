// Reading a drag of a face as a DRAFT ANGLE.
//
// Draft used to be fire-and-forget: pick a face, get 5° about Z, correct it in
// the value row afterwards. Two of those three decisions were guesses made
// without looking at the part — which axis the mould opens along, and how much
// taper — and both are visible facts about the face that was just clicked.
//
// The pull axis is the world axis the face is most PARALLEL to, i.e. the one its
// normal is most perpendicular to. A side wall of a box drafts about the axis
// that runs up the wall; asking for a taper about the wall's own normal is asking
// to tip a face about a line lying in itself, which is not a draft.
//
// The angle comes from the drag the same way a carpenter reads one: the face
// pivots about the line where it meets the NEUTRAL plane (the body's near end
// along the pull axis, which is where the sidecar puts it — builder._draft), so
// the far edge swings by lever * tan(angle). Dragging that edge d millimetres
// along the face's own normal therefore means atan(d / lever), and the number in
// the readout is the angle a protractor laid on the part would show.
//
// Split from draftTool.ts on the house rule: the tool is pointer plumbing that
// cannot run headless, these are the functions that can be wrong in a way the
// user notices.

export type Axis3 = "X" | "Y" | "Z";

/** Steepest taper offered. Past this the neutral line has swung further than the
 *  wall is tall and OCCT starts handing back self-intersecting walls; it is also
 *  well past any draft a mould or a print actually wants. */
export const MAX_DRAFT_DEG = 60;

/** Lever arms shorter than this are treated as unusable: the face meets the
 *  neutral plane there, so every angle would map to the same zero-length swing
 *  and the drag would feel dead. */
const MIN_LEVER = 1e-3;

/** The world axis to pull along for a face with this normal: the one the normal
 *  is LEAST aligned with. Ties break X, Y, Z — a 45° face has no better answer
 *  and a stable one beats a prettier one that moves when the mesh does. */
export function pullAxisFor(normal: readonly [number, number, number]): Axis3 {
  const [nx, ny, nz] = normal;
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ax <= ay && ax <= az) return "X";
  if (ay <= az) return "Y";
  return "Z";
}

/** Component of a vector along a world axis. */
export function alongAxis(v: readonly [number, number, number], axis: Axis3): number {
  return axis === "X" ? v[0] : axis === "Y" ? v[1] : v[2];
}

/** How far the grabbed point sits from the neutral plane, measured along the
 *  pull axis. The sidecar puts the neutral plane at the body's MINIMUM along
 *  that axis, so this is the height of the grab above the bottom of the part. */
export function draftLever(
  anchor: readonly [number, number, number],
  bboxMin: readonly [number, number, number],
  axis: Axis3,
): number {
  const lever = alongAxis(anchor, axis) - alongAxis(bboxMin, axis);
  return Number.isFinite(lever) ? Math.abs(lever) : 0;
}

/** The angle, in degrees, that a drag of `delta` mm along the face normal means
 *  on a face grabbed `lever` mm above the neutral plane. 0 when there is no
 *  lever to swing about. */
export function draftAngle(delta: number, lever: number): number {
  if (!Number.isFinite(delta) || !(lever > MIN_LEVER)) return 0;
  const deg = (Math.atan2(delta, lever) * 180) / Math.PI;
  return Math.max(-MAX_DRAFT_DEG, Math.min(MAX_DRAFT_DEG, deg));
}

/** The inverse: how far the grab point moves for a typed angle. Lets the heads-up
 *  field and the drag drive the same number. */
export function draftDelta(angleDeg: number, lever: number): number {
  if (!Number.isFinite(angleDeg) || !(lever > MIN_LEVER)) return 0;
  const clamped = Math.max(-MAX_DRAFT_DEG, Math.min(MAX_DRAFT_DEG, angleDeg));
  return Math.tan((clamped * Math.PI) / 180) * lever;
}
