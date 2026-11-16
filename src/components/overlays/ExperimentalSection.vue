<script setup lang="ts">
import { fieldNumber, spellNumber } from "../../ui/measure";
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { t } from "../../i18n";
import { confirmDanger } from "../../ui/choice";
import { toast } from "../../ui/toast";
import { claimEscape } from "../../ui/escapeClaim";
import {
  DEFAULT_EXPERIMENTAL,
  ENV_WIDTHS,
  EXPERIMENTAL_GROUPS,
  EXPERIMENTAL_RANGE,
  experimentalLocked,
  experimentalPrefs,
  onExperimentalPrefsChange,
  resetExperimentalGroup,
  setExperimentalPref,
  type EnvWidth,
  type ExperimentalGroup,
  type ExperimentalPrefs,
} from "../../ui/experimentalPrefs";
import { hdrTextureMax } from "../../viewport/hdrRegistry";
import Button from "../ui/Button.vue";
import Chip from "../ui/Chip.vue";
import NumberField from "../ui/NumberField.vue";
import Segmented from "../ui/Segmented.vue";

type NumberKey = keyof typeof EXPERIMENTAL_RANGE;

const prefs = ref({ ...experimentalPrefs() });
let off: (() => void) | null = null;
onMounted(() => {
  off = onExperimentalPrefsChange(() => {
    prefs.value = { ...experimentalPrefs() };
  });
});
// While the focused number holds a draft, its Escape reverts the draft and the dialog closes on the next Escape.
let releaseEscape: (() => void) | null = null;
function holdEscape(on: boolean) {
  if (on) releaseEscape ??= claimEscape();
  else {
    releaseEscape?.();
    releaseEscape = null;
  }
}
const refused = (e: Event) => (e.target as HTMLElement).getAttribute("aria-invalid") === "true";
// A draft that reads back as the stored number leaves Escape nothing to revert, so the first Escape closes.
function drafted(f: Field, e: Event) {
  const text = (e.target as HTMLInputElement).value.trim();
  holdEscape(text === "" ? boxValue(f) !== null : fieldNumber(text) !== boxValue(f));
}
function onNumberKey(f: Field, e: KeyboardEvent) {
  if (e.key === "ArrowUp" || e.key === "ArrowDown") void nextTick(() => drafted(f, e));
  else if (e.key === "Escape") holdEscape(false);
  else if (e.key === "Enter") void nextTick(() => holdEscape(refused(e)));
}
onUnmounted(() => {
  off?.();
  holdEscape(false);
});

const locked = experimentalLocked();
const LOCKED_REASON = computed(() => t("prefs.experimental.lockedReason"));

async function onReset(g: ExperimentalGroup) {
  const asked = await confirmDanger(
    t("prefs.experimental.resetTitle", { group: g.title }),
    t("prefs.experimental.resetAction"),
    t("prefs.experimental.resetBody", { group: g.title }),
  );
  if (!asked) return;
  resetExperimentalGroup(g.id);
  toast(t("prefs.experimental.resetDone", { group: g.title }));
}

const changed = (k: keyof ExperimentalPrefs) => prefs.value[k] !== DEFAULT_EXPERIMENTAL[k];
const groupChanged = (g: ExperimentalGroup) => g.keys.some(changed);
const changedId = (k: keyof ExperimentalPrefs) => `prefs-x-${k}-changed`;
const widthLabel = (w: EnvWidth) =>
  w === "gpu" ? t("prefs.experimental.envWidth.gpu", { n: hdrTextureMax() }) : String(w);
const widthOptions = () =>
  ENV_WIDTHS.map((w) => ({ value: w, label: widthLabel(w), attrs: { "data-env-width": String(w) } }));

interface Field {
  key: NumberKey;
  title: string;
  unit: string;
  step: number;
  /** Shown and typed in these units, stored times `scale`. */
  scale: number;
  hint: string;
}
const FIELDS = computed<Field[]>(() => [
  {
    key: "sampleCap",
    title: t("prefs.experimental.sampleCap.title"),
    unit: t("prefs.experimental.sampleCap.unit"),
    step: 1,
    scale: 1,
    hint: t("prefs.experimental.sampleCap.hint"),
  },
  {
    key: "batterySampleCap",
    title: t("prefs.experimental.batterySampleCap.title"),
    unit: t("prefs.experimental.batterySampleCap.unit"),
    step: 1,
    scale: 1,
    hint: t("prefs.experimental.batterySampleCap.hint"),
  },
  {
    key: "bounces",
    title: t("prefs.experimental.bounces.title"),
    unit: t("prefs.experimental.bounces.unit"),
    step: 1,
    scale: 1,
    hint: t("prefs.experimental.bounces.hint"),
  },
  {
    key: "firefly",
    title: t("prefs.experimental.firefly.title"),
    unit: t("prefs.experimental.firefly.unit"),
    step: 1,
    scale: 1,
    hint: t("prefs.experimental.firefly.hint"),
  },
  {
    key: "traceScale",
    title: t("prefs.experimental.traceScale.title"),
    unit: t("prefs.experimental.traceScale.unit"),
    step: 0.05,
    scale: 1,
    hint: t("prefs.experimental.traceScale.hint"),
  },
  {
    key: "pictureMegapixels",
    title: t("prefs.experimental.pictureMegapixels.title"),
    unit: t("prefs.experimental.pictureMegapixels.unit"),
    step: 1,
    scale: 1,
    hint: t("prefs.experimental.pictureMegapixels.hint"),
  },
  {
    key: "triangleBudget",
    title: t("prefs.experimental.triangleBudget.title"),
    unit: t("prefs.experimental.triangleBudget.unit"),
    step: 0.5,
    scale: 1e6,
    hint: t("prefs.experimental.triangleBudget.hint"),
  },
]);

const fieldsOf = (g: ExperimentalGroup) => FIELDS.value.filter((f) => g.keys.includes(f.key));
const defaultLine = (f: Field) =>
  t("prefs.experimental.default", {
    value: autoAtZero(f) ? t("prefs.experimental.auto") : spellNumber(defaultShown(f)),
  });

const shown = (f: Field) => +(prefs.value[f.key] / f.scale).toFixed(f.key === "pictureMegapixels" ? 1 : 3);
/** Trace resolution's 0 is Auto, shown as an empty box. */
const autoAtZero = (f: Field) => f.key === "traceScale";
const boxValue = (f: Field) => (autoAtZero(f) && shown(f) === 0 ? null : shown(f));
const defaultShown = (f: Field) =>
  +(DEFAULT_EXPERIMENTAL[f.key] / f.scale).toFixed(f.key === "pictureMegapixels" ? 1 : 3);
const onNumber = (f: Field, v: number | null) => setExperimentalPref(f.key, (v ?? 0) * f.scale);
const pickWidth = (w: EnvWidth) => setExperimentalPref("envWidth", w);
const min = (f: Field) => EXPERIMENTAL_RANGE[f.key][0] / f.scale;
const max = (f: Field) => EXPERIMENTAL_RANGE[f.key][1] / f.scale;
</script>

<template>
  <h3 class="prefs-pane-title" tabindex="-1">{{ t("prefs.tab.experimental") }}</h3>
  <p class="pref-warning" role="note" data-experimental-warning>{{ t("prefs.experimental.warning") }}</p>
  <p v-if="locked" class="pref-hint prefs-x-locked" role="note" data-experimental-locked>{{
    t("prefs.experimental.locked")
  }}</p>
  <div
    v-for="g in EXPERIMENTAL_GROUPS"
    :key="g.id"
    class="prefs-group"
    role="group"
    :aria-labelledby="`prefs-x-group-${g.id}`"
    :data-experimental-group="g.id"
  >
    <div class="prefs-group-head">
      <h4 :id="`prefs-x-group-${g.id}`" class="prefs-group-title">{{ g.title }}</h4>
      <Button
        size="sm"
        :disabled="locked || !groupChanged(g)"
        :disabled-reason="locked ? LOCKED_REASON : undefined"
        :aria-describedby="`prefs-x-group-${g.id}`"
        :data-experimental-reset="g.id"
        @click="onReset(g)"
        >{{ t("prefs.experimental.reset") }}</Button
      >
    </div>
    <div class="prefs-grid">
      <div v-if="g.keys.includes('envWidth')" class="pref-card wide">
        <div class="pref-head">
          <span class="pref-title-row">
            <span class="pref-title">{{ t("prefs.experimental.envWidth.title") }}</span>
            <Chip v-if="changed('envWidth')" :id="changedId('envWidth')" variant="accent" data-experimental-changed>{{
              t("prefs.experimental.changed")
            }}</Chip>
          </span>
          <Segmented
            id="prefs-env-width"
            :label="t('prefs.experimental.envWidth.title')"
            :model-value="prefs.envWidth"
            :options="widthOptions()"
            :disabled="locked"
            :disabled-reason="locked ? LOCKED_REASON : undefined"
            :aria-describedby="changed('envWidth') ? changedId('envWidth') : undefined"
            @update:model-value="pickWidth"
          />
        </div>
        <p class="pref-hint">{{ t("prefs.experimental.envWidth.hint") }}</p>
      </div>
      <div v-for="f in fieldsOf(g)" :key="f.key" class="pref-card">
        <div class="pref-head">
          <span class="pref-title-row">
            <label class="pref-title" :for="`prefs-x-${f.key}`">{{ f.title }}</label>
            <Chip v-if="changed(f.key)" :id="changedId(f.key)" variant="accent" data-experimental-changed>{{
              t("prefs.experimental.changed")
            }}</Chip>
          </span>
          <span
            class="pref-number"
            @input="drafted(f, $event)"
            @keydown="onNumberKey(f, $event)"
            @focusin="holdEscape(refused($event))"
            @focusout="holdEscape(false)"
          >
            <NumberField
              :id="`prefs-x-${f.key}`"
              :label="f.title"
              :model-value="boxValue(f)"
              :min="min(f)"
              :max="max(f)"
              :step="f.step"
              :nullable="autoAtZero(f)"
              :placeholder="autoAtZero(f) ? t('prefs.experimental.auto') : undefined"
              :caption="f.unit"
              :width-ch="9"
              :disabled="locked"
              :disabled-reason="locked ? LOCKED_REASON : undefined"
              :aria-describedby="changed(f.key) ? changedId(f.key) : undefined"
              :data-experimental="f.key"
              @update:model-value="onNumber(f, $event)"
            />
          </span>
        </div>
        <p class="pref-hint"> {{ f.hint }} {{ defaultLine(f) }} </p>
      </div>
    </div>
  </div>
</template>
