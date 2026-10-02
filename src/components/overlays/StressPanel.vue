<script setup lang="ts">
// Inspect → Stress: a linear static analysis of one body. The user picks faces
// in the view and sets them as fixed or as a load's faces, chooses a material
// and runs it; the result reads out here with a colour legend while the view
// shows the body coloured by von Mises stress (see ui/panels.ts runStress).
//
// No Esc-dismiss: Esc is how a face selection is cleared while picking, and it
// must not throw the setup away with it.

import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import FloatingPanel from "./FloatingPanel.vue";
import {
  CUSTOM_MATERIAL, FIXED_MARK_COLOR, FORCE_DIRECTIONS, LOAD_MARK_COLOR, STRESS_MATERIALS,
  cssHex, legendGradient,
} from "../../ui/stress";
import { displayRound } from "../../ui/units";

const engine = useEngine();
const panels = usePanelsStore();

const bodies = ref<{ id: string; name: string }[]>([]);
function readBodies() {
  bodies.value = engine.ui?.panels?.stressBodies() ?? [];
}
let offBuild: (() => void) | null = null;
onMounted(() => {
  // onBuild replays at once, and this mounts inside app.mount(), before
  // mountUi has made engine.ui: the first replay has no panels to ask, so the
  // list is read again whenever the panel opens.
  offBuild = engine.store.onBuild(readBodies);
});
onUnmounted(() => offBuild?.());
watch(() => !!panels.stress, (open) => open && readBodies());

const setup = computed(() => panels.stress?.setup ?? null);
const preset = computed(() => STRESS_MATERIALS.find((m) => m.name === setup.value?.material) ?? null);
const gradient = legendGradient();
const fixedColor = cssHex(FIXED_MARK_COLOR);
const loadColor = cssHex(LOAD_MARK_COLOR);

const bodyChoice = computed({
  get: () => setup.value?.body ?? "",
  set: (v: string) => engine.ui.panels.setStressBody(v || null),
});

// Blank means the engine picks the size, so the input is text-like: an empty
// field is null, not 0. In mm whatever the display unit, as the engine's
// warnings about the size quote it.
const sizeText = computed({
  get: () => (setup.value?.size == null ? "" : String(setup.value.size)),
  set: (v: string) => {
    if (!setup.value) return;
    const t = String(v).trim();
    setup.value.size = t === "" ? null : Number(t);
  },
});

function count(n: number): string {
  return n ? `${n} face${n === 1 ? "" : "s"}` : "none";
}

function fmt(v: number): string {
  return String(displayRound(v));
}

function close() {
  engine.ui.panels.closeStress();
}
</script>

<template>
  <FloatingPanel :open="!!panels.stress" panel-class="stress-panel" @close="close">
    <template v-if="panels.stress && setup">
      <div class="measure-title">Stress</div>

      <div class="measure-row">
        <span class="measure-k">Body</span>
        <select v-model="bodyChoice" class="measure-select stress-body" :disabled="panels.stress.running">
          <option value="">Choose…</option>
          <option v-for="b in bodies" :key="b.id" :value="b.id">{{ b.name || b.id }}</option>
        </select>
      </div>

      <div class="measure-divider" />
      <div class="measure-row">
        <span class="measure-k"><span class="stress-swatch" :style="{ background: fixedColor }" />Fixed faces</span>
        <span class="measure-v">
          {{ count(setup.fixed.faceIds.length) }}
          <button type="button" class="btn stress-set-fixed" @click="engine.ui.panels.setStressFacesFromSelection('fixed')">Set from selection</button>
        </span>
      </div>

      <template v-for="(l, i) in setup.loads" :key="l.id">
        <div class="measure-divider" />
        <div class="measure-row">
          <span class="measure-k"><span class="stress-swatch" :style="{ background: loadColor }" />Load {{ i + 1 }}</span>
          <span class="measure-v">
            {{ count(l.faces.faceIds.length) }}
            <button type="button" class="btn stress-set-load" @click="engine.ui.panels.setStressFacesFromSelection(l.id)">Set from selection</button>
            <button
              v-if="setup.loads.length > 1" type="button" class="btn stress-remove-load" title="Remove this load"
              @click="engine.ui.panels.removeStressLoad(l.id)"
            >Remove</button>
          </span>
        </div>
        <div class="measure-row">
          <span class="measure-k">Type</span>
          <select v-model="l.kind" class="measure-select">
            <option value="force">Force</option>
            <option value="pressure">Pressure</option>
          </select>
        </div>
        <template v-if="l.kind === 'force'">
          <div class="measure-row">
            <span class="measure-k">Force</span>
            <span class="measure-v"><input v-model.number="l.force" class="measure-number" type="number" step="any" /> N</span>
          </div>
          <div class="measure-row">
            <span class="measure-k">Direction</span>
            <select v-model="l.direction" class="measure-select">
              <option v-for="d in FORCE_DIRECTIONS" :key="d.value" :value="d.value">{{ d.label }}</option>
            </select>
          </div>
          <div v-if="l.direction === 'custom'" class="measure-row">
            <span class="measure-k">X, Y, Z</span>
            <span class="measure-v">
              <input v-model.number="l.custom[0]" class="measure-number stress-xyz" type="number" step="any" />
              <input v-model.number="l.custom[1]" class="measure-number stress-xyz" type="number" step="any" />
              <input v-model.number="l.custom[2]" class="measure-number stress-xyz" type="number" step="any" />
            </span>
          </div>
        </template>
        <div v-else class="measure-row">
          <span class="measure-k">Pressure</span>
          <span class="measure-v"><input v-model.number="l.pressure" class="measure-number" type="number" step="any" /> MPa</span>
        </div>
      </template>
      <div class="measure-row">
        <button type="button" class="btn stress-add-load" @click="engine.ui.panels.addStressLoad()">Add load</button>
      </div>

      <div class="measure-divider" />
      <div class="measure-row">
        <span class="measure-k">Material</span>
        <select v-model="setup.material" class="measure-select stress-material">
          <option v-for="m in STRESS_MATERIALS" :key="m.name" :value="m.name">{{ m.name }}</option>
          <option :value="CUSTOM_MATERIAL">{{ CUSTOM_MATERIAL }}</option>
        </select>
      </div>
      <div v-if="preset" class="measure-row">
        <span class="measure-v measure-k">E {{ fmt(preset.E) }} MPa, ν {{ preset.nu }}, yield {{ fmt(preset.yield) }} MPa</span>
      </div>
      <template v-else>
        <div class="measure-row">
          <span class="measure-k">E</span>
          <span class="measure-v"><input v-model.number="setup.custom.E" class="measure-number" type="number" min="0" step="any" /> MPa</span>
        </div>
        <div class="measure-row">
          <span class="measure-k">Poisson's ratio</span>
          <span class="measure-v"><input v-model.number="setup.custom.nu" class="measure-number" type="number" min="0" max="0.49" step="0.01" /></span>
        </div>
        <div class="measure-row">
          <span class="measure-k">Yield</span>
          <span class="measure-v"><input v-model.number="setup.custom.yield" class="measure-number" type="number" min="0" step="any" /> MPa</span>
        </div>
      </template>
      <div class="measure-row">
        <span class="measure-k">Element size</span>
        <span class="measure-v">
          <input v-model="sizeText" class="measure-number stress-size" type="number" min="0" step="any" placeholder="auto" /> mm
        </span>
      </div>

      <div class="measure-row stress-actions">
        <button
          type="button" class="btn btn-primary stress-run" :disabled="panels.stress.running"
          @click="engine.ui.panels.runStress()"
        >{{ panels.stress.running ? "Running…" : "Run" }}</button>
        <button
          type="button" class="btn stress-cancel" :disabled="!panels.stress.running"
          @click="engine.ui.panels.cancelStress()"
        >Cancel</button>
        <button
          v-if="panels.stress.colours !== 'none'" type="button" class="btn stress-colours"
          @click="engine.ui.panels.setStressColours(panels.stress.colours !== 'shown')"
        >{{ panels.stress.colours === "shown" ? "Hide colours" : "Show colours" }}</button>
        <button type="button" class="btn stress-close" @click="close">Close</button>
      </div>
      <div v-if="panels.stress.error" class="measure-hint stress-error">{{ panels.stress.error }}</div>

      <template v-if="panels.stress.result">
        <div class="measure-divider" />
        <div v-for="(r, i) in panels.stress.result.rows" :key="i" class="measure-row">
          <span class="measure-k">{{ r.k }}</span>
          <span class="measure-v" :class="{ 'stress-yields': r.k === 'Safety factor' && panels.stress.result.yields }">{{ r.v }}</span>
        </div>
        <div class="stress-legend" :style="{ background: gradient }" />
        <div class="measure-row stress-legend-labels">
          <span class="measure-v">{{ fmt(panels.stress.result.legend.min) }} MPa</span>
          <span class="measure-k">von Mises</span>
          <span class="measure-v">{{ fmt(panels.stress.result.legend.max) }} MPa</span>
        </div>
        <div v-for="(w, i) in panels.stress.result.warnings" :key="'w' + i" class="measure-hint stress-warning">{{ w }}</div>
      </template>

      <div class="measure-hint">
        Select faces in the view, then set them here{{ panels.stress.colours === "shown" ? " (hide the colours to pick on the body)" : "" }} · results are linear and approximate
      </div>
    </template>
  </FloatingPanel>
</template>

<style scoped>
.stress-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 2px;
  vertical-align: middle;
}
.stress-xyz {
  width: 44px;
  margin-left: 2px;
}
.stress-actions {
  justify-content: flex-start;
  gap: var(--s-2);
  margin-top: var(--s-2);
}
.stress-legend {
  height: 10px;
  margin-top: var(--s-2);
  border-radius: 2px;
}
.stress-error,
.stress-warning,
.stress-yields {
  color: var(--accent-hot, #ff9a5c);
}
</style>
