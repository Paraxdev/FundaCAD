<script setup lang="ts">
// The Measure (Inspect) readout. Replaces the innerHTML block at the bottom of
// features/measureTool.ts, the tool keeps every bit of picking, the
// shortest-distance search and the viewport marker; it now pushes rows into the
// store instead of building markup.
//
// This wears the shared .measure-panel shell, which is what the imperative
// version did too (same class, same body-level placement). The two esc() calls
// it needed are gone: {{ }} escapes, and leaving them in would render a row
// value containing "&" as "&amp;".

import { useToolPanelStore } from "../../stores/toolPanels";
import FloatingPanel from "./FloatingPanel.vue";

const panels = useToolPanelStore();
</script>

<template>
  <!-- No close-on-esc: MeasureTool owns Escape for its whole active lifetime
       (it has to also drop the highlight, the marker and the picking suspend),
       so the panel must not close itself out from under it. -->
  <FloatingPanel :open="!!panels.measure">
    <template v-if="panels.measure">
      <div class="measure-title">Measure</div>
      <div v-for="(r, i) in panels.measure" :key="i" class="measure-row">
        <span class="measure-k">{{ r.k }}</span>
        <span class="measure-v">{{ r.v }}</span>
      </div>
      <div class="measure-hint">Esc to exit</div>
    </template>
  </FloatingPanel>
</template>
