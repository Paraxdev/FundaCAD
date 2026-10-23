<script setup lang="ts">
// Frame only: no Escape handling and no modal-depth gate, the dialogs wearing it differ on both (useModalGate.ts).
// The e2e scripts click `.modal-close`, which Home wears too, to dismiss Home at startup.

import { useId } from "vue";
import Icon from "../shell/Icon.vue";

defineProps<{ panelClass?: string }>();
const emit = defineEmits<{ close: [] }>();
const titleId = useId();
</script>

<template>
  <!-- Teleported: the overlay is position:fixed and must not inherit a stacking context from #app. -->
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
