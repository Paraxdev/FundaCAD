<script setup lang="ts">
// A labelled row whose value is one of a fixed set: label on the left, a
// dropdown on the right.
//
// The sibling of ValidatedRow, and deliberately the same row chrome — same
// grid, same label column, same field height — because these sit interleaved
// with the value rows in one list and a control that announced itself as a
// different KIND of control would break the column. What it does not have is
// ValidatedInput's mid-edit guard: a <select> has no half-typed state to
// protect, so it commits on change and there is nothing to reject.

import type { ChoiceOption } from "../../document/optionFields";

defineProps<{
  label: string;
  value: string;
  options: ChoiceOption[];
  commit: (value: string) => void;
  rowTitle?: string | undefined;
}>();
</script>

<template>
  <div class="param-row" :title="rowTitle">
    <label>{{ label }}</label>
    <div class="param-value">
      <select
        class="param-select"
        :value="value"
        @change="commit(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
  </div>
</template>
