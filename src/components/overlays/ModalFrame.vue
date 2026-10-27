<script setup lang="ts">
// The old frame contract over ui/Dialog: no Escape, no modal depth gate and no focus moves, since the dialogs wearing
// it differ on all three (useModalGate.ts). The e2e scripts click `.modal-close`, which Home wears too.

import Dialog from "../ui/Dialog.vue";

defineProps<{ panelClass?: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Dialog
    :panel-class="panelClass"
    :close-on-esc="false"
    :gate="false"
    initial-focus="none"
    :return-focus="false"
    :body="false"
    @close="emit('close')"
  >
    <template #title><slot name="title" /></template>
    <slot />
  </Dialog>
</template>
