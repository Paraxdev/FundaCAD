// Which of the document's features a features-mode pattern can repeat, and why
// the rest can't.
//
// The engine (fundacad-geom/features/pattern.rs) is the one that actually
// refuses a feature, with its own message. This mirrors that rule on the
// frontend, in the same voice, so startPattern can decide whether to open in
// features mode before ever reaching the engine, and can say why not when it
// can't, rather than opening the tool and having the first commit bounce.

import type { Feature, RebuildResult } from "../types";
import { featureMeta } from "../ui/featureMeta";

type BuildBodies = RebuildResult["bodies"];

export interface PatternRefusal {
  id: string;
  reason: string;
}

export interface PatternSources {
  ids: string[]; // patternable, deduplicated, in timeline order
  refused: PatternRefusal[]; // deduplicated, in candidate order
}

const PATTERNABLE =
  "Only a feature that cuts or joins material can be patterned: a hole, or an extrude, revolve, sweep or loft set to cut or join. To repeat a whole body, pattern the body instead.";

/** Feature TYPES that ever have a cut or join to repeat. A member can still be
 *  refused, an extrude set to "new" is one of these types with nothing
 *  patternable about this particular one, see hasCutOrJoin. */
function isPatternableType(type: string): boolean {
  return (
    type === "hole" ||
    type === "extrude" ||
    type === "revolve" ||
    type === "sweep" ||
    type === "loft" ||
    type === "press-pull" ||
    type === "patternRect" ||
    type === "patternLinear" ||
    type === "patternCircular"
  );
}

/** Whether THIS feature actually recorded a cut or join, given its type is
 *  already one of the patternable ones. */
function hasCutOrJoin(f: Feature): boolean {
  switch (f.type) {
    case "hole":
      return true;
    case "extrude":
    case "revolve":
    case "loft":
    case "sweep":
      return f.operation === "cut" || f.operation === "join";
    case "press-pull":
      // `operation` is always "join"/"cut" by the field's own type (the sign of
      // the drag), but a `mode` other than auto overrides what actually gets
      // combined, an explicit "new" or "intersect" boolean has nothing to do
      // with `operation` any more and is not a cut or join to repeat.
      if (f.mode && f.mode !== "auto") return f.mode === "join" || f.mode === "cut";
      return f.operation === "cut" || f.operation === "join";
    case "patternRect":
    case "patternLinear":
    case "patternCircular":
      return !!(f as { features?: string[] }).features?.length;
    default:
      return false;
  }
}

function isPatternableFeature(f: Feature): boolean {
  return isPatternableType(f.type) && hasCutOrJoin(f);
}

/** Its `name` if set, else the readable type label the timeline itself uses. */
export function featureLabel(f: Feature): string {
  const name = (f as { name?: string }).name?.trim();
  return name || featureMeta(f as { type: string; operation?: unknown }).label;
}

function refusalReason(f: Feature): string {
  const label = featureLabel(f);
  if (!isPatternableType(f.type)) {
    const kind = featureMeta(f as { type: string; operation?: unknown }).label.toLowerCase();
    return `Pattern: ${label} is a ${kind}, which cannot be patterned. ${PATTERNABLE}`;
  }
  return `Pattern: ${label} has no cut or join to repeat, it made a new body, is switched off, or did not build. ${PATTERNABLE}`;
}

/** Sort and filter `candidateIds` (feature ids named by clicked faces' owners,
 *  or a timeline selection) into what a features-mode pattern can repeat and
 *  what it can't. A candidate id absent from `features` (stale) is dropped
 *  silently, there is nothing left to say about a feature that is gone. */
export function patternSources(
  features: readonly Feature[],
  candidateIds: readonly string[],
): PatternSources {
  const byId = new Map(features.map((f) => [f.id, f] as const));
  const order = new Map(features.map((f, i) => [f.id, i] as const));
  const ids: string[] = [];
  const refused: PatternRefusal[] = [];
  const seen = new Set<string>();
  for (const cid of candidateIds) {
    if (seen.has(cid)) continue;
    seen.add(cid);
    const f = byId.get(cid);
    if (!f) continue;
    if (isPatternableFeature(f)) ids.push(cid);
    else refused.push({ id: cid, reason: refusalReason(f) });
  }
  ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { ids, refused };
}

/** The feature that owns each of `faceIds` (the build's per-body `faceOwners`,
 *  the same provenance a click resolves through, see app/selection.ts's
 *  featureForFace), deduplicated in the order the faces were given. */
export function featureOwnersOfFaces(bodies: BuildBodies, faceIds: readonly number[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const faceId of faceIds) {
    const owner = ownerOfFace(bodies, faceId);
    if (owner && !seen.has(owner)) {
      seen.add(owner);
      out.push(owner);
    }
  }
  return out;
}

function ownerOfFace(bodies: BuildBodies, faceId: number): string | null {
  for (const b of bodies ?? []) {
    if (faceId >= b.faceStart && faceId < b.faceStart + b.faceCount) {
      return b.faceOwners?.[faceId - b.faceStart] ?? null;
    }
  }
  return null;
}

export interface Extent {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/** A face that reaches across its whole body along two axes, the box's top
 *  that a hole was drilled through. Provenance hands such a face to the hole
 *  because the hole changed it, but it is not part of what the hole repeats. */
export function spansBody(face: Extent, body: Extent): boolean {
  const axes = ["x", "y", "z"] as const;
  const size = Math.hypot(...axes.map((a) => body.max[a] - body.min[a]));
  const tol = 1e-3 * size;
  const full = axes.filter(
    (a) =>
      body.max[a] - body.min[a] > tol &&
      Math.abs(face.min[a] - body.min[a]) <= tol &&
      Math.abs(face.max[a] - body.max[a]) <= tol,
  );
  return full.length >= 2;
}

/** Every face `featureIds` own, across every body, the faces a features-mode
 *  pattern ghosts and anchors on. */
export function facesOwnedByFeatures(bodies: BuildBodies, featureIds: readonly string[]): number[] {
  if (!bodies?.length || !featureIds.length) return [];
  const want = new Set(featureIds);
  const out: number[] = [];
  for (const b of bodies) {
    if (!b.faceOwners) continue;
    for (let i = 0; i < b.faceOwners.length; i++) {
      const owner = b.faceOwners[i];
      if (owner && want.has(owner)) out.push(b.faceStart + i);
    }
  }
  return out;
}

/** Feature types whose result is a body of their own, so pointing Pattern at
 *  one means patterning that body. */
function madeABody(f: Feature): boolean {
  switch (f.type) {
    case "box":
    case "cylinder":
    case "sphere":
    case "cone":
    case "torus":
    case "import":
    case "boolean":
    case "mirror":
    case "duplicate":
      return true;
    case "extrude":
    case "revolve":
    case "loft":
    case "sweep":
      return ((f as { operation?: string }).operation ?? "new") === "new";
    case "thicken":
      return (f as { operation?: string }).operation === "new";
    case "patternRect":
    case "patternLinear":
    case "patternCircular":
      return !(f as { features?: string[] }).features?.length;
    default:
      return false;
  }
}

export type PatternStart =
  | { mode: "features"; ids: string[] }
  | { mode: "body"; body: string | null }
  | { mode: "refuse"; reason: string };

export interface PatternCandidates {
  ids: readonly string[];
  /** Faces clicked on the model named these, rather than a history selection. */
  picked: boolean;
  /** The history selection was the user's, not one the app made on its own. */
  explicit: boolean;
}

/** What Pattern does with what it is pointed at.
 *
 *  A feature the user selected is what they mean to repeat, so one that cannot
 *  be patterned is refused with the reason, never quietly swapped for a whole
 *  body pattern: turning a filleted body about the origin is a star nobody
 *  asked for. Two exceptions fall through to the body pattern: a feature that
 *  made a body (the box just drawn, patterned means its body), and a selection
 *  the app made by itself. */
export function patternStart(
  features: readonly Feature[],
  candidates: PatternCandidates,
  bodies: BuildBodies,
): PatternStart {
  if (!candidates.ids.length) return { mode: "body", body: null };
  const { ids, refused } = patternSources(features, candidates.ids);
  if (ids.length) return { mode: "features", ids };
  const first = refused[0];
  if (!first) return { mode: "body", body: null };
  if (candidates.picked) return { mode: "refuse", reason: first.reason };
  if (!candidates.explicit) return { mode: "body", body: null };
  const f = features.find((x) => x.id === first.id);
  if (f && madeABody(f)) return { mode: "body", body: bodyOwning(bodies, f.id) };
  return { mode: "refuse", reason: first.reason };
}

function bodyOwning(bodies: BuildBodies, featureId: string): string | null {
  for (const b of bodies ?? []) if (b.faceOwners?.includes(featureId)) return b.id;
  return null;
}
