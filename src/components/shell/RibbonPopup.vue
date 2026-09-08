<script setup lang="ts">
// The dropdown shared by the "More" overflow and every split button's caret.
// Fixed-positioned against an anchor rect, teleported to body so it is not
// clipped by the ribbon's overflow.
//
// Positioning stays imperative maths on a measured rect, happy-dom reports all
// zeros for getBoundingClientRect, so this is e2e/manual territory and is kept
// deliberately identical to what the class did.

import { onMounted, onUnmounted, useTemplateRef } from "vue";
import Icon from "./Icon.vue";
import type { ToolItem } from "../../ui/ribbonDefs";

const props = defineProps<{
  items: ToolItem[];
  /** Section headings, for the overflow popup's grouped list. */
  groups?: { label: string; items: ToolItem[] }[] | undefined;
  anchor: HTMLElement;
  /** The overflow popup right-aligns under its button; a split caret left-aligns. */
  align: "left" | "right";
}>();
const emit = defineEmits<{ pick: [ToolItem]; dismiss: [] }>();

const el = useTemplateRef<HTMLElement>("el");

function place() {
  const pop = el.value;
  if (!pop) return;
  const r = props.anchor.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.top = `${r.bottom + 2}px`;
  if (props.align === "right") {
    pop.style.right = `${Math.max(4, window.innerWidth - r.right)}px`;
  } else {
    pop.style.left = `${Math.max(4, Math.min(r.left - 40, window.innerWidth - 190))}px`;
  }
}

// Dismiss on outside pointerdown. Deferred by a tick so the click that OPENED
// the popup doesn't immediately close it again.
function onDown(e: PointerEvent) {
  const t = e.target as Node;
  const pop = el.value;
  if (pop && !pop.contains(t) && t !== props.anchor && !props.anchor.contains(t)) emit("dismiss");
}

let armed: ReturnType<typeof setTimeout> | null = null;
onMounted(() => {
  place();
  armed = setTimeout(() => document.addEventListener("pointerdown", onDown, true), 0);
});
onUnmounted(() => {
  if (armed) clearTimeout(armed);
  document.removeEventListener("pointerdown", onDown, true);
});
</script>

<template>
  <Teleport to="body">
    <div ref="el" class="ribbon-overflow-popup">
      <template v-if="groups">
        <template v-for="g in groups" :key="g.label">
          <div class="ribbon-overflow-label">{{ g.label }}</div>
          <button
            v-for="it in g.items"
            :key="it.action"
            class="ribbon-overflow-item"
            @click="emit('pick', it)"
          >
            <Icon :name="it.iconName" /><span>{{ it.label }}</span>
          </button>
        </template>
      </template>
      <!-- data-pick is how a press-and-hold release finds what it landed on:
           the popup is teleported to the body, so the ribbon never sees the
           pointer enter it and reads the row back out of the document instead. -->
      <button
        v-for="it in items"
        v-else
        :key="it.action"
        class="ribbon-overflow-item"
        :data-pick="it.action"
        @click="emit('pick', it)"
      >
        <Icon :name="it.iconName" /><span>{{ it.label }}</span>
      </button>
    </div>
  </Teleport>
</template>
