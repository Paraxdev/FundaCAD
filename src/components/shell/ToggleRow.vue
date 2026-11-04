<script setup lang="ts">
// A switch reads as on at a glance down a column. The label names it by id, so a click on the label flips it.

import FieldRow from "../ui/FieldRow.vue";
import Switch from "../ui/Switch.vue";

defineProps<{
  label: string;
  value: boolean;
  commit: (value: boolean) => void;
  rowTitle?: string | undefined;
}>();
</script>

<template>
  <FieldRow v-slot="{ id }" layout="param" :label="label" :title="rowTitle">
    <Switch :id="id" :model-value="value" :label="label" @update:model-value="commit" />
  </FieldRow>
</template>
