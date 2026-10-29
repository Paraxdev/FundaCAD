<script setup lang="ts">
// The same row chrome as ValidatedRow, the two interleave in one list. No mid-edit guard: a select has no half-typed state.

import Select from "../ui/Select.vue";
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
      <Select :model-value="value" :options="options" :aria-label="label" @update:model-value="commit" />
    </div>
  </div>
</template>
