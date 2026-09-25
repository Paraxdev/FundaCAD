<script setup lang="ts">
// One feature's editable values.
//
// Lifted out of the docked Parameters panel so the history can show these rows under
// the feature you clicked. Both surfaces render THIS, rather than each building
// its own list: the rows are not a display of the feature, they are the write
// path into it (a bound field edits its expression, a sketch dimension
// re-serialises one entity), and two copies of that would drift the moment a
// field type was added.
//
// Five kinds of row, in the order a form reads best: what the feature is APPLIED
// TO first, then the CHOICES, then the files, then the switches, then the
// numbers. A choice usually decides which of the others are even there, pick a
// texture pattern and the Angle, Seed and heightmap rows appear or go, so
// putting it under the fields it governs would have the reader working upward.
// The numbers come last because they are the long tail.
//
// A file sits directly under the choice that summons it: picking Heightmap is
// what makes the image row exist, and the two read as one decision.
//
// The selection leads because it is the half of a feature that was missing. A
// fillet is a set of edges and a radius; the radius has been editable since these
// rows existed and the set was write-only, picked once and then invisible.
//
// Everything a row can be is declared in document/numFields.ts and
// document/optionFields.ts, never here. That is what keeps the two surfaces
// that render this component, and the tool panel that creates the feature in
// the first place, describing the same feature the same way.
//
// The title is the caller's business, the history heads it with the feature
// name and the timeline already has the chip you clicked.

import { onUnmounted, ref, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { useBuildValue, useDocValue } from "../../app/useDoc";
import { featureNotes } from "../../ui/featureNotes";
import ValidatedRow from "./ValidatedRow.vue";
import ChoiceRow from "./ChoiceRow.vue";
import ToggleRow from "./ToggleRow.vue";
import FileRow from "./FileRow.vue";
import SelectionTargetRow from "./SelectionTargetRow.vue";
import { displayRound, plainNumber } from "../../ui/units";
import { onPreviewError } from "../../ui/previewError";
import { commonUnits, toUnit, tryParseMeasure, unitById, type Dim, type Measured, type UnitDef } from "../../ui/measure";
import { contextMenu } from "../../ui/menu";
import { resolveEntities, resolveRealEntities, toSketchEntity } from "../../sketch/resolve";
import { entityDims } from "../../sketch/entityDims";
import { applyDrivingDimsDirect, dimAnchor, upsertDrivingDim } from "../../sketch/directDims";
import { toast } from "../../ui/toast";
import {
  featureNumFields,
  featureValueRule,
  featureWithTarget,
  readField,
  valueProblem,
  type FieldKind,
  type ValueRule,
} from "../../document/numFields";
import {
  choiceFieldsFor,
  choiceValue,
  fieldApplies,
  fieldLabel,
  fileFieldsFor,
  fileValue,
  patternAxisChoice,
  patternAxisPatch,
  toggleFieldsFor,
  toggleValue,
} from "../../document/optionFields";
import { targetsFor } from "../../features/selectionTargets";
import { featureLabel } from "../../features/patternSources";
import { holeChoicePatch } from "../../features/holeStandards";
import { asFeature } from "../../types";
import type { DimField, Feature, Num, ParamTarget } from "../../types";

const props = defineProps<{ featureId: string; unit: string }>();

const engine = useEngine();
const store = engine.store;

const feature = useDocValue((doc) => doc.features.find((f) => f.id === props.featureId) ?? null);

// What this feature is applied to. Declared in features/selectionTargets.ts, so
// a feature with no editable selection, a primitive, a scale, simply has no
// rows here rather than an empty heading.
const targetRows = useDocValue((doc) => {
  const f = doc.features.find((x) => x.id === props.featureId);
  return f ? targetsFor(f) : [];
});

// The features a pattern repeats, by name. Read only: which features is chosen
// by pointing at them before Pattern starts.
// What the build had to say about this feature, the same note its history chip
// carries, written out where the feature's values are read.
const buildNote = useBuildValue((b) =>
  b
    ? featureNotes({
        featureErrors: b.result?.featureErrors,
        errorFeatureId: b.errorFeatureId,
        diagnostics: b.result?.diagnostics,
      }).get(props.featureId) ?? null
    : null,
);

const repeatedLabels = useDocValue((doc) => {
  const f = doc.features.find((x) => x.id === props.featureId);
  const ids = (f as { features?: string[] } | undefined)?.features ?? [];
  return ids.map((id) => {
    const src = doc.features.find((x) => x.id === id);
    return src ? featureLabel(src) : id;
  });
});

// --- what each row is SHOWING its value in ---------------------------------
// Per row rather than per panel, and the same contract the heads-up dimension
// box has (sketch/dimInput.ts): the row starts at the document's display unit,
// follows a unit the user types, and can be changed from its chip, where
// picking CONVERTS rather than reinterprets. Keyed by row key, so a row that
// disappears takes its override with it the next time the panel is rebuilt.

const shownUnit = ref<Record<string, string>>({});

/** The dimension a field kind measures, or null for a unitless one (a count,
 *  and the real-valued ratios that share its kind). */
function dimOf(kind: FieldKind): Dim | null {
  return kind === "angle" ? "angle" : kind === "count" ? null : "length";
}

/** The unit a row shows: its own override when it still fits the field's
 *  dimension, otherwise the document's for a length and degrees for an angle,
 *  which is the only unit an angle is ever stored or shown in elsewhere. */
function unitOf(key: string, kind: FieldKind): UnitDef | null {
  const dim = dimOf(kind);
  if (!dim) return null;
  const picked = unitById(shownUnit.value[key]);
  if (picked && picked.dim === dim) return picked;
  return unitById(dim === "angle" ? "deg" : props.unit);
}

/** Adopt a unit the user wrote, so the value is shown back in the unit they
 *  just asked for instead of converted straight out of it again. */
function adopt(key: string, u: UnitDef | null) {
  if (u) shownUnit.value = { ...shownUnit.value, [key]: u.id };
}

function pickUnit(key: string, kind: FieldKind, x: number, y: number) {
  const cur = unitOf(key, kind);
  if (!cur) return;
  contextMenu(
    x,
    y,
    commonUnits(cur.dim).map((u) => ({
      label: u.label,
      checked: u.id === cur.id,
      onClick: () => adopt(key, u),
    })),
  );
}

/** Read typed text as a measurement of `dim`, with NO parameter scope: a value
 *  row's other path is the expression engine, and anything naming a parameter
 *  belongs to it.
 *
 *  Null when the text is not a measurement at all, which is what an expression
 *  looks like from here. A string when it IS one, of the wrong kind: inches on
 *  an angle is a mistake no other reading would rescue, so it is reported
 *  rather than passed along. */
function measure(raw: string, showing: UnitDef | null, dim: Dim): Measured | string | null {
  const m = tryParseMeasure(raw, showing, {});
  if (!m) return null;
  if (m.unit && m.unit.dim !== dim) {
    return `${m.unit.label} is not ${dim === "angle" ? "an angle" : "a length"}`;
  }
  return m;
}

// --- sketch: editable per-entity dimensions (same descriptors as the in-canvas
// labels). Editing entity i serialises just that entity back to numbers and
// leaves the others (and their parameter references) untouched. ---

/** "Line", "Arc", ... capitalised for the row label; entity.type is otherwise
 *  only ever spelled lowercase, for JSON. */
const TYPE_NAME: Record<string, string> = {
  line: "Line", arc: "Arc", circle: "Circle", rectangle: "Rectangle",
  slot: "Slot", polygon: "Polygon", bspline: "Curve", spline: "Curve", point: "Point",
};

const sketchRows = useDocValue((doc) => {
  const f = asFeature(feature.value, "sketch");
  if (!f) return [];
  const resolved = resolveEntities(f, doc.parameters);
  const dimsOf = resolved.map((e) => entityDims(e));
  // Only ambiguous when it needs to be: a lone circle still just says
  // "Diameter", the plain label every sketch has always shown. Two lines both
  // showing "Length" is where SK-7 lived, so ONLY a type with more than one
  // dimensioned entity gets a "Line 1" / "Line 2" prefix to tell them apart.
  const perType = new Map<string, number>();
  resolved.forEach((e, i) => { if (dimsOf[i]!.length) perType.set(e.type, (perType.get(e.type) ?? 0) + 1); });
  const out: { key: string; label: string; unit: string; value: string; index: number; field: string }[] = [];
  const seen = new Map<string, number>();
  resolved.forEach((e, i) => {
    const dims = dimsOf[i]!;
    if (!dims.length) return;
    const ambiguous = (perType.get(e.type) ?? 0) > 1;
    const n = (seen.get(e.type) ?? 0) + 1;
    seen.set(e.type, n);
    const prefix = ambiguous ? `${TYPE_NAME[e.type] ?? e.type} ${n} ` : "";
    for (const d of dims) {
      const key = `${i}:${d.field}`;
      const u = unitOf(key, "length");
      out.push({
        key,
        label: `${prefix}${d.label}`,
        unit: u?.label ?? "",
        value: String(toUnit(d.valueMm, u)),
        index: i,
        field: d.field,
      });
    }
  });
  return out;
});

function commitSketchDim(row: { key: string; index: number; field: string }, raw: string): string | null {
  const m = measure(raw, unitOf(row.key, "length"), "length");
  if (typeof m === "string") return m;
  if (!m) return "not a value";
  const f = asFeature(feature.value, "sketch");
  if (!f) return null;
  const resolved = resolveEntities(f, store.document.parameters);
  const copy = resolved[row.index];
  if (!copy) return null;
  adopt(row.key, m.unit);
  // A line's length, a circle's diameter and a rectangle's width/height drive
  // the solver elsewhere (see SketchMode.editDimension); routing this edit the
  // same way keeps whatever else is pinned to that entity (a coincident
  // endpoint, a corner on the origin) intact instead of sliding just the
  // coordinates entityDims' write() touches. The rest (slot, polygon) has no
  // such constraint to bypass and stays a direct coordinate write.
  const driven = upsertDrivingDim(f.constraints ?? [], copy, row.field as DimField, m.value);
  if (driven) {
    const solve = store.headlessSolve;
    if (!solve) {
      // No live solver session (WASM would not start, or this host never wired
      // one in): the same fallback SketchMode reaches for when ITS solver is
      // dead, applied to every entity the constraint set can resolve without
      // solving rather than only the one being edited.
      const all = resolveRealEntities(f, store.document.parameters);
      applyDrivingDimsDirect(all, driven);
      store.updateFeature(f.id, { entities: all.map(toSketchEntity), constraints: driven } as Partial<Feature>);
      return null;
    }
    void (async () => {
      const solved = await solve({ ...f, constraints: driven }, store.document.parameters, dimAnchor([copy], driven[driven.length - 1]!));
      if (!solved) { toast(`Could not satisfy this ${row.field} with the sketch's other constraints`); return; }
      store.updateFeature(f.id, { entities: solved.entities, constraints: driven } as Partial<Feature>);
    })();
    return null;
  }
  entityDims(copy).find((x) => x.field === row.field)?.write(m.value);
  const entities = f.entities.map((ent, j) => (j === row.index ? toSketchEntity(copy) : ent));
  store.updateFeature(f.id, { entities } as Partial<Feature>);
  return null;
}

// --- numeric feature fields ---
// useDocValue rather than a plain computed over `feature`: store.document keeps
// the same object identity across an in-place mutate, so `feature` recomputes to
// a value === its last one and Vue short-circuits the notification (the hazard
// useDoc.ts documents). These rows read `boundExpr` too, which is an untracked
// raw read, so without the version dependency a value committed from anywhere
// else, a drag handle or a parameter commit landing off the promise chain, never
// reached the panel.
// --- the fixed choices, and the switches ---------------------------------
// Written straight onto the feature: unlike a value row there is no expression
// path and no unit to reinterpret, so `updateFeature` IS the whole commit.

// The choices, switches and numbers show the feature as the model on screen has
// it. While a tool edits the feature that is the tool's live version: the
// heads-up box read G2 while this row still said G1, the value committed.
const bridge = engine.bridge;
const liveFeature = (): Feature | null => {
  bridge.editPreviewVersion.value;
  return store.liveFeature(props.featureId);
};

const choiceRows = useDocValue(() => {
  const f = liveFeature();
  if (!f) return [];
  const values = f as unknown as Record<string, unknown>;
  return choiceFieldsFor(f.type)
    .filter((c) => fieldApplies(f.type, c.field, values))
    .map((c) =>
      f.type === "patternCircular" && c.field === "axis"
        ? { ...c, ...patternAxisChoice(f, store.document.features) }
        : { ...c, current: choiceValue(f, c) },
    );
});

const fileRows = useDocValue((doc) => {
  const f = doc.features.find((x) => x.id === props.featureId);
  if (!f) return [];
  const values = f as unknown as Record<string, unknown>;
  return fileFieldsFor(f.type)
    .filter((c) => fieldApplies(f.type, c.field, values))
    .map((c) => ({ ...c, current: fileValue(f, c) }));
});

const toggleRows = useDocValue(() => {
  const f = liveFeature();
  if (!f) return [];
  const values = f as unknown as Record<string, unknown>;
  return toggleFieldsFor(f.type)
    .filter((t) => fieldApplies(f.type, t.field, values))
    .map((t) => ({ ...t, current: toggleValue(f, t) }));
});

function setOption(field: string, value: string | boolean) {
  let patch: Record<string, unknown> = { [field]: value };
  const f = store.document.features.find((x) => x.id === props.featureId);
  if (f?.type === "patternCircular" && field === "axis") {
    const axis = patternAxisPatch(String(value));
    if (!axis) return;
    patch = axis;
  }
  const hole = asFeature(f, "hole");
  if (hole) {
    patch = holeChoicePatch(hole, field, value, (k) =>
      store.isParamBound({ kind: "feature", feature: hole.id, field: k }));
  }
  if (f?.type === "chamfer" && field === "chamferType" && value === "twoDistance" && f.distance2 == null) {
    patch.distance2 = f.distance;
  }
  store.updateFeature(props.featureId, patch as unknown as Partial<Feature>);
}

const featureRows = useDocValue(() => {
  const f = liveFeature();
  if (!f || f.type === "sketch") return [];
  const values = f as unknown as Record<string, unknown>;
  // featureNumFields, not the app's own table: a plugin owns the rows of the
  // feature types it owns, and a type nobody describes falls back to its own
  // numeric fields listed verbatim, so the numbers stay visible and editable on
  // a machine where the plugin that made them is not installed.
  const fields = featureNumFields(f.type, values);
  if (!fields.length) return [];
  // A row for a field this feature will never read is a control with nothing on
  // the other end of it: turn the Seed on a knurl and the model does not move,
  // and nothing says why. The rule lives with the field inventory so the tool
  // that creates the feature and the rows that edit it hide the same ones.
  return fields.filter(([field]) => fieldApplies(f.type, field, values)).map(([field, label, kind]) => {
    const cur = readField(values, field) as Num | undefined;
    const target: ParamTarget = { kind: "feature", feature: f.id, field };
    const bound = store.boundExpr(target);
    const u = unitOf(field, kind);
    // a bound field edits its EXPRESSION (canonical units); a plain field shows
    // its number in the unit the row is showing (counts are unitless and raw)
    const shown = bound
      ? bound.expr
      : typeof cur === "number"
        ? String(u ? toUnit(cur, u) : displayRound(cur))
        : (cur ?? "");
    const fx = bound && store.isParamBound(target);
    return {
      key: field,
      // Not every label is a constant. One tool's shape slider is a flat LAND
      // width on a faceted surface and a crispness on a smooth one, and calling
      // both "Sharpness" describes neither, so whoever owns the feature type
      // gets to answer, and the inventory's label is what it falls back to.
      label: fieldLabel(f.type, field, values)?.text ?? label,
      rule: featureValueRule(f.type, field),
      // An expression is written in CANONICAL units so a file evaluates the
      // same on every machine, which is a fact about it and not a display
      // choice, so the chip states it and is not offered as a picker.
      unit: bound ? (dimOf(kind) === "angle" ? "°" : dimOf(kind) ? "mm" : "") : (u?.label ?? ""),
      pickable: !bound && !!u,
      value: String(shown),
      target,
      kind,
      rowClass: fx ? "fx-row" : undefined,
      rowTitle: fx && bound ? `${bound.name} = ${bound.expr} = ${displayRound(bound.value)}` : undefined,
    };
  });
});

/** Route raw field input.
 *
 *  A plain number is in the unit the row is SHOWING. A literal that NAMES a unit
 *  ("5in", `1/2"`, "2mm+3cm") is a measurement and is written as a value in that
 *  unit. Anything else is an expression, in CANONICAL units (mm/deg) via the
 *  params engine.
 *
 *  Deliberate semantics fork (plan decision R4): bare literals inside
 *  expressions are canonical so the same file evaluates identically on every
 *  machine, while a unit suffix is the display-unit spelling. That rule is
 *  intact; what was broken is narrower. "5in" is not a plain number, so it went
 *  straight to the expression engine, which has no unit vocabulary and rejected
 *  it, while the sketch rows above accepted the same text. The measure parser
 *  gets a first look now, and only claims text that names a unit, so a bare
 *  "2+3" still means 3mm more than 2mm rather than 2+3 of whatever this row
 *  happens to be showing. */
/** The canonical number `raw` names, or null when it does not name one.
 *
 *  The same reading `commitField` does, minus the expression engine: an
 *  expression commits on a promise chain through the params engine and can
 *  create a named parameter, neither of which belongs on a keystroke. A field
 *  driven by an expression therefore has no live preview and still answers on
 *  Enter, which is the behaviour it had.
 */
function previewNumber(row: { key: string; kind: FieldKind }, raw: string): number | null {
  const u = unitOf(row.key, row.kind);
  const plain = plainNumber(raw);
  if (plain !== null) return plain * (u?.factor ?? 1);
  const m = u ? measure(raw, u, u.dim) : null;
  return m && typeof m !== "string" && m.unit ? m.value : null;
}

/** The row's own refusal of what was typed, the heads-up box's rule and words
 *  for the same field. Shown under the row from Enter until the next edit. */
const typedProblem = ref<{ row: string; message: string } | null>(null);
watch(() => props.featureId, () => { typedProblem.value = null; });

function rowProblem(key: string): string | null {
  if (typedProblem.value?.row === key) return typedProblem.value.message;
  return previewProblemRow.value === key ? previewProblem.value : null;
}

/** Show what the typed number would build, without committing it.
 *
 *  A value box that only answers on Enter is a value box you have to guess at:
 *  type 1600 into a revolve's angle, watch nothing move, and the only way to
 *  find out whether that was the number you meant is to commit it, look, undo
 *  and try again. The drag handles have shown their result live since they
 *  existed; this is the same feature reaching the panel the handles are the
 *  alternative to.
 *
 *  Through the store's edit preview, so what is on screen is the REAL feature
 *  rebuilt by the engine in the timeline position it will occupy, not a
 *  drawn approximation of it, which would be a second thing to keep in step and
 *  would go on looking right when the kernel had already refused. A preview is
 *  not an undo step, so Enter is still what commits.
 *
 *  Nonsense is ignored rather than flagged. Half-typed text is nonsense most of
 *  the time it is looked at ("1", "16", "16m"), and the error path is `commit`,
 *  which is what the user asked for by pressing Enter.
 */
function previewField(
  row: { key: string; label: string; target: ParamTarget; kind: FieldKind; rule: ValueRule },
  raw: string,
) {
  previewProblemRow.value = row.key;
  if (typedProblem.value?.row === row.key) typedProblem.value = null;
  const v = previewNumber(row, raw);
  if (v === null || valueProblem(row.label, row.rule, v)) return;
  const next = featureWithTarget(store.document, row.target, v);
  if (!next) return; // unresolvable, or the same value it already holds
  if (previewOpenFor === next.id) {
    store.setEditPreview(next);
  } else {
    if (previewOpenFor !== null) store.endEditPreview(false); // a different row
    previewOpenFor = next.id;
    store.beginEditPreview(next.id, next);
  }
}

/** The feature id this panel opened a preview on, so a second keystroke updates
 *  that preview instead of opening another. */
let previewOpenFor: string | null = null;

/** The kernel's refusal of the value being previewed, and the row it belongs to.
 *
 *  Held against the ROW key, not the feature, so the sentence lands under the
 *  box the user is typing in. The refusal itself names a feature, and a feature
 *  has several rows; putting it under all of them would say the same thing four
 *  times about a number only one of them can move. */
const previewProblem = ref<string | null>(null);
const previewProblemRow = ref<string | null>(null);
onUnmounted(
  onPreviewError((m) => {
    // A refusal only means anything while THIS panel is the thing previewing.
    // A drag tool's preview refusal belongs in its own heads-up box, and the
    // panel behind it must not echo it.
    previewProblem.value = previewOpenFor === null ? null : m;
  }),
);

/** Put the model back to what the document says.
 *
 *  `committing` suppresses the rebuild, because the commit landing a line later
 *  schedules one of its own: without that, every Enter paid for the part twice
 *  and the second build was of the state it was already leaving.
 */
function endPreview(committing: boolean) {
  if (previewOpenFor === null) return;
  previewOpenFor = null;
  previewProblem.value = null;
  previewProblemRow.value = null;
  store.endEditPreview(!committing);
}

function commitField(
  row: { key: string; label: string; target: ParamTarget; kind: FieldKind; rule: ValueRule },
  raw: string,
): string | null {
  const { key, target, kind } = row;
  const u = unitOf(key, kind);
  const refuse = (v: number) => {
    const message = valueProblem(row.label, row.rule, v);
    typedProblem.value = message ? { row: key, message } : null;
    return message;
  };
  const plain = plainNumber(raw);
  if (plain !== null) {
    const v = plain * (u?.factor ?? 1);
    const no = refuse(v);
    if (no) return no;
    store.setTargetValue(target, v, kind);
    return null;
  }
  const m = u ? measure(raw, u, u.dim) : null;
  if (typeof m === "string") return m;
  // Only a literal that NAMED a unit is claimed here. A measurement that did
  // not name one is a bare expression, and R4 says those are canonical.
  if (m?.unit) {
    const no = refuse(m.value);
    if (no) return no;
    store.setTargetValue(target, m.value, kind);
    adopt(key, m.unit);
    return null;
  }
  typedProblem.value = null;
  return store.setTargetExpr(target, raw, kind);
}
</script>

<template>
  <div v-if="buildNote" class="param-note" role="note">{{ buildNote }}</div>
  <div v-if="repeatedLabels.length" class="param-row">
    <label>Features</label>
    <div class="param-value">{{ repeatedLabels.join(", ") }}</div>
  </div>
  <SelectionTargetRow
    v-for="t in targetRows"
    :key="`s:${t.field}`"
    :feature-id="featureId"
    :target="t"
  />
  <ChoiceRow
    v-for="c in choiceRows"
    :key="`c:${c.field}`"
    :label="c.label"
    :value="c.current"
    :options="c.options"
    :row-title="c.title"
    :commit="(v) => setOption(c.field, v)"
  />
  <FileRow
    v-for="r in fileRows"
    :key="`f:${r.field}`"
    :label="r.label"
    :value="r.current"
    :filters="r.filters"
    :row-title="r.title"
    :commit="(v) => setOption(r.field, v)"
  />
  <ToggleRow
    v-for="t in toggleRows"
    :key="`t:${t.field}`"
    :label="t.label"
    :value="t.current"
    :commit="(v) => setOption(t.field, v)"
  />
  <ValidatedRow
    v-for="r in sketchRows"
    :key="r.key"
    :label="r.label"
    :value="r.value"
    :unit="r.unit"
    :pick-unit="(x, y) => pickUnit(r.key, 'length', x, y)"
    hint="a value with any unit (2mm, 1 inch, 1/2&quot;)"
    :commit="(raw) => commitSketchDim(r, raw)"
  />
  <ValidatedRow
    v-for="r in featureRows"
    :key="r.key"
    :label="r.label"
    :value="r.value"
    :unit="r.unit"
    :pick-unit="r.pickable ? (x, y) => pickUnit(r.key, r.kind, x, y) : undefined"
    :row-class="r.rowClass"
    :row-title="r.rowTitle"
    hint="a value with any unit (2mm, 1 inch, 1/2&quot;), a parameter, or an expression"
    :commit="(raw) => commitField(r, raw)"
    :preview="(raw) => previewField(r, raw)"
    :preview-end="endPreview"
    :problem="rowProblem(r.key)"
  />
</template>
