<script setup lang="ts">
// The old name of ui/Panel, kept for the panels and plugins that import it.

import Panel from "../ui/Panel.vue";

withDefaults(defineProps<{ open: boolean; closeOnEsc?: boolean; panelClass?: string }>(), {
  closeOnEsc: false,
  panelClass: "",
});
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Panel :open="open" :close-on-esc="closeOnEsc" :panel-class="panelClass" @close="emit('close')">
    <slot />
  </Panel>
</template>
