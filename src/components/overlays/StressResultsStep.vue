<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import Icon from "../shell/Icon.vue";
import Button from "../ui/Button.vue";
import IconButton from "../ui/IconButton.vue";
import Slider from "../ui/Slider.vue";
import Switch from "../ui/Switch.vue";
import StressVerdict from "./StressVerdict.vue";
import { plainWarning } from "../../ui/stressWarnings";
import { deformLabel, legendEnds, legendGradient, setupSummary, type StressResultView } from "../../ui/stress";
import { getUnit } from "../../ui/units";

const props = defineProps<{ result: StressResultView }>();

const engine = useEngine();
const panels = usePanelsStore();

const stress = computed(() => panels.stress!);
const deform = computed(() => stress.value.deform);
const exaggerationId = useId();
const gradient = legendGradient();
const unit = computed(() => getUnit());

const modelChanged = computed(() => stress.value.colours === "none");
const setupChanged = computed(
  () => stress.value.ranSetup !== null && stress.value.ranSetup !== JSON.stringify(stress.value.setup),
);
const ranWith = computed(() => {
  const ran = stress.value.ranSetup;
  return ran ? setupSummary(JSON.parse(ran)) : setupSummary(stress.value.setup);
});
const keyRows = computed(() => props.result.rows);
const ends = computed(() => legendEnds(props.result.legend));
const detailsOpen = ref(false);

// A power of ten at most 1, so True size (1) and the two figure automatic scale sit on a step.
// Not below 1e-6, since Slider reads its decimals from String(step) and 1e-7 prints as an exponent. Parsed from "1e-4"
// rather than 10 ** -4, which some V8 builds round to 0.00009999999999999999.
const deformStep = computed(() => {
  const d = deform.value;
  const ref = Math.min(d?.max ?? 1, d?.auto ?? 1);
  return Math.min(1, Math.max(1e-6, Number(`1e${Math.floor(Math.log10(ref / 100))}`)));
});
</script>

<template>
  <div class="stress-step stress-results" data-panel-scroll :class="{ stale: modelChanged || setupChanged }">
    <div v-if="modelChanged || setupChanged" class="stress-stale">
      <span>{{ modelChanged ? "The model changed since this Run." : "The setup changed since this Run." }}</span>
      <Button
        variant="primary"
        size="sm"
        class="stress-rerun"
        :disabled="stress.running"
        @click="engine.ui.panels.runStress()"
        >Run again</Button
      >
    </div>

    <StressVerdict
      :input="result.verdict"
      :marked="!modelChanged"
      :scale="deform ? (deform.shown ? deform.scale : 0) : null"
      :max-deflection="result.maxDeflection"
      :unit="unit"
    />
    <div class="measure-k stress-ran-with">{{ ranWith }}</div>

    <template v-if="deform?.shown && !modelChanged">
      <div class="measure-row">
        <span :id="exaggerationId" class="measure-k">Exaggeration</span>
        <span class="measure-v stress-deform-label">{{ deformLabel(deform.scale) }}</span>
      </div>
      <div class="measure-row stress-deform-row">
        <Button
          size="sm"
          class="stress-animate"
          :icon="deform.animate ? 'pause' : 'play'"
          :pressed="deform.animate"
          :tip="deform.animate ? 'Hold the shape where it is' : 'Swing the shape between still and bent'"
          @click="engine.ui.panels.setStressAnimate(!deform.animate)"
          >{{ deform.animate ? "Pause" : "Play" }}</Button
        >
        <Slider
          class="stress-deform"
          :labelledby="exaggerationId"
          :model-value="deform.scale"
          :min="0"
          :max="deform.max"
          :step="deformStep"
          tip="Exaggeration"
          @update:model-value="engine.ui.panels.setStressDeformation($event)"
        />
        <Button
          size="sm"
          class="stress-true-scale"
          tip="Draw the deflection at its true size"
          @click="engine.ui.panels.setStressDeformation(1)"
          >True size</Button
        >
      </div>
    </template>

    <div class="stress-view-row">
      <label v-if="!modelChanged" class="stress-gravity" title="Show the stress colours on the body">
        <Switch
          :model-value="stress.colours === 'shown'"
          class="stress-colours"
          label="Colours"
          @update:model-value="engine.ui.panels.setStressColours($event)"
        />
        <span class="measure-k">Colours</span>
      </label>
      <label v-if="deform && !modelChanged" class="stress-gravity" title="Draw the body bent under the load">
        <Switch
          :model-value="deform.shown"
          class="stress-shape"
          label="Deformed shape"
          @update:model-value="engine.ui.panels.setStressShape($event)"
        />
        <span class="measure-k">Deformed shape</span>
      </label>
      <!-- Stays pressable to leave probe mode whatever the colours are doing. -->
      <Button
        size="sm"
        class="stress-probe"
        :pressed="stress.probe"
        :disabled="modelChanged && !stress.probe"
        tip="Read the stress at a point on the body"
        @click="engine.ui.panels.setStressProbe(!stress.probe)"
        >Read a point</Button
      >
    </div>

    <div v-for="(p, i) in stress.pins" :key="'p' + p.id" class="measure-row stress-pin">
      <span class="measure-k">Point {{ i + 1 }}</span>
      <span class="measure-v">{{ p.label }}</span>
      <IconButton
        class="stress-remove-pin"
        icon="close"
        :tip="`Remove point ${i + 1}`"
        size="sm"
        variant="danger"
        :icon-size="14"
        @click="engine.ui.panels.removeStressProbe(p.id)"
      />
    </div>

    <template v-if="stress.colours === 'shown'">
      <div class="stress-legend" :style="{ background: gradient }" />
      <div class="measure-row stress-legend-labels">
        <span class="measure-v">{{ ends[0] }} MPa</span>
        <span class="measure-k">Stress</span>
        <span class="measure-v">{{ ends[1] }} MPa</span>
      </div>
    </template>

    <div v-for="r in keyRows" :key="r.k" class="measure-row stress-key-row">
      <span class="measure-k">{{ r.k }}</span>
      <span class="measure-v" :class="{ 'stress-yields': r.k === 'Safety factor' && result.yields }">{{ r.v }}</span>
    </div>

    <Button
      variant="ghost"
      size="sm"
      class="stress-more stress-details"
      :aria-expanded="detailsOpen"
      @click="detailsOpen = !detailsOpen"
    >
      <template #icon><Icon :name="detailsOpen ? 'caretDown' : 'caretRight'" :size="12" /></template>Details
    </Button>
    <div v-show="detailsOpen" class="stress-fold stress-details-body">
      <div v-for="(r, i) in result.details" :key="i" class="measure-row stress-detail-row">
        <span class="measure-k">{{ r.k }}</span>
        <span class="measure-v">{{ r.v }}</span>
      </div>
    </div>

    <div v-for="(w, i) in result.warnings" :key="'w' + i" class="measure-hint stress-warning">{{
      plainWarning(w)
    }}</div>
  </div>
</template>
