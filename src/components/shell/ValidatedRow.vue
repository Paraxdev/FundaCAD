<script setup lang="ts">
// The unit is a chip, not part of the label: a label is a name and a unit is part of the value ("Radius mm | 5in" reads
// as a contradiction). The same vocabulary as sketch/dimInput.ts, down to the class.

import ValidatedInput from "./ValidatedInput.vue";

const props = defineProps<{
  label: string;
  /** The value's key, rendered as data-field so a row can be found by it. */
  field?: string | undefined;
  /** Current committed value, in whatever spelling the panel wants shown. */
  value: string;
  /** Return an error message to show, or null on success. */
  commit: (raw: string) => string | null;
  /** Extra classes for the row (fx-row, param-stale, …). */
  rowClass?: string | undefined;
  /** Tooltip for the row; the input's own title is the error, when there is one. */
  rowTitle?: string | undefined;
  hint?: string | undefined;
  /** What the value is measured in, e.g. "mm" or "°". Empty for a unitless
   *  field, which gets no chip rather than a blank one. */
  unit?: string | undefined;
  /** Opens the unit picker under the chip. Absent, the chip is a caption: only a number can be re-shown in another
   *  unit, an expression cannot. */
  pickUnit?: ((x: number, y: number) => void) | undefined;
  /** Shows what the typed text would do without committing, passed through to ValidatedInput. */
  preview?: ((raw: string) => void) | undefined;
  previewEnd?: ((committing: boolean) => void) | undefined;
  /** Why the previewed value could not be built, shown as a line under the row since a tooltip is only found by
   *  someone who already suspects one. */
  problem?: string | null | undefined;
}>();

function onPickUnit(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  props.pickUnit?.(r.left, r.bottom + 2);
}
</script>

<template>
  <div class="param-row" :class="rowClass" :title="rowTitle" :data-field="field">
    <label>{{ label }}</label>
    <div class="param-value">
      <ValidatedInput
        :aria-label="label"
        :value="value"
        :commit="commit"
        :hint="hint"
        :preview="preview"
        :preview-end="previewEnd"
        :problem="problem"
      />
      <button v-if="unit && pickUnit" type="button" class="dim-unit" title="Change unit" @click="onPickUnit">{{
        unit
      }}</button>
      <span v-else-if="unit" class="dim-unit static" title="Expressions are written in this unit">{{ unit }}</span>
    </div>
    <p v-if="problem" class="param-problem">{{ problem }}</p>
  </div>
</template>
