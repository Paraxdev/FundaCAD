// Mirrors the engine's pattern refusal (fundacad-geom/features/pattern.rs) in the same voice, so startPattern
// can choose features mode and say why not before the first commit bounces.

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

/** Types that can ever have a cut or join to repeat; an extrude set to "new" is still refused, see hasCutOrJoin. */
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

/** Assumes the type already passed isPatternableType. */
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
      // A `mode` other than auto overrides `operation`, which is always join or cut by the sign of the drag.
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

/** A candidate id absent from `features` (stale) is dropped silently. */
export function patternSources(features: readonly Feature[], candidateIds: readonly string[]): PatternSources {
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

/** Through the build's per-body `faceOwners`, the provenance a click resolves through (app/selection.ts
 *  featureForFace), deduplicated in face order. */
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

/** A face spanning its body along two axes, like the top a hole was drilled through: provenance gives it to the
 *  hole, but the hole does not repeat it. */
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

/** The faces a features-mode pattern ghosts and anchors on. */
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

/** Its result is a body of its own, so pointing Pattern at it means patterning that body. */
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
  { mode: "features"; ids: string[] } | { mode: "body"; body: string | null } | { mode: "refuse"; reason: string };

export interface PatternCandidates {
  ids: readonly string[];
  /** Faces clicked on the model named these, rather than a history selection. */
  picked: boolean;
  /** The history selection was the user's, not one the app made on its own. */
  explicit: boolean;
}

/** A selected feature that cannot be patterned is refused with the reason, never swapped for a body pattern.
 *  Only a feature that made a body, or a selection the app made itself, falls through to the body pattern. */
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
