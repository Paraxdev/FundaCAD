<script setup lang="ts">
// The unit is a chip, not part of the label: a label is a name and a unit is part of the value ("Radius mm | 5in" reads
// as a contradiction).

import { ref } from "vue";
import NumberField from "../ui/NumberField.vue";
import type { UnitDef } from "../../ui/measure";

defineProps<{
  label: string;
  /** The value's key, rendered as data-field so a row can be found by it. */
  field?: string | undefined;
  /** Canonical, or null while `text` shows what drives it. */
  value: number | null;
  /** An expression shown in place of the value. */
  text?: string | null | undefined;
  /** A ui/measure unit id, the unit the value is shown in. Absent for a unitless field, which gets no chip. */
  unit?: string | null | undefined;
  /** Unit ids the chip offers. Absent, the chip is a caption: only a number can be re-shown in another unit, an
   *  expression cannot. */
  units?: readonly string[] | undefined;
  parse: (raw: string, unit: UnitDef | null) => number | null;
  validate?: ((value: number) => string | null) | undefined;
  /** Commits what `parse` leaves as text, returning the refusal or null. */
  expression?: ((raw: string) => string | null) | undefined;
  /** Extra classes for the row (fx-row, param-stale, …). */
  rowClass?: string | undefined;
  /** Tooltip for the row; the input's own title is the error, when there is one. */
  rowTitle?: string | undefined;
  hint?: string | undefined;
  preview?: ((value: number | null) => void) | undefined;
  previewEnd?: ((committing: boolean) => void) | undefined;
  /** Why the previewed value could not be built, shown as a line under the row since a tooltip is only found by
   *  someone who already suspects one. */
  problem?: string | null | undefined;
}>();
const emit = defineEmits<{ commit: [number]; "update:unit": [string] }>();

const refused = ref<string | null>(null);

function onValue(v: number | null) {
  if (v !== null) emit("commit", v);
}
</script>

<template>
  <div class="param-row" :class="rowClass" :title="rowTitle" :data-field="field">
    <label>{{ label }}</label>
    <div class="param-value">
      <NumberField
        :label="label"
        :title="hint"
        :model-value="value"
        :text="text"
        :unit="unit"
        :units="units"
        :unit-tip="units?.length ? 'Change unit' : 'Expressions are written in this unit'"
        adopt-unit
        :parse="parse"
        :validate="validate"
        :expression="expression"
        :preview="preview"
        :preview-end="previewEnd"
        :problem="problem"
        @update:model-value="onValue"
        @update:unit="emit('update:unit', $event)"
        @error="refused = $event"
      />
    </div>
    <p v-if="refused || problem" class="param-problem">{{ refused ?? problem }}</p>
  </div>
</template>
