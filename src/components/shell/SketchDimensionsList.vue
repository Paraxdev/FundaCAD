<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import FieldRow from "../ui/FieldRow.vue";
import NumberField from "../ui/NumberField.vue";
import { valueProblem } from "../../document/numFields";
import { useSketchAnnotationStore } from "../../stores/sketchAnnotations";
import { distinctNames } from "../../sketch/sketchNames";
import { getUnit, onUnitChange } from "../../ui/units";
import { tryParseMeasure } from "../../ui/measure";
import type { DimItem } from "../../sketch/sketchDimensions";

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

const rows = computed(() => {
  for (const d of s.dimItems) if (!order.has(d.key)) order.set(d.key, order.size);
  const items = [...s.dimItems].sort((a, b) => order.get(a.key)! - order.get(b.key)!);
  const names = distinctNames(items.map((d) => d.name));
  return items.map((item, i) => ({ item, name: names[i]! }));
});

const unitOf = (d: DimItem) => (d.kind === "angle" ? "deg" : lengthUnit.value);

function hint(d: DimItem): string | undefined {
  if (d.conflict) return "Conflicting";
  if (d.over) return "Redundant";
  return undefined;
}

// A formula or a bound dimension goes to commitExpr, as the badge editor does.
function parse(d: DimItem) {
  if (d.expr !== undefined) return () => null;
  if (!d.commitExpr) return undefined;
  return (raw: string, unit: Parameters<typeof tryParseMeasure>[1]) => tryParseMeasure(raw, unit)?.value ?? null;
}

function validate(d: DimItem) {
  return (v: number) => (d.kind === "angle" ? null : valueProblem("Length", { positive: true }, v));
}

let refocus: { key: string; at: number } | null = null;

function committed(key: string) {
  refocus = { key, at: performance.now() };
}

function commit(d: DimItem, mm: number | null) {
  if (mm === null) return;
  committed(d.key);
  d.commit(mm);
}

function expression(d: DimItem, raw: string): string | null {
  committed(d.key);
  return d.commitExpr?.(raw) ?? "Not editable";
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

function focusIn(d: DimItem) {
  s.dimLit = d.key;
  s.dimHooks?.light(d.entities);
}
function focusOut(d: DimItem, e: FocusEvent) {
  if (e.relatedTarget instanceof Node && (e.currentTarget as Node).contains(e.relatedTarget)) return;
  if (s.dimLit === d.key) s.dimLit = null;
  s.dimHooks?.light(null);
}
</script>

<template>
  <p v-if="!rows.length" class="dim-empty">No dimensions yet.</p>
  <ul v-else ref="list" class="dim-list">
    <li
      v-for="r in rows"
      :key="r.item.key"
      class="dim-row"
      :data-dim-key="r.item.key"
      @focusin="focusIn(r.item)"
      @focusout="focusOut(r.item, $event)"
    >
      <FieldRow v-slot="f" :label="r.name" :hint="hint(r.item)" :error="err[r.item.key]">
        <NumberField
          :id="f.id"
          size="sm"
          commit="change"
          :labelledby="f.labelId"
          :aria-describedby="f.describedby"
          :width-ch="6"
          :unit="unitOf(r.item)"
          :model-value="r.item.valueMm"
          :text="r.item.expr ?? null"
          :parse="parse(r.item)"
          :validate="validate(r.item)"
          :expression="(raw: string) => expression(r.item, raw)"
          :disabled="r.item.driven"
          disabled-reason="A reference dimension measures, it does not drive"
          @update:model-value="commit(r.item, $event)"
          @error="err[r.item.key] = $event ?? undefined"
        />
      </FieldRow>
    </li>
  </ul>
</template>
