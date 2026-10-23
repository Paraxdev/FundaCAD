<script setup lang="ts">
import { computed } from "vue";
import NumberBox from "../shell/NumberBox.vue";
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
    <Select v-model="setup.material" :options="options" class="stress-material" />
  </label>
  <div v-if="preset" class="measure-k stress-material-line">
    E {{ fmt(preset.E) }} MPa, ν {{ preset.nu }}, yield {{ fmt(preset.yield) }} MPa, {{ fmt(preset.density) }} g/cm³
  </div>
  <template v-else>
    <div class="stress-field">
      <span class="measure-k">E</span>
      <span class="stress-number"><NumberBox v-model="setup.custom.E" class="sm-input stress-e" /> MPa</span>
    </div>
    <div class="stress-field">
      <span class="measure-k">Poisson's ratio</span>
      <span class="stress-number"><NumberBox v-model="setup.custom.nu" class="sm-input stress-nu" /></span>
    </div>
    <div class="stress-field">
      <span class="measure-k">Yield</span>
      <span class="stress-number"><NumberBox v-model="setup.custom.yield" class="sm-input stress-yield" /> MPa</span>
    </div>
    <div class="stress-field">
      <span class="measure-k">Density</span>
      <span class="stress-number"
        ><NumberBox v-model="setup.custom.density" class="sm-input stress-density" /> g/cm³</span
      >
    </div>
  </template>
</template>
