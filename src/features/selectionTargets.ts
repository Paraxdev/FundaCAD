// What each feature is applied to: every field holding a selection, and how to read and write one. Selectors re-resolve
// each rebuild, body ids are positional, profile points belong to the sketch and are edited through the feature's tool.

import type { Feature, FeatureType, Selector } from "../types";
import { contributedFeature } from "../plugins/contrib";
import { fieldApplies } from "../document/optionFields";

/** "area" is a closed sketch region, the word the extrude prompts already use. */
export type TargetKind = "edge" | "face" | "body" | "area";

/** Decides who can resolve the entries: the generic editor picks off the solid, where a profile area is not. */
export type TargetShape = "selector" | "bodyId" | "regionPoint";

export interface TargetField {
  field: string;
  /** Names the role, not the type, so a boolean's two body targets can be told apart. */
  label: string;
  kind: TargetKind;
  shape: TargetShape;
  /** A "one" field whose document value is an array is still read as one, see readTarget. */
  arity: "one" | "many";
  /** Shown instead of a count, since "0 faces" and "the whole body" are opposite answers. Absent: empty is just empty. */
  whenEmpty?: string;
  /** The plural form some features grew beside the singular, normalised to `field` on write, which the builder prefers. */
  alsoReads?: string;
  /** A face pick writes a tracked selector with its body, so the row keeps naming that face when an edit moves it. */
  tracked?: boolean;
}

/** Empty is the usual case and means every shown body it reaches, so hiding a body changes what it builds. Naming
 *  the bodies ends that, the remedy the engine's own refusal offers. */
const ACTS_ON: TargetField = {
  field: "targets",
  label: "Bodies acted on",
  kind: "body",
  shape: "bodyId",
  arity: "many",
  whenEmpty: "every shown body it reaches",
};

/** The app's own inventory; targetsOf() also asks the plugins and is what consumers call. Declaration order is row
 *  order: what is kept before what is consumed, what is operated on before what it is operated with. */
export const FEATURE_TARGETS: Partial<Record<FeatureType, readonly TargetField[]>> = {
  fillet: [{ field: "edges", label: "Edges", kind: "edge", shape: "selector", arity: "many" }],
  chamfer: [{ field: "edges", label: "Edges", kind: "edge", shape: "selector", arity: "many" }],
  "press-pull": [
    { field: "face", label: "Face", kind: "face", shape: "selector", arity: "one" },
    {
      field: "upTo",
      label: "Up to face",
      kind: "face",
      shape: "selector",
      arity: "one",
      whenEmpty: "the distance",
      tracked: true,
    },
    ACTS_ON,
  ],
  deleteFace: [{ field: "face", label: "Face", kind: "face", shape: "selector", arity: "one" }],
  // Shell's empty set is a sealed hollow, a legitimate and quite different part.
  shell: [
    {
      field: "faces",
      label: "Faces to open",
      kind: "face",
      shape: "selector",
      arity: "many",
      whenEmpty: "sealed hollow",
    },
  ],
  offsetFace: [{ field: "faces", label: "Faces", kind: "face", shape: "selector", arity: "many" }],
  thicken: [
    {
      field: "faces",
      label: "Faces",
      kind: "face",
      shape: "selector",
      arity: "many",
      whenEmpty: "the whole body",
    },
    ACTS_ON,
  ],
  draft: [{ field: "faces", label: "Faces", kind: "face", shape: "selector", arity: "many" }],
  hole: [{ field: "face", label: "Face", kind: "face", shape: "selector", arity: "one" }],
  textOnFace: [{ field: "face", label: "Face", kind: "face", shape: "selector", arity: "one" }],
  // Two body targets with opposite fates, labelled by fate: which body is kept is the whole meaning of a Subtract.
  boolean: [
    { field: "target", label: "Body kept", kind: "body", shape: "bodyId", arity: "one" },
    { field: "tools", label: "Bodies used", kind: "body", shape: "bodyId", arity: "many" },
  ],
  move: [
    {
      field: "bodies",
      label: "Bodies",
      kind: "body",
      shape: "bodyId",
      arity: "many",
      whenEmpty: "the active body",
    },
  ],
  mirror: [
    { field: "bodies", label: "Bodies", kind: "body", shape: "bodyId", arity: "many", whenEmpty: "the active body" },
  ],
  removeBody: [{ field: "bodies", label: "Bodies", kind: "body", shape: "bodyId", arity: "many" }],
  // The body that holds still while the rest of the linkage moves about it.
  mechanism: [{ field: "ground", label: "Ground", kind: "body", shape: "bodyId", arity: "one" }],
  patternRect: [
    { field: "bodies", label: "Bodies", kind: "body", shape: "bodyId", arity: "many", whenEmpty: "the active body" },
  ],
  patternLinear: [
    { field: "bodies", label: "Bodies", kind: "body", shape: "bodyId", arity: "many", whenEmpty: "the active body" },
  ],
  patternCircular: [
    { field: "bodies", label: "Bodies", kind: "body", shape: "bodyId", arity: "many", whenEmpty: "the active body" },
  ],
  split: [
    {
      field: "bodies",
      label: "Bodies",
      kind: "body",
      shape: "bodyId",
      arity: "many",
      whenEmpty: "the active body",
      alsoReads: "body",
    },
  ],
  separate: [
    {
      field: "bodies",
      label: "Bodies",
      kind: "body",
      shape: "bodyId",
      arity: "many",
      whenEmpty: "the active body",
      alsoReads: "body",
    },
  ],
  // Empty is legal and means the whole sketch, a different statement from no areas.
  extrude: [
    {
      field: "regions",
      label: "Profile",
      kind: "area",
      shape: "regionPoint",
      arity: "many",
      whenEmpty: "the whole sketch",
      alsoReads: "region",
    },
    { field: "startFace", label: "Start face", kind: "face", shape: "selector", arity: "one", tracked: true },
    { field: "upToFace", label: "Up to face", kind: "face", shape: "selector", arity: "one", tracked: true },
    { field: "upToFace2", label: "Up to face 2", kind: "face", shape: "selector", arity: "one", tracked: true },
    ACTS_ON,
  ],
  revolve: [
    {
      field: "regions",
      label: "Profile",
      kind: "area",
      shape: "regionPoint",
      arity: "many",
      whenEmpty: "the whole sketch",
    },
    ACTS_ON,
  ],
  sweep: [ACTS_ON],
  loft: [ACTS_ON],
};

/** The app's inventory first, then the plugin that owns the type. An undescribed type gets nothing: guessing which
 *  field holds a selector could overwrite something the app cannot interpret. */
export function targetsOf(type: string): readonly TargetField[] {
  return FEATURE_TARGETS[type as FeatureType] ?? contributedFeature(type)?.targets ?? [];
}

export type TargetEntry = Selector | string | [number, number, number];

/** `targetsOf` for one feature: a pattern that repeats features has no bodies,
 *  and a feature that makes a body of its own acts on none. */
export function targetsFor(f: Feature): readonly TargetField[] {
  const all = targetsOf(f.type);
  const { features: repeats, operation, mode } = f as { features?: string[]; operation?: string; mode?: string };
  const how = f.type === "press-pull" ? (mode ?? "auto") : (operation ?? "new");
  const combines = how !== "auto" && how !== "new";
  const values = f as unknown as Record<string, unknown>;
  return all.filter(
    (t) =>
      (t.field !== "bodies" || !repeats?.length) &&
      (t !== ACTS_ON || combines) &&
      fieldApplies(f.type, t.field, values),
  );
}

/** Tolerant on the way in: `face` was once written as a one-element array and `split` spells its target two ways,
 *  and trusting the declared arity would show a legal target as empty. */
export function readTarget(feature: Feature, t: TargetField): TargetEntry[] {
  const raw = (feature as unknown as Record<string, unknown>)[t.field];
  const fallback = t.alsoReads ? (feature as unknown as Record<string, unknown>)[t.alsoReads] : undefined;
  const val = raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0) ? fallback : raw;
  if (val === undefined || val === null) return [];
  const arr = isOneEntry(val, t) ? [val] : Array.isArray(val) ? val : [val];
  return arr.filter((v): v is TargetEntry => v !== null && v !== undefined) as TargetEntry[];
}

/** Only true for a profile point, which is itself an array, so `[4, 4, 0]` must not read as three areas: numbers
 *  inside mean the value is the point. */
function isOneEntry(val: unknown, t: TargetField): boolean {
  return t.shape === "regionPoint" && Array.isArray(val) && typeof val[0] === "number";
}

/** A "one" field takes the first entry. Emptying deletes the field rather than writing `[]`, the omit-when-empty
 *  discipline that keeps two identical models comparing identical. */
export function writeTarget(t: TargetField, entries: readonly TargetEntry[]): Partial<Feature> {
  const patch: Record<string, unknown> = {};
  if (t.arity === "one") {
    patch[t.field] = entries[0];
  } else {
    patch[t.field] = entries.length ? [...entries] : undefined;
  }
  // `bodies` is preferred in the builder, so a split edited here must not leave a stale `body` behind.
  if (t.alsoReads) patch[t.alsoReads] = undefined;
  return patch as Partial<Feature>;
}

/** Spelled, not derived: "2 bodys" is the sort of thing that ships. */
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

/** Identity, so a click toggles rather than duplicates. Body ids by value, picked selectors by point (all that is
 *  stable across a rebuild), selectors with no point by full value. */
export function sameEntry(a: TargetEntry, b: TargetEntry): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  // A profile point is its point, so it compares as a picked selector does.
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && samePoint(a, b);
  }
  const pa = pointOf(a);
  const pb = pointOf(b);
  if (pa && pb) return samePoint(pa, pb);
  if (pa || pb) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Below any real modelling distance, above the engine's 6-decimal rounding. */
function samePoint(a: readonly number[], b: readonly number[]): boolean {
  return a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) <= 1e-4);
}

/** Null for the forms that name geometry some other way. */
export function pointOf(sel: Selector): [number, number, number] | null {
  const p = (sel as { point?: unknown }).point;
  if (!Array.isArray(p) || p.length !== 3) return null;
  if (!p.every((v) => typeof v === "number")) return null;
  return p as [number, number, number];
}

// Left out on purpose: revolve's axisEdge, whose resolved `revolve.axis` cache only the pick flow keeps in step
// (featureStarters.startRevolve), and loft's {sketch, region} profile pairs, which need a per-field accessor.
// The two profile rows open the feature's own tool (extrudeTool.startEdit), which shows the consumed sketch.
