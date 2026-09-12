// The single inventory of parameter-drivable numeric fields: which fields on a
// feature (and on the solver-rigid sketch entities) hold a `Num`, what kind of
// quantity each is, and how the value rows label it. Consumed by those rows
// (field editors), the load migration (bare-name → model-param conversion), and
// the parameters engine (target read/write + unit coercion).

import type { CadDocument, Feature, ParamTarget, ParamUnit, SketchEntity, SketchPattern } from "../types";
import { isDimConstraint } from "../sketch/id";
import { contributedFeature } from "../plugins/contrib";
import { asFeature } from "../types";

/** What kind of quantity a numeric field holds, drives display-unit conversion
 *  (lengths mm↔display), suffixes (° / mm), and parameter unit coercion.
 *  Defined here (document layer); ui/units.ts re-exports it for its consumers. */
export type FieldKind = "length" | "angle" | "count";

/** [field, label, kind] rows per feature type, for the features the APPLICATION
 *  owns. A plugin's feature type is not in here and cannot be: its geometry
 *  lives in the plugin's own directory and its fields are whatever that code
 *  reads. `featureNumFields()` below is what every consumer should call.
 *
 *  `texture` used to be the last row of this table. */
export const FEATURE_NUM_FIELDS: Partial<Record<Feature["type"], [string, string, FieldKind][]>> = {
  extrude: [["distance", "Distance", "length"], ["taper", "Taper", "angle"]],
  // profile is a dimensionless ratio in (-1, 1), "count" is this file's kind for
  // real-valued unitless fields (see scale.factor, texture.sharpness), not an
  // integer claim; INTEGER_FIELDS below is what marks those.
  fillet: [["radius", "Radius", "length"], ["profile", "Profile", "count"]],
  chamfer: [["distance", "Length", "length"]],
  "press-pull": [["distance", "Distance", "length"], ["taper", "Taper", "angle"]],
  // Pitch is how far one full turn climbs, not how far the whole revolve does,
  // so a thread's pitch is typed straight off its spec and stays right however
  // many turns are wound on. Empty means no climb: the flat revolve.
  revolve: [["angle", "Angle", "angle"], ["pitch", "Pitch", "length"]],
  datumPlane: [["offset", "Offset", "length"]],
  box: [["length", "Length", "length"], ["width", "Width", "length"], ["height", "Height", "length"]],
  cylinder: [["radius", "Radius", "length"], ["height", "Height", "length"]],
  cone: [["bottomRadius", "Bottom radius", "length"], ["topRadius", "Top radius", "length"], ["height", "Height", "length"]],
  sphere: [["radius", "Radius", "length"]],
  torus: [["majorRadius", "Ring radius", "length"], ["minorRadius", "Tube radius", "length"]],
  shell: [["thickness", "Thickness", "length"]],
  offsetFace: [["distance", "Distance", "length"]],
  thicken: [["thickness", "Thickness", "length"]],
  draft: [["angle", "Angle", "angle"]],
  patternRect: [["countX", "Count X", "count"], ["countY", "Count Y", "count"], ["spacingX", "Spacing X", "length"], ["spacingY", "Spacing Y", "length"]],
  patternLinear: [["count", "Count", "count"], ["spacing", "Spacing", "length"]],
  patternCircular: [["count", "Count", "count"], ["angle", "Angle", "angle"]],
  simplifyMesh: [["tolerance", "Angle tol", "angle"]],
  cleanUp: [["tolerance", "Tolerance", "length"]],
  scale: [["factor", "Factor", "count"], ["sx", "X factor", "count"], ["sy", "Y factor", "count"], ["sz", "Z factor", "count"]],
  move: [["dx", "Move X", "length"], ["dy", "Move Y", "length"], ["dz", "Move Z", "length"], ["rx", "Rotate X", "angle"], ["ry", "Rotate Y", "angle"], ["rz", "Rotate Z", "angle"]],
  duplicate: [["dx", "Move X", "length"], ["dy", "Move Y", "length"], ["dz", "Move Z", "length"], ["rx", "Rotate X", "angle"], ["ry", "Rotate Y", "angle"], ["rz", "Rotate Z", "angle"]],
};

/** Whether selecting this feature type actually opens an editor (numeric fields
 *  in the value rows, or the sketch editor). The context menu labels "Edit"
 *  honestly, a type without an editor gets "Select" instead.
 *
 *  Lives here rather than beside the value rows because it is a fact about the field
 *  table above, and its other caller (ui/contextMenus.ts) has no other reason to
 *  reach into a panel. */
export function isInspectorEditable(type: string): boolean {
  return type === "sketch" || featureNumFields(type).length > 0;
}

/** The numeric rows of a feature type: the app's own, else the owning plugin's.
 *
 *  WHY THE FALLBACK AT THE END IS NOT A DETAIL. A document may hold a feature
 *  whose plugin is not installed, and it must still be possible to see and edit
 *  its numbers, and a parameter bound to one of them must keep resolving.
 *  Otherwise uninstalling a plugin does not merely disable a tool, it silently
 *  drops values out of the properties panel and breaks every equation that
 *  referenced them, and re-installing cannot bring them back because by then
 *  something will have saved the document without them.
 *
 *  So an undescribed type gets its own numeric fields listed verbatim, labelled
 *  by field name. That is uglier than the plugin's labels and it is the whole
 *  point: the values are still there, still typed, still parameter-drivable,
 *  and the panel says plainly that it does not know what they are called. */
export function featureNumFields(
  type: string,
  values?: Record<string, unknown>,
): readonly [string, string, FieldKind][] {
  const own = FEATURE_NUM_FIELDS[type as Feature["type"]];
  if (own) return own;
  const contributed = contributedFeature(type)?.numFields;
  if (contributed) return contributed;
  return values ? rawNumFields(values) : [];
}

/** Every numeric-looking field on a feature nobody describes, in key order,
 *  labelled by its own name. Ids, type and geometry selections are skipped:
 *  they are not numbers and a spin box over one would corrupt the feature. */
export function rawNumFields(
  values: Record<string, unknown>,
): [string, string, FieldKind][] {
  const out: [string, string, FieldKind][] = [];
  for (const [k, v] of Object.entries(values)) {
    if (k === "id" || k === "type") continue;
    if (typeof v === "number") out.push([k, k, "count"]);
  }
  return out;
}

/** Numeric fields on the solver-RIGID parametric shapes (the solver never writes
 *  these, so a parameter may own them directly). Solved geometry (lines, circles,
 *  rectangles…) is parameter-driven through a dimension constraint instead, the
 *  solver overwrites raw coordinates every pump. */
export const RIGID_ENTITY_NUM_FIELDS: Partial<Record<SketchEntity["type"], [string, FieldKind][]>> = {
  polygon: [["x", "length"], ["y", "length"], ["radius", "length"], ["sides", "count"], ["angle", "angle"]],
  slot: [["x1", "length"], ["y1", "length"], ["x2", "length"], ["y2", "length"], ["width", "length"]],
  text: [["x", "length"], ["y", "length"], ["height", "length"], ["angle", "angle"], ["positionOnPath", "count"], ["boxWidth", "length"]],
};

/** Canonical unit of a field kind (lengths mm, angles degrees, counts raw). */
export function kindUnit(kind: FieldKind): ParamUnit {
  return kind === "length" ? "mm" : kind === "angle" ? "deg" : "count";
}

/** Numeric fields on sketch patterns. */
export const PATTERN_NUM_FIELDS: Record<SketchPattern["type"], [string, FieldKind][]> = {
  patternRect: [["countX", "count"], ["countY", "count"], ["spacingX", "length"], ["spacingY", "length"]],
  patternCircular: [["cx", "length"], ["cy", "length"], ["count", "count"], ["angle", "angle"]],
  hexHoles: [["cx", "length"], ["cy", "length"], ["diameter", "length"], ["spacing", "length"], ["rings", "count"]],
  honeycomb: [["cx", "length"], ["cy", "length"], ["diameter", "length"], ["spacing", "length"], ["rings", "count"]],
  boltCircle: [["cx", "length"], ["cy", "length"], ["bcd", "length"], ["count", "count"], ["diameter", "length"]],
  gridHoles: [["cx", "length"], ["cy", "length"], ["diameter", "length"], ["countX", "count"], ["countY", "count"], ["spacingX", "length"], ["spacingY", "length"]],
};

/** Integer-only fields (a subset of the "count" kind, which also holds real-
 *  valued unitless fields like texture sharpness or a scale factor) and their
 *  minimum legal value. A parameter write coerces through this. */
export const INT_FIELDS: Record<string, number> = {
  sides: 3,
  count: 1,
  countX: 1,
  countY: 1,
  rings: 1,
  seed: -Infinity,
};

/** String-typed Feature/SketchEntity fields that can NEVER hold a bare
 *  parameter name, the skip-set for the legacy bare-name scans in the params
 *  engine. Keep in sync when a new string field lands on either union. */
export const NON_NUM_STRING_FIELDS = new Set([
  "id", "type", "name", "operation", "font", "style", "align", "text", "pathRef",
  "plane", "sketch", "axis", "profile", "path", "direction", "body", "imagePath", "solid",
]);

/** A parameter target resolved to the live object holding the number. */
export interface ResolvedTarget {
  holder: Record<string, unknown>;
  field: string;
  kind: FieldKind;
  /** id of the sketch feature this value lives in (undefined for feature fields
   *  outside sketches), the re-solve cascade keys off it. */
  sketch?: string;
}

/** Find the object+field a ParamTarget points at, or null if it no longer
 *  exists (deleted feature/entity/constraint, the caller decides what a
 *  dangling binding means). */
export function resolveTarget(doc: CadDocument, target: ParamTarget): ResolvedTarget | null {
  const sketchOf = (id: string) =>
    asFeature(doc.features.find((x) => x.id === id), "sketch");
  switch (target.kind) {
    case "feature": {
      const f = doc.features.find((x) => x.id === target.feature);
      // featureNumFields, not the app's table alone: a parameter may be bound to
      // a field of a PLUGIN's feature, and it has to keep resolving whether or
      // not that plugin is loaded. The raw fallback is what makes the binding
      // survive the plugin being uninstalled instead of quietly going dead.
      const row = f
        && featureNumFields(f.type, f as Record<string, unknown>)
          .find(([field]) => field === target.field);
      if (!f || !row) return null;
      return { holder: f as unknown as Record<string, unknown>, field: target.field, kind: row[2] };
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
      return { holder: e as unknown as Record<string, unknown>, field: target.field, kind: row[1], sketch: target.sketch };
    }
    case "pattern": {
      const f = sketchOf(target.sketch);
      const p = f?.patterns?.find((x) => x.id === target.pattern);
      const row = p && PATTERN_NUM_FIELDS[p.type]?.find(([field]) => field === target.field);
      if (!p || !row) return null;
      return { holder: p as unknown as Record<string, unknown>, field: target.field, kind: row[1], sketch: target.sketch };
    }
  }
}

/** Coerce an evaluated value for its destination field (integer fields round
 *  and clamp to their minimum). */
export function coerceForField(field: string, value: number): number {
  const min = INT_FIELDS[field];
  if (min === undefined) return value;
  return Math.max(min, Math.round(value));
}

/** Write an evaluated parameter value into its target field. Returns the
 *  affected sketch id (for the re-solve cascade) or null when the target is
 *  gone or the value didn't change. Non-finite values are never written. */
/** Which feature a target lives in. Every kind of target is inside exactly one:
 *  a constraint, an entity and a pattern are all parts of a sketch. */
export function targetFeatureId(target: ParamTarget): string {
  return target.kind === "feature" ? target.feature : target.sketch;
}

/** A COPY of the feature `target` lives in, with `value` written into it.
 *
 *  For a LIVE PREVIEW: the store can rebuild a candidate feature in the timeline
 *  position it will occupy without touching the document or the undo stack
 *  (beginEditPreview), and to do that it needs the feature it would build. This
 *  is how a panel gets one without a speculative mutate and an undo entry per
 *  keystroke.
 *
 *  The clone is of the ONE feature, not of the document: the rest is passed
 *  through by reference, so previewing a radius on a hundred-feature part costs
 *  a copy of the fillet rather than a copy of the part.
 *
 *  Null when the target no longer resolves, the value is not finite, or writing
 *  it would change nothing, all three of which a caller reads the same way, as
 *  "there is nothing here worth building".
 */
export function featureWithTarget(
  doc: CadDocument,
  target: ParamTarget,
  value: number,
): Feature | null {
  const id = targetFeatureId(target);
  const src = doc.features.find((f) => f.id === id);
  if (!src) return null;
  const copy = structuredClone(src);
  const view: CadDocument = {
    ...doc,
    features: doc.features.map((f) => (f.id === id ? copy : f)),
  };
  return writeTarget(view, target, value) ? copy : null;
}

export function writeTarget(doc: CadDocument, target: ParamTarget, value: number): { sketch?: string } | null {
  if (!Number.isFinite(value)) return null;
  const rt = resolveTarget(doc, target);
  if (!rt) return null;
  const v = coerceForField(rt.field, value);
  if (rt.holder[rt.field] === v) return null;
  rt.holder[rt.field] = v;
  return rt.sketch !== undefined ? { sketch: rt.sketch } : {};
}
