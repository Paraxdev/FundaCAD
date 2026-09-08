<script setup lang="ts">
// Selection-filter chips for the sketch Project tool. Replaces the DOM half of
// sketch/projectPanel.ts, which stays as the facade SketchMode calls; the chosen
// filter itself lives in the store because the projection routine reads it
// synchronously, mid-pick.

import { onMounted, useTemplateRef, watch, type CSSProperties } from "vue";
import { PROJECT_CHIPS, type ProjectFilter } from "../../sketch/projectPanel";
import { useToolPanelStore } from "../../stores/toolPanels";

const panels = useToolPanelStore();
const bar = useTemplateRef<HTMLDivElement>("bar");

function choose(f: ProjectFilter) {
  panels.projectFilter = f;
  panels.projectChange?.(f);
}

// Horizontal centring stays imperative and stays here: it needs the bar's own
// rendered width, which does not exist until it is in the document, and it is a
// measurement, the same reason TimelineBar.vue keeps gapIndexAt() out of
// reactivity. (Untestable under happy-dom, which reports every width as 0.)
function place() {
  const r = panels.projectAnchor;
  const el = bar.value;
  if (!r || !el) return;
  el.style.top = `${r.top + 10}px`;
  el.style.left = `${r.left + r.width / 2 - el.offsetWidth / 2}px`;
}

onMounted(place);
watch(() => panels.projectAnchor, place, { flush: "post" });

const root: CSSProperties = {
  position: "fixed", zIndex: "40", display: "flex", gap: "6px", padding: "6px 8px",
  background: "#20242c", border: "1px solid #3a4150", borderRadius: "6px",
  boxShadow: "0 4px 14px rgba(0,0,0,0.35)", font: "12px system-ui, sans-serif",
};
const chip: CSSProperties = {
  border: "1px solid #3a4150", borderRadius: "12px", padding: "3px 10px",
  font: "inherit", cursor: "pointer",
};
const on: CSSProperties = { background: "#2f6fd0", color: "#ffffff" };
const off: CSSProperties = { background: "#161a20", color: "#aab4c4" };
</script>

<template>
  <Teleport to="body">
    <div ref="bar" :style="root">
      <button
        v-for="c in PROJECT_CHIPS"
        :key="c.key"
        :style="[chip, panels.projectFilter === c.key ? on : off]"
        @click="choose(c.key)"
      >{{ c.label }}</button>
    </div>
  </Teleport>
</template>
