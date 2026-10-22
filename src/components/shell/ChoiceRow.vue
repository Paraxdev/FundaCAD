<script setup lang="ts">
// The same row chrome as ValidatedRow, the two interleave in one list. No mid-edit guard: a select has no half-typed state.

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
      <select class="param-select" :value="value" @change="commit(($event.target as HTMLSelectElement).value)">
        <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
  </div>
</template>
