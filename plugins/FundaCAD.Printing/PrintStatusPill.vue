<script setup lang="ts">
import { usePrintStatusStore } from "./printStatus";

const print = usePrintStatusStore();

// Inline, because a plugin has nowhere to ship a stylesheet. The same padding
// as the app's prompt banner: a live print job is as much of an announcement.
const PILL = {
  position: "fixed",
  bottom: "46px",
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 3900,
  background: "var(--panel-2, #1c1f26)",
  border: "1px solid var(--accent, #ff7a3c)",
  borderRadius: "var(--r-pill)",
  padding: "var(--s-3) var(--s-5)",
  fontSize: "12px",
  color: "var(--text, #e6e8ec)",
  boxShadow: "var(--shadow-2, 0 2px 8px rgba(0, 0, 0, 0.4))",
  pointerEvents: "none",
} as const;
</script>

<template>
  <Teleport to="body">
    <div
      v-if="print.text != null"
      class="print-status-pill"
      :style="[PILL, print.onClick ? { cursor: 'pointer' } : {}]"
      :title="print.onClick ? 'Show camera' : undefined"
      @click="print.onClick?.()"
    >{{ print.text }}</div>
  </Teleport>
</template>
