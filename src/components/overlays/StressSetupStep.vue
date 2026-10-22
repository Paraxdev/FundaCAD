<script setup lang="ts">
import { computed, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import NumberBox from "../shell/NumberBox.vue";
import Icon from "../shell/Icon.vue";
import Select from "../ui/Select.vue";
import StressMaterialFields from "./StressMaterialFields.vue";
import {
  AXIS_LABELS,
  FORCE_DIRECTIONS,
  GRAVITY_DIRECTIONS,
  GRAVITY_MARK_COLOR,
  LOAD_MARK_COLOR,
  SUPPORT_COLORS,
  SUPPORT_KINDS,
  cssHex,
  faceCountLabel,
  sameTarget,
  type StressSetup,
  type StressTarget,
} from "../../ui/stress";
import type { StressSupportType } from "../../types";

const props = defineProps<{ setup: StressSetup; bodies: readonly { id: string; name: string }[] }>();

const engine = useEngine();
const panels = usePanelsStore();

const running = computed(() => !!panels.stress?.running);
const loadColor = cssHex(LOAD_MARK_COLOR);
const gravityColor = cssHex(GRAVITY_MARK_COLOR);
const LOAD_KINDS = [
  { value: "force", label: "Force" },
  { value: "pressure", label: "Pressure" },
] as const;
const gravityOptions = GRAVITY_DIRECTIONS.map((d) => ({ value: d, label: AXIS_LABELS[d] }));

// The analysed body when the current model does not have it (the timeline rolled back before it), so the list can
// still name what the setup is for.
const bodyOptions = computed(() => {
  const opts: { value: string; label: string; disabled?: boolean }[] = [{ value: "", label: "Choose…" }];
  for (const b of props.bodies) opts.push({ value: b.id, label: b.name || b.id });
  const b = props.setup.body;
  if (b && !props.bodies.some((x) => x.id === b)) {
    opts.push({ value: b, label: `${b} (not on the current model)`, disabled: true });
  }
  return opts;
});

// Open on first show when a size is set, so a value that changes the Run is never hidden.
const moreOpen = ref(props.setup.size != null);

function supportColor(t: StressSupportType): string {
  return cssHex(SUPPORT_COLORS[t]);
}

function supportHint(t: StressSupportType): string {
  return SUPPORT_KINDS.find((k) => k.value === t)?.hint ?? "";
}

function placing(target: StressTarget): boolean {
  return sameTarget(panels.stress?.placing ?? null, target);
}
</script>

<template>
  <div class="stress-step stress-setup">
    <label class="stress-field">
      <span class="measure-k">Body</span>
      <Select
        :model-value="setup.body ?? ''"
        :options="bodyOptions"
        class="stress-body"
        testid="stress-body"
        :disabled="running"
        @update:model-value="engine.ui.panels.setStressBody($event || null)"
      />
    </label>

    <div class="rd-head stress-caption"
      >Supports <span class="tree-count">{{ setup.supports.length }}</span></div
    >
    <div v-for="(x, i) in setup.supports" :key="'s' + x.id" class="stress-item">
      <div class="stress-item-head">
        <span class="stress-swatch" :style="{ background: supportColor(x.type) }" />
        <span class="stress-item-name">Support {{ i + 1 }}</span>
        <Select
          :model-value="x.type"
          :options="SUPPORT_KINDS"
          class="stress-support-type"
          :title="supportHint(x.type)"
          @update:model-value="engine.ui.panels.setStressSupportType(x.id, $event)"
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
            title="Click the body to place a spot"
            @click="engine.ui.panels.placeStressSpot({ support: x.id })"
            >{{ placing({ support: x.id }) ? "Placing…" : "Click on body" }}</button
          >
          <button
            type="button"
            class="btn stress-set-support"
            title="Use the faces selected in the view"
            @click="engine.ui.panels.setStressFacesFromSelection({ support: x.id })"
            >Use selected faces</button
          >
        </span>
      </div>
      <div v-for="(spot, k) in x.spots ?? []" :key="'ss' + x.id + '-' + k" class="stress-field stress-spot">
        <span class="measure-k">Spot {{ k + 1 }}</span>
        <span class="stress-number"
          ><NumberBox v-model="spot.radius" class="sm-input stress-spot-radius" title="Radius" /> mm</span
        >
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
    </div>
    <button type="button" class="btn stress-add stress-add-support" @click="engine.ui.panels.addStressSupport()">
      <Icon name="plus" :size="14" />Add support
    </button>

    <div class="rd-head stress-caption"
      >Loads <span class="tree-count">{{ setup.loads.length }}</span></div
    >
    <div v-for="(l, i) in setup.loads" :key="l.id" class="stress-item">
      <div class="stress-item-head">
        <span class="stress-swatch" :style="{ background: loadColor }" />
        <span class="stress-item-name">Load {{ i + 1 }}</span>
        <Select v-model="l.kind" :options="LOAD_KINDS" class="stress-load-kind" />
        <!-- Down to no load at all: a body under its own weight alone is a study. -->
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
            title="Click the body to place a spot"
            @click="engine.ui.panels.placeStressSpot({ load: l.id })"
            >{{ placing({ load: l.id }) ? "Placing…" : "Click on body" }}</button
          >
          <button
            type="button"
            class="btn stress-set-load"
            title="Use the faces selected in the view"
            @click="engine.ui.panels.setStressFacesFromSelection({ load: l.id })"
            >Use selected faces</button
          >
        </span>
      </div>
      <div v-for="(spot, k) in l.spots ?? []" :key="'ls' + l.id + '-' + k" class="stress-field stress-spot">
        <span class="measure-k">Spot {{ k + 1 }}</span>
        <span class="stress-number"
          ><NumberBox v-model="spot.radius" class="sm-input stress-spot-radius" title="Radius" /> mm</span
        >
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
    </div>
    <button type="button" class="btn stress-add stress-add-load" @click="engine.ui.panels.addStressLoad()">
      <Icon name="plus" :size="14" />Add load
    </button>

    <div class="stress-field stress-weight">
      <label class="stress-gravity" title="Load the body with its own weight">
        <span class="param-switch">
          <input v-model="setup.gravity.on" type="checkbox" class="stress-gravity-on" />
          <span class="track"><span class="knob" /></span>
        </span>
        <span class="stress-swatch" :style="{ background: gravityColor }" />
        <span class="measure-k">Own weight</span>
      </label>
      <Select
        v-if="setup.gravity.on"
        v-model="setup.gravity.direction"
        :options="gravityOptions"
        class="stress-gravity-dir"
        title="Which way is down"
      />
    </div>

    <div class="rd-head stress-caption">Material</div>
    <StressMaterialFields :setup="setup" />

    <button type="button" class="stress-more" :aria-expanded="moreOpen" @click="moreOpen = !moreOpen">
      <Icon :name="moreOpen ? 'caretDown' : 'caretRight'" :size="12" />More options
    </button>
    <div v-show="moreOpen" class="stress-fold stress-more-body">
      <div class="stress-field">
        <span class="measure-k">Mesh size</span>
        <span class="stress-number">
          <NumberBox v-model="setup.size" nullable class="sm-input stress-size" placeholder="auto" /> mm
        </span>
      </div>
      <div class="sm-hint">Smaller is finer and slower.</div>
    </div>

    <div v-if="panels.stress?.error" class="measure-hint stress-error">{{ panels.stress.error }}</div>
  </div>
</template>
