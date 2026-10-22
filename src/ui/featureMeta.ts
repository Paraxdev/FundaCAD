// Icon name and label per feature type, for the timeline, browser tree and toolbar. `icon` names a glyph in
// ui/icons.ts, not a Unicode character: those rendered at mixed weights, some as colour emoji.
import { BOOLEAN_COMMANDS } from "../features/booleanOps";
import { contributedFeature } from "../plugins/contrib";
import type { Feature, FeatureType } from "../types";

export interface FeatureMeta {
  icon: string;
  label: string;
}

/** Partial: the union is every type a file may hold, wider than what this build draws now that tools can be plugins.
 *  tests/ui/featureMeta.test.ts still checks every type gets a mark from here or a plugin in this repository. */
export const FEATURE_META: Partial<Record<FeatureType, FeatureMeta>> = {
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
  datumPoint: { icon: "datumPoint", label: "Datum Point" },
  datumAxis: { icon: "datumAxis", label: "Datum Axis" },
  import: { icon: "import", label: "Import" },
  split: { icon: "split", label: "Split Body" },
  separate: { icon: "split", label: "Separate" },
  imprint: { icon: "imprint", label: "Divide Face" },
  // featureMeta names the actual boolean command, so this entry is only the type's fallback.
  boolean: { icon: "booleanUnion", label: "Boolean" },
  box: { icon: "box", label: "Box" },
  cylinder: { icon: "cylinder", label: "Cylinder" },
  cone: { icon: "cone", label: "Cone" },
  sphere: { icon: "sphere", label: "Sphere" },
  torus: { icon: "torus", label: "Torus" },
  shell: { icon: "shell", label: "Shell" },
  offsetFace: { icon: "offsetFace", label: "Offset Face" },
  thicken: { icon: "thicken", label: "Thicken" },
  draft: { icon: "draft", label: "Draft" },
  hole: { icon: "hole", label: "Hole" },
  thread: { icon: "thread", label: "Thread" },
  textOnFace: { icon: "text", label: "Text on Face" },
  patternRect: { icon: "patternRect", label: "Rect Pattern" },
  patternLinear: { icon: "patternLinear", label: "Linear Pattern" },
  patternCircular: { icon: "patternCircular", label: "Circular Pattern" },
  simplifyMesh: { icon: "simplifyMesh", label: "Simplify Mesh" },
  cleanUp: { icon: "cleanUp", label: "Clean Up" },
  scale: { icon: "scale", label: "Scale" },
  move: { icon: "move", label: "Move" },
  duplicate: { icon: "copy", label: "Duplicate" },
  joint: { icon: "assembly", label: "Joint" },
  mechanism: { icon: "mechanism", label: "Mechanism" },
  removeBody: { icon: "removeBody", label: "Remove Body" },
};

/** A boolean is three commands sharing one type, so it is named by its operation. An unknown type renders as a grey
 *  dot rather than throw. Plugins are asked after the table, so they cannot rename the app's own features. */
export function featureMeta(f: { type: string; operation?: unknown; thin?: unknown }): FeatureMeta {
  if (f.type === "boolean") {
    const cmd = BOOLEAN_COMMANDS.find((c) => c.op === f.operation);
    if (cmd) return { icon: cmd.iconName, label: cmd.label };
  }
  if (f.type === "extrude" && f.thin === true) return { icon: "extrude", label: "Thin extrude" };
  return FEATURE_META[f.type as FeatureType] ?? contributedFeature(f.type)?.meta ?? { icon: "dot", label: f.type };
}

type Nameable = {
  type: string;
  name?: string;
  source?: string;
  nodes?: readonly { name: string; parent: number | null }[];
  operation?: unknown;
  thin?: unknown;
};

/** The one root of an import's assembly tree, the folder name Items shows. */
export function assemblyName(f: Nameable): string | null {
  const roots = f.type === "import" ? (f.nodes ?? []).filter((n) => n.parent === null) : [];
  return roots.length === 1 ? roots[0]!.name || null : null;
}

/** The name History and Items agree on. An import takes its assembly name, but only while its
 *  name is still the file's: `source` is a path, and the engine names an import after the file
 *  stem (or the stem of a .gz one), so a name that is not that was typed. */
export function stepName(f: Nameable): string {
  const own = f.name?.trim() ?? "";
  const asm = assemblyName(f);
  if (asm && own && f.source) {
    const file = (f.source.split(/[\x5c/]/).pop() ?? "").toLowerCase();
    if (file.startsWith(`${own.toLowerCase()}.`)) return asm;
  }
  return own || featureMeta(f).label;
}

/** The same answer for a whole feature, when the caller has one. */
export function labelOf(f: Feature): string {
  return featureMeta(f as { type: string; operation?: unknown; thin?: unknown }).label;
}
