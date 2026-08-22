// Display metadata for feature types (icon name + label), shared by the timeline,
// browser tree, and toolbar.
//
// `icon` is a name in the icon registry (ui/icons.ts), not a character. It used
// to be a Unicode glyph, which cost nothing to write and everything to look at:
// the marks came from four different Unicode blocks, so they rendered at four
// different weights and baselines out of whatever fallback font the platform
// happened to reach for, and a few (Clean Up, Remove Body) were emoji that the
// OS drew in full colour in the middle of a monochrome timeline. A name into a
// hand-drawn 24×24 set is the same amount of typing and renders identically on
// every machine.
import { BOOLEAN_COMMANDS } from "../features/booleanOps";
import type { Feature, FeatureType } from "../types";

export interface FeatureMeta {
  icon: string;
  label: string;
}

export const FEATURE_META: Record<FeatureType, FeatureMeta> = {
  sketch: { icon: "sketch", label: "Sketch" },
  extrude: { icon: "extrude", label: "Extrude" },
  fillet: { icon: "fillet", label: "Fillet" },
  chamfer: { icon: "chamfer", label: "Chamfer" },
  "press-pull": { icon: "presspull", label: "Press/Pull" },
  deleteFace: { icon: "deleteFace", label: "Delete Face" },
  mirror: { icon: "mirror", label: "Mirror" },
  revolve: { icon: "revolve", label: "Revolve" },
  loft: { icon: "loft", label: "Loft" },
  sweep: { icon: "sweep", label: "Sweep" },
  datumPlane: { icon: "datumPlane", label: "Datum Plane" },
  import: { icon: "import", label: "Import" },
  split: { icon: "split", label: "Split Body" },
  // The type-level entry for the booleans, and the one nothing should reach in
  // practice: `featureMeta` below reads the operation and names the actual
  // command. It stays because this table is a Record over the whole union and a
  // hole in it is a crash on a document from a newer build.
  boolean: { icon: "booleanUnion", label: "Boolean" },
  box: { icon: "box", label: "Box" },
  cylinder: { icon: "cylinder", label: "Cylinder" },
  sphere: { icon: "sphere", label: "Sphere" },
  shell: { icon: "shell", label: "Shell" },
  offsetFace: { icon: "offsetFace", label: "Offset Face" },
  thicken: { icon: "thicken", label: "Thicken" },
  draft: { icon: "draft", label: "Draft" },
  patternRect: { icon: "patternRect", label: "Rect Pattern" },
  patternLinear: { icon: "patternLinear", label: "Linear Pattern" },
  patternCircular: { icon: "patternCircular", label: "Circular Pattern" },
  simplifyMesh: { icon: "simplifyMesh", label: "Simplify Mesh" },
  cleanUp: { icon: "cleanUp", label: "Clean Up" },
  scale: { icon: "scale", label: "Scale" },
  move: { icon: "move", label: "Move" },
  removeBody: { icon: "removeBody", label: "Remove Body" },
  texture: { icon: "texture", label: "Texture" },
};

/** The mark and the word for ONE feature, which is not always a fact about its
 *  type alone.
 *
 *  A boolean is three commands sharing a feature type, so a history that named
 *  them all "Boolean" would be a column of identical chips over three different
 *  operations — you could not tell a part being cut from a part being joined
 *  without opening each one. Everything else answers from its type.
 *
 *  Tolerant of a feature this build has never heard of, for the same reason the
 *  table is a total Record: a document from a newer version must render as
 *  something rather than throw mid-draw and make File→Open look like a no-op. */
export function featureMeta(f: { type: string; operation?: unknown }): FeatureMeta {
  if (f.type === "boolean") {
    const cmd = BOOLEAN_COMMANDS.find((c) => c.op === f.operation);
    if (cmd) return { icon: cmd.iconName, label: cmd.label };
  }
  return FEATURE_META[f.type as FeatureType] ?? { icon: "dot", label: f.type };
}

/** The same answer for a whole feature, when the caller has one. */
export function labelOf(f: Feature): string {
  return featureMeta(f as { type: string; operation?: unknown }).label;
}
