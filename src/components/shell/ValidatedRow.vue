<script setup lang="ts">
// A labelled row of feature values: label on the left, a committing text input
// on the right, and the unit the value is measured in as a chip beside it. The
// input's behaviour (and the mid-edit guard) lives in ValidatedInput; this only
// adds the row chrome, the fx-row / param-stale classes and the row tooltip.
//
// The unit is a chip rather than part of the label because a label is a name and
// a unit is part of the value: "Radius mm | 5in" reads as a contradiction, and
// the label column is where the width runs out first. Same vocabulary the
// heads-up dimension box uses (sketch/dimInput.ts), down to the class.

import ValidatedInput from "./ValidatedInput.vue";

const props = defineProps<{
  label: string;
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
  /** Opens the unit picker, positioned under the chip. Absent makes the chip a
   *  caption instead of a button: a value can only be re-shown in another unit
   *  when it is a number, and an expression is neither. */
  pickUnit?: ((x: number, y: number) => void) | undefined;
  /** Show what the typed text would do, without committing it. See
   *  ValidatedInput; passed straight through. */
  preview?: ((raw: string) => void) | undefined;
  previewEnd?: ((committing: boolean) => void) | undefined;
}>();

function onPickUnit(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  props.pickUnit?.(r.left, r.bottom + 2);
}
</script>

<template>
  <div class="param-row" :class="rowClass" :title="rowTitle">
    <label>{{ label }}</label>
    <div class="param-value">
      <ValidatedInput
        :value="value"
        :commit="commit"
        :hint="hint"
        :preview="preview"
        :preview-end="previewEnd"
      />
      <button
        v-if="unit && pickUnit"
        type="button"
        class="dim-unit"
        title="Change unit"
        @click="onPickUnit"
      >{{ unit }}</button>
      <span
        v-else-if="unit"
        class="dim-unit static"
        title="Expressions are written in this unit"
      >{{ unit }}</span>
    </div>
  </div>
</template>
