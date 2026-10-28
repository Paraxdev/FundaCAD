<script setup lang="ts">
// A row of chips of which one is chosen, the control Ground and Denoise use.
import { computed } from "vue";
import Segmented from "../ui/Segmented.vue";

const props = defineProps<{ label: string; value: string; options: { id: string; label: string }[] }>();
const emit = defineEmits<{ (e: "update", id: string): void }>();
const choices = computed(() => props.options.map((o) => ({ value: o.id, label: o.label })));
</script>

<template>
  <Segmented
    class="rd-chips"
    variant="chips"
    size="sm"
    :label="label"
    :model-value="value"
    :options="choices"
    @update:model-value="emit('update', $event)"
  />
</template>
