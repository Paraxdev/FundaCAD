// The feature fields that are NOT numbers: the fixed choices and the switches.
//
// FEATURE_NUM_FIELDS has always been the inventory of what a feature's value
// rows can edit, and everything in it is a number. So the editor could only ever
// be a column of text boxes, and every fact about a feature that is a CHOICE —
// which boolean an extrude performs, which axis a revolve turns about, which
// pattern a texture lays down, which way it is pushed — was editable at the
// moment the feature was made and never again. A texture created as a knurl was
// a knurl for the rest of the document's life; the tool panel that offered the
// seven kinds was gone, and the properties rows showed Seed and Angle whether
// the chosen kind used them or not.
//
// Two more inventories, read the same way as the numeric one:
//
//   FEATURE_CHOICE_FIELDS   one of a fixed set   -> a dropdown
//   FEATURE_TOGGLE_FIELDS   on or off           -> a switch
//
// And one rule, `fieldApplies`, that says whether a field means anything given
// what the feature's OTHER fields currently say. That rule governs the numeric
// rows too, which is what stops a knurl offering a Seed it will never read.
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

import { BOOLEAN_COMMANDS } from "../features/booleanOps";
import type { Feature, FeatureType } from "../types";

/** The seven texture patterns, read off the feature union rather than spelled
 *  again — a kind added to the document type and not to the lists below is then
 *  a compile error rather than a pattern nobody can choose. */
export type TextureKind = Extract<Feature, { type: "texture" }>["kind"];

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

/** Texture patterns. Same list and the same wording the tool panel offers, so a
 *  texture reads the same before and after it is committed. */
export const TEXTURE_KINDS: { value: TextureKind; label: string }[] = [
  { value: "knurl", label: "Knurl" },
  { value: "hex", label: "Hex" },
  { value: "waves", label: "Waves" },
  { value: "ribs", label: "Ribs" },
  { value: "voronoi", label: "Voronoi" },
  { value: "noise", label: "Perlin noise" },
  { value: "image", label: "Heightmap" },
];

/** Texture kinds that have a lattice or wave orientation to rotate. The others
 *  are isotropic (voronoi, noise) or carry their own orientation in the file
 *  (image), so an Angle on them would be a control that does nothing. */
export const ANGLE_KINDS: ReadonlySet<TextureKind> =
  new Set<TextureKind>(["knurl", "hex", "waves", "ribs"]);

/** Texture kinds generated from a pseudo-random field, and so the only ones a
 *  Seed changes. */
export const SEED_KINDS: ReadonlySet<TextureKind> =
  new Set<TextureKind>(["voronoi", "noise"]);

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
  patternCircular: [{ field: "axis", label: "Axis", options: AXES, fallback: "Z" }],
  texture: [
    {
      field: "kind",
      label: "Pattern",
      options: TEXTURE_KINDS,
      fallback: "knurl",
      title: "Which pattern is cut into the surface. Heightmap reads an image file.",
    },
    {
      field: "profile",
      label: "Surface",
      options: [
        { value: "facet", label: "Faceted" },
        { value: "round", label: "Smooth" },
      ],
      fallback: "facet",
      title: "Faceted gives planar facets and real creases, which is what survives "
        + "a print — a printer rounds a sub-millimetre sinusoid into mush. Smooth "
        + "keeps the continuous field.",
    },
    {
      field: "direction",
      label: "Direction",
      options: [
        { value: "out", label: "Emboss" },
        { value: "in", label: "Deboss" },
        { value: "both", label: "Symmetric" },
      ],
      fallback: "out",
      title: "Whether the pattern stands out of the surface, is cut into it, or is "
        + "centred on it.",
    },
  ],
};

export const FEATURE_TOGGLE_FIELDS: Partial<Record<FeatureType, ToggleField[]>> = {
  // A boolean CONSUMES its tool bodies by default: the two circles go in and one
  // shape comes out, which is what the operation means and what leaves a browser
  // tree you can read. Off by default for that reason, and on when the same body
  // is a cutter more than once — a bolt hole punched through three plates should
  // not need three copies of the bolt.
  boolean: [{ field: "keepOriginals", label: "Keep originals", fallback: false }],
  thicken: [{ field: "symmetric", label: "Symmetric", fallback: false }],
  texture: [{ field: "invert", label: "Invert heights", fallback: false }],
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
 *  otherwise have edited.
 */
export function fieldApplies(
  type: FeatureType,
  field: string,
  values: Record<string, unknown>,
): boolean {
  if (type !== "texture") return true;
  const kind = (values["kind"] ?? "knurl") as TextureKind;
  switch (field) {
    case "angle":
      return ANGLE_KINDS.has(kind);
    case "seed":
      return SEED_KINDS.has(kind);
    case "invert":
    case "imagePath":
      return kind === "image";
    case "sharpness":
      // The same slider means different things per surface, and for one pairing
      // it means nothing: a FACETED wave is a fixed eight-join polyline with no
      // shape parameter (the sidecar's `_wave_levels` says why). Under `round`
      // waves is a real sine and the crispness still bites.
      return ANGLE_KINDS.has(kind) && !(values["profile"] === "facet" && kind === "waves");
    default:
      return true;
  }
}

/** The label a texture's shape slider carries, which depends on what it is
 *  currently doing. */
export function sharpnessLabel(profile: unknown): { text: string; title: string } {
  return profile === "round"
    ? { text: "Sharp", title: "Crispness of the smooth profile" }
    : { text: "Land", title: "Flat land on the crests: 0 = pure V-groove peaks, 1 = wide flat tops" };
}

/** Whether a feature type has any of these rows — the panel asks before it
 *  decides there is nothing to show. */
export function hasOptionFields(type: FeatureType): boolean {
  return type in FEATURE_CHOICE_FIELDS || type in FEATURE_TOGGLE_FIELDS;
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
