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
// Four kinds of row, in the order a form reads best: what the feature is APPLIED
// TO first, then the CHOICES, then the switches, then the numbers. A choice
// usually decides which numbers are even there — pick a texture pattern and the
// Angle and Seed rows appear or go — so putting it under the fields it governs
// would have the reader working upward. The numbers come last because they are
// the long tail.
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

import { onUnmounted, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { useDocValue } from "../../app/useDoc";
import ValidatedRow from "./ValidatedRow.vue";
import ChoiceRow from "./ChoiceRow.vue";
import ToggleRow from "./ToggleRow.vue";
import SelectionTargetRow from "./SelectionTargetRow.vue";
import { displayRound, isPlainNumber } from "../../ui/units";
import { onPreviewError } from "../../ui/previewError";
import { commonUnits, toUnit, tryParseMeasure, unitById, type Dim, type Measured, type UnitDef } from "../../ui/measure";
import { contextMenu } from "../../ui/menu";
import { resolveEntities, toSketchEntity } from "../../sketch/resolve";
import { entityDims } from "../../sketch/entityDims";
import { FEATURE_NUM_FIELDS as NUM_FIELDS, featureWithTarget, type FieldKind } from "../../document/numFields";
import {
  FEATURE_CHOICE_FIELDS,
  FEATURE_TOGGLE_FIELDS,
  choiceValue,
  fieldApplies,
  sharpnessLabel,
  toggleValue,
} from "../../document/optionFields";
import { targetsOf } from "../../features/selectionTargets";
import type { Feature, Num, ParamTarget } from "../../types";

const props = defineProps<{ featureId: string; unit: string }>();

const engine = useEngine();
const store = engine.store;

const feature = useDocValue((doc) => doc.features.find((f) => f.id === props.featureId) ?? null);

// What this feature is applied to. Declared in features/selectionTargets.ts, so
// a feature with no editable selection — a primitive, a scale — simply has no
// rows here rather than an empty heading.
const targetRows = useDocValue((doc) => {
  const f = doc.features.find((x) => x.id === props.featureId);
  return f ? targetsOf(f.type) : [];
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
const sketchRows = useDocValue((doc) => {
  const f = feature.value;
  if (f?.type !== "sketch") return [];
  const resolved = resolveEntities(f, doc.parameters);
  const out: { key: string; label: string; unit: string; value: string; index: number; field: string }[] = [];
  resolved.forEach((e, i) => {
    for (const d of entityDims(e)) {
      const key = `${i}:${d.field}`;
      const u = unitOf(key, "length");
      out.push({
        key,
        label: d.label,
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
  const f = feature.value;
  if (f?.type !== "sketch") return null;
  const copy = resolveEntities(f, store.document.parameters)[row.index];
  if (!copy) return null;
  entityDims(copy).find((x) => x.field === row.field)?.write(m.value);
  const entities = f.entities.map((ent, j) => (j === row.index ? toSketchEntity(copy) : ent));
  store.updateFeature(f.id, { entities } as Partial<Feature>);
  adopt(row.key, m.unit);
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

const choiceRows = useDocValue((doc) => {
  const f = doc.features.find((x) => x.id === props.featureId);
  if (!f) return [];
  const values = f as unknown as Record<string, unknown>;
  return (FEATURE_CHOICE_FIELDS[f.type] ?? [])
    .filter((c) => fieldApplies(f.type, c.field, values))
    .map((c) => ({ ...c, current: choiceValue(f, c) }));
});

const toggleRows = useDocValue((doc) => {
  const f = doc.features.find((x) => x.id === props.featureId);
  if (!f) return [];
  const values = f as unknown as Record<string, unknown>;
  return (FEATURE_TOGGLE_FIELDS[f.type] ?? [])
    .filter((t) => fieldApplies(f.type, t.field, values))
    .map((t) => ({ ...t, current: toggleValue(f, t) }));
});

function setOption(field: string, value: string | boolean) {
  store.updateFeature(props.featureId, { [field]: value } as unknown as Partial<Feature>);
}

const featureRows = useDocValue((doc) => {
  const f = doc.features.find((x) => x.id === props.featureId);
  if (!f || f.type === "sketch") return [];
  const fields = NUM_FIELDS[f.type];
  if (!fields) return [];
  const values = f as unknown as Record<string, unknown>;
  // A row for a field this feature will never read is a control with nothing on
  // the other end of it: turn the Seed on a knurl and the model does not move,
  // and nothing says why. The rule lives with the field inventory so the tool
  // that creates the feature and the rows that edit it hide the same ones.
  return fields.filter(([field]) => fieldApplies(f.type, field, values)).map(([field, label, kind]) => {
    const cur = (f as unknown as Record<string, Num | undefined>)[field];
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
      // One label is not a constant: a texture's shape slider is a flat LAND
      // width on a faceted surface and a crispness on a smooth one, and calling
      // both "Sharpness" describes neither.
      label: f.type === "texture" && field === "sharpness"
        ? sharpnessLabel(values["profile"]).text
        : label,
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
  if (isPlainNumber(raw)) return Number(raw.trim()) * (u?.factor ?? 1);
  const m = u ? measure(raw, u, u.dim) : null;
  return m && typeof m !== "string" && m.unit ? m.value : null;
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
 *  rebuilt by the sidecar in the timeline position it will occupy — not a
 *  drawn approximation of it, which would be a second thing to keep in step and
 *  would go on looking right when the kernel had already refused. A preview is
 *  not an undo step, so Enter is still what commits.
 *
 *  Nonsense is ignored rather than flagged. Half-typed text is nonsense most of
 *  the time it is looked at ("1", "16", "16m"), and the error path is `commit`,
 *  which is what the user asked for by pressing Enter.
 */
function previewField(
  row: { key: string; target: ParamTarget; kind: FieldKind },
  raw: string,
) {
  previewProblemRow.value = row.key;
  const v = previewNumber(row, raw);
  if (v === null) return;
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
  row: { key: string; target: ParamTarget; kind: FieldKind },
  raw: string,
): string | null {
  const { key, target, kind } = row;
  const u = unitOf(key, kind);
  if (isPlainNumber(raw)) {
    store.setTargetValue(target, Number(raw.trim()) * (u?.factor ?? 1), kind);
    return null;
  }
  const m = u ? measure(raw, u, u.dim) : null;
  if (typeof m === "string") return m;
  // Only a literal that NAMED a unit is claimed here. A measurement that did
  // not name one is a bare expression, and R4 says those are canonical.
  if (m?.unit) {
    store.setTargetValue(target, m.value, kind);
    adopt(key, m.unit);
    return null;
  }
  return store.setTargetExpr(target, raw, kind);
}
</script>

<template>
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
    :problem="previewProblemRow === r.key ? previewProblem : null"
  />
</template>
