<script setup lang="ts" generic="T extends string">
defineProps<{
  options: readonly { value: T; label: string; hint?: string; disabled?: boolean; title?: string | undefined }[];
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
      :class="{ selected: o.value === modelValue, disabled: o.disabled }"
      :aria-checked="o.value === modelValue"
      :aria-disabled="o.disabled || undefined"
      :title="o.title"
      @click="o.disabled || emit('update:modelValue', o.value)"
    >
      <span class="opt-label">{{ o.label }}</span>
      <span v-if="o.hint" class="opt-hint">{{ o.hint }}</span>
    </button>
  </div>
</template>
