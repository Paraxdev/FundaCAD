<script setup lang="ts">
import { computed, watch } from "vue";
import { t } from "../../i18n";
import { announce } from "../../ui/announce";
import { deflectionNote, verdictView, type VerdictInput } from "../../ui/stressVerdict";
import type { Unit } from "../../ui/units";

const props = defineProps<{
  input: VerdictInput;
  marked: boolean;
  scale: number | null;
  maxDeflection: number | null;
  unit: Unit;
}>();

const view = computed(() => verdictView(props.input, undefined, props.marked));
const bend = computed(() =>
  props.scale === null ? null : deflectionNote(props.maxDeflection, props.unit, props.scale),
);

// Mounted with the result, so the first verdict is spoken as it appears. Keyed on the result, not on the text, so a
// language switch rewrites the words and says nothing.
watch(
  [() => props.input.safetyFactor, () => props.input.peakPlace ?? null, () => props.marked],
  () => {
    const { headline, detail } = view.value;
    announce(detail ? t("stress.verdict.said", { headline, detail }) : headline, "polite", { key: "stress" });
  },
  { immediate: true },
);
</script>

<template>
  <div class="stress-verdict" :class="view.level">
    <div class="stress-verdict-head">{{ view.headline }}</div>
    <div v-if="view.detail" class="stress-verdict-line">{{ view.detail }}</div>
    <div v-if="bend" class="stress-verdict-line stress-verdict-bend">{{ bend }}</div>
  </div>
</template>
