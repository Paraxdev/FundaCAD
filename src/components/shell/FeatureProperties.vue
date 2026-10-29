<script setup lang="ts">
// One feature's editable values, the write path shared by the history and the Parameters panel. Every row kind is
// declared in document/numFields.ts and document/optionFields.ts, never here.

import { onUnmounted, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { useBuildValue, useDocValue } from "../../app/useDoc";
import { featureNotes, featurePlaceholders, placeholderNote } from "../../ui/featureNotes";
import ValidatedRow from "./ValidatedRow.vue";
import ChoiceRow from "./ChoiceRow.vue";
import ToggleRow from "./ToggleRow.vue";
import FileRow from "./FileRow.vue";
import SelectionTargetRow from "./SelectionTargetRow.vue";
import { displayRound, plainNumber } from "../../ui/units";
import { onPreviewError } from "../../ui/previewError";
import {
  canonicalTyping,
  commonUnits,
  tryParseMeasure,
  unitById,
  type Dim,
  type Measured,
  type UnitDef,
} from "../../ui/measure";
import { resolveEntities, resolveRealEntities, toSketchEntity } from "../../sketch/resolve";
import { entityDims } from "../../sketch/entityDims";
import { applyDrivingDimsDirect, dimAnchor, upsertDrivingDim } from "../../sketch/directDims";
import { toast } from "../../ui/toast";
import {
  featureNumFields,
  featureValueRule,
  featureWithTarget,
  readField,
  targetFeatureId,
  valueProblem,
  type FieldKind,
  type ValueRule,
} from "../../document/numFields";
import {
  choiceFieldsFor,
  choiceValue,
  fieldApplies,
  datumChoiceIsNoOp,
  datumChoiceRow,
  fieldLabel,
  fileFieldsFor,
  fileValue,
  patternAxisChoice,
  patternAxisPatch,
  toggleFieldsFor,
  toggleValue,
} from "../../document/optionFields";
import { mechanismDriveChoice, mechanismDrivePatch } from "../../document/mechanism";
import { targetsFor } from "../../features/selectionTargets";
import { featureLabel } from "../../features/patternSources";
import { holeChoicePatch } from "../../features/holeStandards";
import { thinTogglePatch } from "../../features/thinExtrude";
import { asFeature } from "../../types";
import type { DimField, Feature, Num, ParamTarget } from "../../types";

const props = defineProps<{ featureId: string; unit: string }>();

const engine = useEngine();
const store = engine.store;

const feature = useDocValue((doc) => doc.features.find((f) => f.id === props.featureId) ?? null);

// What this feature is applied to (features/selectionTargets.ts). A feature without an editable selection has no rows
// here rather than an empty heading.
const targetRows = useDocValue((doc) => {
  const f = doc.features.find((x) => x.id === props.featureId);
  return f ? targetsFor(f) : [];
});

// A feature of a type this version does not know shows no fields, so it stays
// exactly as the newer version wrote it.
const placeholder = useBuildValue(
  (b) => featurePlaceholders({ skippedFeatures: b?.result?.skippedFeatures }).get(props.featureId) ?? null,
);
// What the build had to say about this feature, the same note its history chip
// carries, written out where the feature's values are read.
const buildNote = useBuildValue((b) =>
  placeholder.value !== null
    ? placeholderNote(placeholder.value)
    : b
      ? (featureNotes({
          featureErrors: b.result?.featureErrors,
          errorFeatureId: b.errorFeatureId,
          diagnostics: b.result?.diagnostics,
        }).get(props.featureId) ?? null)
      : null,
);

// The features a pattern repeats, by name. Read only: which features is chosen
// by pointing at them before Pattern starts.
const repeatedLabels = useDocValue((doc) => {
  const f = doc.features.find((x) => x.id === props.featureId);
  const ids = (f as { features?: string[] } | undefined)?.features ?? [];
  return ids.map((id) => {
    const src = doc.features.find((x) => x.id === id);
    return src ? featureLabel(src) : id;
  });
});

// The unit each row shows, per row like sketch/dimInput.ts: the document's unit, then a typed unit, then its chip,
// which converts rather than reinterprets. Keyed by row, so a vanished row drops its override.

const shownUnit = ref<Record<string, string>>({});

/** The dimension a field kind measures, or null for a unitless one (a count,
 *  and the real-valued ratios that share its kind). */
function dimOf(kind: FieldKind): Dim | null {
  return kind === "angle" ? "angle" : kind === "count" ? null : "length";
}

/** The row's own override while it fits the field's dimension, else the document's for a length and degrees for an
 *  angle, the only unit angles use anywhere. */
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

/** What the chip offers, the shown unit included when it is not a common one (a typed µm). */
function unitChoices(u: UnitDef): string[] {
  const ids = commonUnits(u.dim).map((x) => x.id);
  return ids.includes(u.id) ? ids : [...ids, u.id];
}

/** Typed text as a measurement of `dim`, with no parameter scope (those belong to the expression engine). Null when it
 *  is not a measurement, a string when it is one of the wrong kind, such as inches on an angle. */
function measure(raw: string, showing: UnitDef | null, dim: Dim): Measured | string | null {
  const m = tryParseMeasure(raw, showing, {});
  if (!m) return null;
  if (m.unit && m.unit.dim !== dim) {
    return `${m.unit.label} is not ${dim === "angle" ? "an angle" : "a length"}`;
  }
  return m;
}

// Sketch: editable per-entity dimensions. Editing entity i writes back only that entity, leaving the others and their
// parameter references untouched.

/** Capitalised for the row label, entity.type is lowercase JSON. */
const TYPE_NAME: Record<string, string> = {
  line: "Line",
  arc: "Arc",
  circle: "Circle",
  rectangle: "Rectangle",
  slot: "Slot",
  polygon: "Polygon",
  bspline: "Curve",
  spline: "Curve",
  point: "Point",
};

const sketchRows = useDocValue((doc) => {
  const f = asFeature(feature.value, "sketch");
  if (!f) return [];
  const resolved = resolveEntities(f, doc.parameters);
  const dimsOf = resolved.map((e) => entityDims(e));
  // Only a type with more than one dimensioned entity gets a "Line 1", "Line 2" prefix (SK-7), a lone circle still says
  // Diameter.
  const perType = new Map<string, number>();
  resolved.forEach((e, i) => {
    if (dimsOf[i]!.length) perType.set(e.type, (perType.get(e.type) ?? 0) + 1);
  });
  const out: {
    key: string;
    label: string;
    unit: string | null;
    units: string[] | undefined;
    value: number;
    index: number;
    field: string;
  }[] = [];
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
        unit: u?.id ?? null,
        units: u ? unitChoices(u) : undefined,
        value: d.valueMm,
        index: i,
        field: d.field,
      });
    }
  });
  return out;
});

/** Any measurement, a bare number in the shown unit. */
function parseSketchDim(key: string, raw: string): number {
  const m = measure(raw, unitOf(key, "length"), "length");
  if (typeof m === "string") throw new Error(m);
  if (!m) throw new Error("not a value");
  return m.value;
}

function commitSketchDim(row: { index: number; field: string }, value: number) {
  const f = asFeature(feature.value, "sketch");
  if (!f) return;
  const resolved = resolveEntities(f, store.document.parameters);
  const copy = resolved[row.index];
  if (!copy) return;
  // Lengths, diameters and rectangle sizes go through the solver like SketchMode.editDimension, so whatever is pinned to
  // the entity stays intact. Slots and polygons have no such constraint and stay direct coordinate writes.
  const driven = upsertDrivingDim(f.constraints ?? [], copy, row.field as DimField, value);
  if (driven) {
    const solve = store.headlessSolve;
    if (!solve) {
      // No live solver session (WASM failed or none wired): SketchMode's dead-solver fallback, applied to every entity the
      // constraints resolve without solving.
      const all = resolveRealEntities(f, store.document.parameters);
      applyDrivingDimsDirect(all, driven);
      store.updateFeature(f.id, { entities: all.map(toSketchEntity), constraints: driven } as Partial<Feature>);
      return;
    }
    void (async () => {
      const solved = await solve(
        { ...f, constraints: driven },
        store.document.parameters,
        dimAnchor(resolved, driven, driven[driven.length - 1]!),
      );
      if (!solved) {
        toast(`Could not satisfy this ${row.field} with the sketch's other constraints`);
        return;
      }
      store.updateFeature(f.id, { entities: solved.entities, constraints: driven } as Partial<Feature>);
    })();
    return;
  }
  entityDims(copy)
    .find((x) => x.field === row.field)
    ?.write(value);
  const entities = f.entities.map((ent, j) => (j === row.index ? toSketchEntity(copy) : ent));
  store.updateFeature(f.id, { entities } as Partial<Feature>);
}

// Rows show the feature as the model on screen has it, the tool's live version while a tool edits it.
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
        : f.type === "mechanism" && c.field === "drive"
          ? { ...c, ...mechanismDriveChoice(values) }
          : { ...c, ...(datumChoiceRow(f, c.field, store.document.features) ?? { current: choiceValue(f, c) }) },
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

// Written straight onto the feature: no expression path and no unit, so updateFeature is the whole commit.
function setOption(field: string, value: string | boolean) {
  if (datumChoiceIsNoOp(field, value)) return;
  let patch: Record<string, unknown> = { [field]: value };
  const f = store.document.features.find((x) => x.id === props.featureId);
  if (f?.type === "patternCircular" && field === "axis") {
    const axis = patternAxisPatch(String(value));
    if (!axis) return;
    patch = axis;
  }
  if (f?.type === "mechanism" && field === "drive") patch = mechanismDrivePatch(String(value));
  const hole = asFeature(f, "hole");
  if (hole) {
    patch = holeChoicePatch(hole, field, value, (k) =>
      store.isParamBound({ kind: "feature", feature: hole.id, field: k }),
    );
  }
  if (f?.type === "chamfer" && field === "chamferType" && value === "twoDistance" && f.distance2 == null) {
    patch.distance2 = f.distance;
  }
  if (f?.type === "extrude" && field === "thin") patch = thinTogglePatch(f, value === true);
  store.updateFeature(props.featureId, patch as unknown as Partial<Feature>);
}

// useDocValue, not a computed: store.document keeps its identity across an in-place mutate (useDoc.ts), and these rows
// read the untracked `boundExpr`, so a commit from a drag handle or a parameter would never reach the panel.
const featureRows = useDocValue(() => {
  const f = liveFeature();
  if (!f || f.type === "sketch") return [];
  const values = f as unknown as Record<string, unknown>;
  // featureNumFields, not the app table: a plugin owns its types' rows, and an undescribed type lists its numeric fields
  // verbatim so they stay editable without the plugin.
  const fields = featureNumFields(f.type, values);
  if (!fields.length) return [];
  // Hide rows for fields this feature never reads (a knurl's Seed). The rule lives with the field inventory so the tool
  // and these rows hide the same ones.
  return fields
    .filter(([field]) => fieldApplies(f.type, field, values))
    .map(([field, label, kind]) => {
      const cur = readField(values, field) as Num | undefined;
      const target: ParamTarget = { kind: "feature", feature: f.id, field };
      const bound = store.boundExpr(target);
      const u = unitOf(field, kind);
      // A bound field edits its EXPRESSION (canonical units); a plain field shows its number in the unit the row is
      // showing, and a count is unitless.
      const plain = !bound && typeof cur === "number";
      const fx = bound && store.isParamBound(target);
      return {
        key: field,
        // Labels can vary with the feature: a shape slider is a land width on a faceted surface and a crispness on a smooth
        // one, so the owner of the type answers first.
        label: fieldLabel(f.type, field, values)?.text ?? label,
        rule: featureValueRule(f.type, field),
        // Expressions are in canonical units so a file evaluates the same everywhere, so the chip states it and is no picker.
        unit: bound ? (dimOf(kind) === "angle" ? "deg" : dimOf(kind) ? "mm" : null) : (u?.id ?? null),
        units: !bound && u ? unitChoices(u) : undefined,
        value: plain ? (cur as number) : null,
        text: bound ? bound.expr : plain || cur === undefined ? null : String(cur),
        target,
        kind,
        rowClass: fx ? "fx-row" : undefined,
        rowTitle: fx && bound ? `${bound.name} = ${bound.expr} = ${displayRound(bound.value)}` : undefined,
      };
    });
});

/** A whole fraction is one value ("1 1/2"), so it reads in the row's unit like a plain number, not as arithmetic. */
const WHOLE_FRACTION = /^[+-]?\s*(\d+\s+)?\d+\s*\/\s*\d+$/;

function isFraction(raw: string): boolean {
  try {
    return WHOLE_FRACTION.test(canonicalTyping(raw));
  } catch {
    return false;
  }
}

/** A plain number or a fraction is in the row's unit, a literal naming a unit ("5in", "2mm+3cm") is a measurement in
 *  it, anything else is an expression in canonical mm and deg (plan decision R4), so a file evaluates the same on
 *  every machine. Null hands the text to the parameter engine. */
function parseField(row: { key: string; kind: FieldKind }, raw: string): number | null {
  const u = unitOf(row.key, row.kind);
  const plain = plainNumber(raw);
  if (plain !== null) return plain * (u?.factor ?? 1);
  const frac = isFraction(raw) ? tryParseMeasure(raw, u, {}) : null;
  if (frac) return frac.value;
  const m = u ? measure(raw, u, u.dim) : null;
  if (typeof m === "string") throw new Error(m);
  // Only a literal that NAMED a unit is claimed here. A measurement that did not name one is a bare expression.
  return m?.unit ? m.value : null;
}

function rowProblem(key: string): string | null {
  return previewProblemRow.value === key ? previewProblem.value : null;
}

/** Shows what the typed number would build through the store's edit preview: the real feature rebuilt in place, not an
 *  approximation. Not an undo step, Enter still commits, and half-typed nonsense is ignored. */
function previewField(row: { key: string; target: ParamTarget }, v: number | null) {
  previewProblemRow.value = row.key;
  if (v === null) return;
  const id = targetFeatureId(row.target);
  // The value the document already holds shows the document's own feature again while a preview of it is open.
  const next =
    featureWithTarget(store.document, row.target, v) ??
    (previewOpenFor === id ? (store.document.features.find((f) => f.id === id) ?? null) : null);
  if (!next) return;
  if (previewOpenFor === next.id) {
    store.setEditPreview(next);
  } else {
    if (previewOpenFor !== null) store.endEditPreview(false); // a different row
    previewOpenFor = next.id;
    // A typed number picks no geometry, so nothing after the feature has to roll
    // away: an exploded assembly keeps its parts where they are while typing.
    store.beginEditPreview(next.id, next, { inPlace: true });
  }
}

/** The feature id this panel opened a preview on, so a second keystroke updates
 *  that preview instead of opening another. */
let previewOpenFor: string | null = null;

/** The kernel's refusal of the previewed value, held against the row key so it lands under the box being typed in,
 *  not under every row of the feature. */
const previewProblem = ref<string | null>(null);
const previewProblemRow = ref<string | null>(null);
onUnmounted(
  onPreviewError((m) => {
    // A refusal matters only while this panel is previewing, a drag tool's refusal belongs in its own heads-up box.
    previewProblem.value = previewOpenFor === null ? null : m;
  }),
);

/** Puts the model back to the document. `committing` skips the rebuild, the commit schedules its own. */
function endPreview(committing: boolean) {
  if (previewOpenFor === null) return;
  previewOpenFor = null;
  previewProblem.value = null;
  previewProblemRow.value = null;
  store.endEditPreview(!committing);
}

function validateField(row: { label: string; rule: ValueRule }, v: number): string | null {
  return valueProblem(row.label, row.rule, v);
}
</script>

<template>
  <div v-if="buildNote" class="param-note" role="note">{{ buildNote }}</div>
  <template v-if="placeholder === null">
    <div v-if="repeatedLabels.length" class="param-row">
      <label>Features</label>
      <div class="param-value">{{ repeatedLabels.join(", ") }}</div>
    </div>
    <SelectionTargetRow v-for="t in targetRows" :key="`s:${t.field}`" :feature-id="featureId" :target="t" />
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
      :field="r.key"
      :label="r.label"
      :value="r.value"
      :unit="r.unit"
      :units="r.units"
      hint='a value with any unit (2mm, 1 inch, 1/2")'
      :parse="(raw) => parseSketchDim(r.key, raw)"
      @commit="(v) => commitSketchDim(r, v)"
      @update:unit="(id) => adopt(r.key, unitById(id))"
    />
    <ValidatedRow
      v-for="r in featureRows"
      :key="r.key"
      :field="r.key"
      :label="r.label"
      :value="r.value"
      :text="r.text"
      :unit="r.unit"
      :units="r.units"
      :row-class="r.rowClass"
      :row-title="r.rowTitle"
      hint='a value with any unit (2mm, 1 inch, 1/2"), a parameter, or an expression'
      :parse="(raw) => parseField(r, raw)"
      :validate="(v) => validateField(r, v)"
      :expression="(raw) => store.setTargetExpr(r.target, raw, r.kind)"
      :preview="(v) => previewField(r, v)"
      :preview-end="endPreview"
      :problem="rowProblem(r.key)"
      @commit="(v) => store.setTargetValue(r.target, v, r.kind)"
      @update:unit="(id) => adopt(r.key, unitById(id))"
    />
  </template>
</template>
