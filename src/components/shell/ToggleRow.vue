<script setup lang="ts">
// A switch reads as on at a glance down a column. The label names it by id, so a click on the label flips it.

import Switch from "../ui/Switch.vue";

defineProps<{
  label: string;
  value: boolean;
  commit: (value: boolean) => void;
  rowTitle?: string | undefined;
}>();
</script>

<template>
  <div class="param-row" :title="rowTitle">
    <label :for="`tg-${label}`">{{ label }}</label>
    <div class="param-value">
      <Switch :id="`tg-${label}`" :model-value="value" :label="label" @update:model-value="commit" />
    </div>
  </div>
</template>
