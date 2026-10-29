<script setup lang="ts">
// Esc backs out one layer at a time. A drag, placing a spot and probe mode take it first in the view
// (viewport/stressGlyphs.ts), then a focused field gives up focus, and only then does the panel close. It listens in the
// bubble phase for that, so a layer that stopped the key never reaches it. The setup and the last result stay in the
// document and the panel, as with Close.

import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import FloatingPanel from "./FloatingPanel.vue";
import Button from "../ui/Button.vue";
import IconButton from "../ui/IconButton.vue";
import Tabs from "../ui/Tabs.vue";
import StressSetupStep from "./StressSetupStep.vue";
import StressResultsStep from "./StressResultsStep.vue";
import { buildStressRequest } from "../../ui/stress";
import { escapeClaimed } from "../../ui/escapeClaim";
import { isEditableTarget } from "../../ui/focus";
import { announce } from "../../ui/announce";

type Step = "setup" | "results";

const engine = useEngine();
const panels = usePanelsStore();
watch(
  () => panels.stress?.running,
  (running) => running && announce("Analysing", "polite", { key: "stress" }),
);

const bodies = ref<{ id: string; name: string }[]>([]);
function readBodies() {
  bodies.value = engine.ui?.panels?.stressBodies() ?? [];
}
let offBuild: (() => void) | null = null;
onMounted(() => {
  // onBuild replays at once, before mountUi has made engine.ui, so the list is read again whenever the panel opens.
  offBuild = engine.store.onBuild(readBodies);
});
onUnmounted(() => offBuild?.());
watch(
  () => !!panels.stress,
  (open) => open && readBodies(),
);

const setup = computed(() => panels.stress?.setup ?? null);
const result = computed(() => panels.stress?.result ?? null);
const ready = computed(() => !!setup.value && buildStressRequest(setup.value).ok);

// Results once a Run brings one, Set up when it goes or a Run is refused, since the cause is usually in the setup.
const step = ref<Step>("setup");
watch(result, (now, was) => {
  if (now && !was) step.value = "results";
  if (!now) step.value = "setup";
});
watch(
  () => panels.stress?.error ?? null,
  (error) => {
    if (error) step.value = "setup";
  },
);
watch(
  () => !!panels.stress,
  (open) => {
    if (!open) step.value = "setup";
  },
);

watch(step, (now) => {
  if (now === "setup" && panels.stress?.deform?.animate) engine.ui.panels.pauseStressAnimation();
});

const tabs = computed(() => [
  { value: "setup" as const, label: "Set up" },
  {
    value: "results" as const,
    label: "Results",
    disabled: !result.value,
    title: result.value ? undefined : "Run the analysis to see results",
  },
]);

function close() {
  engine.ui.panels.closeStress();
}

function onEscape(e: KeyboardEvent) {
  const d = panels.stress;
  if (e.key !== "Escape" || !d || e.defaultPrevented || escapeClaimed()) return;
  if (isEditableTarget(e.target)) {
    (e.target as HTMLElement).blur();
    return;
  }
  // The glyph layer already takes these in the view; this is for when the key reaches the panel with one still on.
  if (d.probe) engine.ui.panels.setStressProbe(false);
  else if (d.placing) engine.ui.panels.placeStressSpot(d.placing, d.placeAs);
  else close();
}
onMounted(() => window.addEventListener("keydown", onEscape));
onUnmounted(() => window.removeEventListener("keydown", onEscape));
</script>

<template>
  <FloatingPanel :open="!!panels.stress" panel-class="stress-panel" @close="close">
    <template v-if="panels.stress && setup">
      <div class="stress-head">
        <div class="measure-title">Stress</div>
        <IconButton
          class="stress-close"
          icon="close"
          tip="Close Stress"
          size="sm"
          variant="plain"
          :icon-size="14"
          @click="close"
        />
      </div>
      <Tabs v-model="step" :tabs="tabs" />

      <KeepAlive>
        <StressResultsStep v-if="step === 'results' && result" :result="result" />
        <StressSetupStep v-else :setup="setup" :bodies="bodies" />
      </KeepAlive>

      <div class="measure-hint">
        <template v-if="panels.stress.probe">Hover the body to read it, click to pin, Esc to stop.</template>
        <template v-else-if="panels.stress.placing && panels.stress.placeAs === 'spot'"
          >Click the body to place a spot, Shift click for more, Esc to stop.</template
        >
        <template v-else-if="panels.stress.placing"
          >Click a face to add all of it, Shift click for more, Esc to stop.</template
        >
        <template v-else-if="step === 'results' && result">Results are linear and approximate.</template>
        <template v-else-if="ready">Ready, press Run.</template>
        <template v-else>Give each support and load its faces, then Run.</template>
      </div>

      <div v-if="step === 'setup'" class="stress-foot">
        <template v-if="panels.stress.running">
          <span class="stress-busy">Analysing…</span>
          <Button class="stress-cancel" @click="engine.ui.panels.cancelStress()">Cancel</Button>
        </template>
        <Button v-else variant="primary" class="stress-run" @click="engine.ui.panels.runStress()">Run</Button>
      </div>
    </template>
  </FloatingPanel>
</template>
