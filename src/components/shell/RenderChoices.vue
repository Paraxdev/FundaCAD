<script setup lang="ts">
// A row of chips of which one is chosen, the control Ground and Denoise use.
defineProps<{ label: string; value: string; options: { id: string; label: string }[] }>();
const emit = defineEmits<{ (e: "update", id: string): void }>();
</script>

<template>
  <div class="rd-chips" role="group" :aria-label="label">
    <button
      v-for="o in options"
      :key="o.id"
      class="rd-chip"
      :class="{ active: value === o.id }"
      :aria-pressed="value === o.id"
      @click="emit('update', o.id)"
    >{{ o.label }}</button>
  </div>
</template>
