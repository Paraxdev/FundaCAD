<script setup lang="ts">
import { computed } from "vue";
import NumberField from "../ui/NumberField.vue";
import Select from "../ui/Select.vue";
import { CUSTOM_MATERIAL, STRESS_MATERIALS, type StressSetup } from "../../ui/stress";
import { displayRound } from "../../ui/units";

const props = defineProps<{ setup: StressSetup }>();

const preset = computed(() => STRESS_MATERIALS.find((m) => m.name === props.setup.material) ?? null);
const options = [
  ...STRESS_MATERIALS.map((m) => ({ value: m.name, label: m.name })),
  { value: CUSTOM_MATERIAL, label: CUSTOM_MATERIAL },
];

function fmt(v: number): string {
  return String(displayRound(v));
}
</script>

<template>
  <label class="stress-field">
    <span class="measure-k">Material</span>
    <Select v-model="setup.material" :options="options" label="Material" class="stress-material" />
  </label>
  <div v-if="preset" class="measure-k stress-material-line">
    E {{ fmt(preset.E) }} MPa, ν {{ preset.nu }}, yield {{ fmt(preset.yield) }} MPa, {{ fmt(preset.density) }} g/cm³
  </div>
  <template v-else>
    <div class="stress-field">
      <span class="measure-k">E</span>
      <NumberField v-model="setup.custom.E" commit="live" unit="MPa" :width-ch="7" class="stress-e" aria-label="E" />
    </div>
    <div class="stress-field">
      <span class="measure-k">Poisson's ratio</span>
      <NumberField
        v-model="setup.custom.nu"
        commit="live"
        :step="0.01"
        :width-ch="7"
        class="stress-nu"
        aria-label="Poisson's ratio"
      />
    </div>
    <div class="stress-field">
      <span class="measure-k">Yield</span>
      <NumberField
        v-model="setup.custom.yield"
        commit="live"
        unit="MPa"
        :width-ch="7"
        class="stress-yield"
        aria-label="Yield"
      />
    </div>
    <div class="stress-field">
      <span class="measure-k">Density</span>
      <NumberField
        v-model="setup.custom.density"
        commit="live"
        unit="g/cm³"
        :step="0.1"
        :width-ch="7"
        class="stress-density"
        aria-label="Density"
      />
    </div>
  </template>
</template>
