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
