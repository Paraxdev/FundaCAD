<script setup lang="ts">
// The large centred modal chrome, .modal-overlay > .modal-panel > .modal-head,
// worn by Preferences and the 3D-Mouse settings.
//
// It owns the frame and nothing else. No Escape handling and no modal-depth
// gate: the two dialogs that wear it differ on both, and those differences are
// behaviour rather than layout (see composables/useModalGate.ts).
//
// `.modal-close` lives here, in one place. Home wears the same class on its own
// close button, which is what the e2e scripts click to dismiss it at startup.

import { useId } from "vue";
import Icon from "../shell/Icon.vue";

defineProps<{ panelClass?: string }>();
const emit = defineEmits<{ close: [] }>();
const titleId = useId();
</script>

<template>
  <!-- to body, where the imperative version appended itself: the overlay is
       position:fixed and must not inherit a stacking context from #app. -->
  <Teleport to="body">
    <div class="modal-overlay" @pointerdown.self="emit('close')">
      <div class="modal-panel" :class="panelClass" role="dialog" aria-modal="true" :aria-labelledby="titleId">
        <div class="modal-head">
          <h2 :id="titleId"><slot name="title" /></h2>
          <button class="modal-close" aria-label="Close" title="Close" @click="emit('close')">
            <Icon name="close" :size="15" />
          </button>
        </div>
        <slot />
      </div>
    </div>
  </Teleport>
</template>
