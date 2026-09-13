<script setup lang="ts" generic="T extends string">
defineProps<{
  options: readonly { value: T; label: string; hint?: string }[];
  modelValue: T | null;
}>();
const emit = defineEmits<{ "update:modelValue": [T] }>();
</script>

<template>
  <div class="opt-list" role="radiogroup">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="radio"
      class="opt-row"
      :class="{ selected: o.value === modelValue }"
      :aria-checked="o.value === modelValue"
      @click="emit('update:modelValue', o.value)"
    >
      <span class="opt-label">{{ o.label }}</span>
      <span v-if="o.hint" class="opt-hint">{{ o.hint }}</span>
    </button>
  </div>
</template>
