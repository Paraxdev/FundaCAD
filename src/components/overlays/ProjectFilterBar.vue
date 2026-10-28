<script setup lang="ts">
// The chosen filter lives in the store because the projection routine reads it synchronously, mid-pick.

import { computed, onMounted, useTemplateRef, watch } from "vue";
import Segmented from "../ui/Segmented.vue";
import { PROJECT_CHIPS, type ProjectFilter } from "../../sketch/projectPanel";
import { useToolPanelStore } from "../../stores/toolPanels";

const panels = useToolPanelStore();
const bar = useTemplateRef<HTMLDivElement>("bar");
const options = computed(() => PROJECT_CHIPS.map((c) => ({ value: c.key, label: c.label })));

function choose(f: ProjectFilter) {
  panels.projectFilter = f;
  panels.projectChange?.(f);
}

// Centring stays imperative: it needs the bar's rendered width, which exists only once mounted (happy-dom reports 0).
function place() {
  const r = panels.projectAnchor;
  const el = bar.value;
  if (!r || !el) return;
  el.style.top = `${r.top + 10}px`;
  el.style.left = `${r.left + r.width / 2 - el.offsetWidth / 2}px`;
}

onMounted(place);
watch(() => panels.projectAnchor, place, { flush: "post" });
</script>

<template>
  <Teleport to="body">
    <!-- A press keeps focus where it was, so the sketch keys still reach the Project tool. -->
    <div ref="bar" class="float-card project-filter-bar" @pointerdown.prevent>
      <Segmented
        :model-value="panels.projectFilter"
        :options="options"
        label="Project filter"
        variant="chips"
        size="sm"
        @update:model-value="choose"
      />
    </div>
  </Teleport>
</template>
