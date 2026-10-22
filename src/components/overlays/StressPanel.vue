<script setup lang="ts">
// No Esc dismiss: Esc clears a face selection while picking and must not throw the setup away. In probe mode Esc
// ends probe mode only (viewport/stressGlyphs.ts).

import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import FloatingPanel from "./FloatingPanel.vue";
import Icon from "../shell/Icon.vue";
import Tabs from "../ui/Tabs.vue";
import StressSetupStep from "./StressSetupStep.vue";
import StressResultsStep from "./StressResultsStep.vue";

type Step = "setup" | "results";

const engine = useEngine();
const panels = usePanelsStore();

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
</script>

<template>
  <FloatingPanel :open="!!panels.stress" panel-class="stress-panel" @close="close">
    <template v-if="panels.stress && setup">
      <div class="stress-head">
        <div class="measure-title">Stress</div>
        <button
          type="button"
          class="float-card-close stress-close"
          title="Close Stress"
          aria-label="Close Stress"
          @click="close"
        >
          <Icon name="close" :size="14" />
        </button>
      </div>
      <Tabs v-model="step" :tabs="tabs" />

      <StressResultsStep v-if="step === 'results' && result" :result="result" />
      <StressSetupStep v-else :setup="setup" :bodies="bodies" />

      <div class="measure-hint">
        <template v-if="panels.stress.probe">Hover the body to read it, click to pin, Esc to stop.</template>
        <template v-else-if="panels.stress.placing"
          >Click the body to place a spot, Shift click for more, Esc to stop.</template
        >
        <template v-else-if="step === 'results' && result">Results are linear and approximate.</template>
        <template v-else>Pick faces with Place or Use selected, then Run.</template>
      </div>

      <div v-if="step === 'setup'" class="stress-foot">
        <template v-if="panels.stress.running">
          <span class="stress-busy">Analysing…</span>
          <button type="button" class="btn stress-cancel" @click="engine.ui.panels.cancelStress()">Cancel</button>
        </template>
        <button v-else type="button" class="btn btn-primary stress-run" @click="engine.ui.panels.runStress()"
          >Run</button
        >
      </div>
    </template>
  </FloatingPanel>
</template>
