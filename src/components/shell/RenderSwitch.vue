<script setup lang="ts">
// An on/off chip, the control Shadows and Performance use.
defineProps<{ label: string; value: boolean }>();
const emit = defineEmits<{ (e: "update", value: boolean): void }>();
</script>

<template>
  <div class="rd-chips" role="group" :aria-label="label">
    <button class="rd-chip" :class="{ active: value }" :aria-pressed="value" @click="emit('update', !value)">{{
      value ? "On" : "Off"
    }}</button>
  </div>
</template>
