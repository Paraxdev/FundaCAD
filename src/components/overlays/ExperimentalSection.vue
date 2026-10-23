<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  DEFAULT_EXPERIMENTAL,
  ENV_WIDTHS,
  EXPERIMENTAL_RANGE,
  experimentalPrefs,
  onExperimentalPrefsChange,
  resetExperimentalPrefs,
  setExperimentalPref,
  type EnvWidth,
  type ExperimentalPrefs,
} from "../../ui/experimentalPrefs";
import { hdrTextureMax } from "../../viewport/hdrRegistry";

type NumberKey = keyof typeof EXPERIMENTAL_RANGE;

const prefs = ref({ ...experimentalPrefs() });
let off: (() => void) | null = null;
onMounted(() => {
  off = onExperimentalPrefsChange(() => {
    prefs.value = { ...experimentalPrefs() };
  });
});
onUnmounted(() => off?.());

const changed = computed(() =>
  (Object.keys(DEFAULT_EXPERIMENTAL) as (keyof ExperimentalPrefs)[]).some(
    (k) => prefs.value[k] !== DEFAULT_EXPERIMENTAL[k],
  ),
);
const widthLabel = (w: EnvWidth) => (w === "gpu" ? `GPU maximum (${hdrTextureMax()})` : String(w));

interface Field {
  key: NumberKey;
  title: string;
  unit: string;
  step: number;
  /** Shown and typed in these units, stored times `scale`. */
  scale: number;
  hint: string;
}
const PATH: Field[] = [
  {
    key: "sampleCap",
    title: "Samples per pixel",
    unit: "samples",
    step: 1,
    scale: 1,
    hint: "Where Path traced stops refining. More is cleaner and takes longer.",
  },
  {
    key: "batterySampleCap",
    title: "Samples on battery",
    unit: "samples",
    step: 1,
    scale: 1,
    hint: "The same, while a laptop runs on its battery.",
  },
  {
    key: "bounces",
    title: "Bounces",
    unit: "bounces",
    step: 1,
    scale: 1,
    hint: "How many times light reflects or passes through glass, in both tracers.",
  },
  {
    key: "firefly",
    title: "Firefly clamp",
    unit: "luminance",
    step: 1,
    scale: 1,
    hint: "How bright an indirect light sample may be before it is turned down, in the native tracer. 0 turns the clamp off, which is unbiased and speckled.",
  },
  {
    key: "traceScale",
    title: "Trace resolution",
    unit: "of the screen",
    step: 0.05,
    scale: 1,
    hint: "The viewport trace against the screen's pixels, up to 1, the view's own size. Empty is Auto, 0.75 or 0.5 by the screen and the battery.",
  },
  {
    key: "pictureMegapixels",
    title: "Largest traced picture",
    unit: "megapixels",
    step: 1,
    scale: 1,
    hint: "Save picture is scaled down past this. The GPU's own buffer and texture sizes still apply.",
  },
  {
    key: "triangleBudget",
    title: "Most triangles traced",
    unit: "million",
    step: 0.5,
    scale: 1e6,
    hint: "Path traced refuses a model with more. What the GPU can bind is still checked.",
  },
];

const shown = (f: Field) => +(prefs.value[f.key] / f.scale).toFixed(f.key === "pictureMegapixels" ? 1 : 3);
/** Trace resolution's 0 is Auto, shown as an empty box. */
const autoAtZero = (f: Field) => f.key === "traceScale";
const boxValue = (f: Field) => (autoAtZero(f) && shown(f) === 0 ? "" : String(shown(f)));
const defaultShown = (f: Field) =>
  +(DEFAULT_EXPERIMENTAL[f.key] / f.scale).toFixed(f.key === "pictureMegapixels" ? 1 : 3);
const onNumber = (f: Field, e: Event) => {
  const input = e.target as HTMLInputElement;
  const v = input.value.trim() === "" && autoAtZero(f) ? 0 : Number.parseFloat(input.value);
  if (Number.isFinite(v)) setExperimentalPref(f.key, v * f.scale);
  input.value = boxValue(f);
};
const pickWidth = (w: EnvWidth) => setExperimentalPref("envWidth", w);
const min = (f: Field) => EXPERIMENTAL_RANGE[f.key][0] / f.scale;
const max = (f: Field) => EXPERIMENTAL_RANGE[f.key][1] / f.scale;
</script>

<template>
  <h3 class="prefs-pane-title">Experimental</h3>
  <p class="pref-warning" role="note" data-experimental-warning>
    These settings can make FundaCAD unstable or crash it. Use them at your own risk.
  </p>
  <div class="prefs-grid">
    <div class="pref-card wide">
      <div class="pref-head">
        <span class="pref-title">HDR environment size</span>
        <div id="prefs-env-width" class="pref-seg" role="radiogroup" aria-label="HDR environment size">
          <button
            v-for="w in ENV_WIDTHS"
            :key="w"
            type="button"
            role="radio"
            :aria-checked="prefs.envWidth === w"
            :class="{ on: prefs.envWidth === w }"
            :data-env-width="w"
            @click="pickWidth(w)"
            >{{ widthLabel(w) }}</button
          >
        </div>
      </div>
      <p class="pref-hint">
        The width an imported HDR is kept at, for lighting and inside saved documents; the lighting reads half of it.
        Larger needs more memory and makes documents bigger. Applies to the next import. Default 2048.
      </p>
    </div>
    <div v-for="f in PATH" :key="f.key" class="pref-card">
      <div class="pref-head">
        <label class="pref-title" :for="`prefs-x-${f.key}`">{{ f.title }}</label>
        <span class="pref-number">
          <input
            :id="`prefs-x-${f.key}`"
            class="sm-input"
            type="number"
            :min="min(f)"
            :max="max(f)"
            :step="f.step"
            :value="boxValue(f)"
            :placeholder="autoAtZero(f) ? 'Auto' : undefined"
            :data-experimental="f.key"
            @change="onNumber(f, $event)"
          />
          <span class="prefs-readout">{{ f.unit }}</span>
        </span>
      </div>
      <p class="pref-hint"> {{ f.hint }} Default {{ autoAtZero(f) ? "Auto" : defaultShown(f) }}. </p>
    </div>
  </div>
  <div class="prefs-actions">
    <button type="button" class="btn" :disabled="!changed" data-experimental-reset @click="resetExperimentalPrefs"
      >Reset to defaults</button
    >
  </div>
</template>
