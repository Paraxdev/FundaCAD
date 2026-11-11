<script setup lang="ts">
// The same row chrome as ValidatedRow, the two interleave in one list. No mid-edit guard: a select has no half-typed state.

import FieldRow from "../ui/FieldRow.vue";
import Select from "../ui/Select.vue";
import type { ChoiceOption } from "../../document/optionFields";

defineProps<{
  label: string;
  /** The value's key, rendered as data-field so a row can be found by it. */
  field?: string | undefined;
  value: string;
  options: ChoiceOption[];
  commit: (value: string) => void;
  rowTitle?: string | undefined;
}>();
</script>

<template>
  <FieldRow v-slot="{ id }" layout="param" :label="label" :data-field="field" :title="rowTitle">
    <Select :id="id" :model-value="value" :options="options" :label="label" @update:model-value="commit" />
  </FieldRow>
</template>
