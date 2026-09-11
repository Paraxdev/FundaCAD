// What a texture IS, as far as anything that draws one is concerned: the seven
// patterns, the value shape, the mapping between that shape and the form fields,
// and the rules that decide which rows a given pattern even has.
//
// Pure, and imports nothing from the host. That is not an accident of what it
// happens to need, it is what lets this file's tests run in a node environment
// with no DOM and no app, which is where the interesting content is. The
// visibility rules encode real sidecar behaviour (a FACETED wave has no shape
// parameter at all) and have been wrong before, in a way that shows up as a
// slider with nothing on the other end of it rather than as an error.
//
// THESE RULES USED TO BE IN THE APPLICATION, in document/optionFields.ts, where
// `fieldApplies` opened with `if (type !== "texture") return true;`, a function
// in the document layer whose entire body was one tool's business. They are
// contributed back now, so the value rows for a committed texture ask this file
// through the contribution table and get the same answer the panel does. Two
// copies of "which kinds have an angle" is exactly how a tool panel and the rows
// that edit the same feature afterwards come to disagree about it.

import type {
  ChoiceField, Feature, FieldKind, FileField, Num, Selector, TargetField, ToggleField,
} from "fundacad";

export type TextureKind =
  | "knurl" | "hex" | "waves" | "ribs" | "voronoi" | "noise" | "image"
  | "stripes" | "grid" | "dots" | "brick" | "basket" | "carbon"
  | "isogrid" | "grip" | "leather";
export type TextureMode = "faces" | "body";
export type TextureProjection = "auto" | "triplanar" | "box";

/** The patterns, grouped so a picker of sixteen stays legible. Read by the tool
 *  panel (as option groups) and, flattened, by the value rows that edit a texture
 *  after it is committed, so it reads the same before and after. Categories are
 *  geometric / organic / functional / image. */
export const TEXTURE_KIND_GROUPS: { label: string; kinds: { value: TextureKind; label: string }[] }[] = [
  {
    label: "Geometric",
    kinds: [
      { value: "knurl", label: "Knurl" },
      { value: "hex", label: "Hex" },
      { value: "waves", label: "Waves" },
      { value: "ribs", label: "Ribs" },
      { value: "stripes", label: "Stripes" },
      { value: "grid", label: "Grid" },
      { value: "dots", label: "Dots" },
      { value: "brick", label: "Brick" },
      { value: "isogrid", label: "Isogrid" },
      { value: "basket", label: "Basket weave" },
      { value: "carbon", label: "Carbon fibre" },
    ],
  },
  {
    label: "Organic",
    kinds: [
      { value: "voronoi", label: "Voronoi" },
      { value: "noise", label: "Perlin noise" },
      { value: "leather", label: "Leather" },
    ],
  },
  { label: "Functional", kinds: [{ value: "grip", label: "Grip" }] },
  { label: "Image", kinds: [{ value: "image", label: "Heightmap" }] },
];

/** The flat pattern list, derived from the groups so the two cannot drift. */
export const TEXTURE_KINDS: { value: TextureKind; label: string }[] =
  TEXTURE_KIND_GROUPS.flatMap((g) => g.kinds);

/** Kinds with a lattice or wave orientation to rotate. The others are isotropic
 *  or seed-driven (voronoi, noise, leather) or carry their own orientation in the
 *  file (image), so an Angle on them would be a control that does nothing. */
export const ANGLE_KINDS: ReadonlySet<TextureKind> =
  new Set<TextureKind>([
    "knurl", "hex", "waves", "ribs",
    "stripes", "grid", "dots", "brick", "basket", "carbon", "isogrid", "grip",
  ]);

/** Kinds generated from a pseudo-random field, and so the only ones a Seed
 *  changes. */
export const SEED_KINDS: ReadonlySet<TextureKind> =
  new Set<TextureKind>(["voronoi", "noise", "leather"]);

/** The projection selector, and its seam controls, mean something only for a
 *  procedural pattern on a freeform face. A heightmap carries its own
 *  orientation, so it is always the odd one out (the geometry keeps it on the
 *  planar chart whatever this says), and the row is hidden rather than shown
 *  doing nothing. plane/cylinder/cone faces keep their exact chart in every
 *  mode, but the tool cannot know which faces are selected, so the control shows
 *  for every non-image kind and simply has no effect where the chart is exact. */
export const PROJECTION_KINDS: ReadonlySet<TextureKind> =
  new Set<TextureKind>(TEXTURE_KINDS.map((k) => k.value).filter((v) => v !== "image"));

/** Does this field mean anything, given what the feature's other fields say?
 *
 *  Governs the numeric rows as well as the dropdowns, which is the point of it:
 *  turn the Seed on a knurl and the model does not move, and nothing says why.
 *  The application owns the numeric inventory, a parameter can drive
 *  `texture1.seed` whether or not this is installed, and this decides which of
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
    case "projection":
      return PROJECTION_KINDS.has(kind);
    case "seamBlend":
      // triplanar's blend softness, meaningless outside triplanar (box has its
      // own band control, auto has no seam to blend). Absent projection is the
      // triplanar default.
      return PROJECTION_KINDS.has(kind) && (values["projection"] ?? "triplanar") === "triplanar";
    case "seamBand":
      return PROJECTION_KINDS.has(kind) && values["projection"] === "box";
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
/** The feature's parameter-drivable numeric rows.
 *
 *  MOVED OUT OF THE APPLICATION, and that move is the point. These seven rows
 *  were the last thing in src/document/numFields.ts that named a texture: the
 *  app knew a texture had a Depth and an Edge blend, in a table beside
 *  extrude's Distance and fillet's Radius, because the feature type was in its
 *  own union. It is not any more.
 *
 *  The kinds mean what they mean everywhere else: "length" is millimetres and
 *  converts to the display unit, "angle" is degrees, and "count" is this
 *  codebase's name for a real-valued unitless field, not an integer claim, so
 *  Sharpness (0..1) and Seed share it.
 *
 *  Which of these a given pattern actually READS is a separate question and is
 *  answered by `textureFieldApplies` below; a row that does not apply is not
 *  drawn. */
export const TEXTURE_NUM_FIELDS: readonly [string, string, FieldKind][] = [
  ["depth", "Depth", "length"],
  ["scale", "Scale", "length"],
  ["angle", "Angle", "angle"],
  ["offset", "Offset", "length"],
  ["sharpness", "Sharpness", "count"],
  ["boundaryInset", "Edge blend", "length"],
  ["grime", "Grime", "count"],
  ["smooth", "Soften", "count"],
  ["seamBlend", "Seam blend", "count"],
  ["seamBand", "Seam band", "count"],
  ["amplitude", "Amplitude", "count"],
  ["slopeMin", "Slope min", "angle"],
  ["slopeMax", "Slope max", "angle"],
  ["targetEdge", "Mesh detail", "length"],
  ["triBudget", "Max triangles", "count"],
  ["seed", "Seed", "count"],
];

/** The feature's editable geometry selection.
 *
 *  Empty is LEGAL here and means the whole body, which is a different statement
 *  from "no faces" and has to be spelled out or the row shows "0 faces" for a
 *  texture that covers everything. Moved out of
 *  src/features/selectionTargets.ts for the same reason as the rows above. */
export const TEXTURE_TARGETS: readonly TargetField[] = [
  {
    field: "faces", label: "Faces", kind: "face", shape: "selector", arity: "many",
    whenEmpty: "the whole body",
  },
];

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
  {
    field: "projection",
    label: "Projection",
    options: [
      { value: "triplanar", label: "Triplanar" },
      { value: "box", label: "Box" },
      { value: "auto", label: "Planar" },
    ],
    fallback: "triplanar",
    title: "How a curved (freeform) face lays out the pattern. Triplanar blends "
      + "three world planes so the pattern keeps one size where the face curves; "
      + "Box favours the nearest axis; Planar projects along one mean direction "
      + "and foreshortens where the face turns away. Flat, cylindrical and "
      + "conical faces use their exact chart regardless.",
  },
];

/** The switch a committed texture offers. */
export const TEXTURE_TOGGLE_FIELDS: ToggleField[] = [
  { field: "invert", label: "Invert heights", fallback: false },
];

/** The heightmap, in the value rows as well as in the panel.
 *
 *  `textureFieldApplies` already answered "does imagePath mean anything here",
 *  and the answer was read by nothing: there was no kind of row that could show
 *  a path, so choosing Heightmap in Properties changed the pattern to the one
 *  that reads an image and then offered no way to name one. Same field, same
 *  filters and same dialog as the Browse button in the panel, so a texture reads
 *  the same before and after it is committed. */
export const TEXTURE_FILE_FIELDS: FileField[] = [
  {
    field: "imagePath",
    label: "Heightmap",
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "bmp"] }],
    title: "The image whose brightness becomes height. Light is high.",
  },
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
  grime: number; // 0 = none; a noise bleed onto the neighbouring faces
  smooth: number; // 0 = crisp; a low-pass blur of the height field before it displaces
  projection: TextureProjection; // how a freeform face charts the pattern
  seamBlend: number; // triplanar blend softness (0..1)
  seamBand: number; // box axis-transition band (0..1)
  amplitude: number; // master depth trim (0..1; 1 = full depth)
  slopeMin: number; // keep texture only where the normal's angle from +Z is >= this (deg)
  slopeMax: number; // ... and <= this (deg); 0..180 masks nothing
  targetEdge: number; // sampling mesh target edge length in mm (0 = automatic)
  triBudget: number; // hard per-face triangle budget (0 = off)
  direction: "out" | "in" | "both";
  seed: number;
  invert: boolean;
  imagePath?: string;
  colorSlot?: number; // palette slot for a two-tone inlay; undefined = body color
}

/** A `texture` feature as it sits in the document.
 *
 *  THE SCHEMA LIVES HERE, and that is what owning a feature type means. It used
 *  to be thirty-five lines of the application's own `Feature` union in
 *  src/types.ts, which is why the app could describe, label and validate a
 *  texture whether or not this plugin existed. The app now carries the feature
 *  as a `PluginFeature`, two known keys and an index signature, and this is the
 *  only description of what is actually in it.
 *
 *  Every field except `kind` is optional, mirroring what the geometry accepts:
 *  register.py's validator supplies the same defaults, and a document written by
 *  an older version of this plugin is missing whichever ones it predates.
 *
 *  `Num` rather than `number` for the parameter-drivable ones: a field may hold
 *  a parameter NAME instead of a value, and the tool refuses to edit one that
 *  does (see startEdit) rather than overwriting the equation with a literal. */
export interface TextureFeature {
  id: string;
  type: "texture";
  kind: TextureKind;
  faces?: Selector | Selector[];
  body?: string;
  depth?: Num;
  scale?: Num;
  angle?: Num;
  offset?: Num;
  sharpness?: Num;
  profile?: "facet" | "round";
  boundaryInset?: Num;
  grime?: Num;
  smooth?: Num;
  projection?: TextureProjection;
  seamBlend?: Num;
  seamBand?: Num;
  amplitude?: Num;
  slopeMin?: Num;
  slopeMax?: Num;
  targetEdge?: Num;
  triBudget?: Num;
  direction?: "out" | "in" | "both";
  seed?: Num;
  invert?: boolean;
  imagePath?: string;
  colorSlot?: Num;
}

/** Read a document feature as a texture, or null.
 *
 *  The cast is the honest shape of the boundary: the app hands out a
 *  `PluginFeature` because it genuinely does not know what the fields are, and
 *  this plugin does. Checking `type` is the whole of the check that can be made
 *  here; the geometry validates the values properly, on every build, and turns
 *  the timeline row red when they are wrong. */
export function asTexture(f: Feature | null | undefined): TextureFeature | null {
  return f && f.type === "texture" ? (f as unknown as TextureFeature) : null;
}

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
  grime: string;
  smooth: string;
  projection: TextureProjection;
  seamBlend: string;
  seamBand: string;
  amplitude: string;
  slopeMin: string;
  slopeMax: string;
  targetEdge: string;
  triBudget: string;
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
    grime: String(initial.grime ?? 0),
    smooth: String(initial.smooth ?? 0),
    // Triplanar is the default for a freeform face: it keeps the pattern one size
    // where a single planar projection would foreshorten it.
    projection: initial.projection ?? "triplanar",
    seamBlend: String(initial.seamBlend ?? 0.5),
    seamBand: String(initial.seamBand ?? 0.5),
    amplitude: String(initial.amplitude ?? 1),
    slopeMin: String(initial.slopeMin ?? 0),
    slopeMax: String(initial.slopeMax ?? 180),
    targetEdge: String(initial.targetEdge ?? 0),
    triBudget: String(initial.triBudget ?? 0),
  };
}

/** Parse a numeric field, clamp to [lo, hi], and fall back to `def` when it is
 *  blank or unparseable. Unlike `parseFloat(x) || def`, a real 0 survives. */
function clampOr(s: string, def: number, lo: number, hi: number): number {
  const n = parseFloat(s);
  return Number.isNaN(n) ? def : Math.max(lo, Math.min(hi, n));
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
    grime: Math.max(0, parseFloat(f.grime) || 0),
    smooth: Math.max(0, Math.min(1, parseFloat(f.smooth) || 0)),
    projection: f.projection,
    seamBlend: Math.max(0, Math.min(1, parseFloat(f.seamBlend) || 0)),
    seamBand: Math.max(0, Math.min(1, parseFloat(f.seamBand) || 0)),
    // clamp with a NaN-safe fallback, not `|| default`, so a legitimate 0
    // amplitude is not read back as full depth
    amplitude: clampOr(f.amplitude, 1, 0, 1),
    slopeMin: clampOr(f.slopeMin, 0, 0, 180),
    slopeMax: clampOr(f.slopeMax, 180, 0, 180),
    targetEdge: Math.max(0, parseFloat(f.targetEdge) || 0),
    triBudget: Math.max(0, Math.round(parseFloat(f.triBudget) || 0)),
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
export function textureRows(
  f: Pick<TextureForm, "kind" | "profile"> & { projection?: TextureProjection },
) {
  const applies = (field: string) => textureFieldApplies(field, f);
  return {
    angle: applies("angle"),
    seed: applies("seed"),
    image: applies("imagePath"),
    sharpness: applies("sharpness"),
    projection: applies("projection"),
    seamBlend: applies("seamBlend"),
    seamBand: applies("seamBand"),
  };
}
