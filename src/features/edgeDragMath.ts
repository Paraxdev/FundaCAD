// The arithmetic of the edge drag. It is signed: one way along the handle axis is a fillet, the other a chamfer, with
// no feature at the origin between, so changing your mind costs a mouse move rather than a restart.

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

/** mm. Below this OCCT refuses or builds an invisible blend; it floors a typed value and marks a drag sitting on
 *  the origin as asking for no feature. */
export const MIN_EDGE_VALUE = 0.001;

/** A runaway guard so a flick cannot run the number to 10^4 mm and fire doomed rebuilds; the kernel decides what
 *  builds (blendVerdict). Half the diagonal is past a full round on a cube. Typed values are not clamped.
 *  Never the neighbourhood clearance: as a wall it stopped a drag at 0.11 mm on a part that blends at 20x that. */
export const MAX_DIAGONAL_FRACTION = 0.5;

export function treatmentField(kind: EdgeTreatment): TreatmentField {
  return kind === "fillet" ? { name: "radius", label: "R" } : { name: "distance", label: "D" };
}

export function otherTreatment(kind: EdgeTreatment): EdgeTreatment {
  return kind === "fillet" ? "chamfer" : "fillet";
}

export function treatmentLabel(kind: EdgeTreatment): string {
  return kind === "fillet" ? "Fillet" : "Chamfer";
}

/** mm, the same cap on both sides since an overrunning chamfer is no more buildable than a fillet. Infinity when
 *  there is no geometry to measure. */
export function dragLimit(modelDiagonal: number | null): number {
  if (modelDiagonal == null || !(modelDiagonal > 0) || !Number.isFinite(modelDiagonal)) {
    return Infinity;
  }
  return Math.max(MIN_EDGE_VALUE, modelDiagonal * MAX_DIAGONAL_FRACTION);
}

/** For a value chosen outright (typed, or carried across a Tab flip), floored at the smallest visible blend. */
export function valueBounds(modelDiagonal: number | null): ValueBounds {
  return { min: MIN_EDGE_VALUE, max: dragLimit(modelDiagonal) };
}

/** The kernel's answers on size in one gesture on one question (treatment, edges, profile), reset when it changes. */
export interface BlendRange {
  /** the largest size seen to build that is below every refusal, or null */
  built: number | null;
  /** the smallest size the kernel refused, or null */
  refused: number | null;
}

export const EMPTY_BLEND_RANGE: BlendRange = { built: null, refused: null };

/** A refusal drops a `built` at or above it, so the range never claims a size both builds and does not. */
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

/** Assumes a size refused is refused at every larger size on the same edges, and one that built builds smaller, so a
 *  drag past the limit sends no doomed request per pointermove and turns back at once. */
export function blendVerdict(range: BlendRange, value: number): BlendVerdict {
  if (!Number.isFinite(value) || value <= 0) return "unknown";
  if (range.refused != null && value >= range.refused - SAME_SIZE) return "refused";
  if (range.built != null && value <= range.built + SAME_SIZE) return "builds";
  return "unknown";
}

export type CommitDecision =
  { action: "commit"; value: number; unverified?: true } | { action: "cancel" } | { action: "stay" };

/** `shown` is the size on screen (null for the bare model), `settled` says the reply for `value` landed, `typed` that
 *  it came from the keyboard. A refused drag commits what is shown or nothing; a refused typed value stays open.
 *  An unanswered value commits `unverified` and DocumentStore.verifyCommit undoes a refusal: no waiting on confirm. */
export function commitDecision(o: {
  value: number;
  verdict: BlendVerdict;
  settled: boolean;
  shown: number | null;
  typed: boolean;
  meaningful?: (v: number) => boolean;
}): CommitDecision {
  if (o.verdict === "refused") {
    if (o.typed) return { action: "stay" };
    const meaningful = o.meaningful ?? ((v: number) => v >= MIN_EDGE_VALUE);
    return o.shown != null && meaningful(o.shown) ? { action: "commit", value: o.shown } : { action: "cancel" };
  }
  if (o.settled || o.verdict === "builds") return { action: "commit", value: o.value };
  return { action: "commit", value: o.value, unverified: true };
}

/** `code` is the engine's category (errors.py); the message is only read for older wording that carried no code. */
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

/** Relative to the grab so taking hold never makes the value jump, snapped to a clean step, held inside ±limit.
 *  Exactly 0 within one step of the origin: half a step is about 4 px, too fine a detent for abandoning the gesture. */
export function scrubSigned(s: Scrub): number {
  const raw = s.grabSigned + (s.proj - s.grabProj);
  if (!Number.isFinite(raw)) return 0;
  const dead = s.step > 0 && Number.isFinite(s.step) ? s.step : MIN_EDGE_VALUE;
  if (Math.abs(raw) < dead) return 0;
  const stepped = snap(raw, s.step);
  const limit = s.limit > 0 ? s.limit : Infinity;
  return Math.sign(stepped) * Math.min(Math.abs(stepped), limit);
}

/** `positive` is what the arrow's own direction means, the magnitude is the radius or setback. At exactly 0 the kind
 *  is arbitrary, and callers keep the one they showed so the label does not flicker. */
export function treatmentAt(positive: EdgeTreatment, signed: number): { kind: EdgeTreatment; value: number } {
  return {
    kind: signed < 0 ? otherTreatment(positive) : positive,
    value: Math.abs(signed),
  };
}

/** What Tab does, the only way to switch a typed value, which has no side of the origin. Re-clamped since the value
 *  may come from other bounds (typed, or dragged before a zoom). */
export function switchTreatment(
  kind: EdgeTreatment,
  value: number,
  bounds: ValueBounds,
): { kind: EdgeTreatment; value: number } {
  return { kind: otherTreatment(kind), value: clampValue(value, bounds) };
}

/** Opening value when a gesture starts from a command (a handle grab opens at 0): the usual 2 mm fillet or 1 mm
 *  chamfer, held to what the edges' neighbourhood plausibly holds (blendClearance.ts) and to the drag bounds. */
export function seedValue(kind: EdgeTreatment, bounds: ValueBounds, localLimit?: number | null): number {
  const want = kind === "fillet" ? 2 : 1;
  const local = localLimit != null && Number.isFinite(localLimit) && localLimit > 0 ? localLimit : Infinity;
  return clampValue(Math.min(want, local), bounds);
}
