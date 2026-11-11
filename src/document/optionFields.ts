// The non-numeric feature rows: FEATURE_CHOICE_FIELDS (dropdowns) and FEATURE_TOGGLE_FIELDS (switches), plus a
// plugin's contributed rows. Derived fields, geometry selections and PlaneSpec `plane` are left out on purpose.

import { BOOLEAN_COMMANDS } from "../features/booleanOps";
import { HOLE_SIZES, holeFieldApplies } from "../features/holeStandards";
import { t, type MessageKey } from "../i18n";
import { contributedFeature } from "../plugins/contrib";
import { mirrorPlaneName } from "./mirrorPlane";
import { mechanismFieldApplies, NO_DRIVE } from "./mechanism";
import type { Feature, FeatureType } from "../types";

export interface ChoiceOption {
  value: string;
  label: string;
}

export interface ChoiceField {
  field: string;
  label: string;
  options: ChoiceOption[];
  // Option labels stay short for the 120px value column and a one-line <select>; the longer words live here.
  title?: string;
  // The builder's default, shown when the feature does not carry the field.
  fallback: string;
}

export interface ToggleField {
  field: string;
  label: string;
  fallback: boolean;
}

// A path chosen through the native dialog, unvalidated until the build reads it. Absent `filters` means every file.
export interface FileField {
  field: string;
  label: string;
  filters?: { name: string; extensions: string[] }[];
  title?: string;
}

const BOOLEAN_OPS: ChoiceOption[] = [
  { value: "new", label: "New body" },
  { value: "join", label: "Join" },
  { value: "cut", label: "Cut" },
  { value: "intersect", label: "Intersect" },
];

// Off the same inventory as the three commands and ribbon buttons, so a row never shows a word its command lacks.
const BOOLEAN_KINDS: ChoiceOption[] = BOOLEAN_COMMANDS.map((c) => ({ value: c.op, label: c.label }));

const AXES: ChoiceOption[] = [
  { value: "X", label: "X" },
  { value: "Y", label: "Y" },
  { value: "Z", label: "Z" },
];

const PLANES: ChoiceOption[] = [
  { value: "XY", label: "XY" },
  { value: "XZ", label: "XZ" },
  { value: "YZ", label: "YZ" },
];

const EXTRUDE_STARTS: ChoiceOption[] = [
  { value: "sketch", label: "Sketch plane" },
  { value: "offset", label: "Offset" },
  { value: "face", label: "Face" },
  { value: "plane", label: "Plane" },
  { value: "point", label: "Point" },
];

const EXTRUDE_ENDS: ChoiceOption[] = [
  { value: "distance", label: "Distance" },
  { value: "upToFace", label: "Up to face" },
  { value: "upToPlane", label: "Up to plane" },
  { value: "upToPoint", label: "Up to point" },
  { value: "throughAll", label: "Through all" },
];

const END_TITLE =
  "Up to a target ignores the distance and goes towards the target; the end offset runs past it, negative stops short";

const THIN_SIDES: ChoiceOption[] = [
  { value: "center", label: "Centered" },
  { value: "inside", label: "Inside" },
  { value: "outside", label: "Outside" },
  { value: "twoSides", label: "Two sides" },
];

const THIN_SIDE_TITLE =
  "Inside is the enclosed side, of an open chain the side it bends toward, of a straight line its left as drawn; two sides puts Thickness inside and Thickness 2 outside";

export function datumChoices(field: string, features: readonly Feature[]): ChoiceOption[] | null {
  if (/^(startPlane|upToPlane2?)$/.test(field)) {
    const datums = features
      .filter((f) => f.type === "datumPlane")
      .map((f) => ({ value: f.id, label: (f as { name?: string }).name || f.id }));
    return [...PLANES, ...datums];
  }
  if (/^(startPoint|upToPoint2?)$/.test(field)) {
    return features
      .filter((f) => f.type === "datumPoint")
      .map((f) => ({ value: f.id, label: (f as { name?: string }).name || f.id }));
  }
  return null;
}

const DATUM_FIELD = /^(startPlane|startPoint|upToPlane2?|upToPoint2?)$/;

// A picked vertex, which is not one of the row's choices.
export const PICKED_POINT = "picked";

// Holds its value even when that is a picked vertex, a datum that is gone, or nothing chosen yet.
export function datumChoiceRow(
  feature: Feature,
  field: string,
  features: readonly Feature[],
): { options: ChoiceOption[]; current: string } | null {
  const mirror = feature.type === "mirror" && field === "plane";
  if (!mirror && !DATUM_FIELD.test(field)) return null;
  const at = features.findIndex((x) => x.id === feature.id);
  const options = datumChoices(mirror ? "startPlane" : field, at < 0 ? features : features.slice(0, at)) ?? [];
  const v = mirror
    ? mirrorPlaneName((feature as Extract<Feature, { type: "mirror" }>).plane)
    : (feature as unknown as Record<string, unknown>)[field];
  if (v && typeof v === "object") {
    return { options: [...options, { value: PICKED_POINT, label: "Picked point" }], current: PICKED_POINT };
  }
  if (typeof v === "string" && v) {
    if (options.some((o) => o.value === v)) return { options, current: v };
    return { options: [...options, { value: v, label: `${v} (missing)` }], current: v };
  }
  return { options: [{ value: "", label: "Choose one" }, ...options], current: "" };
}

export function datumChoiceIsNoOp(field: string, value: string | boolean): boolean {
  return DATUM_FIELD.test(field) && (value === "" || value === PICKED_POINT);
}

function extrudeFieldApplies(field: string, v: Record<string, unknown>): boolean {
  const start = (v.startType as string) || "sketch";
  const end = (v.endType as string) || "distance";
  const end2 = (v.endType2 as string) || "distance";
  const two = v.twoSided === true;
  switch (field) {
    case "startOffset":
      return start !== "sketch" || v.startOffset !== undefined;
    case "startFace":
      return start === "face";
    case "startPlane":
      return start === "plane";
    case "startPoint":
      return start === "point";
    case "distance":
      return !end.startsWith("upTo");
    case "upToFace":
      return end === "upToFace";
    case "upToPlane":
      return end === "upToPlane";
    case "upToPoint":
      return end === "upToPoint";
    case "endOffset":
      return end.startsWith("upTo");
    case "symmetric":
      return !two;
    case "twoSided":
      return v.symmetric !== true;
    case "distance2":
      return two && !end2.startsWith("upTo");
    case "taper2":
    case "endType2":
      return two;
    case "upToFace2":
      return two && end2 === "upToFace";
    case "upToPlane2":
      return two && end2 === "upToPlane";
    case "upToPoint2":
      return two && end2 === "upToPoint";
    case "endOffset2":
      return two && end2.startsWith("upTo");
    case "thickness":
    case "side":
      return v.thin === true;
    case "thickness2":
      return v.thin === true && v.side === "twoSides";
    default:
      return true;
  }
}

// The row name is a getter so an open panel follows a change of language.
function choice(
  field: string,
  key: MessageKey,
  options: ChoiceOption[],
  fallback: string,
  title?: string,
): ChoiceField {
  return {
    field,
    get label() {
      return t(key);
    },
    options,
    fallback,
    ...(title === undefined ? {} : { title }),
  };
}

function toggle(field: string, key: MessageKey, fallback: boolean): ToggleField {
  return {
    field,
    get label() {
      return t(key);
    },
    fallback,
  };
}

const operation = (options: ChoiceOption[], fallback: string) =>
  choice("operation", "field.operation", options, fallback);

// No row for a sketch or datum `plane`: it is a PlaneSpec, and a dropdown offering only the three world planes would
// silently discard a placed plane the moment it was used.
export const FEATURE_CHOICE_FIELDS: Partial<Record<FeatureType, ChoiceField[]>> = {
  // The commands never ask which boolean, so this row is the only place to change it without recreating the feature.
  boolean: [operation(BOOLEAN_KINDS, "union")],
  extrude: [
    operation(BOOLEAN_OPS, "new"),
    choice("startType", "field.start", EXTRUDE_STARTS, "sketch"),
    choice("startPlane", "field.startPlane", PLANES, "XY"),
    choice("startPoint", "field.startPoint", [], ""),
    choice("endType", "field.end", EXTRUDE_ENDS, "distance", END_TITLE),
    choice("upToPlane", "field.upToPlane", PLANES, "XY"),
    choice("upToPoint", "field.upToPoint", [], ""),
    choice("endType2", "field.end2", EXTRUDE_ENDS, "distance", END_TITLE),
    choice("upToPlane2", "field.upToPlane2", PLANES, "XY"),
    choice("upToPoint2", "field.upToPoint2", [], ""),
    choice("side", "field.wallSide", THIN_SIDES, "center", THIN_SIDE_TITLE),
  ],
  revolve: [operation(BOOLEAN_OPS, "new"), choice("axis", "field.axis", AXES, "Z")],
  thread: [
    choice(
      "hand",
      "field.hand",
      [
        { value: "right", label: "Right" },
        { value: "left", label: "Left" },
      ],
      "right",
    ),
    operation(
      BOOLEAN_OPS.filter((o) => o.value === "cut" || o.value === "join"),
      "cut",
    ),
  ],
  textOnFace: [
    operation(
      [
        { value: "join", label: "Emboss" },
        { value: "cut", label: "Engrave" },
      ],
      "join",
    ),
    choice(
      "align",
      "field.align",
      [
        { value: "left", label: "Left" },
        { value: "center", label: "Centre" },
        { value: "right", label: "Right" },
      ],
      "center",
    ),
  ],
  loft: [operation(BOOLEAN_OPS, "new")],
  sweep: [
    // The builder has no sweep intersect.
    operation(
      BOOLEAN_OPS.filter((o) => o.value !== "intersect"),
      "new",
    ),
  ],
  thicken: [
    operation(
      BOOLEAN_OPS.filter((o) => o.value === "new" || o.value === "join"),
      "join",
    ),
  ],
  mirror: [choice("plane", "field.plane", PLANES, "XY")],
  draft: [choice("axis", "field.pullAxis", AXES, "Z")],
  patternLinear: [choice("axis", "field.direction", AXES, "X")],
  patternCircular: [choice("axis", "field.axis", AXES, "Z")],
  // Options come from mechanismDriveChoice in FeatureProperties; this entry only puts the row there.
  mechanism: [
    choice(
      "drive",
      "field.drive",
      [{ value: NO_DRIVE, label: "None" }],
      NO_DRIVE,
      "The joint the drive value moves: a revolute joint turns by the drive angle, a slider slides by the drive offset",
    ),
  ],
  // press-pull's operation is read off the sign of `distance` by the builder, so a dropdown over it would offer states
  // the rebuild cannot produce. `mode` is the explicit choice.
  "press-pull": [
    choice(
      "mode",
      "field.operation",
      [{ value: "auto", label: "Auto" }, ...BOOLEAN_OPS],
      "auto",
      "Auto grows or shrinks the face by the sign of the distance; the others extrude it and combine like an extrude",
    ),
    choice(
      "direction",
      "field.direction",
      [
        { value: "normal", label: "Along normal" },
        { value: "axis", label: "Along axis" },
      ],
      "normal",
      "Along axis slides the end of a hole down the hole, so the hole gets deeper or shallower and the end keeps its shape",
    ),
  ],
  fillet: [
    choice(
      "sizeType",
      "field.sizeType",
      [
        { value: "radius", label: "Radius" },
        { value: "chord", label: "Chord Length" },
      ],
      "radius",
      "Chord Length sizes the round by the width across it rather than its radius",
    ),
    choice(
      "continuity",
      "field.continuity",
      [
        { value: "G1", label: "G1" },
        { value: "G2", label: "G2" },
        { value: "G3", label: "G3" },
      ],
      "G1",
      "G1 is a circular round; G2 eases into the faces with no jump in curvature, G3 with no jump in its rate either. G2 and G3 need both faces flat across the edge",
    ),
  ],
  chamfer: [
    choice(
      "chamferType",
      "field.type",
      [
        { value: "equal", label: "Equal Distance" },
        { value: "twoDistance", label: "Two-Distance" },
      ],
      "equal",
    ),
  ],
  hole: [
    choice(
      "holeType",
      "field.holeType",
      [
        { value: "simple", label: "Simple" },
        { value: "counterbore", label: "Counterbore" },
        { value: "countersink", label: "Countersink" },
        { value: "insert", label: "Heat-set insert" },
      ],
      "simple",
      "Heat-set insert sizes the bore for a brass insert of the chosen size",
    ),
    choice(
      "standard",
      "field.standard",
      [
        { value: "clearance", label: "Clearance" },
        { value: "tap", label: "Tap drill" },
        { value: "custom", label: "Custom" },
      ],
      "clearance",
      "Clearance is ISO 273, Tap drill the coarse pitch drill; Custom keeps the diameter you type",
    ),
    choice(
      "size",
      "field.size",
      HOLE_SIZES.map((s) => ({ value: s, label: s })),
      "M3",
    ),
    choice(
      "fit",
      "field.fit",
      [
        { value: "close", label: "Close" },
        { value: "normal", label: "Normal" },
        { value: "loose", label: "Loose" },
      ],
      "normal",
    ),
    choice(
      "extent",
      "field.extent",
      [
        { value: "blind", label: "Blind" },
        { value: "through", label: "Through all" },
      ],
      "blind",
    ),
  ],
};

export const FEATURE_TOGGLE_FIELDS: Partial<Record<FeatureType, ToggleField[]>> = {
  // Tool bodies are consumed by default, as the operation means; on when one body cuts several times, a bolt through
  // three plates.
  boolean: [toggle("keepOriginals", "field.keepOriginals", false)],
  // Both ways off the sketch plane, `distance` each way, for an extrude on a datum plane inside a body.
  extrude: [
    toggle("symmetric", "field.symmetric", false),
    toggle("twoSided", "field.twoSided", false),
    // A wall along the sketch's curves, which is also how an open sketch extrudes.
    toggle("thin", "field.thin", false),
  ],
  thicken: [toggle("symmetric", "field.symmetric", false)],
  fillet: [toggle("tangentEdges", "field.includeTangentEdges", true)],
  chamfer: [toggle("tangentEdges", "field.includeTangentEdges", true)],
  "press-pull": [toggle("followTangent", "field.tangentFacesFollow", true)],
  offsetFace: [toggle("followTangent", "field.tangentFacesFollow", true)],
  hole: [
    toggle("drillPoint", "field.drillPoint", false),
    toggle("flip", "field.flipDirection", false),
    toggle("tapped", "field.tapped", false),
  ],
};

// Applies to numeric rows too: a row the engine ignores is worse than none. Unnamed fields always apply, including for
// a type with no rule or no installed plugin, since hiding a row on a guess loses an editable value.
export function fieldApplies(type: FeatureType | string, field: string, values: Record<string, unknown>): boolean {
  if (type === "chamfer" && field === "distance2") return values.chamferType === "twoDistance";
  if (type === "hole") return holeFieldApplies(field, values);
  if (type === "extrude") return extrudeFieldApplies(field, values);
  if (type === "press-pull" && field === "upToOffset") {
    return values.upTo != null || values.upToPlane != null || values.upToPoint != null;
  }
  if (type === "mechanism") return mechanismFieldApplies(field, values);
  // The tool writes followTangent only for a round face with tangent neighbours; absent means nothing to act on.
  if ((type === "press-pull" || type === "offsetFace") && field === "followTangent") {
    return (
      typeof values.followTangent === "boolean" && (values.mode ?? "auto") === "auto" && values.direction !== "axis"
    );
  }
  // The app owns rows like `seed` and `angle` because a parameter can drive them and a document must mean the same with
  // the plugin off; the plugin only decides which of them a given pattern reads.
  return contributedFeature(type)?.fieldApplies?.(field, values) ?? true;
}

// For a row whose meaning changes with another field. Null means use the inventory's label.
export function fieldLabel(
  type: FeatureType | string,
  field: string,
  values: Record<string, unknown>,
): { text: string; title?: string } | null {
  if (type === "fillet" && field === "radius" && values.sizeType === "chord") return { text: t("field.chordLength") };
  return contributedFeature(type)?.fieldLabel?.(field, values) ?? null;
}

export function choiceFieldsFor(type: FeatureType | string): readonly ChoiceField[] {
  return FEATURE_CHOICE_FIELDS[type as FeatureType] ?? contributedFeature(type)?.choiceFields ?? [];
}

export function toggleFieldsFor(type: FeatureType | string): readonly ToggleField[] {
  return FEATURE_TOGGLE_FIELDS[type as FeatureType] ?? contributedFeature(type)?.toggleFields ?? [];
}

// The app declares no file rows: the only one (a texture heightmap) comes with the plugin that knows its filter.
export function fileFieldsFor(type: FeatureType | string): readonly FileField[] {
  return contributedFeature(type)?.fileFields ?? [];
}

// "" renders as "Choose…".
export function fileValue(feature: Feature, f: FileField): string {
  const v = (feature as unknown as Record<string, unknown>)[f.field];
  return typeof v === "string" ? v : "";
}

export function hasOptionFields(type: FeatureType | string): boolean {
  return choiceFieldsFor(type).length > 0 || toggleFieldsFor(type).length > 0 || fileFieldsFor(type).length > 0;
}

// The builder's default when absent, the common case for optional fields and files saved before the field existed.
export function choiceValue(feature: Feature, f: ChoiceField): string {
  const v =
    feature.type === "mirror" && f.field === "plane"
      ? mirrorPlaneName((feature as Extract<Feature, { type: "mirror" }>).plane)
      : (feature as unknown as Record<string, unknown>)[f.field];
  if (typeof v !== "string") return f.fallback;
  return f.options.some((o) => o.value === v) ? v : f.fallback;
}

export function toggleValue(feature: Feature, f: ToggleField): boolean {
  const v = (feature as unknown as Record<string, unknown>)[f.field];
  return typeof v === "boolean" ? v : f.fallback;
}

// An axis that is not one of the choices: a line, a picked edge or a face. Choosing it again changes nothing.
export const PLACED_AXIS = "placed";

export function patternAxisDatum(axis: unknown): string | null {
  const d = (axis as { datum?: unknown } | null)?.datum;
  return typeof d === "string" ? d : null;
}

// World axes, datum axes above the pattern, and its placed axis, so the row never shows "Z" for another axis.
// Picking a world axis or a datum drops the placed one.
export function patternAxisChoice(
  feature: Feature,
  features: readonly Feature[],
): { options: ChoiceOption[]; current: string } {
  const raw = feature as unknown as { axis?: unknown; axisRef?: unknown };
  const at = features.findIndex((f) => f.id === feature.id);
  const datums = features
    .slice(0, at < 0 ? features.length : at)
    .filter((f) => f.type === "datumAxis")
    .map((f) => ({ value: f.id, label: (f as { name?: string }).name?.trim() || f.id }));
  const options = [...AXES, ...datums];
  const datum = patternAxisDatum(raw.axis);
  const placed = raw.axisRef != null || (raw.axis != null && typeof raw.axis !== "string" && datum == null);
  if (placed) {
    options.push({ value: PLACED_AXIS, label: raw.axisRef != null ? "Picked" : "Line" });
    return { options, current: PLACED_AXIS };
  }
  const name = datum ?? (typeof raw.axis === "string" ? raw.axis : "Z");
  if (!options.some((o) => o.value === name)) options.push({ value: name, label: name });
  return { options, current: name };
}

// A datum axis is `{datum}`, never the bare id, which older builds turn about world Z.
export function patternAxisPatch(value: string): Record<string, unknown> | null {
  if (value === PLACED_AXIS) return null;
  const named = AXES.some((o) => o.value === value);
  return { axis: named ? value : { datum: value }, axisRef: undefined };
}
