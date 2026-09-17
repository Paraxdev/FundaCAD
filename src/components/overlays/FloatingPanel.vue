<script setup lang="ts">
// The "measure-panel" floating popup shell: Properties, Interference, Overhang,
// the Parameters dialog and plugins' own panels all wear it. Replaces the
// FloatingPanel class, which existed to dedupe element creation + an optional
// Esc listener + dismiss bookkeeping.
//
// The class's onClose hook is gone and not replaced: it existed so a panel with
// live subscriptions (the camera poller) could be torn down on EVERY dismissal
// path. onUnmounted is that hook, and it cannot be forgotten or fire twice.

import { onUnmounted, watch } from "vue";

const props = withDefaults(defineProps<{ open: boolean; closeOnEsc?: boolean; panelClass?: string }>(), {
  closeOnEsc: false,
  panelClass: "",
});
const emit = defineEmits<{ close: [] }>();

// Capture phase, matching the original. Deliberately NOT stopPropagation: the
// panels are non-modal, and Escape has always also reached the global handler
// (clearing selection / cancelling a tool) while one was open.
function onEsc(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

function unbind() {
  window.removeEventListener("keydown", onEsc, true);
}

watch(
  () => props.open && props.closeOnEsc,
  (armed) => {
    unbind();
    if (armed) window.addEventListener("keydown", onEsc, true);
  },
  { immediate: true },
);
onUnmounted(unbind);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="measure-panel" :class="panelClass">
      <slot />
    </div>
  </Teleport>
</template>
