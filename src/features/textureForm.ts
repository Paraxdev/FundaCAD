// The printed-Texture tool's panel, minus the panel: the value shape, the
// mapping between it and the form fields, and the conditional-visibility rules
// that decide which rows a given kind/profile combination even has.
//
// Split out of texturePanel.ts when that became a facade over
// components/overlays/TextureToolPanel.vue. The visibility rules are the part
// worth testing: they encode sidecar behaviour (a FACETED wave has no shape
// parameter at all) and one fixed bug (Direction applies to every kind, not
// just the lattice ones).

import {
  ANGLE_KINDS, SEED_KINDS, TEXTURE_KINDS, fieldApplies, sharpnessLabel,
} from "../document/optionFields";

// Re-exported rather than redefined: these are facts about the texture FEATURE,
// so they live with the rest of the feature's field inventory and are shared
// with the value rows that edit one after it is committed. Two copies of "which
// kinds have an angle" is exactly how the tool panel and the value rows would
// come to disagree about the same texture.
export { ANGLE_KINDS, SEED_KINDS, sharpnessLabel };

export type TextureKind = "knurl" | "hex" | "waves" | "ribs" | "voronoi" | "noise" | "image";
export type TextureMode = "faces" | "body";

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
  TEXTURE_KINDS.map((o) => [o.value as TextureKind, o.label]);

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
 *  part — changing its dimensions instead of texturing the surface it sits on. */
export function textureRows(f: Pick<TextureForm, "kind" | "profile">) {
  const applies = (field: string) => fieldApplies("texture", field, f);
  return {
    angle: applies("angle"),
    seed: applies("seed"),
    image: applies("imagePath"),
    sharpness: applies("sharpness"),
  };
}
