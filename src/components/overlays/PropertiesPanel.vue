<script setup lang="ts">
// Inspect → Properties: volume / area / centre of mass / bounding box, plus a
// filament estimate (mass + length at 1.75mm and 2.85mm) from a material
// density and infill %. The measurements are a one-shot readout of the
// CURRENT selection (computed by ui/panels.ts at open time); the estimate
// below is live, it recomputes from `raw` as material/infill/wall change,
// no new geometry call needed for that.

import { computed, reactive } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import FloatingPanel from "./FloatingPanel.vue";
import { displayRound } from "../../ui/units";
import { printPrefs, setPrintPref } from "../../ui/printPrefs";
import {
  MATERIAL_PRESETS, CUSTOM_MATERIAL_ID, FILAMENT_DIAMETERS,
  densityFor, estimateFilament,
} from "../../features/filamentEstimate";

const engine = useEngine();
const panels = usePanelsStore();

// A local reactive copy so the controls respond instantly; each edit also
// persists through setPrintPref (module-level, shared across the app).
const prefs = reactive({ ...printPrefs() });
function commit<K extends "materialId" | "customDensity" | "infillPct" | "wallThicknessMm">(key: K) {
  setPrintPref(key, prefs[key]);
}

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
// Mass doesn't depend on filament diameter, any entry's massG is the same
// number; pulled out so the template never indexes into the array.
const massG = computed(() => estimates.value?.[0]?.massG ?? null);

function close() {
  engine.ui.panels.closeProperties();
}
</script>

<template>
  <FloatingPanel :open="!!panels.properties" close-on-esc panel-class="properties-panel" @close="close">
    <template v-if="panels.properties">
      <div class="measure-title">Properties, {{ panels.properties.title }}</div>
      <div v-for="r in panels.properties.rows" :key="r.k" class="measure-row">
        <span class="measure-k">{{ r.k }}</span>
        <span class="measure-v">{{ r.v }}</span>
      </div>

      <div class="measure-divider" />

      <div class="measure-row">
        <span class="measure-k">Material</span>
        <select class="measure-select" v-model="prefs.materialId" @change="commit('materialId')">
          <option v-for="m in MATERIAL_PRESETS" :key="m.id" :value="m.id">{{ m.label }} ({{ m.density }} g/cm³)</option>
          <option :value="CUSTOM_MATERIAL_ID">Custom…</option>
        </select>
      </div>
      <div v-if="prefs.materialId === CUSTOM_MATERIAL_ID" class="measure-row">
        <span class="measure-k">Density</span>
        <span class="measure-v">
          <input
            class="measure-number"
            type="number" min="0.1" max="30" step="0.01"
            v-model.number="prefs.customDensity"
            @change="commit('customDensity')"
          /> g/cm³
        </span>
      </div>
      <div class="measure-row">
        <span class="measure-k">Infill</span>
        <span class="measure-v">
          <input
            type="range" min="0" max="100" step="5"
            v-model.number="prefs.infillPct"
            @change="commit('infillPct')"
            style="vertical-align: middle; margin-right: 6px"
          />{{ prefs.infillPct }}%
        </span>
      </div>
      <div class="measure-row">
        <span class="measure-k">Wall thickness</span>
        <span class="measure-v">
          <input
            class="measure-number"
            type="number" min="0" max="20" step="0.1"
            v-model.number="prefs.wallThicknessMm"
            @change="commit('wallThicknessMm')"
          /> mm
        </span>
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
        Estimate: solid volume at 100% infill; below that, shell (area × wall) plus infill share of the rest · Esc to close
      </div>
    </template>
  </FloatingPanel>
</template>
