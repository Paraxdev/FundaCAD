<script setup lang="ts">
// A card anchored beside the element that opened it. Closes on a press outside
// it and on Escape, and keeps itself inside the window as its content changes.

import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
import { placeBeside, type Side } from "../../ui/anchor";
import { claimEscape } from "../../ui/escapeClaim";
import { inputModality } from "../../ui/inputModality";
import { escapeLayer } from "./escapeLayer";
import { focusables, focusReturn } from "./focusables";
import { useName } from "./useName";

const props = withDefaults(
  defineProps<{
    anchor: HTMLElement | null;
    side?: Side;
    align?: "start" | "center";
    gap?: number;
    /** extra class for the card */
    kind?: string;
    /** an element beside the anchor the card must also stay clear of */
    clear?: HTMLElement | null;
    /** px floor, for a card that should not be narrower than what opened it (a picker under a full-width field) */
    minWidth?: number | null;
    /** Names the card, which makes it a dialog that takes focus when a key opened it and gives focus back. */
    label?: string;
    labelledby?: string;
    /** "none" for a card that is part of its opener, such as a picker's list, which then needs no name. */
    role?: "dialog" | "none";
    /** "first" moves focus to the card's first control on open, or to the card when it holds none, and "keyboard"
     *  does so only when a key opened it. A named card defaults to "keyboard", an unnamed one to "none". */
    focus?: "first" | "keyboard" | "none";
    /** Gives focus back to what held it before, on close, while focus is still in the card. A named card defaults
     *  to doing so when a key opened it or focus is in the card, so a click elsewhere keeps today's focus. */
    returnFocus?: boolean | undefined;
  }>(),
  {
    side: "right",
    align: "start",
    gap: 8,
    kind: "",
    clear: null,
    minWidth: null,
    // Note: without an explicit undefined Vue casts an absent boolean to false, and the named default needs to tell.
    returnFocus: undefined,
  },
);
const emit = defineEmits<{ close: [] }>();

const el = useTemplateRef<HTMLElement>("el");
const pos = ref({ left: -9999, top: -9999 });

const named = () => !!(props.label || props.labelledby);
const name = useName(props, "Popover", () => named() || props.role === "none");
const dialog = computed(() => props.role !== "none" && (props.role === "dialog" || named()));
const focusMode = computed(() => props.focus ?? (named() ? "keyboard" : "none"));
const byKey = inputModality() === "keyboard";

function place() {
  const a = props.anchor;
  const box = el.value;
  if (!a || !box) return;
  const r = a.getBoundingClientRect();
  const c = props.clear?.getBoundingClientRect();
  const p = placeBeside(
    c ? { left: Math.min(r.left, c.left), top: r.top, right: Math.max(r.right, c.right), bottom: r.bottom } : r,
    { width: box.offsetWidth, height: box.offsetHeight },
    props.side,
    { width: window.innerWidth, height: window.innerHeight },
    { gap: props.gap, align: props.align },
  );
  pos.value = { left: p.left, top: p.top };
}

function onDown(e: PointerEvent) {
  const t = e.target as Node;
  if (el.value?.contains(t) || props.anchor?.contains(t)) return;
  // Note: a context menu opened from inside the card is teleported elsewhere,
  // and a press in it must not close the card underneath.
  if ((t as Element).closest?.(".context-menu, .ui-menu")) return;
  emit("close");
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || !layer.isTop()) return;
  e.stopImmediatePropagation();
  emit("close");
}

let ro: ResizeObserver | null = null;
const releaseEscape = claimEscape();
const layer = escapeLayer();
const back = focusReturn(() => props.anchor);
onMounted(async () => {
  window.addEventListener("keydown", onKey, true);
  await nextTick();
  place();
  if (el.value && (focusMode.value === "first" || (focusMode.value === "keyboard" && byKey)))
    (focusables(el.value)[0] ?? el.value).focus();
  ro = new ResizeObserver(() => place());
  if (el.value) ro.observe(el.value);
  window.addEventListener("resize", place);
  document.addEventListener("pointerdown", onDown, true);
});
onBeforeUnmount(() => {
  const inCard = (n: Node | null) => !!n && !!el.value?.contains(n);
  const give = props.returnFocus ?? (named() && (byKey || inCard(document.activeElement)));
  if (give) back.restore(inCard);
});
onUnmounted(() => {
  releaseEscape();
  layer.release();
  ro?.disconnect();
  window.removeEventListener("resize", place);
  document.removeEventListener("pointerdown", onDown, true);
  window.removeEventListener("keydown", onKey, true);
});

defineExpose({ place });
</script>

<template>
  <Teleport to="body">
    <div
      ref="el"
      class="float-popover"
      :class="kind"
      :role="dialog ? 'dialog' : undefined"
      v-bind="dialog ? name : {}"
      :tabindex="focusMode === 'none' ? undefined : -1"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px`, ...(minWidth ? { minWidth: `${minWidth}px` } : {}) }"
    >
      <slot />
    </div>
  </Teleport>
</template>
