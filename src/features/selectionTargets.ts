// What each feature is applied to: every field holding a selection, and how to read and write one. Selectors re-resolve
// each rebuild, body ids are positional, profile points belong to the sketch and are edited through the feature's tool.

import type { Feature, FeatureType, Selector } from "../types";
import { contributedFeature } from "../plugins/contrib";
import { fieldApplies } from "../document/optionFields";
import { t, type MessageKey } from "../i18n";

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
  /** A face pick writes its body: the feature acts on each selector's own body, and one with none means the active one. */
  ownBody?: boolean;
}

type Keyed = Omit<TargetField, "label" | "whenEmpty">;

// Getters, so a row read after a language switch speaks the new language.
function row(labelKey: MessageKey, rest: Keyed, emptyKey?: MessageKey): TargetField {
  const out: TargetField = {
    ...rest,
    get label() {
      return t(labelKey);
    },
  };
  if (emptyKey) Object.defineProperty(out, "whenEmpty", { get: () => t(emptyKey), enumerable: true });
  return out;
}

const BODIES: Keyed = { field: "bodies", kind: "body", shape: "bodyId", arity: "many" };

/** Empty is the usual case and means every shown body it reaches, so hiding a body changes what it builds. Naming
 *  the bodies ends that, the remedy the engine's own refusal offers. */
const ACTS_ON = row(
  "selectionTarget.actsOn",
  { field: "targets", kind: "body", shape: "bodyId", arity: "many" },
  "selectionTarget.empty.everyShownBody",
);

const EDGES = (): TargetField[] => [
  row("selectionTarget.edges", { field: "edges", kind: "edge", shape: "selector", arity: "many" }),
];
const ONE_FACE = (): TargetField[] => [
  row("selectionTarget.face", { field: "face", kind: "face", shape: "selector", arity: "one" }),
];
const BODIES_OR_ACTIVE = (): TargetField[] => [
  row("selectionTarget.bodies", BODIES, "selectionTarget.empty.activeBody"),
];

/** The app's own inventory; targetsOf() also asks the plugins and is what consumers call. Declaration order is row
 *  order: what is kept before what is consumed, what is operated on before what it is operated with. */
export const FEATURE_TARGETS: Partial<Record<FeatureType, readonly TargetField[]>> = {
  fillet: EDGES(),
  chamfer: EDGES(),
  "press-pull": [
    ...ONE_FACE(),
    row(
      "selectionTarget.upToFace",
      { field: "upTo", kind: "face", shape: "selector", arity: "one", tracked: true },
      "selectionTarget.empty.distance",
    ),
    ACTS_ON,
  ],
  deleteFace: ONE_FACE(),
  // Shell's empty set is a sealed hollow, a legitimate and quite different part.
  shell: [
    row(
      "selectionTarget.facesToOpen",
      { field: "faces", kind: "face", shape: "selector", arity: "many", ownBody: true },
      "selectionTarget.empty.sealed",
    ),
  ],
  offsetFace: [row("selectionTarget.faces", { field: "faces", kind: "face", shape: "selector", arity: "many" })],
  thicken: [
    row(
      "selectionTarget.faces",
      { field: "faces", kind: "face", shape: "selector", arity: "many" },
      "selectionTarget.empty.wholeBody",
    ),
    ACTS_ON,
  ],
  draft: [
    row("selectionTarget.faces", { field: "faces", kind: "face", shape: "selector", arity: "many", ownBody: true }),
  ],
  hole: ONE_FACE(),
  textOnFace: ONE_FACE(),
  // Two body targets with opposite fates, labelled by fate: which body is kept is the whole meaning of a Subtract.
  boolean: [
    row("selectionTarget.bodyKept", { field: "target", kind: "body", shape: "bodyId", arity: "one" }),
    row("selectionTarget.bodiesUsed", { field: "tools", kind: "body", shape: "bodyId", arity: "many" }),
  ],
  move: BODIES_OR_ACTIVE(),
  mirror: BODIES_OR_ACTIVE(),
  removeBody: [row("selectionTarget.bodies", BODIES)],
  // The body that holds still while the rest of the linkage moves about it.
  mechanism: [row("selectionTarget.ground", { field: "ground", kind: "body", shape: "bodyId", arity: "one" })],
  patternRect: BODIES_OR_ACTIVE(),
  patternLinear: BODIES_OR_ACTIVE(),
  patternCircular: BODIES_OR_ACTIVE(),
  split: [row("selectionTarget.bodies", { ...BODIES, alsoReads: "body" }, "selectionTarget.empty.activeBody")],
  separate: [row("selectionTarget.bodies", { ...BODIES, alsoReads: "body" }, "selectionTarget.empty.activeBody")],
  // Empty is legal and means the whole sketch, a different statement from no areas.
  extrude: [
    row(
      "selectionTarget.profile",
      { field: "regions", kind: "area", shape: "regionPoint", arity: "many", alsoReads: "region" },
      "selectionTarget.empty.wholeSketch",
    ),
    row("selectionTarget.startFace", {
      field: "startFace",
      kind: "face",
      shape: "selector",
      arity: "one",
      tracked: true,
    }),
    row("selectionTarget.upToFace", {
      field: "upToFace",
      kind: "face",
      shape: "selector",
      arity: "one",
      tracked: true,
    }),
    row("selectionTarget.upToFace2", {
      field: "upToFace2",
      kind: "face",
      shape: "selector",
      arity: "one",
      tracked: true,
    }),
    ACTS_ON,
  ],
  revolve: [
    row(
      "selectionTarget.profile",
      { field: "regions", kind: "area", shape: "regionPoint", arity: "many" },
      "selectionTarget.empty.wholeSketch",
    ),
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

/** What the row says: "4 edges", "every edge", "2 edges, 1 tangent chain", or the field's own words for empty. An entry
 *  covering many edges is worded, not counted, since only the engine knows how many it reaches. */
export function describeTarget(target: TargetField, entries: readonly TargetEntry[]): string {
  if (entries.length === 0) return target.whenEmpty ?? t("selectionTarget.empty.nothing");
  const spans = new Map<string, number>();
  let picks = 0;
  for (const entry of entries) {
    const span = spanOf(entry);
    if (span === "all") return t("target.span.all");
    if (span) spans.set(span, (spans.get(span) ?? 0) + 1);
    else picks++;
  }
  const parts = picks ? [t("selectionTarget.count", { kind: target.kind, n: picks })] : [];
  for (const [span, n] of spans) parts.push(spanWords(span, n));
  return parts.join(", ");
}

/** An entry's own row in the editor, for the forms that name no single spot to find on screen. */
export function spanLabel(entry: TargetEntry): string | null {
  const span = spanOf(entry);
  if (span === "all") return t("target.row.all");
  if (span === "tangentChain") return t("target.row.chain");
  if (span === "ofFace") return t("target.row.faceEdges");
  return span ? t("target.row.along", { axis: span }) : null;
}

/** "all", "tangentChain", "ofFace", the axis letter of the edges along it, or null for an entry naming one entity. */
function spanOf(entry: TargetEntry): string | null {
  if (typeof entry === "string" || Array.isArray(entry)) return null;
  if (entry.by === "all" || entry.by === "tangentChain" || entry.by === "ofFace") return entry.by;
  return entry.by === "axis" ? entry.axis : null;
}

function spanWords(span: string, n: number): string {
  if (span === "tangentChain") return t("target.span.chains", { n });
  if (span === "ofFace") return t("target.span.faceEdges", { n });
  return t("target.span.along", { axis: span });
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
