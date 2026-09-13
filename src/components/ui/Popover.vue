<script setup lang="ts">
// A card anchored beside the element that opened it. Closes on a press outside
// it and on Escape, and keeps itself inside the window as its content changes.

import { nextTick, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
import { placeBeside, type Side } from "../../ui/anchor";
import { claimEscape } from "../../ui/escapeClaim";

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
  }>(),
  { side: "right", align: "start", gap: 8, kind: "", clear: null },
);
const emit = defineEmits<{ close: [] }>();

const el = useTemplateRef<HTMLElement>("el");
const pos = ref({ left: -9999, top: -9999 });

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
  if ((t as Element).closest?.(".context-menu")) return;
  emit("close");
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.stopImmediatePropagation();
  emit("close");
}

let ro: ResizeObserver | null = null;
const releaseEscape = claimEscape();
onMounted(async () => {
  await nextTick();
  place();
  ro = new ResizeObserver(() => place());
  if (el.value) ro.observe(el.value);
  window.addEventListener("resize", place);
  document.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey, true);
});
onUnmounted(() => {
  releaseEscape();
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
      :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
    >
      <slot />
    </div>
  </Teleport>
</template>
