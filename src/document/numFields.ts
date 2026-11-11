// The inventory of parameter-drivable numeric fields: which feature and rigid entity fields hold a `Num`, their kind
// and label. Read by the value rows, the load migration and the parameters engine.

import type { CadDocument, Feature, ParamTarget, ParamUnit, SketchEntity, SketchPattern } from "../types";
import { isDimConstraint } from "../sketch/id";
import { t, type MessageKey } from "../i18n";
import { contributedFeature } from "../plugins/contrib";
import { asFeature } from "../types";

// Drives display unit conversion, suffixes and parameter unit coercion. ui/units.ts re-exports it.
export type FieldKind = "length" | "angle" | "count";

type KeyedField = [field: string, label: MessageKey, kind: FieldKind];

// Application-owned feature types only: a plugin's fields are whatever its code reads. The label column is a key, call
// `featureNumFields()` for the rows in the language.
export const FEATURE_NUM_FIELDS: Partial<Record<Feature["type"], KeyedField[]>> = {
  extrude: [
    ["distance", "field.distance", "length"],
    ["taper", "field.taper", "angle"],
    ["startOffset", "field.startOffset", "length"],
    ["endOffset", "field.endOffset", "length"],
    ["distance2", "field.distance2", "length"],
    ["taper2", "field.taper2", "angle"],
    ["endOffset2", "field.endOffset2", "length"],
    ["thickness", "field.thickness", "length"],
    ["thickness2", "field.thickness2", "length"],
  ],
  // "count" is this file's kind for real-valued unitless fields like profile, not an integer claim; INTEGER_FIELDS
  // marks those.
  fillet: [
    ["radius", "field.radius", "length"],
    ["profile", "field.profile", "count"],
  ],
  chamfer: [
    ["distance", "field.distance", "length"],
    ["distance2", "field.distance2", "length"],
  ],
  "press-pull": [
    ["distance", "field.distance", "length"],
    ["taper", "field.taper", "angle"],
    ["upToOffset", "field.upToOffset", "length"],
  ],
  // Pitch is the climb per full turn, so a thread pitch is typed off its spec. Empty means the flat revolve.
  revolve: [
    ["angle", "field.angle", "angle"],
    ["pitch", "field.pitch", "length"],
  ],
  datumPlane: [
    ["offset", "field.offset", "length"],
    ["tiltX", "field.tiltX", "angle"],
    ["tiltY", "field.tiltY", "angle"],
    ["spin", "field.spin", "angle"],
    ["shiftX", "field.shiftX", "length"],
    ["shiftY", "field.shiftY", "length"],
  ],
  box: [
    ["length", "field.length", "length"],
    ["width", "field.width", "length"],
    ["height", "field.height", "length"],
  ],
  cylinder: [
    ["radius", "field.radius", "length"],
    ["height", "field.height", "length"],
  ],
  cone: [
    ["bottomRadius", "field.bottomRadius", "length"],
    ["topRadius", "field.topRadius", "length"],
    ["height", "field.height", "length"],
  ],
  sphere: [["radius", "field.radius", "length"]],
  torus: [
    ["majorRadius", "field.ringRadius", "length"],
    ["minorRadius", "field.tubeRadius", "length"],
  ],
  shell: [["thickness", "field.thickness", "length"]],
  offsetFace: [["distance", "field.distance", "length"]],
  thicken: [["thickness", "field.thickness", "length"]],
  draft: [["angle", "field.angle", "angle"]],
  thread: [
    ["pitch", "field.pitch", "length"],
    ["starts", "field.starts", "count"],
    ["offset", "field.offset", "length"],
    ["length", "field.length", "length"],
    ["clearance", "field.printClearance", "length"],
  ],
  textOnFace: [
    ["height", "field.height", "length"],
    ["depth", "field.depth", "length"],
    ["angle", "field.angle", "angle"],
  ],
  hole: [
    ["diameter", "field.diameter", "length"],
    ["depth", "field.depth", "length"],
    ["cbDiameter", "field.counterboreDiameter", "length"],
    ["cbDepth", "field.counterboreDepth", "length"],
    ["csDiameter", "field.countersinkDiameter", "length"],
    ["csAngle", "field.countersinkAngle", "angle"],
    ["leadIn", "field.leadIn", "length"],
  ],
  patternRect: [
    ["countX", "field.countX", "count"],
    ["countY", "field.countY", "count"],
    ["spacingX", "field.spacingX", "length"],
    ["spacingY", "field.spacingY", "length"],
  ],
  patternLinear: [
    ["count", "field.count", "count"],
    ["spacing", "field.spacing", "length"],
  ],
  patternCircular: [
    ["count", "field.count", "count"],
    ["angle", "field.angle", "angle"],
  ],
  simplifyMesh: [["tolerance", "field.angleTol", "angle"]],
  cleanUp: [["tolerance", "field.tolerance", "length"]],
  scale: [
    ["factor", "field.factor", "count"],
    ["sx", "field.xFactor", "count"],
    ["sy", "field.yFactor", "count"],
    ["sz", "field.zFactor", "count"],
  ],
  move: [
    ["dx", "field.moveX", "length"],
    ["dy", "field.moveY", "length"],
    ["dz", "field.moveZ", "length"],
    ["rx", "field.rotateX", "angle"],
    ["ry", "field.rotateY", "angle"],
    ["rz", "field.rotateZ", "angle"],
  ],
  joint: [
    ["offset", "field.offset", "length"],
    ["angle", "field.angle", "angle"],
  ],
  // Only the drive value the joint reads shows (document/mechanism.ts).
  mechanism: [
    ["offset", "field.driveOffset", "length"],
    ["angle", "field.driveAngle", "angle"],
  ],
  duplicate: [
    ["dx", "field.moveX", "length"],
    ["dy", "field.moveY", "length"],
    ["dz", "field.moveZ", "length"],
    ["rx", "field.rotateX", "angle"],
    ["ry", "field.rotateY", "angle"],
    ["rz", "field.rotateZ", "angle"],
  ],
};

// A type without an editor is labelled "Select" rather than "Edit" in the context menu (ui/contextMenus.ts).
export function isInspectorEditable(type: string): boolean {
  return type === "sketch" || featureNumFields(type).length > 0;
}

// An uninstalled plugin's type gets its raw numeric fields by name, so its values stay editable and bound parameters
// keep resolving; otherwise the next save would drop them for good.
export function featureNumFields(
  type: string,
  values?: Record<string, unknown>,
): readonly [string, string, FieldKind][] {
  const base = typeNumFields(type, values);
  const common = values ? presentCommonFields(values).map(spoken) : [];
  return common.length ? [...base, ...common] : base;
}

const spoken = ([field, key, kind]: KeyedField): [string, string, FieldKind] => [field, t(key), kind];

// Only on the datum plane forms that read them: `t` is a 0..1 fraction along the edge, `angle` the turn about it.
const DATUM_REF_FIELDS: KeyedField[] = [
  ["t", "field.position", "count"],
  ["angle", "field.angle", "angle"],
];

function typeNumFields(type: string, values?: Record<string, unknown>): readonly [string, string, FieldKind][] {
  const own = FEATURE_NUM_FIELDS[type as Feature["type"]];
  if (own && type === "datumPlane" && values) {
    return [...own, ...DATUM_REF_FIELDS.filter(([field]) => values[field] !== undefined)].map(spoken);
  }
  if (own) return own.map(spoken);
  const contributed = contributedFeature(type)?.numFields;
  if (contributed) return typeof contributed === "function" ? contributed(values ?? {}) : contributed;
  return values ? rawNumFields(values) : [];
}

// A path is keys joined by dots, where the segment after a list names an entry by `id`: `nodes.n3.sx` survives a reorder.
export function fieldHolder(
  root: Record<string, unknown>,
  path: string,
): { holder: Record<string, unknown>; key: string } | null {
  const parts = path.split(".");
  let holder: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = holder[parts[i]!];
    if (Array.isArray(next)) {
      const id = parts[++i];
      const entry = next.find((e) => isRecord(e) && e["id"] === id);
      if (!isRecord(entry)) return null;
      holder = entry;
    } else if (isRecord(next)) {
      holder = next;
    } else {
      return null;
    }
    if (i === parts.length - 1) return null;
  }
  return { holder, key: parts[parts.length - 1]! };
}

export function readField(root: Record<string, unknown>, path: string): unknown {
  const at = fieldHolder(root, path);
  return at ? at.holder[at.key] : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The build skips a feature while `activeWhen` is 0 (engine `is_inactive`). Listed only when present: the parameter
// engine writes every resolving target, so an always-resolving row would undo "Remove condition".
export const COMMON_NUM_FIELDS: KeyedField[] = [["activeWhen", "field.activeWhen", "count"]];

export function presentCommonFields(values: Record<string, unknown>): KeyedField[] {
  return COMMON_NUM_FIELDS.filter(([field]) => values[field] !== undefined);
}

// Ids, type and geometry selections are skipped: a spin box over one would corrupt the feature.
export function rawNumFields(values: Record<string, unknown>): [string, string, FieldKind][] {
  const out: [string, string, FieldKind][] = [];
  for (const [k, v] of Object.entries(values)) {
    if (k === "id" || k === "type" || COMMON_NUM_FIELDS.some(([field]) => field === k)) continue;
    if (typeof v === "number") out.push([k, k, "count"]);
    // Lists of id-carrying entries are path addressable, so a parameter bound inside one survives the plugin's removal.
    if (Array.isArray(v) && v.length && v.every((e) => isRecord(e) && typeof e["id"] === "string")) {
      for (const e of v as Record<string, unknown>[]) {
        for (const [ek, ev] of Object.entries(e)) {
          if (ek !== "id" && typeof ev === "number")
            out.push([`${k}.${e["id"]}.${ek}`, `${k} ${e["id"]} ${ek}`, "count"]);
        }
      }
    }
  }
  return out;
}

// Solver-rigid shapes only, which a parameter may own directly; solved geometry is driven through dimension
// constraints because the solver overwrites raw coordinates every pump.
export const RIGID_ENTITY_NUM_FIELDS: Partial<Record<SketchEntity["type"], [string, FieldKind][]>> = {
  polygon: [
    ["x", "length"],
    ["y", "length"],
    ["radius", "length"],
    ["sides", "count"],
    ["angle", "angle"],
  ],
  slot: [
    ["x1", "length"],
    ["y1", "length"],
    ["x2", "length"],
    ["y2", "length"],
    ["width", "length"],
  ],
  text: [
    ["x", "length"],
    ["y", "length"],
    ["height", "length"],
    ["angle", "angle"],
    ["positionOnPath", "count"],
    ["boxWidth", "length"],
  ],
};

// Lengths mm, angles degrees, counts raw.
export function kindUnit(kind: FieldKind): ParamUnit {
  return kind === "length" ? "mm" : kind === "angle" ? "deg" : "count";
}

export const PATTERN_NUM_FIELDS: Record<SketchPattern["type"], [string, FieldKind][]> = {
  patternRect: [
    ["countX", "count"],
    ["countY", "count"],
    ["spacingX", "length"],
    ["spacingY", "length"],
    ["angle", "angle"],
  ],
  patternCircular: [
    ["cx", "length"],
    ["cy", "length"],
    ["count", "count"],
    ["angle", "angle"],
  ],
  hexHoles: [
    ["cx", "length"],
    ["cy", "length"],
    ["diameter", "length"],
    ["spacing", "length"],
    ["rings", "count"],
  ],
  honeycomb: [
    ["cx", "length"],
    ["cy", "length"],
    ["diameter", "length"],
    ["spacing", "length"],
    ["rings", "count"],
  ],
  boltCircle: [
    ["cx", "length"],
    ["cy", "length"],
    ["bcd", "length"],
    ["count", "count"],
    ["diameter", "length"],
  ],
  gridHoles: [
    ["cx", "length"],
    ["cy", "length"],
    ["diameter", "length"],
    ["countX", "count"],
    ["countY", "count"],
    ["spacingX", "length"],
    ["spacingY", "length"],
  ],
};

// Integer-only fields and their minimum, a subset of the "count" kind. A parameter write coerces through this.
export const INT_FIELDS: Record<string, number> = {
  sides: 3,
  count: 1,
  countX: 1,
  countY: 1,
  rings: 1,
  starts: 1,
  seed: -Infinity,
};

// Shared by the heads-up value box and the feature rows, so both refuse the same number in the same words.
export interface ValueRule {
  // A radius or a scale: only a value above zero means anything.
  positive?: boolean;
  atLeast?: number;
  integer?: boolean;
}

const POSITIVE_FIELDS: Partial<Record<Feature["type"], readonly string[]>> = {
  fillet: ["radius"],
  chamfer: ["distance", "distance2"],
  scale: ["factor", "sx", "sy", "sz"],
};

export function featureValueRule(type: string, field: string): ValueRule {
  const rule: ValueRule = {};
  if (POSITIVE_FIELDS[type as Feature["type"]]?.includes(field)) rule.positive = true;
  const min = INT_FIELDS[field];
  if (min !== undefined) {
    rule.integer = true;
    if (Number.isFinite(min)) rule.atLeast = min;
  }
  return rule;
}

export function valueProblem(label: string, rule: ValueRule, v: number): string | null {
  if (rule.integer && Math.abs(v - Math.round(v)) > 1e-9) return t("field.problem.whole", { label });
  if (rule.positive && !(v > 0)) return t("field.problem.positive", { label });
  if (rule.atLeast !== undefined && v < rule.atLeast) return t("field.problem.atLeast", { label, min: rule.atLeast });
  return null;
}

// The parameter engine words its problems in English for the MCP tools too, so a row translates the one a mistype
// gives and passes every other through as sent.
export function exprProblem(problem: string | null): string | null {
  const unknown = problem === null ? null : /^unknown parameter "(.*)"$/.exec(problem);
  return unknown ? t("field.problem.unknownName", { name: unknown[1]! }) : problem;
}

// String fields that can never hold a bare parameter name, skipped by the legacy scans. Keep in sync with the unions.
export const NON_NUM_STRING_FIELDS = new Set([
  "id",
  "type",
  "name",
  "operation",
  "font",
  "style",
  "align",
  "text",
  "pathRef",
  "plane",
  "sketch",
  "axis",
  "profile",
  "path",
  "direction",
  "body",
  "imagePath",
  "solid",
  "ground",
  "drive",
  "mode",
]);

export interface ResolvedTarget {
  holder: Record<string, unknown>;
  field: string;
  kind: FieldKind;
  // The re-solve cascade keys off it; undefined for feature fields outside sketches.
  sketch?: string;
}

// Null once the target is gone; the caller decides what a dangling binding means.
export function resolveTarget(doc: CadDocument, target: ParamTarget): ResolvedTarget | null {
  const sketchOf = (id: string) =>
    asFeature(
      doc.features.find((x) => x.id === id),
      "sketch",
    );
  switch (target.kind) {
    case "feature": {
      const f = doc.features.find((x) => x.id === target.feature);
      // featureNumFields, not the app table alone, so a binding to a plugin's field survives the plugin being uninstalled.
      const row = f && featureNumFields(f.type, f as Record<string, unknown>).find(([field]) => field === target.field);
      const at = f && row && fieldHolder(f as unknown as Record<string, unknown>, target.field);
      if (!at) return null;
      return { holder: at.holder, field: at.key, kind: row![2] };
    }
    case "constraint": {
      const f = sketchOf(target.sketch);
      const c = f?.constraints?.find((k) => isDimConstraint(k) && k.id === target.constraint);
      if (!c) return null;
      return {
        holder: c as unknown as Record<string, unknown>,
        field: "value",
        kind: c.type === "angle" ? "angle" : "length",
        sketch: target.sketch,
      };
    }
    case "entity": {
      const f = sketchOf(target.sketch);
      const e = f?.entities.find((x) => x.id === target.entity);
      const row = e && RIGID_ENTITY_NUM_FIELDS[e.type]?.find(([field]) => field === target.field);
      if (!e || !row) return null;
      return {
        holder: e as unknown as Record<string, unknown>,
        field: target.field,
        kind: row[1],
        sketch: target.sketch,
      };
    }
    case "pattern": {
      const f = sketchOf(target.sketch);
      const p = f?.patterns?.find((x) => x.id === target.pattern);
      const row = p && PATTERN_NUM_FIELDS[p.type]?.find(([field]) => field === target.field);
      if (!p || !row) return null;
      return {
        holder: p as unknown as Record<string, unknown>,
        field: target.field,
        kind: row[1],
        sketch: target.sketch,
      };
    }
  }
}

export function coerceForField(field: string, value: number): number {
  const min = INT_FIELDS[field];
  if (min === undefined) return value;
  return Math.max(min, Math.round(value));
}

export function targetFeatureId(target: ParamTarget): string {
  return target.kind === "feature" ? target.feature : target.sketch;
}

// A copy for live preview (beginEditPreview) without a mutate and an undo entry per keystroke. Only the one feature is
// cloned. Null when the target is gone, the value is not finite or nothing would change.
export function featureWithTarget(doc: CadDocument, target: ParamTarget, value: number): Feature | null {
  const id = targetFeatureId(target);
  if (!doc.features.some((f) => f.id === id)) return null;
  const view: CadDocument = { ...doc, features: doc.features.slice() };
  return writeTarget(view, target, value) ? view.features.find((f) => f.id === id)! : null;
}

// Returns the sketch id to re-solve, or null when the target is gone or the value is unchanged. Non-finite never writes.
export function writeTarget(doc: CadDocument, target: ParamTarget, value: number): { sketch?: string } | null {
  if (!Number.isFinite(value)) return null;
  const rt = resolveTarget(doc, target);
  if (!rt) return null;
  const v = coerceForField(rt.field, value);
  if (rt.holder[rt.field] === v) return null;
  // Replaced, never patched: the rebuild protocol ships only features whose object changed.
  const i = doc.features.findIndex((f) => f.id === targetFeatureId(target));
  if (i < 0) return null;
  doc.features[i] = structuredClone(doc.features[i]!);
  const fresh = resolveTarget(doc, target)!;
  fresh.holder[fresh.field] = v;
  return rt.sketch !== undefined ? { sketch: rt.sketch } : {};
}
