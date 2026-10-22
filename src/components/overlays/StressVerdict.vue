<script setup lang="ts">
import { computed } from "vue";
import { deflectionNote, type StressVerdictView } from "../../ui/stressVerdict";
import type { Unit } from "../../ui/units";

const props = defineProps<{
  view: StressVerdictView;
  scale: number | null;
  maxDeflection: number | null;
  unit: Unit;
}>();

const bend = computed(() =>
  props.scale === null ? null : deflectionNote(props.maxDeflection, props.unit, props.scale),
);
</script>

<template>
  <div class="stress-verdict" :class="view.level">
    <div class="stress-verdict-head">{{ view.headline }}</div>
    <div v-if="view.detail" class="stress-verdict-line">{{ view.detail }}</div>
    <div v-if="bend" class="stress-verdict-line stress-verdict-bend">{{ bend }}</div>
  </div>
</template>
