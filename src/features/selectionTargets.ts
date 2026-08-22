// What each feature is APPLIED TO: the inventory of every field that holds a
// selection, and the two functions that read and write one.
//
// A modifier is a verb plus the geometry it acts on, and until now the second
// half was write-only. You picked four edges, the fillet swallowed them, and
// from then on the feature said "Fillet" and a radius. Which four edges was not
// shown, could not be checked, and could only be changed by deleting the feature
// and picking again — so a fillet that caught one edge too many was cheaper to
// redo than to correct.
//
// The same shape as document/numFields.ts and document/optionFields.ts, and for
// the same reason: one declaration, read by the row that shows the selection, by
// the editor that changes it, and by the tests that hold the two together.
// optionFields.ts deliberately leaves geometry references out of its tables and
// says why — picking one is a viewport gesture, not a menu. This is that gesture,
// declared where the menus are declared.
//
// SHAPES. Three of them, and the difference is real rather than historical:
//
//   * a SELECTOR (`edges`, `faces`, `face`) is a saved description of geometry
//     that the sidecar re-resolves on every rebuild, so it survives the part
//     changing underneath it.
//   * a BODY ID (`tools`, `bodies`, `target`) is positional and does not
//     survive much of anything, which is a fact about the document rather than
//     about this module.
//   * a PROFILE POINT (`extrude.regions`, `revolve.regions`) belongs to the
//     sketch overlay rather than to the solid: an interior point on a plane,
//     resolved against a sketch that has already been consumed and hidden. It is
//     in the table but NOT editable by the generic editor, which picks on the
//     solid and has nothing to offer here. Its Edit re-opens the feature's own
//     tool, which already shows the sketch and already takes the picks.
//
// Pure. No store, no viewport, no Vue: everything here is a function of a
// feature object, which is what lets the whole inventory be tested without a
// scene.

import type { Feature, FeatureType, Selector } from "../types";

/** What a target holds, one entry at a time. "area" is a closed region of a
 *  sketch — the word the extrude prompts already use for the thing you click. */
export type TargetKind = "edge" | "face" | "body" | "area";

/** How the entries are stored, which decides WHO can resolve them — and, for
 *  `regionPoint`, who cannot: the generic editor picks edges, faces and bodies
 *  off the solid, and a profile area is on neither. */
export type TargetShape = "selector" | "bodyId" | "regionPoint";

export interface TargetField {
  /** The document field. */
  field: string;
  /** The row's label. Names the ROLE, not the type: a boolean's two body
   *  targets are both bodies, and "Bodies" twice would be two rows nobody can
   *  tell apart. */
  label: string;
  kind: TargetKind;
  shape: TargetShape;
  /** "one" fields hold a bare value; "many" hold an array. A "one" field whose
   *  document value is an array is still read as one — see readTarget. */
  arity: "one" | "many";
  /** What an EMPTY target means, when empty is legal and means something other
   *  than "nothing". Shown in the row in place of a count, because "0 faces" and
   *  "the whole body" are opposite answers and a count alone cannot tell them
   *  apart. Absent = empty is simply empty. */
  whenEmpty?: string;
  /** A second field this target also reads, for the features that grew a plural
   *  form beside a singular one. Normalised to `field` on write: both are live
   *  in the builder, `field` wins there, and keeping the pair in step through an
   *  edit is not worth the fifth reader it would need. */
  alsoReads?: string;
}

/** The inventory. A feature type absent from this table has no editable
 *  selection — a primitive, a scale, a datum plane.
 *
 *  Declaration order is row order, and it is the order the feature reads in:
 *  what is kept before what is consumed, what is operated on before what it is
 *  operated with. */
export const FEATURE_TARGETS: Partial<Record<FeatureType, readonly TargetField[]>> = {
  // Fillet and chamfer are the case this exists for. A blend is a set of edges
  // and a size, the size has been editable since the value rows, and the set has
  // never been.
  fillet: [{ field: "edges", label: "Edges", kind: "edge", shape: "selector", arity: "many" }],
  chamfer: [{ field: "edges", label: "Edges", kind: "edge", shape: "selector", arity: "many" }],
  "press-pull": [{ field: "face", label: "Face", kind: "face", shape: "selector", arity: "one" }],
  deleteFace: [{ field: "face", label: "Face", kind: "face", shape: "selector", arity: "one" }],
  // Shell's empty set is not "no faces", it is a sealed hollow — a legitimate
  // and quite different part.
  shell: [{
    field: "faces", label: "Faces to open", kind: "face", shape: "selector", arity: "many",
    whenEmpty: "sealed hollow",
  }],
  offsetFace: [{ field: "faces", label: "Faces", kind: "face", shape: "selector", arity: "many" }],
  thicken: [{
    field: "faces", label: "Faces", kind: "face", shape: "selector", arity: "many",
    whenEmpty: "the whole body",
  }],
  draft: [{ field: "faces", label: "Faces", kind: "face", shape: "selector", arity: "many" }],
  texture: [{
    field: "faces", label: "Faces", kind: "face", shape: "selector", arity: "many",
    whenEmpty: "the whole body",
  }],
  // Two body targets with opposite fates, so they are labelled by fate. Which
  // body is kept is the whole meaning of a Subtract, and it was previously
  // decided by which one you happened to click first and then never shown.
  boolean: [
    { field: "target", label: "Body kept", kind: "body", shape: "bodyId", arity: "one" },
    { field: "tools", label: "Bodies used", kind: "body", shape: "bodyId", arity: "many" },
  ],
  move: [{
    field: "bodies", label: "Bodies", kind: "body", shape: "bodyId", arity: "many",
    whenEmpty: "the active body",
  }],
  removeBody: [{ field: "bodies", label: "Bodies", kind: "body", shape: "bodyId", arity: "many" }],
  patternLinear: [{ field: "bodies", label: "Bodies", kind: "body", shape: "bodyId", arity: "many", whenEmpty: "the active body" }],
  patternCircular: [{ field: "bodies", label: "Bodies", kind: "body", shape: "bodyId", arity: "many", whenEmpty: "the active body" }],
  split: [{
    field: "bodies", label: "Bodies", kind: "body", shape: "bodyId", arity: "many",
    whenEmpty: "the active body", alsoReads: "body",
  }],
  // The half of an extrude that was never shown. It is the FIRST thing about the
  // feature — which areas of the sketch became solid — and until now the panel
  // opened on "Distance" as though the profile were settled at creation and
  // beyond discussion. Empty is legal and means the whole sketch, which is a
  // different statement from "no areas" and has to be spelled out.
  extrude: [{
    field: "regions", label: "Profile", kind: "area", shape: "regionPoint",
    arity: "many", whenEmpty: "the whole sketch", alsoReads: "region",
  }],
  revolve: [{
    field: "regions", label: "Profile", kind: "area", shape: "regionPoint",
    arity: "many", whenEmpty: "the whole sketch",
  }],
};

/** The targets this feature has, or an empty list. */
export function targetsOf(type: string): readonly TargetField[] {
  return FEATURE_TARGETS[type as FeatureType] ?? [];
}

/** One entry of a target: a selector, a body id, or a profile point. The three
 *  shapes, one per line. */
export type TargetEntry = Selector | string | [number, number, number];

/** Everything in the target, always as an array however it is stored.
 *
 *  Tolerant on the way in, because the document is not: `faces` is typed
 *  `Selector | Selector[]`, `face` is a bare selector that some old documents
 *  wrote as a one-element array, and `split` spells its target two ways. A
 *  reader that trusted the declared arity would silently show an empty target
 *  for a legal document, which reads as "this feature acts on nothing". */
export function readTarget(feature: Feature, t: TargetField): TargetEntry[] {
  const raw = (feature as unknown as Record<string, unknown>)[t.field];
  const fallback = t.alsoReads
    ? (feature as unknown as Record<string, unknown>)[t.alsoReads]
    : undefined;
  const val = raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)
    ? fallback
    : raw;
  if (val === undefined || val === null) return [];
  const arr = isOneEntry(val, t) ? [val] : Array.isArray(val) ? val : [val];
  return arr.filter((v): v is TargetEntry => v !== null && v !== undefined) as TargetEntry[];
}

/** Is this stored value ONE entry rather than a list of them?
 *
 *  Only ever true for a profile point, and that is the whole reason it exists: a
 *  point is itself an array, so `Array.isArray` cannot tell `[4, 4, 0]` (one
 *  area) from `[[4, 4, 0]]` (a list holding one). Read the wrong way, the
 *  legacy singular `extrude.region` came back as THREE areas — a row saying
 *  "3 areas" over an extrude with one. Look at what is inside instead: numbers
 *  mean the value is the point. */
function isOneEntry(val: unknown, t: TargetField): boolean {
  return t.shape === "regionPoint" && Array.isArray(val) && typeof val[0] === "number";
}

/** The patch that sets this target to `entries`, in the shape the field is
 *  declared with.
 *
 *  An "one" field takes the first entry and drops the rest rather than storing
 *  an array the builder would misread. Emptying a field DELETES it (undefined)
 *  instead of writing `[]`: several of these mean something specific when
 *  absent, and every writer in the document keeps the omit-when-empty
 *  discipline that makes two identical models compare identical. */
export function writeTarget(
  t: TargetField,
  entries: readonly TargetEntry[],
): Partial<Feature> {
  const patch: Record<string, unknown> = {};
  if (t.arity === "one") {
    patch[t.field] = entries[0];
  } else {
    patch[t.field] = entries.length ? [...entries] : undefined;
  }
  // Normalise the pair: `bodies` wins in the builder, so a split edited here
  // must not leave a stale `body` behind to be resolved on some later read.
  if (t.alsoReads) patch[t.alsoReads] = undefined;
  return patch as Partial<Feature>;
}

/** The plural of each kind, spelled rather than derived. Two of three take an
 *  "s" and the third does not, and "2 bodys" is the sort of thing that ships. */
const PLURAL: Record<TargetKind, string> = {
  edge: "edges",
  face: "faces",
  body: "bodies",
  area: "areas",
};

/** What the row says in place of a count: "4 edges", "1 body", or the field's
 *  own words for empty. */
export function describeTarget(t: TargetField, count: number): string {
  if (count === 0) return t.whenEmpty ?? "nothing selected";
  return `${count} ${count === 1 ? t.kind : PLURAL[t.kind]}`;
}

/** Is this entry the same one? Identity for a target, so an entry can be
 *  removed and a click can toggle rather than pile up duplicates.
 *
 *  A body id compares by value. A selector compares by its POINT, because that
 *  is what a picked selector carries and what the sidecar resolves it by; two
 *  selectors naming the same edge from the same pick have the same point, and
 *  nothing else about them is stable across a rebuild. Selectors with no point
 *  (by:"all", by:"axis", a v2 fingerprint) compare by full value — they are not
 *  picked one at a time, so an exact match is the only honest test. */
export function sameEntry(a: TargetEntry, b: TargetEntry): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  // A profile point IS its point, so it compares the same way a picked
  // selector's does — same tolerance, same reason.
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && samePoint(a, b);
  }
  const pa = pointOf(a);
  const pb = pointOf(b);
  if (pa && pb) return samePoint(pa, pb);
  if (pa || pb) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Two picked points naming the same thing. The tolerance is well below any
 *  real modelling distance and above the 6-decimal rounding the sidecar applies
 *  to a point it hands back. */
function samePoint(a: readonly number[], b: readonly number[]): boolean {
  return a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) <= 1e-4);
}

/** The world point a picked selector carries, or null for the forms that name
 *  geometry some other way. */
export function pointOf(sel: Selector): [number, number, number] | null {
  const p = (sel as { point?: unknown }).point;
  if (!Array.isArray(p) || p.length !== 3) return null;
  if (!p.every((v) => typeof v === "number")) return null;
  return p as [number, number, number];
}

// Two absences, both deliberate.
//
// REVOLVE'S AXIS EDGE is a selector like any other, and it is left out because
// it does not stand alone: `revolve.axis` is written beside it as the RESOLVED
// line, a cache the sidecar falls back to when the edge stops resolving and
// older builds read instead of the reference. Writing a new `axisEdge` through
// the generic editor would leave that cache describing the OLD edge — harmless
// while the new one resolves, and quietly wrong the moment it stops. Keeping the
// pair in step needs the edge's geometry, which is exactly what a pure module
// does not have, so the axis stays with the pick flow that mints both together
// (featureStarters.startRevolve).
//
// LOFT'S PROFILES are the one profile target still missing, and the reason is
// the shape rather than the picking. `extrude.regions` and `revolve.regions` are
// flat arrays of points, which readTarget can hand back and a count can be taken
// of; `loft.profiles` is an array of {sketch, region} PAIRS, and a row that
// reported "3 areas" while silently dropping which sketch each came from would
// be a row that cannot be written back. Reading it needs a per-field accessor,
// which is a change to the shape of this table rather than another entry in it.
//
// The two profile rows that ARE here do not use the generic editor. A profile
// area is an interior point on a sketch plane, resolved against the overlay
// rather than the solid, and editing one means showing a sketch that has already
// been consumed and hidden — which the feature's own tool already does
// (features/extrudeTool.startEdit rolls the model back, forces the sketch
// visible and restores the saved areas). The row opens THAT, rather than an
// editor that would have nothing to pick.
