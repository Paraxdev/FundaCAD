<script setup lang="ts">
// No Esc dismiss: it closes when Overhang is toggled off, and Esc must not leave the analysis running without
// its controls. The settings live on the viewport, display only and not undoable.

import { ref, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import FloatingPanel from "./FloatingPanel.vue";
import Select from "../ui/Select.vue";
import { cssHex } from "../../ui/stress";
import { DRAFT_COLORS } from "../../viewport/draftColors";

type BuildDir = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";
const DIRS: BuildDir[] = ["+Z", "-Z", "+X", "-X", "+Y", "-Y"];
const DIR_OPTIONS = DIRS.map((d) => ({ value: d, label: d }));
const LEGEND = [
  { color: DRAFT_COLORS.overhang, label: "Overhang, needs support" },
  { color: DRAFT_COLORS.wall, label: "Wall or steep underside, prints as is" },
  { color: DRAFT_COLORS.top, label: "Faces up" },
];

const engine = useEngine();
const panels = usePanelsStore();

const dir = ref<BuildDir>("+Z");
const threshold = ref(45);

// Seed from the viewport each time it opens rather than once at mount: Overhang
// Analysis can be toggled off and on, and the config may have moved meanwhile.
watch(
  () => panels.overhang,
  (open) => {
    if (!open) return;
    const cfg = engine.viewport.draftConfig;
    dir.value = cfg.dir as BuildDir;
    threshold.value = cfg.threshold;
  },
  { immediate: true },
);

function setDir(d: BuildDir) {
  dir.value = d;
  apply();
}

function apply() {
  engine.viewport.setDraftConfig(dir.value, threshold.value);
}
</script>

<template>
  <FloatingPanel :open="panels.overhang" panel-class="overhang-panel">
    <div class="measure-title">Overhang analysis</div>
    <div class="measure-row">
      <span class="measure-k">Build direction</span>
      <Select :model-value="dir" :options="DIR_OPTIONS" testid="overhang-dir" @update:model-value="setDir" />
    </div>
    <div class="measure-row">
      <span class="measure-k">Threshold</span>
      <span class="overhang-threshold">
        <input
          v-model.number="threshold"
          class="sm-slider"
          type="range"
          min="0"
          max="90"
          step="1"
          aria-label="Overhang threshold"
          @input="apply()"
        />
        <span class="measure-v">{{ threshold }}°</span>
      </span>
    </div>
    <div class="measure-divider" />
    <div v-for="k in LEGEND" :key="k.label" class="measure-row overhang-legend">
      <span class="measure-v"><span class="overhang-key" :style="{ '--key': cssHex(k.color) }" />{{ k.label }}</span>
    </div>
    <div class="measure-hint">Downward faces flatter than the threshold need support · Overhang again to close</div>
  </FloatingPanel>
</template>
