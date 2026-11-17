<script setup lang="ts">
// No Esc dismiss: it closes when Overhang is toggled off, and Esc must not leave the analysis running without
// its controls. The settings live on the viewport, display only and not undoable.

import { computed, ref, useId, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { t } from "../../i18n";
import { usePanelsStore } from "../../stores/panels";
import Panel from "../ui/Panel.vue";
import Select from "../ui/Select.vue";
import Slider from "../ui/Slider.vue";
import { cssHex } from "../../ui/stress";
import { DRAFT_COLORS } from "../../viewport/draftColors";

type BuildDir = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";
const DIRS: BuildDir[] = ["+Z", "-Z", "+X", "-X", "+Y", "-Y"];
const DIR_OPTIONS = DIRS.map((d) => ({ value: d, label: d }));
const legend = computed(() => [
  { key: "overhang", color: DRAFT_COLORS.overhang, label: t("overhang.legend.overhang") },
  { key: "wall", color: DRAFT_COLORS.wall, label: t("overhang.legend.wall") },
  { key: "top", color: DRAFT_COLORS.top, label: t("overhang.legend.top") },
]);

const engine = useEngine();
const panels = usePanelsStore();

const dir = ref<BuildDir>("+Z");
const threshold = ref(45);
const thresholdId = useId();

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
  <Panel
    :open="panels.overhang"
    :title="t('overhang.title')"
    :hint="t('overhang.hint', { tool: t('tool.overhang') })"
    panel-class="overhang-panel"
  >
    <div class="measure-row">
      <span class="measure-k">{{ t("overhang.buildDirection") }}</span>
      <Select
        :model-value="dir"
        :options="DIR_OPTIONS"
        :label="t('overhang.buildDirection')"
        testid="overhang-dir"
        @update:model-value="setDir"
      />
    </div>
    <div class="measure-row">
      <span :id="thresholdId" class="measure-k">{{ t("overhang.threshold") }}</span>
      <Slider
        v-model="threshold"
        class="overhang-threshold"
        :labelledby="thresholdId"
        :min="0"
        :max="90"
        :step="1"
        :tip="t('overhang.thresholdTip')"
        @update:model-value="apply()"
      >
        <template #value="{ value }">{{ value }}°</template>
      </Slider>
    </div>
    <div class="measure-divider" />
    <div v-for="k in legend" :key="k.key" class="measure-row overhang-legend">
      <span class="measure-v"><span class="overhang-key" :style="{ '--key': cssHex(k.color) }" />{{ k.label }}</span>
    </div>
  </Panel>
</template>
