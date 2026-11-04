<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { legendGradient, legendTicks, STRESS_BANDS, STRESS_RAMPS, type StressRamp } from "../../ui/stress";
import { onStressLookChange, stressLook } from "../../ui/stressLook";
import Select from "../ui/Select.vue";
import Switch from "../ui/Switch.vue";

const props = defineProps<{ legend: { min: number; max: number } }>();

const engine = useEngine();
const look = ref({ ...stressLook() });
const gradient = computed(() => legendGradient(look.value.ramp, look.value.bands ? STRESS_BANDS : 0));
let stop: (() => void) | null = null;
onMounted(() => {
  look.value = { ...stressLook() };
  stop = onStressLookChange((l) => (look.value = { ...l }));
});
onUnmounted(() => stop?.());
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
    <div class="stress-look">
      <label class="stress-field">
        <span class="measure-k">Colour map</span>
        <Select
          :model-value="look.ramp"
          :options="STRESS_RAMPS"
          size="sm"
          label="Colour map"
          testid="stress-colour-map"
          @update:model-value="(r: StressRamp) => engine.ui.panels.setStressLook({ ramp: r })"
        />
      </label>
      <label class="stress-gravity" title="Draw the colours in steps">
        <Switch
          :model-value="look.bands"
          class="stress-bands"
          label="Bands"
          @update:model-value="engine.ui.panels.setStressLook({ bands: $event })"
        />
        <span class="measure-k">Bands</span>
      </label>
    </div>
  </div>
</template>
