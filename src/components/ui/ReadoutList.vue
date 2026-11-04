<script setup lang="ts">
defineProps<{
  rows: readonly { k: string; v: string }[];
  rowClass?: string;
}>();
</script>

<template>
  <dl class="readout-list">
    <div v-for="(row, index) in rows" :key="index" class="measure-row" :class="rowClass">
      <dt class="measure-k">{{ row.k }}</dt>
      <slot name="value" :row="row" :index="index"
        ><dd class="measure-v">{{ row.v }}</dd></slot
      >
    </div>
  </dl>
</template>
