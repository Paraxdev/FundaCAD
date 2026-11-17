<script setup lang="ts">
// A labelled slider row, laid out like Brightness and Bloom on the Environment tab.
import Slider from "../ui/Slider.vue";

defineProps<{ label: string; value: number; min: number; max: number; step?: number; unit?: string }>();
const emit = defineEmits<{ (e: "update", value: number): void }>();
</script>

<template>
  <Slider
    class="prefs-row"
    :label="label"
    :model-value="value"
    :min="min"
    :max="max"
    :step="step ?? 0.05"
    :unit="unit"
    @update:model-value="emit('update', $event)"
  />
</template>
