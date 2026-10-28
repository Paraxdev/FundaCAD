<script setup lang="ts">
// features/measureTool.ts does the picking and the distance search and pushes these rows into the store.

import { useToolPanelStore } from "../../stores/toolPanels";
import Panel from "../ui/Panel.vue";

const panels = useToolPanelStore();
</script>

<template>
  <!-- No close on Esc: MeasureTool owns Escape while active, it also drops the highlight, marker and picking suspend. -->
  <Panel :open="!!panels.measure" title="Measure" hint="Esc to exit">
    <div v-for="(r, i) in panels.measure" :key="i" class="measure-row">
      <span class="measure-k">{{ r.k }}</span>
      <span class="measure-v">{{ r.v }}</span>
    </div>
  </Panel>
</template>
