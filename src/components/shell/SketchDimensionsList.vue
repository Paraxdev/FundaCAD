<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import FieldRow from "../ui/FieldRow.vue";
import NumberField from "../ui/NumberField.vue";
import { valueProblem } from "../../document/numFields";
import { useSketchAnnotationStore } from "../../stores/sketchAnnotations";
import { distinctNames } from "../../sketch/sketchNames";
import { getUnit, onUnitChange } from "../../ui/units";
import { tryParseMeasure } from "../../ui/measure";
import type { DimKind } from "../../sketch/annotationFormat";

const s = useSketchAnnotationStore();
const list = ref<HTMLElement | null>(null);
const lengthUnit = ref(getUnit());
const offUnit = onUnitChange(() => (lengthUnit.value = getUnit()));
onBeforeUnmount(offUnit);

// The store moves a rectangle side between its entity and constraint blocks, so rows keep the order they first
// appeared in, per sketch.
const order = new Map<string, number>();
const err = ref<Record<string, string | undefined>>({});
watch(
  () => s.dimPlane,
  () => {
    order.clear();
    err.value = {};
  },
  { flush: "sync" },
);

interface Row {
  key: string;
  name: string;
  valueMm: number;
  expr?: string;
  kind?: DimKind;
  driven: boolean;
  conflict: boolean;
  over: boolean;
  formula: boolean;
  entities: readonly string[];
}

const sameRow = (a: Row, b: Row) =>
  a.key === b.key &&
  a.name === b.name &&
  a.valueMm === b.valueMm &&
  a.expr === b.expr &&
  a.kind === b.kind &&
  a.driven === b.driven &&
  a.conflict === b.conflict &&
  a.over === b.over &&
  a.formula === b.formula &&
  a.entities.join() === b.entities.join();

// Every 5% zoom step rebuilds the items to move the badges, keeping the old rows skips a full list render.
const rows = computed<readonly Row[]>((prev) => {
  for (const d of s.dimItems) if (!order.has(d.key)) order.set(d.key, order.size);
  const items = [...s.dimItems].sort((a, b) => order.get(a.key)! - order.get(b.key)!);
  const names = distinctNames(items.map((d) => d.name));
  const next = items.map((d, i): Row => ({
    key: d.key,
    name: names[i]!,
    valueMm: d.valueMm,
    ...(d.expr !== undefined ? { expr: d.expr } : {}),
    ...(d.kind ? { kind: d.kind } : {}),
    driven: !!d.driven,
    conflict: !!d.conflict,
    over: !!d.over,
    formula: !!d.commitExpr,
    entities: d.entities,
  }));
  return prev && prev.length === next.length && next.every((r, i) => sameRow(r, prev[i]!)) ? prev : next;
});

const itemOf = (key: string) => s.dimItems.find((d) => d.key === key);

const unitOf = (r: Row) => (r.kind === "angle" ? "deg" : lengthUnit.value);

function hint(r: Row): string | undefined {
  if (r.conflict) return "Conflicting";
  if (r.over) return "Redundant";
  return undefined;
}

// A formula or a bound dimension goes to commitExpr, as the badge editor does.
function parse(r: Row) {
  if (r.expr !== undefined) return () => null;
  if (!r.formula) return undefined;
  return (raw: string, unit: Parameters<typeof tryParseMeasure>[1]) => tryParseMeasure(raw, unit)?.value ?? null;
}

function validate(r: Row) {
  return (v: number) => (r.kind === "angle" ? null : valueProblem("Length", { positive: true }, v));
}

let refocus: { key: string; at: number } | null = null;

function committed(key: string) {
  refocus = { key, at: performance.now() };
}

function commit(r: Row, mm: number | null) {
  if (mm === null) return;
  committed(r.key);
  itemOf(r.key)?.commit(mm);
}

function expression(r: Row, raw: string): string | null {
  committed(r.key);
  return itemOf(r.key)?.commitExpr?.(raw) ?? "Not editable";
}

// A rebuild redraws the badges and may swap the list's elements, keep focus on the row the user committed.
watch(
  () => s.dimItems,
  async () => {
    await nextTick();
    const want = refocus;
    refocus = null;
    if (!want || performance.now() - want.at > 2000) return;
    if (list.value?.contains(document.activeElement)) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    list.value?.querySelector<HTMLInputElement>(`[data-dim-key="${CSS.escape(want.key)}"] input`)?.focus();
  },
);

function focusIn(r: Row) {
  s.dimLit = r.key;
  s.dimHooks?.light([...r.entities]);
}
function focusOut(r: Row, e: FocusEvent) {
  if (e.relatedTarget instanceof Node && (e.currentTarget as Node).contains(e.relatedTarget)) return;
  if (s.dimLit === r.key) s.dimLit = null;
  s.dimHooks?.light(null);
}
</script>

<template>
  <p v-if="!rows.length" class="dim-empty">No dimensions yet.</p>
  <ul v-else ref="list" class="dim-list">
    <li
      v-for="r in rows"
      :key="r.key"
      class="dim-row"
      :data-dim-key="r.key"
      @focusin="focusIn(r)"
      @focusout="focusOut(r, $event)"
    >
      <FieldRow v-slot="f" :label="r.name" :hint="hint(r)" :error="err[r.key]">
        <NumberField
          :id="f.id"
          size="sm"
          commit="change"
          :labelledby="f.labelId"
          :aria-describedby="f.describedby"
          :width-ch="6"
          :unit="unitOf(r)"
          :model-value="r.valueMm"
          :text="r.expr ?? null"
          :parse="parse(r)"
          :validate="validate(r)"
          :expression="(raw: string) => expression(r, raw)"
          :disabled="r.driven"
          disabled-reason="A reference dimension measures, it does not drive"
          @update:model-value="commit(r, $event)"
          @error="err[r.key] = $event ?? undefined"
        />
      </FieldRow>
    </li>
  </ul>
</template>
