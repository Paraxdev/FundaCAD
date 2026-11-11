// Icon name and label per feature type, for the timeline, browser tree and toolbar. `icon` names a glyph in
// ui/icons.ts, not a Unicode character: those rendered at mixed weights, some as colour emoji.
import { BOOLEAN_COMMANDS, type BooleanOp } from "../features/booleanOps";
import { t, tEnglish, type MessageKey } from "../i18n";
import { contributedFeature } from "../plugins/contrib";
import type { Feature, FeatureType } from "../types";

export interface FeatureMeta {
  icon: string;
  label: string;
  /** A plugin's English name, for a label that follows the language. */
  refName?: string;
}

const META_KEYS = new WeakMap<FeatureMeta, MessageKey>();

// The label is a getter so it follows a change of language; the key stays for the English name.
function meta(icon: string, key: MessageKey): FeatureMeta {
  const m: FeatureMeta = {
    icon,
    get label() {
      return t(key);
    },
  };
  META_KEYS.set(m, key);
  return m;
}

/** Partial: the union is every type a file may hold, wider than what this build draws now that tools can be plugins.
 *  tests/ui/featureMeta.test.ts still checks every type gets a mark from here or a plugin in this repository. */
export const FEATURE_META: Partial<Record<FeatureType, FeatureMeta>> = {
  sketch: meta("sketch", "tool.sketch"),
  extrude: meta("extrude", "tool.extrude"),
  fillet: meta("fillet", "tool.fillet"),
  chamfer: meta("chamfer", "tool.chamfer"),
  "press-pull": meta("presspull", "tool.pressPull"),
  deleteFace: meta("deleteFace", "feature.deleteFace"),
  mirror: meta("mirror", "tool.mirror"),
  revolve: meta("revolve", "tool.revolve"),
  loft: meta("loft", "tool.loft"),
  sweep: meta("sweep", "tool.sweep"),
  datumPlane: meta("datumPlane", "tool.datumPlane"),
  datumPoint: meta("datumPoint", "tool.datumPoint"),
  datumAxis: meta("datumAxis", "tool.datumAxis"),
  import: meta("import", "feature.import"),
  split: meta("split", "tool.splitBody"),
  separate: meta("split", "tool.separate"),
  imprint: meta("imprint", "feature.divideFace"),
  // featureMeta names the actual boolean command, so this entry is only the type's fallback.
  boolean: meta("booleanUnion", "tool.family.boolean"),
  box: meta("box", "feature.box"),
  cylinder: meta("cylinder", "feature.cylinder"),
  cone: meta("cone", "feature.cone"),
  sphere: meta("sphere", "feature.sphere"),
  torus: meta("torus", "feature.torus"),
  shell: meta("shell", "tool.shell"),
  offsetFace: meta("offsetFace", "tool.offsetFace"),
  thicken: meta("thicken", "tool.thicken"),
  draft: meta("draft", "tool.draft"),
  hole: meta("hole", "tool.hole"),
  thread: meta("thread", "tool.thread"),
  textOnFace: meta("text", "tool.textOnFace"),
  patternRect: meta("patternRect", "tool.rectPattern"),
  patternLinear: meta("patternLinear", "tool.linearPattern"),
  patternCircular: meta("patternCircular", "tool.circularPattern"),
  simplifyMesh: meta("simplifyMesh", "tool.simplifyMesh"),
  cleanUp: meta("cleanUp", "tool.cleanUp"),
  scale: meta("scale", "tool.scale"),
  move: meta("move", "tool.move"),
  duplicate: meta("copy", "feature.duplicate"),
  joint: meta("assembly", "tool.joint"),
  mechanism: meta("mechanism", "tool.mechanism"),
  removeBody: meta("removeBody", "feature.removeBody"),
};

// The rail's keys for the three commands, so a boolean step reads like its button.
const BOOLEAN_KEYS: Record<BooleanOp, MessageKey> = {
  union: "tool.union",
  subtract: "tool.subtract",
  intersect: "tool.intersect",
};
const BOOLEAN_META = new Map(BOOLEAN_COMMANDS.map((c) => [c.op, meta(c.iconName, BOOLEAN_KEYS[c.op])]));
const THIN_EXTRUDE_META = meta("extrude", "feature.thinExtrude");

/** A boolean is three commands sharing one type, so it is named by its operation. An unknown type renders as a grey
 *  dot rather than throw. Plugins are asked after the table, so they cannot rename the app's own features. */
export function featureMeta(f: { type: string; operation?: unknown; thin?: unknown }): FeatureMeta {
  if (f.type === "boolean") {
    const found = BOOLEAN_META.get(f.operation as BooleanOp);
    if (found) return found;
  }
  if (f.type === "extrude" && f.thin === true) return THIN_EXTRUDE_META;
  return FEATURE_META[f.type as FeatureType] ?? contributedFeature(f.type)?.meta ?? { icon: "dot", label: f.type };
}

/** The feature type's name in English whatever the language, for English sentences and for counting. */
export function featureEnglish(f: { type: string; operation?: unknown; thin?: unknown }): string {
  const m = featureMeta(f);
  const key = META_KEYS.get(m);
  return key ? tEnglish(key) : (m.refName ?? m.label);
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

/** A datum plane's name, or its place among the datum planes when it has none. */
export const datumPlaneName = (f: { name?: string }, place: number) => f.name || `Plane${place + 1}`;

// An import takes its assembly name, but only while its name is still the file's: `source` is a path, and the engine
// names an import after the file stem (or the stem of a .gz one), so a name that is not that was typed.
function nameWith(f: Nameable, typeName: () => string): string {
  const own = f.name?.trim() ?? "";
  const asm = assemblyName(f);
  if (asm && own && f.source) {
    const file = (f.source.split(/[\x5c/]/).pop() ?? "").toLowerCase();
    if (file.startsWith(`${own.toLowerCase()}.`)) return asm;
  }
  return own || typeName();
}

/** The name History and Items agree on. */
export const stepName = (f: Nameable): string => nameWith(f, () => featureMeta(f).label);

/** stepName with an unnamed feature called by its English type name. */
export const stepEnglish = (f: Nameable): string => nameWith(f, () => featureEnglish(f));

/** The same answer for a whole feature, when the caller has one. */
export function labelOf(f: Feature): string {
  return featureMeta(f as { type: string; operation?: unknown; thin?: unknown }).label;
}

type Placed = Nameable & { id?: string };

/** A step's name as data: a typed name, or the type and its place, spoken in the language of the moment. */
export interface NameRef {
  fixed: string | null;
  meta: { type: string; operation?: unknown; thin?: unknown };
  place: number | null;
}

// Steps are counted by their English type name, so a language switch never renumbers a step.
export function nameRef(f: Placed, features?: readonly Placed[]): NameRef {
  const meta = { type: f.type, operation: f.operation, thin: f.thin };
  if (f.name?.trim()) return { fixed: nameWith(f, () => ""), meta, place: null };
  const at = features ? features.findIndex((g) => g === f || (f.id !== undefined && g.id === f.id)) : -1;
  if (!features || at < 0) return { fixed: null, meta, place: null };
  const kind = featureEnglish(f);
  return { fixed: null, meta, place: features.slice(0, at + 1).filter((g) => featureEnglish(g) === kind).length };
}

export function nameText(ref: NameRef, english = false): string {
  if (ref.fixed !== null) return ref.fixed;
  const word = english ? featureEnglish(ref.meta) : featureMeta(ref.meta).label;
  return ref.place === null ? word : (english ? tEnglish : t)("feature.numbered", { name: word, n: ref.place });
}

/** stepName, with the 1-based place among same-typed steps added to an unnamed one. A named
 *  step counts toward the place so a rename does not renumber the others. */
export const numberedName = (f: Placed, features: readonly Placed[]): string => nameText(nameRef(f, features));

export const numberedEnglish = (f: Placed, features: readonly Placed[]): string => nameText(nameRef(f, features), true);
