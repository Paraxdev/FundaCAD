<script setup lang="ts">
import { computed, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import Icon from "../shell/Icon.vue";
import StressVerdict from "./StressVerdict.vue";
import { plainWarning } from "../../ui/stressWarnings";
import { deformLabel, legendGradient, setupSummary, type StressResultView } from "../../ui/stress";
import { displayRound, getUnit } from "../../ui/units";

const props = defineProps<{ result: StressResultView }>();

const engine = useEngine();
const panels = usePanelsStore();

const stress = computed(() => panels.stress!);
const deform = computed(() => stress.value.deform);
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
const detailsOpen = ref(false);

function fmt(v: number): string {
  return String(displayRound(v));
}

function onDeform(e: Event) {
  engine.ui.panels.setStressDeformation(Number((e.target as HTMLInputElement).value));
}
</script>

<template>
  <div class="stress-step stress-results">
    <StressVerdict
      :input="result.verdict"
      :marked="stress.colours === 'shown'"
      :scale="deform?.scale ?? null"
      :max-deflection="result.maxDeflection"
      :unit="unit"
    />
    <div class="measure-k stress-ran-with">{{ ranWith }}</div>

    <div v-if="modelChanged || setupChanged" class="stress-stale">
      <span>{{ modelChanged ? "The model changed since this Run." : "The setup changed since this Run." }}</span>
      <button
        type="button"
        class="btn btn-primary stress-rerun"
        :disabled="stress.running"
        @click="engine.ui.panels.runStress()"
        >Run again</button
      >
    </div>

    <template v-if="deform && !modelChanged">
      <div class="measure-row">
        <span class="measure-k">Exaggeration</span>
        <span class="measure-v stress-deform-label">{{ deformLabel(deform.scale) }}</span>
      </div>
      <div class="measure-row stress-deform-row">
        <button
          type="button"
          class="btn stress-animate"
          :class="{ active: deform.animate }"
          :aria-pressed="deform.animate"
          :title="deform.animate ? 'Hold the shape where it is' : 'Swing the shape between still and bent'"
          @click="engine.ui.panels.setStressAnimate(!deform.animate)"
        >
          <Icon :name="deform.animate ? 'pause' : 'play'" :size="14" />{{ deform.animate ? "Pause" : "Play" }}
        </button>
        <input
          class="sm-slider stress-deform"
          type="range"
          min="0"
          :max="deform.max"
          :step="deform.max / 200"
          :value="deform.scale"
          aria-label="Exaggeration"
          @input="onDeform"
        />
        <button
          type="button"
          class="btn stress-true-scale"
          title="Draw the deflection at its true size"
          @click="engine.ui.panels.setStressDeformation(1)"
          >True size</button
        >
      </div>
    </template>

    <div class="stress-view-row">
      <label v-if="!modelChanged" class="stress-gravity" title="Show the stress colours on the body">
        <span class="param-switch">
          <input
            type="checkbox"
            class="stress-colours"
            :checked="stress.colours === 'shown'"
            @change="engine.ui.panels.setStressColours(($event.target as HTMLInputElement).checked)"
          />
          <span class="track"><span class="knob" /></span>
        </span>
        <span class="measure-k">Colours</span>
      </label>
      <!-- Stays pressable to leave probe mode whatever the colours are doing. -->
      <button
        type="button"
        class="btn stress-probe"
        :class="{ active: stress.probe }"
        :aria-pressed="stress.probe"
        :disabled="modelChanged && !stress.probe"
        title="Read the stress at a point on the body"
        @click="engine.ui.panels.setStressProbe(!stress.probe)"
        >Read a point</button
      >
    </div>

    <div v-for="(p, i) in stress.pins" :key="'p' + p.id" class="measure-row stress-pin">
      <span class="measure-k">Point {{ i + 1 }}</span>
      <span class="measure-v">{{ p.label }}</span>
      <button
        type="button"
        class="float-card-close stress-remove-pin"
        :title="`Remove point ${i + 1}`"
        :aria-label="`Remove point ${i + 1}`"
        @click="engine.ui.panels.removeStressProbe(p.id)"
      >
        <Icon name="close" :size="14" />
      </button>
    </div>

    <div class="stress-legend" :style="{ background: gradient }" />
    <div class="measure-row stress-legend-labels">
      <span class="measure-v">{{ fmt(result.legend.min) }} MPa</span>
      <span class="measure-k">Stress (von Mises)</span>
      <span class="measure-v">{{ fmt(result.legend.max) }} MPa</span>
    </div>

    <div v-for="r in keyRows" :key="r.k" class="measure-row stress-key-row">
      <span class="measure-k">{{ r.k }}</span>
      <span class="measure-v" :class="{ 'stress-yields': r.k === 'Safety factor' && result.yields }">{{ r.v }}</span>
    </div>

    <button
      type="button"
      class="stress-more stress-details"
      :aria-expanded="detailsOpen"
      @click="detailsOpen = !detailsOpen"
    >
      <Icon :name="detailsOpen ? 'caretDown' : 'caretRight'" :size="12" />Details
    </button>
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
