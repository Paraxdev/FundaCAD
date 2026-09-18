// The arithmetic behind the direct-manipulation edge gesture: a drag along the
// handle's axis into a radius/distance, the flip between the two edge treatments
// mid-gesture, and the bounds that keep the number buildable.
//
// The drag is SIGNED, and that is the design: one axis carries both treatments with
// "nothing" at the origin between them. Drag the way the arrow points for a fillet,
// keep pulling back through the origin and the same travel becomes a chamfer's
// setback, stop at the origin and there is no feature. Changing your mind costs a
// mouse movement rather than an abort and a restart, which is what the earlier
// one-sided drag, floored at a snap step, forced on you.
//
// Split out of edgeFeatureTool.ts because the tool is pointer plumbing that cannot
// run headless, and these are the functions that can be wrong in a way a user
// notices.

import { snap } from "../ui/units";

export type EdgeTreatment = "fillet" | "chamfer";

export interface TreatmentField {
  /** the Feature field the value is stored in (mm) */
  name: "radius" | "distance";
  /** the one-letter label on the heads-up input */
  label: "R" | "D";
}

export interface ValueBounds {
  min: number;
  max: number;
}

/** Smallest value worth committing, in mm. Below this OCCT either refuses or
 *  produces a blend nobody can see, so it is both the floor for a TYPED value
 *  and, for a dragged one, the test for "the user is sitting on the origin and
 *  has asked for no feature at all". */
export const MIN_EDGE_VALUE = 0.001;

/** How much of the model's bounding-box diagonal a dragged value may reach.
 *
 *  A runaway guard, not a judgement. It exists to stop a flick of the mouse from
 *  running the number to 10⁴ mm and firing a string of doomed rebuilds; the
 *  KERNEL decides what actually builds, and blendVerdict below carries that
 *  answer back into the drag. Half the diagonal is past a full round on a cube
 *  (s/2 ≈ 0.29 of s·√3), so nothing a blend can legitimately reach is behind it.
 *
 *  It used to be a quarter, and it used to be replaced outright by the measured
 *  neighbourhood clearance (features/blendClearance.ts), which made that
 *  measurement a WALL. A distance to the nearest neighbouring edge cannot decide
 *  what OCCT will build, its own module says so, and used that way it stopped
 *  a drag at 0.11 mm on a part that blends happily at twenty times that. The
 *  clearance now sizes the OPENING value only, which is the job it can do.
 *
 *  Typed values are deliberately not clamped by any of this. */
export const MAX_DIAGONAL_FRACTION = 0.5;

export function treatmentField(kind: EdgeTreatment): TreatmentField {
  return kind === "fillet" ? { name: "radius", label: "R" } : { name: "distance", label: "D" };
}

export function otherTreatment(kind: EdgeTreatment): EdgeTreatment {
  return kind === "fillet" ? "chamfer" : "fillet";
}

/** Human name for prompts and the gizmo readout. */
export function treatmentLabel(kind: EdgeTreatment): string {
  return kind === "fillet" ? "Fillet" : "Chamfer";
}

/** How far a dragged value may travel from the origin, in mm, the same cap on
 *  BOTH sides, since a chamfer that overruns the face is no more buildable than
 *  a fillet that does. Infinity when the document has no geometry to measure. */
export function dragLimit(modelDiagonal: number | null): number {
  if (modelDiagonal == null || !(modelDiagonal > 0) || !Number.isFinite(modelDiagonal)) {
    return Infinity;
  }
  return Math.max(MIN_EDGE_VALUE, modelDiagonal * MAX_DIAGONAL_FRACTION);
}

/** Bounds for a value the user is free to choose outright (a typed one, or one
 *  carried across a Tab flip): anything the kernel might build, floored at the
 *  smallest visible blend. */
export function valueBounds(modelDiagonal: number | null): ValueBounds {
  return { min: MIN_EDGE_VALUE, max: dragLimit(modelDiagonal) };
}

/** What the kernel has said about size so far, during ONE gesture on ONE
 *  question (treatment, edges, profile). Reset whenever the question changes. */
export interface BlendRange {
  /** the largest size seen to build that is below every refusal, or null */
  built: number | null;
  /** the smallest size the kernel refused, or null */
  refused: number | null;
}

export const EMPTY_BLEND_RANGE: BlendRange = { built: null, refused: null };

/** Fold one kernel answer into the range. A refusal drops a `built` at or above
 *  it, so the range never claims a size both builds and does not. */
export function noteBlendOutcome(range: BlendRange, value: number, built: boolean): BlendRange {
  if (!Number.isFinite(value) || value <= 0) return range;
  if (!built) {
    const refused = range.refused == null ? value : Math.min(range.refused, value);
    return {
      built: range.built != null && range.built >= refused ? null : range.built,
      refused,
    };
  }
  const below = range.refused == null || value < range.refused;
  return {
    built: below ? Math.max(range.built ?? 0, value) : range.built,
    refused: range.refused,
  };
}

export type BlendVerdict = "builds" | "refused" | "unknown";

const SAME_SIZE = 1e-9;

/** What the kernel's answers so far say about `value`, before asking again.
 *
 *  Assumes a blend refused at one size is refused at every larger size on the
 *  same edges, and builds at every smaller size than one that built. That is
 *  what lets a drag run on past the limit without sending the kernel a doomed
 *  request per pointermove, and turn back the instant it comes under it. */
export function blendVerdict(range: BlendRange, value: number): BlendVerdict {
  if (!Number.isFinite(value) || value <= 0) return "unknown";
  if (range.refused != null && value >= range.refused - SAME_SIZE) return "refused";
  if (range.built != null && value <= range.built + SAME_SIZE) return "builds";
  return "unknown";
}

export type CommitDecision =
  | { action: "commit"; value: number; unverified?: true }
  | { action: "cancel" }
  | { action: "stay" };

/** What confirming the gesture does with the value on the handle.
 *
 *  `shown` is the size the model on screen was built at (null for the bare
 *  model), `settled` says the reply for `value` itself has landed, and `typed`
 *  says the value came from the keyboard rather than the drag.
 *
 *  A refused drag commits what the user is looking at, or nothing. A refused
 *  TYPED value stays open instead: swapping someone's typed number for another
 *  one on Enter is not a thing to do silently. A value the kernel has not
 *  answered for yet commits at once, `unverified`, and the store undoes it if
 *  the kernel then refuses it (DocumentStore.verifyCommit): confirming never
 *  waits on the kernel. */
export function commitDecision(o: {
  value: number;
  verdict: BlendVerdict;
  settled: boolean;
  shown: number | null;
  typed: boolean;
}): CommitDecision {
  if (o.verdict === "refused") {
    if (o.typed) return { action: "stay" };
    return o.shown != null && o.shown >= MIN_EDGE_VALUE
      ? { action: "commit", value: o.shown }
      : { action: "cancel" };
  }
  if (o.settled || o.verdict === "builds") return { action: "commit", value: o.value };
  return { action: "commit", value: o.value, unverified: true };
}

/** A kernel refusal, said the way a person would say it. `code` is the engine's
 *  machine category (the Python engine's `errors.py`); the message is only read for the older
 *  wording that carried no code. */
export function blendRefusalReason(
  kind: EdgeTreatment,
  edgeCount: number,
  refusal: { code: string | null; message: string },
): string {
  const these = edgeCount === 1 ? "this edge" : "these edges";
  const These = edgeCount === 1 ? "This edge is" : "These edges are";
  const size = kind === "fillet" ? "Radius" : "Distance";
  switch (refusal.code) {
    case "blendTooLarge":
      return `${size} too large for the faces around ${these}`;
    case "blendHasNoEnd":
      return `No ${kind} size works on ${these}, the blend has nowhere to end`;
    case "edgeAlreadySmooth":
      return `${These} already smooth, there is no corner to ${kind === "fillet" ? "round" : "cut"}`;
    case "edgeIsSeam":
      return `${These} a seam, not a corner, pick where the face meets its neighbours`;
    case "blendFoldsOver":
      return `At this size the ${kind} folds back over the model`;
  }
  if (/smaller (length )?value/i.test(refusal.message)) {
    return `${size} too large for the faces around ${these}`;
  }
  return refusal.message.replace(/^(Fillet|Chamfer) failed on [^:]+:\s*/, "");
}

export function clampValue(v: number, bounds: ValueBounds): number {
  if (!Number.isFinite(v)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, v));
}

export interface Scrub {
  /** signed offset in mm when the handle was grabbed (see scrubSigned) */
  grabSigned: number;
  /** axis projection (mm) at grab time */
  grabProj: number;
  /** axis projection (mm) now */
  proj: number;
  /** snap granularity in mm */
  step: number;
  /** largest magnitude the drag may reach, either side of the origin */
  limit: number;
}

/** Signed offset for the current pointer position: where the drag started plus
 *  how far the cursor has travelled along the handle's axis, snapped to a clean
 *  step so the readout says 2.5 rather than 2.4713, then held inside ±limit.
 *  Relative to the grab (not absolute along the axis) so taking hold of the
 *  handle never makes the value jump.
 *
 *  Exactly 0 inside a one-step dead zone around the origin. Snapping alone would
 *  already produce 0 within half a step, but half a step is ~4 px of mouse
 *  travel, too fine a target for a state the user has to be able to stop in on
 *  purpose, since it is how the gesture is abandoned. A whole step either side
 *  makes the origin a detent you can feel, and the first value past it is one
 *  clean increment rather than a jump. */
export function scrubSigned(s: Scrub): number {
  const raw = s.grabSigned + (s.proj - s.grabProj);
  if (!Number.isFinite(raw)) return 0;
  const dead = s.step > 0 && Number.isFinite(s.step) ? s.step : MIN_EDGE_VALUE;
  if (Math.abs(raw) < dead) return 0;
  const stepped = snap(raw, s.step);
  const limit = s.limit > 0 ? s.limit : Infinity;
  return Math.sign(stepped) * Math.min(Math.abs(stepped), limit);
}

/** Read a signed offset as a treatment: `positive` is the one the arrow's own
 *  direction means, its opposite lives on the other side of the origin, and the
 *  magnitude is the radius or setback either way.
 *
 *  A radius and a setback are the same drag off the same edge, which is why one
 *  axis can carry both, the sign is the only thing that distinguishes them. At
 *  exactly 0 the value is 0 and the reported kind is arbitrary; callers keep
 *  showing whichever they had rather than let the label flicker at the
 *  crossing. */
export function treatmentAt(
  positive: EdgeTreatment,
  signed: number,
): { kind: EdgeTreatment; value: number } {
  return {
    kind: signed < 0 ? otherTreatment(positive) : positive,
    value: Math.abs(signed),
  };
}

/** Flip fillet ↔ chamfer in place, carrying the number across untouched, what
 *  Tab does, and the only way to switch a value that was TYPED rather than
 *  dragged (a typed number has no side of the origin to be on).
 *
 *  Re-clamped only because the caller may hand us a value from a different
 *  bounds regime (a typed one, or one dragged before the camera zoomed). */
export function switchTreatment(
  kind: EdgeTreatment,
  value: number,
  bounds: ValueBounds,
): { kind: EdgeTreatment; value: number } {
  return { kind: otherTreatment(kind), value: clampValue(value, bounds) };
}

/** Opening value for a gesture that starts from a command rather than from the
 *  handle, the tool has to show SOMETHING the moment it arms. (A gesture that
 *  starts by grabbing the handle opens at 0 instead: there the drag itself is
 *  the value, measured from where you pressed.)
 *
 *  A 2 mm fillet / 1 mm chamfer is the familiar MCAD default, held down to what
 *  the picked edges' own neighbourhood plausibly holds (blendClearance.ts) and
 *  then to the drag bounds, a default nobody can build is worse than a small
 *  one. This is the whole of the clearance measurement's job: it is a good guess
 *  at where to open, and it was never able to be the wall it used to be. */
export function seedValue(
  kind: EdgeTreatment,
  bounds: ValueBounds,
  localLimit?: number | null,
): number {
  const want = kind === "fillet" ? 2 : 1;
  const local =
    localLimit != null && Number.isFinite(localLimit) && localLimit > 0 ? localLimit : Infinity;
  return clampValue(Math.min(want, local), bounds);
}
