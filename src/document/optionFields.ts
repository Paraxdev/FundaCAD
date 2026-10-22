// The feature fields that are NOT numbers: the fixed choices and the switches.
//
// FEATURE_NUM_FIELDS has always been the inventory of what a feature's value
// rows can edit, and everything in it is a number. So the editor could only ever
// be a column of text boxes, and every fact about a feature that is a CHOICE,
// which boolean an extrude performs, which axis a revolve turns about, which way
// a pattern is pushed, was editable at the moment the feature was made and
// never again. Changing your mind meant deleting the feature and re-picking
// everything it referred to.
//
// Two more inventories, read the same way as the numeric one:
//
//   FEATURE_CHOICE_FIELDS   one of a fixed set   -> a dropdown
//   FEATURE_TOGGLE_FIELDS   on or off           -> a switch
//
// And two rules about ONE row rather than about a type: `fieldApplies`, which
// says whether a field means anything given what the feature's other fields
// currently say, and `fieldLabel`, for the rare row whose name is not a
// constant. Both govern the numeric rows too, which is what stops a feature
// offering a control with nothing on the other end of it.
//
// Deliberately not exhaustive over the union. A field belongs here when its
// options are a closed set the user picks from and editing it after the fact is
// meaningful. Three kinds of field are left out on purpose:
//
//   * anything derived from another field. press-pull's `operation` is read off
//     the SIGN of its distance by the builder, so a dropdown offering "join" on
//     a negative distance would be offering a state the rebuild cannot produce.
//     Its explicit choice is `mode` instead.
//   * references to geometry, `faces`, `edges`, `sketch`, `body`. Those are
//     selections, and picking one is a viewport gesture, not a menu.
//   * `plane` on a sketch or a datum, which is a PlaneSpec: a string for the
//     three world planes and a full origin/normal/xdir triple otherwise, so a
//     dropdown over it could only offer the three and would silently discard a
//     placement the moment it was used.
//
// AND A PLUGIN CAN ADD ROWS HERE, for a feature type whose tool it owns. The
// readers below ask the contribution table after their own inventory, so a
// feature the app stores and builds but does not know how to PRESENT gets its
// dropdowns from whoever does.
//
// `fieldApplies` is the interesting one, and it used to be the clearest sign
// that this file had the wrong owner: its entire body was `if (type !==
// "texture") return true;` followed by one tool's rules, sitting in the document
// layer. Those rules are contributed now, and they still govern the app's own
// numeric rows, which is the better arrangement rather than a concession. The
// app owns `seed` and `angle` because a PARAMETER can drive them and a document
// has to mean the same thing with the plugin switched off; the plugin decides
// which of them a given pattern actually reads.

import { BOOLEAN_COMMANDS } from "../features/booleanOps";
import { HOLE_SIZES, holeFieldApplies } from "../features/holeStandards";
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
  /** Tooltip for the row. Option labels are kept SHORT because the value column
   *  is 120px and a closed <select> shows one line, "Faceted (hard surface)"
   *  rendered as "Faceted (hard". The words that had to go live here instead,
   *  rather than being lost. */
  title?: string;
  /** Shown when the feature does not carry the field at all. Every one of these
   *  is optional on some feature or other, and the builder has a default for
   *  each; this is that default, so the row shows what WILL happen rather than
   *  an empty box. */
  fallback: string;
}

export interface ToggleField {
  field: string;
  label: string;
  fallback: boolean;
}

/** A row whose value is a path on disk, chosen through the native dialog.
 *
 *  Not a choice and not a number: the set of values is the filesystem, so there
 *  is no inventory to offer and nothing to validate against until the build
 *  tries to read it. `filters` is what the dialog offers, and absent means every
 *  file, which is the right default for a row nobody has narrowed. */
export interface FileField {
  field: string;
  label: string;
  filters?: { name: string; extensions: string[] }[];
  title?: string;
}

/** New / Join / Cut / Intersect, the same four everywhere they appear, so they
 *  are written once. */
const BOOLEAN_OPS: ChoiceOption[] = [
  { value: "new", label: "New body" },
  { value: "join", label: "Join" },
  { value: "cut", label: "Cut" },
  { value: "intersect", label: "Intersect" },
];

/** Union / Subtract / Intersect, off the same inventory the three commands and
 *  the three ribbon buttons read, so a feature can never be shown a word its
 *  command does not use. */
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

/** The planes and points a document offers a start or end row: the three base
 *  planes and every datum plane, or every datum point, as the row's options. */
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

/** The value a point row shows for a picked vertex, which is not one of its choices. */
export const PICKED_POINT = "picked";

/** A start or up to plane or point row: its choices from the datums above the
 *  feature, and the value it holds even when that is a picked vertex, a datum
 *  that is gone, or nothing chosen yet. */
export function datumChoiceRow(
  feature: Feature,
  field: string,
  features: readonly Feature[],
): { options: ChoiceOption[]; current: string } | null {
  if (!DATUM_FIELD.test(field)) return null;
  const at = features.findIndex((x) => x.id === feature.id);
  const options = datumChoices(field, at < 0 ? features : features.slice(0, at)) ?? [];
  const v = (feature as unknown as Record<string, unknown>)[field];
  if (v && typeof v === "object") {
    return { options: [...options, { value: PICKED_POINT, label: "Picked point" }], current: PICKED_POINT };
  }
  if (typeof v === "string" && v) {
    if (options.some((o) => o.value === v)) return { options, current: v };
    return { options: [...options, { value: v, label: `${v} (missing)` }], current: v };
  }
  return { options: [{ value: "", label: "Choose one" }, ...options], current: "" };
}

/** Whether picking `value` on a datum row would only rewrite what it already holds. */
export function datumChoiceIsNoOp(field: string, value: string | boolean): boolean {
  return DATUM_FIELD.test(field) && (value === "" || value === PICKED_POINT);
}

/** Which start and end rows an extrude reads, given its start and end types. */
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

export const FEATURE_CHOICE_FIELDS: Partial<Record<FeatureType, ChoiceField[]>> = {
  // Three commands make the feature, and the row edits it afterwards. Nothing
  // asks which boolean you want, so this is the only place the answer is ever
  // typed by hand, which is exactly what the row is for: changing your mind
  // should not mean deleting the feature and re-picking the bodies.
  boolean: [{ field: "operation", label: "Operation", options: BOOLEAN_KINDS, fallback: "union" }],
  extrude: [
    { field: "operation", label: "Operation", options: BOOLEAN_OPS, fallback: "new" },
    { field: "startType", label: "Start", options: EXTRUDE_STARTS, fallback: "sketch" },
    { field: "startPlane", label: "Start plane", options: PLANES, fallback: "XY" },
    { field: "startPoint", label: "Start point", options: [], fallback: "" },
    { field: "endType", label: "End", options: EXTRUDE_ENDS, fallback: "distance", title: END_TITLE },
    { field: "upToPlane", label: "Up to plane", options: PLANES, fallback: "XY" },
    { field: "upToPoint", label: "Up to point", options: [], fallback: "" },
    { field: "endType2", label: "End 2", options: EXTRUDE_ENDS, fallback: "distance", title: END_TITLE },
    { field: "upToPlane2", label: "Up to plane 2", options: PLANES, fallback: "XY" },
    { field: "upToPoint2", label: "Up to point 2", options: [], fallback: "" },
    { field: "side", label: "Wall side", options: THIN_SIDES, fallback: "center", title: THIN_SIDE_TITLE },
  ],
  revolve: [
    { field: "operation", label: "Operation", options: BOOLEAN_OPS, fallback: "new" },
    { field: "axis", label: "Axis", options: AXES, fallback: "Z" },
  ],
  thread: [
    {
      field: "hand",
      label: "Hand",
      options: [
        { value: "right", label: "Right" },
        { value: "left", label: "Left" },
      ],
      fallback: "right",
    },
    {
      field: "operation",
      label: "Operation",
      options: BOOLEAN_OPS.filter((o) => o.value === "cut" || o.value === "join"),
      fallback: "cut",
    },
  ],
  textOnFace: [
    {
      field: "operation",
      label: "Operation",
      options: [
        { value: "join", label: "Emboss" },
        { value: "cut", label: "Engrave" },
      ],
      fallback: "join",
    },
    {
      field: "align",
      label: "Align",
      options: [
        { value: "left", label: "Left" },
        { value: "center", label: "Centre" },
        { value: "right", label: "Right" },
      ],
      fallback: "center",
    },
  ],
  loft: [{ field: "operation", label: "Operation", options: BOOLEAN_OPS, fallback: "new" }],
  sweep: [
    {
      field: "operation",
      label: "Operation",
      // A sweep has no intersect path in the builder, so the list is the three it
      // can actually do rather than the shared four.
      options: BOOLEAN_OPS.filter((o) => o.value !== "intersect"),
      fallback: "new",
    },
  ],
  thicken: [
    {
      field: "operation",
      label: "Operation",
      options: BOOLEAN_OPS.filter((o) => o.value === "new" || o.value === "join"),
      fallback: "join",
    },
  ],
  mirror: [{ field: "plane", label: "Plane", options: PLANES, fallback: "XY" }],
  draft: [{ field: "axis", label: "Pull axis", options: AXES, fallback: "Z" }],
  patternLinear: [{ field: "axis", label: "Direction", options: AXES, fallback: "X" }],
  patternCircular: [{ field: "axis", label: "Axis", options: AXES, fallback: "Z" }],
  // Which joint the drive value moves. The options are this mechanism's own
  // revolute and slider joints, so FeatureProperties asks mechanismDriveChoice
  // for them; this entry is what puts the row there at all.
  mechanism: [
    {
      field: "drive",
      label: "Drive",
      fallback: NO_DRIVE,
      options: [{ value: NO_DRIVE, label: "None" }],
      title:
        "The joint the drive value moves: a revolute joint turns by the drive angle, a slider slides by the drive offset",
    },
  ],
  "press-pull": [
    {
      field: "mode",
      label: "Operation",
      fallback: "auto",
      options: [{ value: "auto", label: "Auto" }, ...BOOLEAN_OPS],
      title:
        "Auto grows or shrinks the face by the sign of the distance; the others extrude it and combine like an extrude",
    },
    {
      field: "direction",
      label: "Direction",
      fallback: "normal",
      options: [
        { value: "normal", label: "Along normal" },
        { value: "axis", label: "Along axis" },
      ],
      title:
        "Along axis slides the end of a hole down the hole, so the hole gets deeper or shallower and the end keeps its shape",
    },
  ],
  fillet: [
    {
      field: "sizeType",
      label: "Size Type",
      fallback: "radius",
      options: [
        { value: "radius", label: "Radius" },
        { value: "chord", label: "Chord Length" },
      ],
      title: "Chord Length sizes the round by the width across it rather than its radius",
    },
    {
      field: "continuity",
      label: "Continuity",
      fallback: "G1",
      options: [
        { value: "G1", label: "G1" },
        { value: "G2", label: "G2" },
      ],
      title: "G1 is a circular round; G2 eases into the faces with no jump in curvature",
    },
  ],
  chamfer: [
    {
      field: "chamferType",
      label: "Type",
      fallback: "equal",
      options: [
        { value: "equal", label: "Equal Distance" },
        { value: "twoDistance", label: "Two-Distance" },
      ],
    },
  ],
  hole: [
    {
      field: "holeType",
      label: "Hole type",
      fallback: "simple",
      options: [
        { value: "simple", label: "Simple" },
        { value: "counterbore", label: "Counterbore" },
        { value: "countersink", label: "Countersink" },
        { value: "insert", label: "Heat-set insert" },
      ],
      title: "Heat-set insert sizes the bore for a brass insert of the chosen size",
    },
    {
      field: "standard",
      label: "Standard",
      fallback: "clearance",
      options: [
        { value: "clearance", label: "Clearance" },
        { value: "tap", label: "Tap drill" },
        { value: "custom", label: "Custom" },
      ],
      title: "Clearance is ISO 273, Tap drill the coarse pitch drill; Custom keeps the diameter you type",
    },
    { field: "size", label: "Size", fallback: "M3", options: HOLE_SIZES.map((s) => ({ value: s, label: s })) },
    {
      field: "fit",
      label: "Fit",
      fallback: "normal",
      options: [
        { value: "close", label: "Close" },
        { value: "normal", label: "Normal" },
        { value: "loose", label: "Loose" },
      ],
    },
    {
      field: "extent",
      label: "Extent",
      fallback: "blind",
      options: [
        { value: "blind", label: "Blind" },
        { value: "through", label: "Through all" },
      ],
    },
  ],
};

export const FEATURE_TOGGLE_FIELDS: Partial<Record<FeatureType, ToggleField[]>> = {
  // A boolean CONSUMES its tool bodies by default: the two circles go in and one
  // shape comes out, which is what the operation means and what leaves a browser
  // tree you can read. Off by default for that reason, and on when the same body
  // is a cutter more than once, a bolt hole punched through three plates should
  // not need three copies of the bolt.
  boolean: [{ field: "keepOriginals", label: "Keep originals", fallback: false }],
  // Both ways off the sketch plane, `distance` each way. The row an extrude made
  // on a datum plane inside a body wants, and the one thing about an extrude's
  // direction that a saved feature could not previously be talked out of.
  extrude: [
    { field: "symmetric", label: "Symmetric", fallback: false },
    { field: "twoSided", label: "Two sided", fallback: false },
    // A wall along the sketch's curves instead of its closed areas, which is also
    // what an open sketch extrudes as.
    { field: "thin", label: "Thin", fallback: false },
  ],
  thicken: [{ field: "symmetric", label: "Symmetric", fallback: false }],
  fillet: [{ field: "tangentEdges", label: "Include Tangent Edges", fallback: true }],
  chamfer: [{ field: "tangentEdges", label: "Include Tangent Edges", fallback: true }],
  "press-pull": [{ field: "followTangent", label: "Tangent faces follow", fallback: true }],
  offsetFace: [{ field: "followTangent", label: "Tangent faces follow", fallback: true }],
  hole: [
    { field: "drillPoint", label: "Drill point", fallback: false },
    { field: "flip", label: "Flip direction", fallback: false },
    { field: "tapped", label: "Tapped", fallback: false },
  ],
};

/** Does this field mean anything, given what the feature's other fields say?
 *
 *  Applies to every kind of row, numeric included. A knurl reads no Seed and a
 *  faceted wave has no shape parameter at all, the engine simply ignores what
 *  it is sent, so a row for either is a control the user can turn with nothing
 *  on the other end, which is worse than no row.
 *
 *  Fields not named here always apply, which is the honest default: a rule that
 *  hid a row it had no reason to hide would lose the user a value they could
 *  otherwise have edited. A feature type nobody has a rule for is that case, and
 *  so is one whose plugin is not installed, which is right: with nothing left
 *  to say which rows a knurl reads, showing all of them is preferred over hiding some on a
 *  guess.
 */
export function fieldApplies(type: FeatureType | string, field: string, values: Record<string, unknown>): boolean {
  if (type === "chamfer" && field === "distance2") return values.chamferType === "twoDistance";
  if (type === "fillet" && field === "profile") return values.continuity !== "G2";
  if (type === "hole") return holeFieldApplies(field, values);
  if (type === "extrude") return extrudeFieldApplies(field, values);
  if (type === "press-pull" && field === "upToOffset") {
    return values.upTo != null || values.upToPlane != null || values.upToPoint != null;
  }
  if (type === "mechanism") return mechanismFieldApplies(field, values);
  // The tool writes followTangent only for a round face with tangent neighbours, so its
  // absence is how a feature says the switch has nothing to act on.
  if ((type === "press-pull" || type === "offsetFace") && field === "followTangent") {
    return (
      typeof values.followTangent === "boolean" && (values.mode ?? "auto") === "auto" && values.direction !== "axis"
    );
  }
  return contributedFeature(type)?.fieldApplies?.(field, values) ?? true;
}

/** The label one row carries when its name is not a constant, a slider whose
 *  meaning changes with another field, say. Null for "use the inventory's". */
export function fieldLabel(
  type: FeatureType | string,
  field: string,
  values: Record<string, unknown>,
): { text: string; title?: string } | null {
  if (type === "fillet" && field === "radius" && values.sizeType === "chord") return { text: "Chord Length" };
  return contributedFeature(type)?.fieldLabel?.(field, values) ?? null;
}

/** Every choice row for a feature type: the app's own, then a plugin's. */
export function choiceFieldsFor(type: FeatureType | string): readonly ChoiceField[] {
  return FEATURE_CHOICE_FIELDS[type as FeatureType] ?? contributedFeature(type)?.choiceFields ?? [];
}

/** Every toggle row for a feature type: the app's own, then a plugin's. */
export function toggleFieldsFor(type: FeatureType | string): readonly ToggleField[] {
  return FEATURE_TOGGLE_FIELDS[type as FeatureType] ?? contributedFeature(type)?.toggleFields ?? [];
}

/** Every file row for a feature type. The app declares none of its own: no
 *  feature it ships reads a path, and the one that does (a texture's heightmap)
 *  arrives with the plugin that knows what to filter the dialog by. The
 *  inventory constant is deliberately absent rather than empty, so a reader can
 *  see there is nothing to look for here. */
export function fileFieldsFor(type: FeatureType | string): readonly FileField[] {
  return contributedFeature(type)?.fileFields ?? [];
}

/** The path a file row should show: what the feature carries, or "" for a
 *  feature that has none, which is the state the row renders as "Choose…". */
export function fileValue(feature: Feature, f: FileField): string {
  const v = (feature as unknown as Record<string, unknown>)[f.field];
  return typeof v === "string" ? v : "";
}

/** Whether a feature type has any of these rows, the panel asks before it
 *  decides there is nothing to show. */
export function hasOptionFields(type: FeatureType | string): boolean {
  return choiceFieldsFor(type).length > 0 || toggleFieldsFor(type).length > 0 || fileFieldsFor(type).length > 0;
}

/** The value a choice row should show for this feature: what it carries, or the
 *  builder's default when the field is absent. Absent is the common case, most
 *  of these are optional, and a feature saved before the field existed has none. */
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

/** The value the axis row shows for an axis that is not one of its choices: a
 *  line or a picked edge or face. Choosing it again changes nothing. */
export const PLACED_AXIS = "placed";

/** The datum axis id a circular pattern's `axis` names, if it names one. */
export function patternAxisDatum(axis: unknown): string | null {
  const d = (axis as { datum?: unknown } | null)?.datum;
  return typeof d === "string" ? d : null;
}

/** A circular pattern's Axis row: the world axes, every datum axis above the
 *  pattern, and the placed axis it already has, so the row never shows "Z" for
 *  a pattern that turns about something else. Picking a world axis or a datum
 *  drops the placed one. */
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

/** What choosing `value` in that row writes. A datum axis is `{datum}`, never
 *  the bare id, which a build from before datum axes turns about world Z. */
export function patternAxisPatch(value: string): Record<string, unknown> | null {
  if (value === PLACED_AXIS) return null;
  const named = AXES.some((o) => o.value === value);
  return { axis: named ? value : { datum: value }, axisRef: undefined };
}
