<script setup lang="ts">
// The measure-panel popup shell worn by Properties, Interference, Overhang, Parameters, Stress and plugin panels.

import { computed, onUnmounted, ref, useId, useSlots, watch } from "vue";
import Icon from "../shell/Icon.vue";
import { panelStack } from "../../ui/panelStack";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string | undefined;
    hint?: string | undefined;
    /** Draws a close button in the head. */
    closable?: boolean;
    closeOnEsc?: boolean;
    panelClass?: string;
  }>(),
  { title: undefined, hint: undefined, closable: false, closeOnEsc: false, panelClass: "" },
);
const emit = defineEmits<{ close: [] }>();
const slots = useSlots();
const titleId = useId();
const hasHead = computed(() => !!props.title || props.closable || !!slots["head-actions"]);

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
    <div
      v-if="open"
      ref="el"
      class="measure-panel ui-panel"
      :class="panelClass"
      :role="title ? 'region' : undefined"
      :aria-labelledby="title ? titleId : undefined"
    >
      <div v-if="hasHead" class="ui-panel-head">
        <div v-if="title" :id="titleId" class="measure-title ui-panel-title">{{ title }}</div>
        <slot name="head-actions" />
        <button
          v-if="closable"
          type="button"
          class="float-card-close ui-panel-close"
          aria-label="Close"
          title="Close"
          @click="emit('close')"
        >
          <Icon name="close" :size="14" />
        </button>
      </div>
      <slot />
      <div v-if="hint" class="measure-hint ui-panel-hint">{{ hint }}</div>
      <div v-if="$slots.foot" class="ui-panel-foot"><slot name="foot" /></div>
    </div>
  </Teleport>
</template>
