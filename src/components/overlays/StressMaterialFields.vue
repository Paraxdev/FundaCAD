<script setup lang="ts">
import { computed } from "vue";
import NumberField from "../ui/NumberField.vue";
import Select from "../ui/Select.vue";
import { t } from "../../i18n";
import { STRESS_MATERIALS, materialOptions, type StressSetup } from "../../ui/stress";
import { spellNumber, spellRounded } from "../../ui/measure";

const props = defineProps<{ setup: StressSetup }>();

const preset = computed(() => STRESS_MATERIALS.find((m) => m.name === props.setup.material) ?? null);
const options = computed(materialOptions);

function fmt(v: number): string {
  return spellRounded(v);
}
</script>

<template>
  <label class="stress-field stress-keyed">
    <span class="measure-k">{{ t("stress.setup.material") }}</span>
    <Select v-model="setup.material" :options="options" :label="t('stress.setup.material')" class="stress-material" />
  </label>
  <div v-if="preset" class="measure-k stress-material-line">
    {{
      t("stress.setup.materialLine", {
        e: fmt(preset.E),
        nu: spellNumber(preset.nu),
        yield: fmt(preset.yield),
        density: fmt(preset.density),
      })
    }}
  </div>
  <template v-else>
    <div class="stress-field stress-keyed">
      <span class="measure-k">E</span>
      <NumberField v-model="setup.custom.E" commit="live" unit="MPa" :width-ch="7" class="stress-e" label="E" />
    </div>
    <div class="stress-field stress-keyed">
      <span class="measure-k">{{ t("stress.setup.poisson") }}</span>
      <NumberField
        v-model="setup.custom.nu"
        commit="live"
        unitless
        :step="0.01"
        :width-ch="7"
        class="stress-nu"
        :label="t('stress.setup.poisson')"
      />
    </div>
    <div class="stress-field stress-keyed">
      <span class="measure-k">{{ t("stress.setup.yield") }}</span>
      <NumberField
        v-model="setup.custom.yield"
        commit="live"
        unit="MPa"
        :width-ch="7"
        class="stress-yield"
        :label="t('stress.setup.yield')"
      />
    </div>
    <div class="stress-field stress-keyed">
      <span class="measure-k">{{ t("stress.setup.density") }}</span>
      <NumberField
        v-model="setup.custom.density"
        commit="live"
        unit="g/cm³"
        :step="0.1"
        :width-ch="7"
        class="stress-density"
        :label="t('stress.setup.density')"
      />
    </div>
  </template>
</template>
