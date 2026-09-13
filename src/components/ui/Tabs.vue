<script setup lang="ts" generic="T extends string">
defineProps<{ tabs: readonly { value: T; label: string }[]; modelValue: T }>();
const emit = defineEmits<{ "update:modelValue": [T] }>();
</script>

<template>
  <div class="float-tabs" role="tablist">
    <button
      v-for="t in tabs"
      :key="t.value"
      type="button"
      role="tab"
      class="float-tab"
      :class="{ active: t.value === modelValue }"
      :aria-selected="t.value === modelValue"
      @click="emit('update:modelValue', t.value)"
    >{{ t.label }}</button>
  </div>
</template>
