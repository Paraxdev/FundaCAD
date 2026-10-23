<script setup lang="ts">
// The measure-panel popup shell worn by Properties, Interference, Overhang, Parameters and plugin panels.

import { onUnmounted, watch } from "vue";

const props = withDefaults(defineProps<{ open: boolean; closeOnEsc?: boolean; panelClass?: string }>(), {
  closeOnEsc: false,
  panelClass: "",
});
const emit = defineEmits<{ close: [] }>();

// Capture phase and no stopPropagation: the panels are non-modal, so Escape also reaches the global handler.
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
