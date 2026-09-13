<script setup lang="ts" generic="T extends string">
defineProps<{
  options: readonly { value: T; label: string; hint?: string }[];
  modelValue: T | null;
}>();
const emit = defineEmits<{ "update:modelValue": [T] }>();
</script>

<template>
  <div class="choice-list" role="radiogroup">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="radio"
      class="choice-row"
      :class="{ selected: o.value === modelValue }"
      :aria-checked="o.value === modelValue"
      @click="emit('update:modelValue', o.value)"
    >
      <span class="choice-label">{{ o.label }}</span>
      <span v-if="o.hint" class="choice-hint">{{ o.hint }}</span>
    </button>
  </div>
</template>
