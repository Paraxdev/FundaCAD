<script setup lang="ts">
// An on/off row, the control Shadows and Performance use.
import Checkbox from "../ui/Checkbox.vue";

defineProps<{ label: string; value: boolean }>();
const emit = defineEmits<{ (e: "update", value: boolean): void }>();
</script>

<template>
  <Checkbox class="rd-check" :model-value="value" :label="label" @update:model-value="emit('update', $event)" />
</template>
