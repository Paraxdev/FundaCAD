<script setup lang="ts">
// Inspect → Stress: a linear static analysis of one body. The user places a
// support or a load on the body with a click (a spot, drawn as an orb), or
// picks faces in the view and sets them as supports (fixed, pinned or sliding)
// or as a load's faces, chooses a material, gravity if it matters, and runs it; the
// result reads out here with a colour legend while the view shows the body
// coloured by von Mises stress, deformed to taste, with probes pinned on it
// (see ui/panels.ts runStress). The setup is saved with the document.
//
// No Esc-dismiss: Esc is how a face selection is cleared while picking, and it
// must not throw the setup away with it. In probe mode Esc ends probe mode and
// nothing else (viewport/stressGlyphs.ts).
//
// The panel floats over the model it analyses, so it keeps to a narrow column
// at the side, and once a Run has a result the setup folds into one summary
// line: the result, the deformation and the probe come up where the setup
// was, and the setup opens again from its line or when the result goes.

import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import FloatingPanel from "./FloatingPanel.vue";
import {
  CUSTOM_MATERIAL, FORCE_DIRECTIONS, GRAVITY_DIRECTIONS, GRAVITY_MARK_COLOR, LOAD_MARK_COLOR, STRESS_MATERIALS,
  SUPPORT_COLORS, SUPPORT_KINDS, cssHex, deformLabel, faceCountLabel, legendGradient, sameTarget,
  type StressTarget,
} from "../../ui/stress";
import { displayRound } from "../../ui/units";
import type { StressSupportType } from "../../types";

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
const deform = computed(() => panels.stress?.deform ?? null);
const gradient = legendGradient();
const loadColor = cssHex(LOAD_MARK_COLOR);
const gravityColor = cssHex(GRAVITY_MARK_COLOR);

function supportColor(t: StressSupportType): string {
  return cssHex(SUPPORT_COLORS[t]);
}

function supportHint(t: StressSupportType): string {
  return SUPPORT_KINDS.find((k) => k.value === t)?.hint ?? "";
}

/** The analysed body when the current model does not have it (the timeline
 *  rolled back before it), so the list can still name what the setup is for. */
const missingBody = computed(() => {
  const b = setup.value?.body;
  return b && !bodies.value.some((x) => x.id === b) ? b : null;
});

// Folded once a Run brings a result, open again when the result goes for good
// (not while a new Run replaces it) or a Run is refused, since what is in the
// way is usually in the setup.
const setupOpen = ref(true);
watch(() => panels.stress?.result ?? null, (now, was) => {
  if (now && !was) setupOpen.value = false;
  if (!now && !panels.stress?.running) setupOpen.value = true;
});
watch(() => panels.stress?.error ?? null, (error) => { if (error) setupOpen.value = true; });
watch(() => !!panels.stress, (open) => { if (!open) setupOpen.value = true; });

/** The folded setup's one line: what is held, what pushes, and the material. */
const setupSummary = computed(() => {
  const s = setup.value;
  if (!s) return "";
  const n = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
  const parts = [n(s.supports.length, "support"), n(s.loads.length, "load")];
  if (s.gravity.on) parts.push(`gravity ${s.gravity.direction}`);
  parts.push(s.material);
  return parts.join(", ");
});

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

function fmt(v: number): string {
  return String(displayRound(v));
}

function placing(target: StressTarget): boolean {
  return sameTarget(panels.stress?.placing ?? null, target);
}

function onSupportType(id: number, e: Event) {
  engine.ui.panels.setStressSupportType(id, (e.target as HTMLSelectElement).value as StressSupportType);
}

function onDeform(e: Event) {
  engine.ui.panels.setStressDeformation(Number((e.target as HTMLInputElement).value));
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
          <option v-if="missingBody" :value="missingBody" disabled>{{ missingBody }} (not on the current model)</option>
        </select>
      </div>

      <div v-if="!setupOpen" class="measure-row stress-setup-folded">
        <span class="measure-k">{{ setupSummary }}</span>
        <button type="button" class="btn stress-setup-toggle" title="Show the supports, loads and material" @click="setupOpen = true">Edit setup</button>
      </div>

      <template v-if="setupOpen">
        <template v-for="(x, i) in setup.supports" :key="'s' + x.id">
          <div class="measure-divider" />
          <div class="measure-row">
            <span class="measure-k"><span class="stress-swatch" :style="{ background: supportColor(x.type) }" />Support {{ i + 1 }}</span>
            <select :value="x.type" class="measure-select stress-support-type" :title="supportHint(x.type)" @change="onSupportType(x.id, $event)">
              <option v-for="k in SUPPORT_KINDS" :key="k.value" :value="k.value" :title="k.hint">{{ k.label }}</option>
            </select>
          </div>
          <div class="measure-row stress-faces">
            <span class="measure-k stress-count">{{ faceCountLabel(x.faces, x.spots) }}</span>
            <span class="measure-v stress-face-actions">
              <button
                type="button" class="btn stress-place-support" :class="{ active: placing({ support: x.id }) }"
                title="Click the body where it is held, no face of its own needed"
                @click="engine.ui.panels.placeStressSpot({ support: x.id })"
              >{{ placing({ support: x.id }) ? "Placing…" : "Place" }}</button>
              <button
                type="button" class="btn stress-set-support" title="Hold the whole of the faces selected in the view"
                @click="engine.ui.panels.setStressFacesFromSelection({ support: x.id })"
              >From selection</button>
              <button
                v-if="setup.supports.length > 1" type="button" class="btn stress-remove-support" title="Remove this support"
                @click="engine.ui.panels.removeStressSupport(x.id)"
              >Remove</button>
            </span>
          </div>
          <div v-for="(spot, k) in x.spots ?? []" :key="'ss' + x.id + '-' + k" class="measure-row stress-spot">
            <span class="measure-k">Spot {{ k + 1 }} radius</span>
            <span class="measure-v">
              <input v-model.number="spot.radius" class="measure-number stress-spot-radius" type="number" min="0" step="any" /> mm
              <button type="button" class="btn stress-remove-spot" title="Remove this spot" @click="engine.ui.panels.removeStressSpot({ support: x.id }, k)">Remove</button>
            </span>
          </div>
        </template>
        <div class="measure-row">
          <button type="button" class="btn stress-add-support" @click="engine.ui.panels.addStressSupport()">Add support</button>
        </div>

        <template v-for="(l, i) in setup.loads" :key="l.id">
          <div class="measure-divider" />
          <div class="measure-row">
            <span class="measure-k"><span class="stress-swatch" :style="{ background: loadColor }" />Load {{ i + 1 }}</span>
            <select v-model="l.kind" class="measure-select stress-load-kind">
              <option value="force">Force</option>
              <option value="pressure">Pressure</option>
            </select>
          </div>
          <div class="measure-row stress-faces">
            <span class="measure-k stress-count">{{ faceCountLabel(l.faces, l.spots) }}</span>
            <span class="measure-v stress-face-actions">
              <button
                type="button" class="btn stress-place-load" :class="{ active: placing({ load: l.id }) }"
                title="Click the body where it pushes, no face of its own needed"
                @click="engine.ui.panels.placeStressSpot({ load: l.id })"
              >{{ placing({ load: l.id }) ? "Placing…" : "Place" }}</button>
              <button
                type="button" class="btn stress-set-load" title="Push on the whole of the faces selected in the view"
                @click="engine.ui.panels.setStressFacesFromSelection({ load: l.id })"
              >From selection</button>
              <!-- Down to no load at all: a body under gravity alone is a study. -->
              <button
                type="button" class="btn stress-remove-load" title="Remove this load"
                @click="engine.ui.panels.removeStressLoad(l.id)"
              >Remove</button>
            </span>
          </div>
          <div v-for="(spot, k) in l.spots ?? []" :key="'ls' + l.id + '-' + k" class="measure-row stress-spot">
            <span class="measure-k">Spot {{ k + 1 }} radius</span>
            <span class="measure-v">
              <input v-model.number="spot.radius" class="measure-number stress-spot-radius" type="number" min="0" step="any" /> mm
              <button type="button" class="btn stress-remove-spot" title="Remove this spot" @click="engine.ui.panels.removeStressSpot({ load: l.id }, k)">Remove</button>
            </span>
          </div>
          <template v-if="l.kind === 'force'">
            <div class="measure-row">
              <span class="measure-k">Force</span>
              <span class="measure-v"><input v-model.number="l.force" class="measure-number stress-force" type="number" step="any" /> N</span>
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
                <input v-for="k in 3" :key="k" v-model.number="l.custom[k - 1]" class="measure-number stress-xyz" type="number" step="any" :title="String(l.custom[k - 1])" />
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
          <label class="measure-k stress-gravity">
            <input v-model="setup.gravity.on" type="checkbox" class="stress-gravity-on" />
            <span class="stress-swatch" :style="{ background: gravityColor }" />Gravity
          </label>
          <select v-model="setup.gravity.direction" class="measure-select stress-gravity-dir" :disabled="!setup.gravity.on">
            <option v-for="d in GRAVITY_DIRECTIONS" :key="d" :value="d">{{ d }}</option>
          </select>
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
          <span class="measure-v measure-k">E {{ fmt(preset.E) }} MPa, ν {{ preset.nu }}, yield {{ fmt(preset.yield) }} MPa, {{ fmt(preset.density) }} g/cm³</span>
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
          <div class="measure-row">
            <span class="measure-k">Density</span>
            <span class="measure-v"><input v-model.number="setup.custom.density" class="measure-number stress-density" type="number" min="0" step="any" /> g/cm³</span>
          </div>
        </template>
        <div class="measure-row">
          <span class="measure-k">Element size</span>
          <span class="measure-v">
            <input v-model="sizeText" class="measure-number stress-size" type="number" min="0" step="any" placeholder="auto" /> mm
          </span>
        </div>
        <div v-if="panels.stress.result" class="measure-row">
          <button type="button" class="btn stress-setup-toggle" @click="setupOpen = false">Hide setup</button>
        </div>
      </template>

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
        <template v-if="deform">
          <div class="measure-row">
            <span class="measure-k">Deformation</span>
            <span class="measure-v stress-deform-label">{{ deformLabel(deform.scale) }}</span>
          </div>
          <div class="measure-row stress-deform-row">
            <input
              class="stress-deform" type="range" min="0" :max="deform.max" :step="deform.max / 200" :value="deform.scale"
              @input="onDeform"
            />
            <button type="button" class="btn stress-true-scale" title="Draw the deflection at its true size" @click="engine.ui.panels.setStressDeformation(1)">1x</button>
            <button
              type="button" class="btn stress-animate" :class="{ active: deform.animate }"
              @click="engine.ui.panels.setStressAnimate(!deform.animate)"
            >{{ deform.animate ? "Stop" : "Animate" }}</button>
          </div>
        </template>
        <div class="measure-row stress-probe-row">
          <!-- Stop probing stays pressable whatever the colours are doing. -->
          <button
            type="button" class="btn stress-probe" :class="{ active: panels.stress.probe }"
            :disabled="panels.stress.colours === 'none' && !panels.stress.probe"
            @click="engine.ui.panels.setStressProbe(!panels.stress.probe)"
          >{{ panels.stress.probe ? "Stop probing" : "Probe" }}</button>
        </div>
        <div v-for="(p, i) in panels.stress.pins" :key="'p' + p.id" class="measure-row stress-pin">
          <span class="measure-k">Probe {{ i + 1 }}</span>
          <span class="measure-v">
            {{ p.label }}
            <button type="button" class="btn stress-remove-pin" title="Remove this probe" @click="engine.ui.panels.removeStressProbe(p.id)">Remove</button>
          </span>
        </div>
        <div class="stress-legend" :style="{ background: gradient }" />
        <div class="measure-row stress-legend-labels">
          <span class="measure-v">{{ fmt(panels.stress.result.legend.min) }} MPa</span>
          <span class="measure-k">von Mises</span>
          <span class="measure-v">{{ fmt(panels.stress.result.legend.max) }} MPa</span>
        </div>
        <div v-for="(r, i) in panels.stress.result.rows" :key="i" class="measure-row">
          <span class="measure-k">{{ r.k }}</span>
          <span class="measure-v" :class="{ 'stress-yields': r.k === 'Safety factor' && panels.stress.result.yields }">{{ r.v }}</span>
        </div>
        <div v-for="(w, i) in panels.stress.result.warnings" :key="'w' + i" class="measure-hint stress-warning">{{ w }}</div>
      </template>

      <div class="measure-hint">
        <template v-if="panels.stress.probe">Hover the body to read it, click to pin a probe, Esc to stop.</template>
        <template v-else-if="panels.stress.placing">Click the body to put the spot there, Shift click to place several, Esc to stop.</template>
        <template v-else-if="panels.stress.colours === 'shown'">Hide the colours to pick faces on the body.</template>
        <template v-else>Press Place and click the body where it is held or pushed, or select whole faces and use From selection. Drag an orb's rim to size it, a force's arrow tip to aim and size it.</template>
        Results are linear and approximate.
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
.stress-gravity {
  display: flex;
  align-items: center;
  gap: 4px;
}
.stress-deform-row {
  align-items: center;
  gap: var(--s-2);
}
.stress-deform {
  flex: 1;
  min-width: 0;
}
/* Wide enough for what a drag writes, a sign and three decimals, beside the
   number input's spinner. */
.stress-xyz {
  width: 64px;
  margin-left: 2px;
}
/* A face set's row: its count on the left, wrapping when it says what the view
   cannot show, and its buttons on the right, under it when they do not fit. */
.stress-faces {
  flex-wrap: wrap;
  align-items: center;
}
.stress-spot .measure-v {
  display: flex;
  align-items: center;
  gap: var(--s-1);
}
.stress-count {
  min-width: 0;
}
.stress-face-actions {
  display: flex;
  flex: none;
  gap: var(--s-1);
}
.stress-setup-folded {
  align-items: center;
}
.stress-actions {
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: var(--s-2);
  margin-top: var(--s-2);
}
.stress-legend {
  height: 10px;
  margin-top: var(--s-2);
  border-radius: 2px;
}
/* The app's own error and warning colours: the accent is a green, which
   would read a failing safety factor as a good one. */
.stress-error,
.stress-yields {
  color: var(--error, #ff5c5c);
}
.stress-warning {
  color: var(--warn, #ffab2e);
}
</style>
