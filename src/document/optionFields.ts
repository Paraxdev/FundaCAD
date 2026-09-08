// The feature fields that are NOT numbers: the fixed choices and the switches.
//
// FEATURE_NUM_FIELDS has always been the inventory of what a feature's value
// rows can edit, and everything in it is a number. So the editor could only ever
// be a column of text boxes, and every fact about a feature that is a CHOICE —
// which boolean an extrude performs, which axis a revolve turns about, which way
// a pattern is pushed — was editable at the moment the feature was made and
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
//   * references to geometry — `faces`, `edges`, `sketch`, `body`. Those are
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
// numeric rows — which is the better arrangement rather than a concession. The
// app owns `seed` and `angle` because a PARAMETER can drive them and a document
// has to mean the same thing with the plugin switched off; the plugin decides
// which of them a given pattern actually reads.

import { BOOLEAN_COMMANDS } from "../features/booleanOps";
import { contributedFeature } from "../plugins/contrib";
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
   *  is 120px and a closed <select> shows one line — "Faceted (hard surface)"
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

/** New / Join / Cut / Intersect — the same four everywhere they appear, so they
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

export const FEATURE_CHOICE_FIELDS: Partial<Record<FeatureType, ChoiceField[]>> = {
  // Three commands make the feature, and the row edits it afterwards. Nothing
  // asks which boolean you want, so this is the only place the answer is ever
  // typed by hand — which is exactly what the row is for: changing your mind
  // should not mean deleting the feature and re-picking the bodies.
  boolean: [{ field: "operation", label: "Operation", options: BOOLEAN_KINDS, fallback: "union" }],
  extrude: [{ field: "operation", label: "Operation", options: BOOLEAN_OPS, fallback: "new" }],
  revolve: [
    { field: "operation", label: "Operation", options: BOOLEAN_OPS, fallback: "new" },
    { field: "axis", label: "Axis", options: AXES, fallback: "Z" },
  ],
  loft: [{ field: "operation", label: "Operation", options: BOOLEAN_OPS, fallback: "new" }],
  sweep: [{
    field: "operation",
    label: "Operation",
    // A sweep has no intersect path in the builder, so the list is the three it
    // can actually do rather than the shared four.
    options: BOOLEAN_OPS.filter((o) => o.value !== "intersect"),
    fallback: "new",
  }],
  thicken: [{
    field: "operation",
    label: "Operation",
    options: BOOLEAN_OPS.filter((o) => o.value === "new" || o.value === "join"),
    fallback: "join",
  }],
  mirror: [{ field: "plane", label: "Plane", options: PLANES, fallback: "XY" }],
  draft: [{ field: "axis", label: "Pull axis", options: AXES, fallback: "Z" }],
  patternLinear: [{ field: "axis", label: "Direction", options: AXES, fallback: "X" }],
  patternCircular: [{ field: "axis", label: "Axis", options: AXES, fallback: "Z" }],
};

export const FEATURE_TOGGLE_FIELDS: Partial<Record<FeatureType, ToggleField[]>> = {
  // A boolean CONSUMES its tool bodies by default: the two circles go in and one
  // shape comes out, which is what the operation means and what leaves a browser
  // tree you can read. Off by default for that reason, and on when the same body
  // is a cutter more than once — a bolt hole punched through three plates should
  // not need three copies of the bolt.
  boolean: [{ field: "keepOriginals", label: "Keep originals", fallback: false }],
  thicken: [{ field: "symmetric", label: "Symmetric", fallback: false }],
};

/** Does this field mean anything, given what the feature's other fields say?
 *
 *  Applies to every kind of row, numeric included. A knurl reads no Seed and a
 *  faceted wave has no shape parameter at all — the sidecar simply ignores what
 *  it is sent — so a row for either is a control the user can turn with nothing
 *  on the other end, which is worse than no row.
 *
 *  Fields not named here always apply, which is the honest default: a rule that
 *  hid a row it had no reason to hide would lose the user a value they could
 *  otherwise have edited. A feature type nobody has a rule for is that case, and
 *  so is one whose plugin is not installed — which is right: with nothing left
 *  to say which rows a knurl reads, showing all of them beats hiding some on a
 *  guess.
 */
export function fieldApplies(
  type: FeatureType | string,
  field: string,
  values: Record<string, unknown>,
): boolean {
  return contributedFeature(type)?.fieldApplies?.(field, values) ?? true;
}

/** The label one row carries when its name is not a constant — a slider whose
 *  meaning changes with another field, say. Null for "use the inventory's". */
export function fieldLabel(
  type: FeatureType | string,
  field: string,
  values: Record<string, unknown>,
): { text: string; title?: string } | null {
  return contributedFeature(type)?.fieldLabel?.(field, values) ?? null;
}

/** Every choice row for a feature type: the app's own, then a plugin's. */
export function choiceFieldsFor(type: FeatureType | string): readonly ChoiceField[] {
  return (
    FEATURE_CHOICE_FIELDS[type as FeatureType] ??
    contributedFeature(type)?.choiceFields ??
    []
  );
}

/** Every toggle row for a feature type: the app's own, then a plugin's. */
export function toggleFieldsFor(type: FeatureType | string): readonly ToggleField[] {
  return (
    FEATURE_TOGGLE_FIELDS[type as FeatureType] ??
    contributedFeature(type)?.toggleFields ??
    []
  );
}

/** Whether a feature type has any of these rows — the panel asks before it
 *  decides there is nothing to show. */
export function hasOptionFields(type: FeatureType | string): boolean {
  return choiceFieldsFor(type).length > 0 || toggleFieldsFor(type).length > 0;
}

/** The value a choice row should show for this feature: what it carries, or the
 *  builder's default when the field is absent. Absent is the common case — most
 *  of these are optional, and a feature saved before the field existed has none. */
export function choiceValue(feature: Feature, f: ChoiceField): string {
  const v = (feature as unknown as Record<string, unknown>)[f.field];
  if (typeof v !== "string") return f.fallback;
  return f.options.some((o) => o.value === v) ? v : f.fallback;
}

export function toggleValue(feature: Feature, f: ToggleField): boolean {
  const v = (feature as unknown as Record<string, unknown>)[f.field];
  return typeof v === "boolean" ? v : f.fallback;
}
