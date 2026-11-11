<script setup lang="ts">
// A switch reads as on at a glance down a column. The label names it by id, so a click on the label flips it.

import FieldRow from "../ui/FieldRow.vue";
import Switch from "../ui/Switch.vue";

defineProps<{
  label: string;
  /** The value's key, rendered as data-field so a row can be found by it. */
  field?: string | undefined;
  value: boolean;
  commit: (value: boolean) => void;
  rowTitle?: string | undefined;
}>();
</script>

<template>
  <FieldRow v-slot="{ id }" layout="param" :label="label" :data-field="field" :title="rowTitle">
    <Switch :id="id" :model-value="value" :label="label" @update:model-value="commit" />
  </FieldRow>
</template>
