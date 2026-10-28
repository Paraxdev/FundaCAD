<script setup lang="ts">
// Dialog for plugins, without the modal depth gate; a plugin still running its own Escape or focus opts out by prop.
// The e2e scripts click `.modal-close`.

import Dialog from "../ui/Dialog.vue";

withDefaults(
  defineProps<{
    panelClass?: string | undefined;
    closeOnEsc?: boolean;
    initialFocus?: string;
    returnFocus?: boolean;
  }>(),
  { panelClass: undefined, closeOnEsc: true, initialFocus: "first", returnFocus: true },
);
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Dialog
    :panel-class="panelClass"
    :close-on-esc="closeOnEsc"
    :gate="false"
    :initial-focus="initialFocus"
    :return-focus="returnFocus"
    :body="false"
    @close="emit('close')"
  >
    <template #title><slot name="title" /></template>
    <slot />
  </Dialog>
</template>
