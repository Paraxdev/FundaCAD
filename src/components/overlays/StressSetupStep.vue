<script setup lang="ts">
import { computed, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import Icon from "../shell/Icon.vue";
import Button from "../ui/Button.vue";
import IconButton from "../ui/IconButton.vue";
import NumberField from "../ui/NumberField.vue";
import Switch from "../ui/Switch.vue";
import Select from "../ui/Select.vue";
import StressMaterialFields from "./StressMaterialFields.vue";
import {
  AXIS_LABELS,
  FORCE_DIRECTIONS,
  GRAVITY_DIRECTIONS,
  GRAVITY_MARK_COLOR,
  LOAD_MARK_COLOR,
  REFINE_CHOICES,
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
const AXES = [0, 1, 2] as const;
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

// Open on first show when a size or refinement is set, so a value that changes the Run is never hidden.
const moreOpen = ref(props.setup.size != null || props.setup.refine !== "standard");

function supportColor(t: StressSupportType): string {
  return cssHex(SUPPORT_COLORS[t]);
}

function supportHint(t: StressSupportType): string {
  return SUPPORT_KINDS.find((k) => k.value === t)?.hint ?? "";
}

function placing(target: StressTarget, as: "face" | "spot"): boolean {
  return sameTarget(panels.stress?.placing ?? null, target) && panels.stress?.placeAs === as;
}
</script>

<template>
  <div class="stress-step stress-setup" data-panel-scroll>
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
        <IconButton
          v-if="setup.supports.length > 1"
          class="stress-remove-support"
          icon="close"
          :tip="`Remove support ${i + 1}`"
          size="sm"
          variant="danger"
          :icon-size="14"
          @click="engine.ui.panels.removeStressSupport(x.id)"
        />
      </div>
      <div class="stress-faces">
        <span class="measure-k stress-count">{{ faceCountLabel(x.faces, x.spots) }}</span>
        <span class="stress-face-actions">
          <Button
            size="sm"
            class="stress-place-support"
            :pressed="placing({ support: x.id }, 'face')"
            tip="Click faces of the body to add each whole face"
            @click="engine.ui.panels.placeStressSpot({ support: x.id })"
            >{{ placing({ support: x.id }, "face") ? "Picking…" : "Click faces" }}</Button
          >
          <Button
            size="sm"
            class="stress-spot-support"
            :pressed="placing({ support: x.id }, 'spot')"
            tip="Click the body to place a round spot, for a local support"
            @click="engine.ui.panels.placeStressSpot({ support: x.id }, 'spot')"
            >{{ placing({ support: x.id }, "spot") ? "Placing…" : "Spot" }}</Button
          >
          <Button
            size="sm"
            class="stress-set-support"
            tip="Use the faces selected in the view"
            @click="engine.ui.panels.setStressFacesFromSelection({ support: x.id })"
            >Use selected faces</Button
          >
        </span>
      </div>
      <div v-for="(spot, k) in x.spots ?? []" :key="'ss' + x.id + '-' + k" class="stress-field stress-spot">
        <span class="measure-k">Spot {{ k + 1 }}</span>
        <NumberField
          v-model="spot.radius"
          commit="live"
          unit="mm"
          :width-ch="7"
          class="stress-spot-radius"
          title="Radius"
        />
        <IconButton
          class="stress-remove-spot"
          icon="close"
          :tip="`Remove spot ${k + 1}`"
          size="sm"
          variant="danger"
          :icon-size="14"
          @click="engine.ui.panels.removeStressSpot({ support: x.id }, k)"
        />
      </div>
    </div>
    <Button size="sm" icon="plus" class="stress-add stress-add-support" @click="engine.ui.panels.addStressSupport()"
      >Add support</Button
    >

    <div class="rd-head stress-caption"
      >Loads <span class="tree-count">{{ setup.loads.length }}</span></div
    >
    <div v-for="(l, i) in setup.loads" :key="l.id" class="stress-item">
      <div class="stress-item-head">
        <span class="stress-swatch" :style="{ background: loadColor }" />
        <span class="stress-item-name">Load {{ i + 1 }}</span>
        <Select v-model="l.kind" :options="LOAD_KINDS" class="stress-load-kind" />
        <!-- Down to no load at all: a body under its own weight alone is a study. -->
        <IconButton
          class="stress-remove-load"
          icon="close"
          :tip="`Remove load ${i + 1}`"
          size="sm"
          variant="danger"
          :icon-size="14"
          @click="engine.ui.panels.removeStressLoad(l.id)"
        />
      </div>
      <div class="stress-faces">
        <span class="measure-k stress-count">{{ faceCountLabel(l.faces, l.spots) }}</span>
        <span class="stress-face-actions">
          <Button
            size="sm"
            class="stress-place-load"
            :pressed="placing({ load: l.id }, 'face')"
            tip="Click faces of the body to add each whole face"
            @click="engine.ui.panels.placeStressSpot({ load: l.id })"
            >{{ placing({ load: l.id }, "face") ? "Picking…" : "Click faces" }}</Button
          >
          <Button
            size="sm"
            class="stress-spot-load"
            :pressed="placing({ load: l.id }, 'spot')"
            tip="Click the body to place a round spot, for a local load"
            @click="engine.ui.panels.placeStressSpot({ load: l.id }, 'spot')"
            >{{ placing({ load: l.id }, "spot") ? "Placing…" : "Spot" }}</Button
          >
          <Button
            size="sm"
            class="stress-set-load"
            tip="Use the faces selected in the view"
            @click="engine.ui.panels.setStressFacesFromSelection({ load: l.id })"
            >Use selected faces</Button
          >
        </span>
      </div>
      <div v-for="(spot, k) in l.spots ?? []" :key="'ls' + l.id + '-' + k" class="stress-field stress-spot">
        <span class="measure-k">Spot {{ k + 1 }}</span>
        <NumberField
          v-model="spot.radius"
          commit="live"
          unit="mm"
          :width-ch="7"
          class="stress-spot-radius"
          title="Radius"
        />
        <IconButton
          class="stress-remove-spot"
          icon="close"
          :tip="`Remove spot ${k + 1}`"
          size="sm"
          variant="danger"
          :icon-size="14"
          @click="engine.ui.panels.removeStressSpot({ load: l.id }, k)"
        />
      </div>
      <template v-if="l.kind === 'force'">
        <div class="stress-field">
          <span class="measure-k">Force</span>
          <NumberField v-model="l.force" commit="live" unit="N" :width-ch="7" class="stress-force" />
          <Select v-model="l.direction" :options="FORCE_DIRECTIONS" class="stress-direction" title="Direction" />
        </div>
        <div v-if="l.direction === 'custom'" class="stress-field">
          <span class="measure-k">X, Y, Z</span>
          <span class="stress-xyz-row">
            <!-- Wide enough for what a drag writes, a sign and three decimals. -->
            <NumberField
              v-for="i in AXES"
              :key="i"
              v-model="l.custom[i]"
              commit="live"
              :step="0.1"
              :width-ch="6"
              class="stress-xyz"
              :title="String(l.custom[i])"
            />
          </span>
        </div>
      </template>
      <div v-else class="stress-field">
        <span class="measure-k">Pressure</span>
        <NumberField v-model="l.pressure" commit="live" unit="MPa" :width-ch="7" class="stress-pressure" />
      </div>
    </div>
    <Button size="sm" icon="plus" class="stress-add stress-add-load" @click="engine.ui.panels.addStressLoad()"
      >Add load</Button
    >

    <div class="stress-field stress-weight">
      <label class="stress-gravity" title="Load the body with its own weight">
        <Switch v-model="setup.gravity.on" class="stress-gravity-on" label="Own weight" />
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

    <Button variant="ghost" size="sm" class="stress-more" :aria-expanded="moreOpen" @click="moreOpen = !moreOpen">
      <template #icon><Icon :name="moreOpen ? 'caretDown' : 'caretRight'" :size="12" /></template>More options
    </Button>
    <div v-show="moreOpen" class="stress-fold stress-more-body">
      <div class="stress-field">
        <span class="measure-k">Mesh size</span>
        <NumberField
          v-model="setup.size"
          commit="live"
          nullable
          unit="mm"
          :width-ch="7"
          class="stress-size"
          placeholder="auto"
        />
      </div>
      <div class="sm-hint">Smaller is finer and slower.</div>
      <div class="stress-field">
        <span class="measure-k">Refinement</span>
        <Select
          v-model="setup.refine"
          :options="REFINE_CHOICES"
          class="stress-refine"
          title="Refine the mesh where stress is high"
        />
      </div>
      <div class="sm-hint">Fine finds the peak more closely and takes longer. Off uses one even mesh.</div>
    </div>

    <div v-if="panels.stress?.error" class="measure-hint stress-error">{{ panels.stress.error }}</div>
  </div>
</template>
