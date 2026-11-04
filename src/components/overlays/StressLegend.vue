<script setup lang="ts">
import { computed } from "vue";
import { legendGradient, legendTicks } from "../../ui/stress";

const props = defineProps<{ legend: { min: number; max: number } }>();

const gradient = legendGradient();
const ticks = computed(() => legendTicks(props.legend));
</script>

<template>
  <div class="stress-legend-wrap">
    <div class="stress-legend" :style="{ background: gradient }" />
    <ol class="stress-ticks" aria-label="Stress scale, MPa">
      <li
        v-for="t in ticks"
        :key="t.pct"
        class="stress-tick"
        :class="{ 'is-first': t.pct === 0, 'is-last': t.pct === 100 }"
        :style="{ left: `${t.pct}%` }"
      >
        {{ t.label }}
      </li>
    </ol>
    <div class="stress-legend-unit" aria-hidden="true">Stress, MPa</div>
  </div>
</template>
