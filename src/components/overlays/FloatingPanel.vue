<script setup lang="ts">
// The measure-panel popup shell worn by Properties, Interference, Overhang, Parameters and plugin panels.

import { onUnmounted, ref, watch } from "vue";
import { panelStack } from "../../ui/panelStack";

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

// Each open panel takes the next slot in the column under the view cube.
const el = ref<HTMLElement | null>(null);
let slot = "";
let serial = 0;
function release() {
  if (slot) panelStack.remove(slot);
  slot = "";
}
watch(el, (node) => {
  release();
  if (!node) return;
  slot = `panel-${++serial}-${Math.random().toString(36).slice(2)}`;
  panelStack.add(slot, node);
});
onUnmounted(() => {
  unbind();
  release();
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="el" class="measure-panel" :class="panelClass">
      <slot />
    </div>
  </Teleport>
</template>
