<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, onUnmounted, useId, useTemplateRef } from "vue";
import Icon from "../shell/Icon.vue";
import { useModalGate } from "../../composables/useModalGate";
import { useModalStore } from "../../stores/modals";
import { escapeClaimed } from "../../ui/escapeClaim";
import { focusables, focusReturn } from "./focusables";

const props = withDefaults(
  defineProps<{
    title?: string | undefined;
    /** Unset keeps the .modal-panel width, which is lg. */
    size?: "sm" | "md" | "lg" | undefined;
    closeOnEsc?: boolean;
    /** "first" is an [autofocus] control, else the first control after the close button; or a selector, or "none". */
    initialFocus?: string;
    returnFocus?: boolean;
    /** Holds the modal depth gate (useModalGate) while open. Read once, at setup. */
    gate?: boolean;
    /** Wraps the default slot in .modal-body. */
    body?: boolean;
    panelClass?: string | undefined;
    /** Id of the text a screen reader reads after the title, a confirm's message. */
    describedBy?: string | undefined;
  }>(),
  {
    title: undefined,
    size: undefined,
    closeOnEsc: true,
    initialFocus: "first",
    returnFocus: true,
    gate: true,
    body: true,
    panelClass: undefined,
    describedBy: undefined,
  },
);
const emit = defineEmits<{ close: [] }>();

const titleId = useId();
const panel = useTemplateRef<HTMLElement>("panel");

if (props.gate) useModalGate();

// The topmost dialog only: a choice raised over this one, or a popover or menu inside it, takes its own Escape.
let modals: ReturnType<typeof useModalStore> | null = null;
let ownDepth = 0;
function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || !props.closeOnEsc || !modals) return;
  if (modals.current !== null || modals.depth !== ownDepth || escapeClaimed()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  emit("close");
}

function onTab(e: KeyboardEvent) {
  if (e.key !== "Tab" || !panel.value) return;
  const stops = focusables(panel.value);
  const first = stops[0];
  const last = stops[stops.length - 1];
  const now = document.activeElement;
  if (!first || !last) {
    e.preventDefault();
    panel.value.focus();
  } else if (e.shiftKey && (now === first || now === panel.value)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && now === last) {
    e.preventDefault();
    first.focus();
  }
}

function initialTarget(root: HTMLElement): HTMLElement | null {
  if (props.initialFocus === "none") return null;
  if (props.initialFocus !== "first") return root.querySelector<HTMLElement>(props.initialFocus);
  return (
    root.querySelector<HTMLElement>("[autofocus]") ??
    focusables(root).find((el) => !el.classList.contains("modal-close")) ??
    root
  );
}

const back = focusReturn();
onMounted(async () => {
  if (props.closeOnEsc) {
    modals = useModalStore();
    ownDepth = modals.depth;
    window.addEventListener("keydown", onKey, true);
  }
  await nextTick();
  if (panel.value) initialTarget(panel.value)?.focus();
});
onBeforeUnmount(() => {
  if (props.returnFocus) back.restore((n) => !!panel.value?.contains(n));
});
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <!-- Teleported: the overlay is position:fixed and must not inherit a stacking context from #app. -->
  <Teleport to="body">
    <div class="modal-overlay" @pointerdown.self="emit('close')">
      <div
        ref="panel"
        class="modal-panel ui-dialog"
        :class="[size && `ui-dialog-${size}`, panelClass]"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="describedBy"
        tabindex="-1"
        @keydown="onTab"
      >
        <div class="modal-head">
          <h2 :id="titleId">
            <slot name="title">{{ title }}</slot>
          </h2>
          <!-- The e2e scripts click .modal-close to dismiss Home and dialogs. -->
          <button type="button" class="modal-close" aria-label="Close" title="Close" @click="emit('close')">
            <Icon name="close" :size="15" />
          </button>
        </div>
        <div v-if="body && $slots.default" class="modal-body ui-dialog-body"><slot /></div>
        <slot v-else />
        <div v-if="$slots.footer" class="modal-foot ui-dialog-foot"><slot name="footer" /></div>
      </div>
    </div>
  </Teleport>
</template>
