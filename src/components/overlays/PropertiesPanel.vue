<script setup lang="ts">
// The measurements are a one-shot readout of the selection at open (ui/panels.ts), the filament estimate is live.

import { computed, reactive } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import Panel from "../ui/Panel.vue";
import Select from "../ui/Select.vue";
import NumberField from "../ui/NumberField.vue";
import Slider from "../ui/Slider.vue";
import { displayRound } from "../../ui/units";
import { printPrefs, setPrintPref } from "../../ui/printPrefs";
import {
  MATERIAL_PRESETS,
  CUSTOM_MATERIAL_ID,
  FILAMENT_DIAMETERS,
  densityFor,
  estimateFilament,
} from "../../features/filamentEstimate";

const engine = useEngine();
const panels = usePanelsStore();

// A local copy so the controls respond instantly, each edit also persists through the app-wide setPrintPref: a pick at
// once, a typed number on its field's change.
const prefs = reactive({ ...printPrefs() });
type Key = "materialId" | "customDensity" | "infillPct" | "wallThicknessMm";
function commit<K extends Key>(key: K) {
  setPrintPref(key, prefs[key]);
}
function take<K extends Key>(key: K, v: (typeof prefs)[K] | null) {
  if (v !== null) prefs[key] = v;
}
function set<K extends Key>(key: K, v: (typeof prefs)[K] | null) {
  if (v === null) return;
  prefs[key] = v;
  commit(key);
}

const MATERIALS = [
  ...MATERIAL_PRESETS.map((m) => ({ value: m.id, label: `${m.label} (${m.density} g/cm³)` })),
  { value: CUSTOM_MATERIAL_ID, label: "Custom…" },
];

const density = computed(() => densityFor(prefs.materialId, prefs.customDensity));

const estimates = computed(() => {
  const raw = panels.properties?.raw;
  if (!raw) return null;
  return FILAMENT_DIAMETERS.map((d) => ({
    diameter: d,
    ...estimateFilament({
      volumeMm3: raw.volumeMm3,
      areaMm2: raw.areaMm2,
      densityGPerCm3: density.value,
      infillPct: prefs.infillPct,
      wallThicknessMm: prefs.wallThicknessMm,
      filamentDiameterMm: d,
    }),
  }));
});
// Mass does not depend on filament diameter, so any entry's massG will do.
const massG = computed(() => estimates.value?.[0]?.massG ?? null);

function close() {
  engine.ui.panels.closeProperties();
}
</script>

<template>
  <Panel
    :open="!!panels.properties"
    :title="panels.properties ? `Properties, ${panels.properties.title}` : undefined"
    close-on-esc
    panel-class="properties-panel"
    @close="close"
  >
    <template v-if="panels.properties">
      <div v-for="r in panels.properties.rows" :key="r.k" class="measure-row">
        <span class="measure-k">{{ r.k }}</span>
        <span class="measure-v">{{ r.v }}</span>
      </div>

      <template v-if="panels.properties.faults.length">
        <div class="measure-divider" />
        <div class="measure-hint" style="color: var(--accent-hot)">Not a sound solid, so no volume or mass:</div>
        <div v-for="(why, i) in panels.properties.faults" :key="'fault' + i" class="measure-hint">{{ why }}</div>
      </template>

      <template v-if="panels.properties.raw">
        <div class="measure-divider" />

        <div class="measure-row">
          <span class="measure-k">Material</span>
          <Select
            :model-value="prefs.materialId"
            :options="MATERIALS"
            size="sm"
            label="Material"
            @update:model-value="set('materialId', $event)"
          />
        </div>
        <div v-if="prefs.materialId === CUSTOM_MATERIAL_ID" class="measure-row">
          <span class="measure-k">Density</span>
          <NumberField
            class="measure-v"
            commit="live"
            size="sm"
            unit="g/cm³"
            :width-ch="6"
            :min="0.1"
            :max="30"
            :step="0.01"
            label="Density"
            tip="Density"
            :model-value="prefs.customDensity"
            @update:model-value="take('customDensity', $event)"
            @change="commit('customDensity')"
          />
        </div>
        <div class="measure-row">
          <span class="measure-k">Infill</span>
          <Slider
            v-model="prefs.infillPct"
            class="measure-v"
            :min="0"
            :max="100"
            :step="5"
            unit="%"
            show-value
            tip="Infill"
            @commit="commit('infillPct')"
          />
        </div>
        <div class="measure-row">
          <span class="measure-k">Wall thickness</span>
          <NumberField
            class="measure-v"
            commit="live"
            size="sm"
            unit="mm"
            :width-ch="6"
            :min="0"
            :max="20"
            :step="0.1"
            label="Wall thickness"
            tip="Wall thickness"
            :model-value="prefs.wallThicknessMm"
            @update:model-value="take('wallThicknessMm', $event)"
            @change="commit('wallThicknessMm')"
          />
        </div>

        <template v-if="estimates && massG !== null">
          <div class="measure-divider" />
          <div class="measure-row">
            <span class="measure-k">Mass, estimate</span>
            <span class="measure-v">{{ displayRound(massG) }} g</span>
          </div>
          <div v-for="e in estimates" :key="e.diameter" class="measure-row">
            <span class="measure-k">Filament, {{ e.diameter }}mm</span>
            <span class="measure-v">{{ displayRound(e.lengthM) }} m</span>
          </div>
        </template>

        <div class="measure-hint">
          Estimate: solid volume at 100% infill; below that, shell (area × wall) plus infill share of the rest · Esc to
          close
        </div>
      </template>
    </template>
  </Panel>
</template>
