<script setup lang="ts">
// features/measureTool.ts does the picking and the distance search and pushes these rows into the store.

import { watch } from "vue";
import { useToolPanelStore } from "../../stores/toolPanels";
import { announce } from "../../ui/announce";
import Panel from "../ui/Panel.vue";
import ReadoutList from "../ui/ReadoutList.vue";

const panels = useToolPanelStore();

watch(
  () => panels.measure?.map((r) => `${r.k} ${r.v}`).join(", "),
  (rows) => rows && announce(rows, "polite", { key: "measure", delay: 150 }),
);
</script>

<template>
  <!-- No close on Esc: MeasureTool owns Escape while active, it also drops the highlight, marker and picking suspend. -->
  <Panel :open="!!panels.measure" title="Measure" hint="Esc to exit">
    <ReadoutList v-if="panels.measure?.every((r) => r.k)" :rows="panels.measure" />
    <div v-else class="measure-row">
      <span class="measure-v">{{ panels.measure?.[0]?.v }}</span>
    </div>
  </Panel>
</template>
