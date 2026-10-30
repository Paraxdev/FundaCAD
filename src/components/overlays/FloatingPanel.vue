<script setup lang="ts">
// The old name of ui/Panel, kept for the panels and plugins that import it.

import Panel from "../ui/Panel.vue";

// The title names the region and is read as its heading; the panel's own content draws what is seen.
withDefaults(defineProps<{ open: boolean; title: string; closeOnEsc?: boolean; panelClass?: string }>(), {
  closeOnEsc: false,
  panelClass: "",
});
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Panel
    :open="open"
    :title="title"
    title-hidden
    :close-on-esc="closeOnEsc"
    :panel-class="panelClass"
    @close="emit('close')"
  >
    <slot />
  </Panel>
</template>
