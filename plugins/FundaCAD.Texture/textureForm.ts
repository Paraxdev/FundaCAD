// What a texture IS, as far as anything that draws one is concerned: the seven
// patterns, the value shape, the mapping between that shape and the form fields,
// and the rules that decide which rows a given pattern even has.
//
// Pure, and imports nothing from the host. That is not an accident of what it
// happens to need — it is what lets this file's tests run in a node environment
// with no DOM and no app, which is where the interesting content is. The
// visibility rules encode real sidecar behaviour (a FACETED wave has no shape
// parameter at all) and have been wrong before, in a way that shows up as a
// slider with nothing on the other end of it rather than as an error.
//
// THESE RULES USED TO BE IN THE APPLICATION, in document/optionFields.ts, where
// `fieldApplies` opened with `if (type !== "texture") return true;` — a function
// in the document layer whose entire body was one tool's business. They are
// contributed back now, so the value rows for a committed texture ask this file
// through the contribution table and get the same answer the panel does. Two
// copies of "which kinds have an angle" is exactly how a tool panel and the rows
// that edit the same feature afterwards come to disagree about it.

import type { ChoiceField, ToggleField } from "fundacad";

export type TextureKind = "knurl" | "hex" | "waves" | "ribs" | "voronoi" | "noise" | "image";
export type TextureMode = "faces" | "body";

/** The patterns. One list, read by the tool panel and by the value rows that
 *  edit a texture after it is committed, so it reads the same before and after. */
export const TEXTURE_KINDS: { value: TextureKind; label: string }[] = [
  { value: "knurl", label: "Knurl" },
  { value: "hex", label: "Hex" },
  { value: "waves", label: "Waves" },
  { value: "ribs", label: "Ribs" },
  { value: "voronoi", label: "Voronoi" },
  { value: "noise", label: "Perlin noise" },
  { value: "image", label: "Heightmap" },
];

/** Kinds with a lattice or wave orientation to rotate. The others are isotropic
 *  (voronoi, noise) or carry their own orientation in the file (image), so an
 *  Angle on them would be a control that does nothing. */
export const ANGLE_KINDS: ReadonlySet<TextureKind> =
  new Set<TextureKind>(["knurl", "hex", "waves", "ribs"]);

/** Kinds generated from a pseudo-random field, and so the only ones a Seed
 *  changes. */
export const SEED_KINDS: ReadonlySet<TextureKind> =
  new Set<TextureKind>(["voronoi", "noise"]);

/** Does this field mean anything, given what the feature's other fields say?
 *
 *  Governs the numeric rows as well as the dropdowns, which is the point of it:
 *  turn the Seed on a knurl and the model does not move, and nothing says why.
 *  The application owns the numeric inventory — a parameter can drive
 *  `texture1.seed` whether or not this is installed — and this decides which of
 *  those rows are worth showing. */
export function textureFieldApplies(field: string, values: Record<string, unknown>): boolean {
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

/** The label the shape slider carries, which depends on what it is currently
 *  doing. Contributed as this feature's `fieldLabel`, so the value rows and the
 *  panel call the same control the same thing. */
export function sharpnessLabel(profile: unknown): { text: string; title: string } {
  return profile === "round"
    ? { text: "Sharp", title: "Crispness of the smooth profile" }
    : { text: "Land", title: "Flat land on the crests: 0 = pure V-groove peaks, 1 = wide flat tops" };
}

/** The dropdowns a committed texture offers in the value rows. */
export const TEXTURE_CHOICE_FIELDS: ChoiceField[] = [
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
      + "a print, a printer rounds a sub-millimetre sinusoid into mush. Smooth "
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
];

/** The switch a committed texture offers. */
export const TEXTURE_TOGGLE_FIELDS: ToggleField[] = [
  { field: "invert", label: "Invert heights", fallback: false },
];

export interface TextureValues {
  kind: TextureKind;
  depth: number;
  scale: number;
  angle: number;
  offset: number;
  sharpness: number;
  profile: "facet" | "round";
  boundaryInset: number;
  direction: "out" | "in" | "both";
  seed: number;
  invert: boolean;
  imagePath?: string;
  colorSlot?: number; // palette slot for a two-tone inlay; undefined = body color
}

export const KIND_OPTIONS: [TextureKind, string][] =
  TEXTURE_KINDS.map((o) => [o.value, o.label]);

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Live form state. Strings for every numeric field, because that is what the
 *  <input>s hold and a half-typed "0." is legitimate. */
export interface TextureForm {
  kind: TextureKind;
  profile: TextureValues["profile"];
  depth: string;
  scale: string;
  angle: string;
  sharpness: string;
  direction: TextureValues["direction"];
  seed: string;
  invert: boolean;
  imagePath: string; // "" = no file chosen
  colorSlot: string; // "" = the body colour
  offset: string;
  edgeBlend: string;
}

export function initialTextureForm(initial: Partial<TextureValues>): TextureForm {
  return {
    kind: initial.kind ?? "knurl",
    // Hard surface is the default: planar facets and real creases are what a
    // printer can actually reproduce. "Smooth" restores the original fields.
    profile: initial.profile ?? "facet",
    depth: String(initial.depth ?? 0.4),
    scale: String(initial.scale ?? 2),
    angle: String(initial.angle ?? 0),
    sharpness: String(initial.sharpness ?? 0.5),
    direction: initial.direction ?? "out",
    seed: String(initial.seed ?? 1),
    invert: initial.invert ?? false,
    imagePath: initial.imagePath ?? "",
    colorSlot: initial.colorSlot != null ? String(initial.colorSlot) : "",
    offset: String(initial.offset ?? 0),
    edgeBlend: String(initial.boundaryInset ?? 0),
  };
}

export function toTextureValues(f: TextureForm): TextureValues {
  return {
    kind: f.kind,
    depth: parseFloat(f.depth) || 0.4,
    scale: parseFloat(f.scale) || 2,
    angle: parseFloat(f.angle) || 0,
    offset: parseFloat(f.offset) || 0,
    sharpness: parseFloat(f.sharpness) || 0,
    profile: f.profile,
    boundaryInset: Math.max(0, parseFloat(f.edgeBlend) || 0),
    direction: f.direction,
    seed: parseFloat(f.seed) || 1,
    invert: f.invert,
    ...(f.imagePath ? { imagePath: f.imagePath } : {}),
    ...(f.colorSlot !== "" ? { colorSlot: Number(f.colorSlot) } : {}),
  };
}

/** Which optional rows a given form shows.
 *
 *  `direction` is deliberately absent: the sidecar applies it to the height
 *  field itself (out = h, in = h-1, both = centred), so EVERY kind honours it.
 *  Gating it behind ANGLE_KINDS left noise/voronoi/image able only to GROW the
 *  part, changing its dimensions instead of texturing the surface it sits on. */
export function textureRows(f: Pick<TextureForm, "kind" | "profile">) {
  const applies = (field: string) => textureFieldApplies(field, f);
  return {
    angle: applies("angle"),
    seed: applies("seed"),
    image: applies("imagePath"),
    sharpness: applies("sharpness"),
  };
}
