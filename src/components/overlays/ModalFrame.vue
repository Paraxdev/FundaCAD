<script setup lang="ts">
// The large centred modal chrome, .modal-overlay > .modal-panel > .modal-head,
// worn by the welcome screen and the 3D-Mouse settings.
//
// It owns the frame and nothing else. No Escape handling and no modal-depth
// gate: the two dialogs that wear it differ on both, and those differences are
// behaviour rather than layout (see composables/useModalGate.ts).
//
// `.modal-close` lives here, in one place. e2e/assembly_tree_e2e.cjs dismisses
// the startup welcome modal by clicking it, and a missing button makes that
// script hang rather than fail.

import Icon from "../shell/Icon.vue";

defineProps<{ panelClass?: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <!-- to body, where the imperative version appended itself: the overlay is
       position:fixed and must not inherit a stacking context from #app. -->
  <Teleport to="body">
    <div class="modal-overlay" @pointerdown.self="emit('close')">
      <div class="modal-panel" :class="panelClass">
        <div class="modal-head">
          <h2><slot name="title" /></h2>
          <button class="modal-close" aria-label="Close" @click="emit('close')">
            <Icon name="close" :size="15" />
          </button>
        </div>
        <slot />
      </div>
    </div>
  </Teleport>
</template>
