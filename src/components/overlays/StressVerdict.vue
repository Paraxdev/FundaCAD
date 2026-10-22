<script setup lang="ts">
import { computed } from "vue";
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
</script>

<template>
  <div class="stress-verdict" :class="view.level">
    <div class="stress-verdict-head">{{ view.headline }}</div>
    <div v-if="view.detail" class="stress-verdict-line">{{ view.detail }}</div>
    <div v-if="bend" class="stress-verdict-line stress-verdict-bend">{{ bend }}</div>
  </div>
</template>
