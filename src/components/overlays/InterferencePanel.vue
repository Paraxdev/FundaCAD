<script setup lang="ts">
// Inspect → Interference: which bodies clash and by how much. Clicking a row
// selects the offending pair in the viewport so it can be seen.

import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import { useUiStore } from "../../stores/ui";
import FloatingPanel from "./FloatingPanel.vue";
import type { ClashRow } from "../../stores/panels";

const engine = useEngine();
const panels = usePanelsStore();
const ui = useUiStore();

function highlight(c: ClashRow) {
  if (engine.viewport.policy === "faces") {
    engine.viewport.setSelectPolicy("bodies");
    ui.selMode = "bodies";
  }
  engine.viewport.setSelectedBodies([c.a, c.b]);
}
</script>

<template>
  <FloatingPanel :open="!!panels.interference" close-on-esc @close="panels.interference = null">
    <template v-if="panels.interference">
      <div class="measure-title">{{ panels.interference.title }}</div>
      <div
        v-for="(c, i) in panels.interference.clashes"
        :key="i"
        class="measure-row clash-row"
        style="cursor: pointer"
        @click="highlight(c)"
      >
        <span class="measure-k">{{ c.k }}</span>
        <span class="measure-v">{{ c.v }}</span>
      </div>
      <div v-if="!panels.interference.clashes.length" class="measure-row">
        <span class="measure-v">No overlapping bodies</span>
      </div>
      <div class="measure-hint">
        {{ panels.interference.clashes.length ? "Click a clash to highlight the bodies · Esc to close" : "Esc to close" }}
      </div>
    </template>
  </FloatingPanel>
</template>
