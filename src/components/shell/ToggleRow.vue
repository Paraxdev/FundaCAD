<script setup lang="ts">
// A switch reads as on at a glance down a column, and a real checkbox underneath keeps keyboard, label and focus ring.

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
      <label class="param-switch">
        <input
          :id="`tg-${label}`"
          type="checkbox"
          :checked="value"
          @change="commit(($event.target as HTMLInputElement).checked)"
        />
        <span class="track"><span class="knob"></span></span>
      </label>
    </div>
  </div>
</template>
