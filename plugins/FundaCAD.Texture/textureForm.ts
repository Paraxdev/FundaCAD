// Pure and host free, so its tests run in node with no DOM. The visibility rules encode real engine behaviour (a faceted
// wave has no shape parameter) and are contributed to the value rows, so the panel and the rows agree.

import type { ChoiceField, Feature, FieldKind, FileField, Num, Selector, TargetField, ToggleField } from "fundacad";
import { fieldError, fieldNumber } from "fundacad";

export type TextureKind =
  | "knurl"
  | "hex"
  | "waves"
  | "ribs"
  | "voronoi"
  | "noise"
  | "image"
  | "stripes"
  | "grid"
  | "dots"
  | "brick"
  | "basket"
  | "carbon"
  | "isogrid"
  | "grip"
  | "leather";
export type TextureMode = "faces" | "body";
export type TextureProjection = "auto" | "triplanar" | "box";

/** Grouped so a picker of sixteen stays legible, and flattened for the value rows so a texture reads the same before
 *  and after it is committed. */
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
export const TEXTURE_KINDS: { value: TextureKind; label: string }[] = TEXTURE_KIND_GROUPS.flatMap((g) => g.kinds);

/** Kinds with an orientation to rotate. Voronoi, noise and leather are isotropic or seeded and an image carries its own,
 *  so an Angle there would do nothing. */
export const ANGLE_KINDS: ReadonlySet<TextureKind> = new Set<TextureKind>([
  "knurl",
  "hex",
  "waves",
  "ribs",
  "stripes",
  "grid",
  "dots",
  "brick",
  "basket",
  "carbon",
  "isogrid",
  "grip",
]);

/** Kinds from a pseudo-random field, the only ones a Seed changes. */
export const SEED_KINDS: ReadonlySet<TextureKind> = new Set<TextureKind>(["voronoi", "noise", "leather"]);

/** Only a procedural pattern on a freeform face uses the projection, the geometry keeps a heightmap on the planar chart.
 *  The tool cannot know which faces are selected, so the row shows for every non-image kind. */
export const PROJECTION_KINDS: ReadonlySet<TextureKind> = new Set<TextureKind>(
  TEXTURE_KINDS.map((k) => k.value).filter((v) => v !== "image"),
);

/** Governs the numeric rows too: turn the Seed on a knurl and nothing moves, with nothing saying why. A parameter can
 *  drive any field whether or not this is installed, this only decides which rows are shown. */
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
      // Triplanar blend softness only, box has its own band control and auto has no seam. No projection means triplanar.
      return PROJECTION_KINDS.has(kind) && (values["projection"] ?? "triplanar") === "triplanar";
    case "seamBand":
      return PROJECTION_KINDS.has(kind) && values["projection"] === "box";
    case "sharpness":
      // A faceted wave is a fixed eight-join polyline with no shape parameter (the engine's `_wave_levels`), a round
      // wave is a real sine where the crispness still bites.
      return ANGLE_KINDS.has(kind) && !(values["profile"] === "facet" && kind === "waves");
    default:
      return true;
  }
}

/** Contributed as `fieldLabel`, so the value rows and the panel name the shape slider the same. */
export function sharpnessLabel(profile: unknown): { text: string; title: string } {
  return profile === "round"
    ? { text: "Sharp", title: "Crispness of the smooth profile" }
    : { text: "Land", title: "Flat land on the crests: 0 = pure V-groove peaks, 1 = wide flat tops" };
}

/** "length" is millimetres shown in the display unit, "angle" is degrees, "count" is any real unitless value (Sharpness
 *  0..1, Seed). textureFieldApplies decides which rows a pattern reads. */
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

/** Empty is legal and means the whole body, spelled out so the row does not show "0 faces". */
export const TEXTURE_TARGETS: readonly TargetField[] = [
  {
    field: "faces",
    label: "Faces",
    kind: "face",
    shape: "selector",
    arity: "many",
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
    title:
      "Faceted gives planar facets and real creases, which is what survives " +
      "a print, a printer rounds a sub-millimetre sinusoid into mush. Smooth " +
      "keeps the continuous field.",
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
    title: "Whether the pattern stands out of the surface, is cut into it, or is " + "centred on it.",
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
    title:
      "How a curved (freeform) face lays out the pattern. Triplanar blends " +
      "three world planes so the pattern keeps one size where the face curves; " +
      "Box favours the nearest axis; Planar projects along one mean direction " +
      "and foreshortens where the face turns away. Flat, cylindrical and " +
      "conical faces use their exact chart regardless.",
  },
];

export const TEXTURE_TOGGLE_FIELDS: ToggleField[] = [{ field: "invert", label: "Invert heights", fallback: false }];

/** The heightmap path in the value rows, with the same filters and dialog as the panel's Browse button. */
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

/** The only description of a `texture` feature, which the app carries as a `PluginFeature`. Every field but `kind` is
 *  optional and register.py supplies the same defaults. A `Num` field may hold a parameter name, which the tool refuses
 *  to overwrite with a literal (see startEdit). */
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

/** Checking `type` is all that can be done here, the geometry validates the values on every build. */
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
 *  blank or unparseable. Unlike `fieldNumber(x) || def`, a real 0 survives. */
function clampOr(s: string, def: number, lo: number, hi: number): number {
  const n = fieldNumber(s);
  return Number.isNaN(n) ? def : Math.max(lo, Math.min(hi, n));
}

const NUMBER_FIELDS = [
  "depth",
  "scale",
  "angle",
  "sharpness",
  "seed",
  "offset",
  "edgeBlend",
  "grime",
  "smooth",
  "seamBlend",
  "seamBand",
  "amplitude",
  "slopeMin",
  "slopeMax",
  "targetEdge",
  "triBudget",
] as const satisfies readonly (keyof TextureForm)[];

/** The message for each number box whose text the shared parser rejects. */
export function textureFormErrors(f: TextureForm): Partial<Record<(typeof NUMBER_FIELDS)[number], string>> {
  const out: Partial<Record<(typeof NUMBER_FIELDS)[number], string>> = {};
  for (const k of NUMBER_FIELDS) {
    const e = fieldError(f[k]);
    if (e) out[k] = e;
  }
  return out;
}

export function toTextureValues(f: TextureForm): TextureValues {
  return {
    kind: f.kind,
    depth: fieldNumber(f.depth) || 0.4,
    scale: fieldNumber(f.scale) || 2,
    angle: fieldNumber(f.angle) || 0,
    offset: fieldNumber(f.offset) || 0,
    sharpness: fieldNumber(f.sharpness) || 0,
    profile: f.profile,
    boundaryInset: Math.max(0, fieldNumber(f.edgeBlend) || 0),
    grime: Math.max(0, fieldNumber(f.grime) || 0),
    smooth: Math.max(0, Math.min(1, fieldNumber(f.smooth) || 0)),
    projection: f.projection,
    seamBlend: Math.max(0, Math.min(1, fieldNumber(f.seamBlend) || 0)),
    seamBand: Math.max(0, Math.min(1, fieldNumber(f.seamBand) || 0)),
    // clamp with a NaN-safe fallback, not `|| default`, so a legitimate 0
    // amplitude is not read back as full depth
    amplitude: clampOr(f.amplitude, 1, 0, 1),
    slopeMin: clampOr(f.slopeMin, 0, 0, 180),
    slopeMax: clampOr(f.slopeMax, 180, 0, 180),
    targetEdge: Math.max(0, fieldNumber(f.targetEdge) || 0),
    triBudget: Math.max(0, Math.round(fieldNumber(f.triBudget) || 0)),
    direction: f.direction,
    seed: fieldNumber(f.seed) || 1,
    invert: f.invert,
    ...(f.imagePath ? { imagePath: f.imagePath } : {}),
    ...(f.colorSlot !== "" ? { colorSlot: Number(f.colorSlot) } : {}),
  };
}

/** Which optional rows a given form shows.
 *
 *  `direction` is deliberately absent: the engine applies it to the height
 *  field itself (out = h, in = h-1, both = centred), so EVERY kind honours it.
 *  Gating it behind ANGLE_KINDS left noise/voronoi/image able only to GROW the
 *  part, changing its dimensions instead of texturing the surface it sits on. */
export function textureRows(f: Pick<TextureForm, "kind" | "profile"> & { projection?: TextureProjection }) {
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
