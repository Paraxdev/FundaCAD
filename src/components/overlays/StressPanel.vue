<script setup lang="ts">
// No Esc dismiss: Esc clears a face selection while picking and must not throw the setup away. In probe mode Esc
// ends probe mode only (viewport/stressGlyphs.ts).

import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import FloatingPanel from "./FloatingPanel.vue";
import NumberBox from "../shell/NumberBox.vue";
import Icon from "../shell/Icon.vue";
import Select from "../ui/Select.vue";
import {
  CUSTOM_MATERIAL,
  FORCE_DIRECTIONS,
  GRAVITY_DIRECTIONS,
  GRAVITY_MARK_COLOR,
  LOAD_MARK_COLOR,
  STRESS_MATERIALS,
  SUPPORT_COLORS,
  SUPPORT_KINDS,
  cssHex,
  deformLabel,
  faceCountLabel,
  legendGradient,
  sameTarget,
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
  // onBuild replays at once, before mountUi has made engine.ui, so the list is read again whenever the panel opens.
  offBuild = engine.store.onBuild(readBodies);
});
onUnmounted(() => offBuild?.());
watch(
  () => !!panels.stress,
  (open) => open && readBodies(),
);

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

// Folded once a Run brings a result. Opens again when the result goes for good (not when a new Run replaces it) or a
// Run is refused, since the cause is usually in the setup.
const setupOpen = ref(true);
watch(
  () => panels.stress?.result ?? null,
  (now, was) => {
    if (now && !was) setupOpen.value = false;
    if (!now && !panels.stress?.running) setupOpen.value = true;
  },
);
watch(
  () => panels.stress?.error ?? null,
  (error) => {
    if (error) setupOpen.value = true;
  },
);
watch(
  () => !!panels.stress,
  (open) => {
    if (!open) setupOpen.value = true;
  },
);

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

const bodyOptions = computed(() => {
  const opts: { value: string; label: string; disabled?: boolean }[] = [{ value: "", label: "Choose…" }];
  for (const b of bodies.value) opts.push({ value: b.id, label: b.name || b.id });
  if (missingBody.value) {
    opts.push({ value: missingBody.value, label: `${missingBody.value} (not on the current model)`, disabled: true });
  }
  return opts;
});
const LOAD_KINDS = [
  { value: "force", label: "Force" },
  { value: "pressure", label: "Pressure" },
] as const;
const gravityOptions = GRAVITY_DIRECTIONS.map((d) => ({ value: d, label: d }));
const materialOptions = [...STRESS_MATERIALS.map((m) => ({ value: m.name, label: m.name })), {
  value: CUSTOM_MATERIAL,
  label: CUSTOM_MATERIAL,
}];

function onBody(v: string) {
  engine.ui.panels.setStressBody(v || null);
}

function fmt(v: number): string {
  return String(displayRound(v));
}

function placing(target: StressTarget): boolean {
  return sameTarget(panels.stress?.placing ?? null, target);
}

function onSupportType(id: number, t: StressSupportType) {
  engine.ui.panels.setStressSupportType(id, t);
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

      <label class="stress-field">
        <span class="measure-k">Body</span>
        <Select
          :model-value="setup.body ?? ''"
          :options="bodyOptions"
          class="stress-body"
          testid="stress-body"
          :disabled="panels.stress.running"
          @update:model-value="onBody"
        />
      </label>

      <div v-if="!setupOpen" class="measure-row stress-setup-folded">
        <span class="measure-k">{{ setupSummary }}</span>
        <button
          type="button"
          class="btn stress-setup-toggle"
          title="Show the supports, loads and material"
          @click="setupOpen = true"
          >Edit setup</button
        >
      </div>

      <template v-if="setupOpen">
        <template v-for="(x, i) in setup.supports" :key="'s' + x.id">
          <div class="measure-divider" />
          <div class="stress-item-head">
            <span class="stress-swatch" :style="{ background: supportColor(x.type) }" />
            <span class="stress-item-name">Support {{ i + 1 }}</span>
            <Select
              :model-value="x.type"
              :options="SUPPORT_KINDS"
              class="stress-support-type"
              :title="supportHint(x.type)"
              @update:model-value="onSupportType(x.id, $event)"
            />
            <button
              v-if="setup.supports.length > 1"
              type="button"
              class="float-card-close stress-remove-support"
              :title="`Remove support ${i + 1}`"
              :aria-label="`Remove support ${i + 1}`"
              @click="engine.ui.panels.removeStressSupport(x.id)"
            >
              <Icon name="close" :size="14" />
            </button>
          </div>
          <div class="stress-faces">
            <span class="measure-k stress-count">{{ faceCountLabel(x.faces, x.spots) }}</span>
            <span class="stress-face-actions">
              <button
                type="button"
                class="btn stress-place-support"
                :class="{ active: placing({ support: x.id }) }"
                :aria-pressed="placing({ support: x.id })"
                title="Click the body where it is held, no face of its own needed"
                @click="engine.ui.panels.placeStressSpot({ support: x.id })"
                >{{ placing({ support: x.id }) ? "Placing…" : "Place" }}</button
              >
              <button
                type="button"
                class="btn stress-set-support"
                title="Hold the whole of the faces selected in the view"
                @click="engine.ui.panels.setStressFacesFromSelection({ support: x.id })"
                >From selection</button
              >
            </span>
          </div>
          <div v-for="(spot, k) in x.spots ?? []" :key="'ss' + x.id + '-' + k" class="stress-field stress-spot">
            <span class="measure-k">Spot {{ k + 1 }} radius</span>
            <span class="stress-number"> <NumberBox v-model="spot.radius" class="sm-input stress-spot-radius" /> mm </span>
            <button
              type="button"
              class="float-card-close stress-remove-spot"
              :title="`Remove spot ${k + 1}`"
              :aria-label="`Remove spot ${k + 1}`"
              @click="engine.ui.panels.removeStressSpot({ support: x.id }, k)"
            >
              <Icon name="close" :size="14" />
            </button>
          </div>
        </template>
        <button type="button" class="btn stress-add stress-add-support" @click="engine.ui.panels.addStressSupport()">
          <Icon name="plus" :size="14" />Add support
        </button>

        <template v-for="(l, i) in setup.loads" :key="l.id">
          <div class="measure-divider" />
          <div class="stress-item-head">
            <span class="stress-swatch" :style="{ background: loadColor }" />
            <span class="stress-item-name">Load {{ i + 1 }}</span>
            <Select v-model="l.kind" :options="LOAD_KINDS" class="stress-load-kind" />
            <!-- Down to no load at all: a body under gravity alone is a study. -->
            <button
              type="button"
              class="float-card-close stress-remove-load"
              :title="`Remove load ${i + 1}`"
              :aria-label="`Remove load ${i + 1}`"
              @click="engine.ui.panels.removeStressLoad(l.id)"
            >
              <Icon name="close" :size="14" />
            </button>
          </div>
          <div class="stress-faces">
            <span class="measure-k stress-count">{{ faceCountLabel(l.faces, l.spots) }}</span>
            <span class="stress-face-actions">
              <button
                type="button"
                class="btn stress-place-load"
                :class="{ active: placing({ load: l.id }) }"
                :aria-pressed="placing({ load: l.id })"
                title="Click the body where it pushes, no face of its own needed"
                @click="engine.ui.panels.placeStressSpot({ load: l.id })"
                >{{ placing({ load: l.id }) ? "Placing…" : "Place" }}</button
              >
              <button
                type="button"
                class="btn stress-set-load"
                title="Push on the whole of the faces selected in the view"
                @click="engine.ui.panels.setStressFacesFromSelection({ load: l.id })"
                >From selection</button
              >
            </span>
          </div>
          <div v-for="(spot, k) in l.spots ?? []" :key="'ls' + l.id + '-' + k" class="stress-field stress-spot">
            <span class="measure-k">Spot {{ k + 1 }} radius</span>
            <span class="stress-number"> <NumberBox v-model="spot.radius" class="sm-input stress-spot-radius" /> mm </span>
            <button
              type="button"
              class="float-card-close stress-remove-spot"
              :title="`Remove spot ${k + 1}`"
              :aria-label="`Remove spot ${k + 1}`"
              @click="engine.ui.panels.removeStressSpot({ load: l.id }, k)"
            >
              <Icon name="close" :size="14" />
            </button>
          </div>
          <template v-if="l.kind === 'force'">
            <div class="stress-field">
              <span class="measure-k">Force</span>
              <span class="stress-number"><NumberBox v-model="l.force" class="sm-input stress-force" /> N</span>
              <Select v-model="l.direction" :options="FORCE_DIRECTIONS" class="stress-direction" title="Direction" />
            </div>
            <div v-if="l.direction === 'custom'" class="stress-field">
              <span class="measure-k">X, Y, Z</span>
              <span class="stress-xyz-row">
                <NumberBox
                  v-for="k in 3"
                  :key="k"
                  v-model="l.custom[k - 1]"
                  class="sm-input stress-xyz"
                  :title="String(l.custom[k - 1])"
                />
              </span>
            </div>
          </template>
          <div v-else class="stress-field">
            <span class="measure-k">Pressure</span>
            <span class="stress-number"><NumberBox v-model="l.pressure" class="sm-input stress-pressure" /> MPa</span>
          </div>
        </template>
        <button type="button" class="btn stress-add stress-add-load" @click="engine.ui.panels.addStressLoad()">
          <Icon name="plus" :size="14" />Add load
        </button>

        <div class="measure-divider" />
        <div class="stress-field">
          <label class="stress-gravity">
            <span class="param-switch">
              <input v-model="setup.gravity.on" type="checkbox" class="stress-gravity-on" />
              <span class="track"><span class="knob" /></span>
            </span>
            <span class="stress-swatch" :style="{ background: gravityColor }" />
            <span class="measure-k">Gravity</span>
          </label>
          <Select
            v-model="setup.gravity.direction"
            :options="gravityOptions"
            class="stress-gravity-dir"
            :disabled="!setup.gravity.on"
          />
        </div>

        <div class="measure-divider" />
        <label class="stress-field">
          <span class="measure-k">Material</span>
          <Select v-model="setup.material" :options="materialOptions" class="stress-material" />
        </label>
        <div v-if="preset" class="measure-k stress-material-line">
          E {{ fmt(preset.E) }} MPa, ν {{ preset.nu }}, yield {{ fmt(preset.yield) }} MPa,
          {{ fmt(preset.density) }} g/cm³
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
        <div class="stress-field">
          <span class="measure-k">Element size</span>
          <span class="stress-number">
            <NumberBox v-model="setup.size" nullable class="sm-input stress-size" placeholder="auto" /> mm
          </span>
        </div>
        <button v-if="panels.stress.result" type="button" class="btn stress-setup-toggle" @click="setupOpen = false"
          >Hide setup</button
        >
      </template>

      <div class="measure-row stress-actions">
        <button
          type="button"
          class="btn btn-primary stress-run"
          :disabled="panels.stress.running"
          @click="engine.ui.panels.runStress()"
          >{{ panels.stress.running ? "Running…" : "Run" }}</button
        >
        <button
          type="button"
          class="btn stress-cancel"
          :disabled="!panels.stress.running"
          @click="engine.ui.panels.cancelStress()"
          >Cancel</button
        >
        <button
          v-if="panels.stress.colours !== 'none'"
          type="button"
          class="btn stress-colours"
          @click="engine.ui.panels.setStressColours(panels.stress.colours !== 'shown')"
          >{{ panels.stress.colours === "shown" ? "Hide colours" : "Show colours" }}</button
        >
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
              class="sm-slider stress-deform"
              type="range"
              min="0"
              :max="deform.max"
              :step="deform.max / 200"
              :value="deform.scale"
              @input="onDeform"
            />
            <button
              type="button"
              class="btn stress-true-scale"
              title="Draw the deflection at its true size"
              @click="engine.ui.panels.setStressDeformation(1)"
              >1x</button
            >
            <button
              type="button"
              class="btn stress-animate"
              :class="{ active: deform.animate }"
              @click="engine.ui.panels.setStressAnimate(!deform.animate)"
              >{{ deform.animate ? "Stop" : "Animate" }}</button
            >
          </div>
        </template>
        <div class="measure-row stress-probe-row">
          <!-- Stop probing stays pressable whatever the colours are doing. -->
          <button
            type="button"
            class="btn stress-probe"
            :class="{ active: panels.stress.probe }"
            :disabled="panels.stress.colours === 'none' && !panels.stress.probe"
            @click="engine.ui.panels.setStressProbe(!panels.stress.probe)"
            >{{ panels.stress.probe ? "Stop probing" : "Probe" }}</button
          >
        </div>
        <div v-for="(p, i) in panels.stress.pins" :key="'p' + p.id" class="measure-row stress-pin">
          <span class="measure-k">Probe {{ i + 1 }}</span>
          <span class="measure-v">{{ p.label }}</span>
          <button
            type="button"
            class="float-card-close stress-remove-pin"
            :title="`Remove probe ${i + 1}`"
            :aria-label="`Remove probe ${i + 1}`"
            @click="engine.ui.panels.removeStressProbe(p.id)"
          >
            <Icon name="close" :size="14" />
          </button>
        </div>
        <div class="stress-legend" :style="{ background: gradient }" />
        <div class="measure-row stress-legend-labels">
          <span class="measure-v">{{ fmt(panels.stress.result.legend.min) }} MPa</span>
          <span class="measure-k">von Mises</span>
          <span class="measure-v">{{ fmt(panels.stress.result.legend.max) }} MPa</span>
        </div>
        <div v-for="(r, i) in panels.stress.result.rows" :key="i" class="measure-row">
          <span class="measure-k">{{ r.k }}</span>
          <span
            class="measure-v"
            :class="{ 'stress-yields': r.k === 'Safety factor' && panels.stress.result.yields }"
            >{{ r.v }}</span
          >
        </div>
        <div v-for="(w, i) in panels.stress.result.warnings" :key="'w' + i" class="measure-hint stress-warning">{{
          w
        }}</div>
      </template>

      <div class="measure-hint">
        <template v-if="panels.stress.probe">Hover the body to read it, click to pin a probe, Esc to stop.</template>
        <template v-else-if="panels.stress.placing"
          >Click the body to put the spot there, Shift click to place several, Esc to stop.</template
        >
        <template v-else-if="panels.stress.colours === 'shown'">Hide the colours to pick faces on the body.</template>
        <template v-else
          >Press Place and click the body where it is held or pushed, or select whole faces and use From selection. Drag
          an orb's rim to size it, a force's arrow tip to aim and size it.</template
        >
        Results are linear and approximate.
      </div>
    </template>
  </FloatingPanel>
</template>
