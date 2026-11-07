<script setup lang="ts">
import { Button } from "fundacad/ui";
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
  fontSize: "var(--fs-small, 12px)",
  color: "var(--text, #e6e8ec)",
  boxShadow: "var(--shadow-2, 0 2px 8px rgba(0, 0, 0, 0.4))",
  display: "flex",
  alignItems: "center",
  gap: "var(--s-3)",
  pointerEvents: "none",
} as const;
</script>

<template>
  <Teleport to="body">
    <!-- Progress changes by the percent, so it is a status region that does not speak each change. -->
    <div
      v-if="print.text != null"
      class="print-status-pill"
      role="status"
      aria-live="off"
      :style="[PILL, print.onClick ? { pointerEvents: 'auto' } : {}]"
    >
      <span>{{ print.text }}</span>
      <Button v-if="print.onClick" size="sm" variant="ghost" @click="print.onClick()">Show camera</Button>
    </div>
  </Teleport>
</template>
