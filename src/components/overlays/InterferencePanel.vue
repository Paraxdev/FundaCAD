<script setup lang="ts">
// Inspect → Interference: which bodies clash (and by how much), plus an
// optional clearance pass for pairs that come within a user threshold without
// actually overlapping. Clicking a row selects the offending pair in the
// viewport; the overlap solids and clearance lines are drawn by the viewport
// itself (see ui/panels.ts showInterference / closeInterference).

import { ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import { useUiStore } from "../../stores/ui";
import FloatingPanel from "./FloatingPanel.vue";
import type { ClashRow, ClearanceRow } from "../../stores/panels";

const engine = useEngine();
const panels = usePanelsStore();
const ui = useUiStore();

// Typical print-in-place clearance; not persisted, this is a per-check value.
const clearanceOn = ref(false);
const threshold = ref(0.2);

function highlight(c: ClashRow | ClearanceRow) {
  if (engine.viewport.policy === "faces") {
    engine.viewport.setSelectPolicy("bodies");
    ui.selMode = "bodies";
  }
  engine.viewport.setSelectedBodies([c.a, c.b]);
}

function recheck() {
  void engine.ui.panels.showInterference(clearanceOn.value ? threshold.value : undefined);
}

function close() {
  engine.ui.panels.closeInterference();
}
</script>

<template>
  <FloatingPanel :open="!!panels.interference" close-on-esc @close="close">
    <template v-if="panels.interference">
      <div class="measure-title">{{ panels.interference.title }}</div>
      <div
        v-for="(c, i) in panels.interference.clashes"
        :key="'clash' + i"
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

      <div class="measure-divider" />
      <div class="measure-row">
        <label class="measure-k" style="display: flex; align-items: center; gap: 6px; cursor: pointer">
          <input type="checkbox" v-model="clearanceOn" @change="recheck" />
          Clearance mode
        </label>
        <span class="measure-v" v-if="clearanceOn">
          <input
            class="measure-number" type="number" min="0.01" max="50" step="0.01"
            v-model.number="threshold" @change="recheck"
          /> mm
        </span>
      </div>

      <template v-if="clearanceOn">
        <div
          v-for="(c, i) in panels.interference.clearances"
          :key="'clear' + i"
          class="measure-row clash-row"
          style="cursor: pointer"
          @click="highlight(c)"
        >
          <span class="measure-k">{{ c.k }}</span>
          <span class="measure-v">{{ c.v }}</span>
        </div>
        <div v-if="!panels.interference.clearances.length" class="measure-row">
          <span class="measure-v">No pairs closer than {{ threshold }} mm</span>
        </div>
      </template>

      <div v-if="panels.interference.truncatedMessage" class="measure-hint" style="color: var(--accent-hot, #ff9a5c)">
        {{ panels.interference.truncatedMessage }}
      </div>
      <div class="measure-hint">
        {{
          panels.interference.clashes.length || panels.interference.clearances.length
            ? "Click a row to highlight the pair · Esc to close"
            : "Esc to close"
        }}
      </div>
    </template>
  </FloatingPanel>
</template>
