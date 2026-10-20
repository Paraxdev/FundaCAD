<script setup lang="ts">
// A labelled slider row, laid out like Brightness and Bloom on the Environment tab.
defineProps<{ label: string; value: number; min: number; max: number; step?: number }>();
const emit = defineEmits<{ (e: "update", value: number): void }>();
</script>

<template>
  <label class="prefs-row">
    <span class="prefs-label">{{ label }}</span>
    <input
      class="sm-slider"
      type="range"
      :min="min"
      :max="max"
      :step="step ?? 0.05"
      :value="value"
      @input="emit('update', Number.parseFloat(($event.target as HTMLInputElement).value))"
    />
  </label>
</template>
