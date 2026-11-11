<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { t } from "../../i18n";
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
  MESH_DETAIL_CHOICES,
  SUPPORT_COLORS,
  SUPPORT_KINDS,
  cssHex,
  faceCountLabel,
  finerLabel,
  sameTarget,
  type StressFaceSet,
  type StressSetup,
  type StressTarget,
} from "../../ui/stress";
import type { StressSupportType } from "../../types";

const props = defineProps<{ setup: StressSetup; bodies: readonly { id: string; name: string }[] }>();

const engine = useEngine();
const panels = usePanelsStore();

const running = computed(() => !!panels.stress?.running);

// A long language pushes the refusal below the column's fold, under Run, where nobody looks for it.
const errorLine = ref<HTMLElement | null>(null);
watch([errorLine, () => panels.stress?.error], ([el]) => el?.scrollIntoView?.({ block: "nearest" }), { flush: "post" });
// The time on the button was for the setup that ran.
const finer = computed(() => {
  const s = panels.stress;
  return s?.finer && s.ranSetup === JSON.stringify(s.setup) ? s.finer : null;
});
const loadColor = cssHex(LOAD_MARK_COLOR);
const gravityColor = cssHex(GRAVITY_MARK_COLOR);
const loadKinds = computed(() => [
  { value: "force" as const, label: t("stress.setup.force") },
  { value: "pressure" as const, label: t("stress.setup.pressure") },
]);
const AXES = [0, 1, 2] as const;
const AXIS_NAMES = ["X", "Y", "Z"] as const;
const gravityOptions = computed(() => GRAVITY_DIRECTIONS.map((d) => ({ value: d, label: AXIS_LABELS[d] })));

// The analysed body when the current model does not have it (the timeline rolled back before it), so the list can
// still name what the setup is for.
const bodyOptions = computed(() => {
  const opts: { value: string; label: string; disabled?: boolean }[] = [{ value: "", label: t("stress.setup.choose") }];
  for (const b of props.bodies) opts.push({ value: b.id, label: b.name || b.id });
  const b = props.setup.body;
  if (b && !props.bodies.some((x) => x.id === b)) {
    opts.push({ value: b, label: t("stress.setup.bodyGone", { body: b }), disabled: true });
  }
  return opts;
});

// Open on first show when the detail is not Standard, so a value that changes the Run is never hidden.
const moreOpen = ref(props.setup.refine !== "standard");

function supportColor(t: StressSupportType): string {
  return cssHex(SUPPORT_COLORS[t]);
}

function supportHint(t: StressSupportType): string {
  return SUPPORT_KINDS.find((k) => k.value === t)?.hint ?? "";
}

function holdsPlaces(row: { faces: StressFaceSet; spots?: readonly unknown[] }): boolean {
  return row.faces.selectors.length > 0 || !!row.spots?.length;
}

function placing(target: StressTarget, as: "face" | "spot"): boolean {
  return sameTarget(panels.stress?.placing ?? null, target) && panels.stress?.placeAs === as;
}
</script>

<template>
  <div class="stress-step stress-setup" data-panel-scroll>
    <label class="stress-field">
      <span class="measure-k">{{ t("stress.setup.body") }}</span>
      <Select
        :model-value="setup.body ?? ''"
        :options="bodyOptions"
        :label="t('stress.setup.body')"
        class="stress-body"
        testid="stress-body"
        :disabled="running"
        @update:model-value="engine.ui.panels.setStressBody($event || null)"
      />
    </label>

    <div class="rd-head stress-caption"
      >{{ t("stress.setup.supports") }} <span class="tree-count">{{ setup.supports.length }}</span></div
    >
    <div v-for="(x, i) in setup.supports" :key="'s' + x.id" class="stress-item">
      <div class="stress-item-head">
        <span class="stress-swatch" :style="{ background: supportColor(x.type) }" />
        <span class="stress-item-name">{{ t("stress.setup.support", { i: i + 1 }) }}</span>
        <Select
          :model-value="x.type"
          :options="SUPPORT_KINDS"
          :label="t('stress.setup.supportType', { i: i + 1 })"
          class="stress-support-type"
          :title="supportHint(x.type)"
          @update:model-value="engine.ui.panels.setStressSupportType(x.id, $event)"
        />
        <IconButton
          class="stress-remove-support"
          icon="close"
          :tip="t('stress.setup.removeSupport', { i: i + 1 })"
          size="sm"
          variant="danger"
          :icon-size="14"
          @click="engine.ui.panels.removeStressSupport(x.id)"
        />
      </div>
      <div class="stress-faces">
        <div class="stress-count-line">
          <span class="measure-k stress-count">{{ faceCountLabel(x.faces, x.spots) }}</span>
          <Button
            size="sm"
            variant="ghost"
            class="stress-clear-support"
            :tip="t('stress.setup.clearSupport', { i: i + 1 })"
            :disabled="!holdsPlaces(x)"
            :disabled-reason="t('stress.setup.nothingPlaced')"
            @click="engine.ui.panels.clearStressPlaces({ support: x.id })"
            >{{ t("stress.setup.clear") }}</Button
          >
        </div>
        <span class="stress-face-actions">
          <Button
            size="sm"
            class="stress-place-support"
            :pressed="placing({ support: x.id }, 'face')"
            :tip="t('stress.setup.clickFacesTip')"
            @click="engine.ui.panels.placeStressSpot({ support: x.id })"
            >{{ placing({ support: x.id }, "face") ? t("stress.setup.picking") : t("stress.setup.clickFaces") }}</Button
          >
          <Button
            size="sm"
            class="stress-spot-support"
            :pressed="placing({ support: x.id }, 'spot')"
            :tip="t('stress.setup.spotSupportTip')"
            @click="engine.ui.panels.placeStressSpot({ support: x.id }, 'spot')"
            >{{ placing({ support: x.id }, "spot") ? t("stress.setup.placing") : t("stress.setup.spot") }}</Button
          >
          <Button
            size="sm"
            class="stress-set-support"
            :tip="t('stress.setup.useSelectedTip')"
            @click="engine.ui.panels.setStressFacesFromSelection({ support: x.id })"
            >{{ t("stress.setup.useSelected") }}</Button
          >
        </span>
      </div>
      <div v-for="(spot, k) in x.spots ?? []" :key="'ss' + x.id + '-' + k" class="stress-field stress-spot">
        <span class="measure-k">{{ t("stress.setup.spotN", { k: k + 1 }) }}</span>
        <NumberField
          v-model="spot.radius"
          commit="live"
          unit="mm"
          :width-ch="7"
          class="stress-spot-radius"
          :title="t('stress.setup.radius')"
          :label="t('stress.setup.spotRadius', { k: k + 1 })"
        />
        <IconButton
          class="stress-remove-spot"
          icon="close"
          :tip="t('stress.setup.removeSpot', { k: k + 1 })"
          size="sm"
          variant="danger"
          :icon-size="14"
          @click="engine.ui.panels.removeStressSpot({ support: x.id }, k)"
        />
      </div>
    </div>
    <Button size="sm" icon="plus" class="stress-add stress-add-support" @click="engine.ui.panels.addStressSupport()">{{
      t("stress.setup.addSupport")
    }}</Button>

    <div class="rd-head stress-caption"
      >{{ t("stress.setup.loads") }} <span class="tree-count">{{ setup.loads.length }}</span></div
    >
    <div v-for="(l, i) in setup.loads" :key="l.id" class="stress-item">
      <div class="stress-item-head">
        <span class="stress-swatch" :style="{ background: loadColor }" />
        <span class="stress-item-name">{{ t("stress.setup.load", { i: i + 1 }) }}</span>
        <Select
          v-model="l.kind"
          :options="loadKinds"
          :label="t('stress.setup.loadKind', { i: i + 1 })"
          class="stress-load-kind"
        />
        <!-- Down to no load at all: a body under its own weight alone is a study. -->
        <IconButton
          class="stress-remove-load"
          icon="close"
          :tip="t('stress.setup.removeLoad', { i: i + 1 })"
          size="sm"
          variant="danger"
          :icon-size="14"
          @click="engine.ui.panels.removeStressLoad(l.id)"
        />
      </div>
      <div class="stress-faces">
        <div class="stress-count-line">
          <span class="measure-k stress-count">{{ faceCountLabel(l.faces, l.spots) }}</span>
          <Button
            size="sm"
            variant="ghost"
            class="stress-clear-load"
            :tip="t('stress.setup.clearLoad', { i: i + 1 })"
            :disabled="!holdsPlaces(l)"
            :disabled-reason="t('stress.setup.nothingPlaced')"
            @click="engine.ui.panels.clearStressPlaces({ load: l.id })"
            >{{ t("stress.setup.clear") }}</Button
          >
        </div>
        <span class="stress-face-actions">
          <Button
            size="sm"
            class="stress-place-load"
            :pressed="placing({ load: l.id }, 'face')"
            :tip="t('stress.setup.clickFacesTip')"
            @click="engine.ui.panels.placeStressSpot({ load: l.id })"
            >{{ placing({ load: l.id }, "face") ? t("stress.setup.picking") : t("stress.setup.clickFaces") }}</Button
          >
          <Button
            size="sm"
            class="stress-spot-load"
            :pressed="placing({ load: l.id }, 'spot')"
            :tip="t('stress.setup.spotLoadTip')"
            @click="engine.ui.panels.placeStressSpot({ load: l.id }, 'spot')"
            >{{ placing({ load: l.id }, "spot") ? t("stress.setup.placing") : t("stress.setup.spot") }}</Button
          >
          <Button
            size="sm"
            class="stress-set-load"
            :tip="t('stress.setup.useSelectedTip')"
            @click="engine.ui.panels.setStressFacesFromSelection({ load: l.id })"
            >{{ t("stress.setup.useSelected") }}</Button
          >
        </span>
      </div>
      <div v-for="(spot, k) in l.spots ?? []" :key="'ls' + l.id + '-' + k" class="stress-field stress-spot">
        <span class="measure-k">{{ t("stress.setup.spotN", { k: k + 1 }) }}</span>
        <NumberField
          v-model="spot.radius"
          commit="live"
          unit="mm"
          :width-ch="7"
          class="stress-spot-radius"
          :title="t('stress.setup.radius')"
          :label="t('stress.setup.spotRadius', { k: k + 1 })"
        />
        <IconButton
          class="stress-remove-spot"
          icon="close"
          :tip="t('stress.setup.removeSpot', { k: k + 1 })"
          size="sm"
          variant="danger"
          :icon-size="14"
          @click="engine.ui.panels.removeStressSpot({ load: l.id }, k)"
        />
      </div>
      <template v-if="l.kind === 'force'">
        <div class="stress-field">
          <span class="measure-k">{{ t("stress.setup.force") }}</span>
          <NumberField
            v-model="l.force"
            commit="live"
            unit="N"
            :width-ch="7"
            class="stress-force"
            :label="t('stress.setup.force')"
          />
          <Select
            v-model="l.direction"
            :options="FORCE_DIRECTIONS"
            :label="t('stress.setup.forceDirection')"
            class="stress-direction"
            :title="t('stress.setup.direction')"
          />
        </div>
        <div v-if="l.direction === 'custom'" class="stress-field">
          <span class="measure-k">{{ t("stress.setup.xyz") }}</span>
          <span class="stress-xyz-row">
            <!-- Wide enough for what a drag writes, a sign and three decimals. -->
            <NumberField
              v-for="i in AXES"
              :key="i"
              v-model="l.custom[i]"
              commit="live"
              unitless
              :step="0.1"
              :width-ch="6"
              class="stress-xyz"
              :title="String(l.custom[i])"
              :label="AXIS_NAMES[i]"
            />
          </span>
        </div>
      </template>
      <div v-else class="stress-field">
        <span class="measure-k">{{ t("stress.setup.pressure") }}</span>
        <NumberField
          v-model="l.pressure"
          commit="live"
          unit="MPa"
          :width-ch="7"
          class="stress-pressure"
          :label="t('stress.setup.pressure')"
        />
      </div>
    </div>
    <Button size="sm" icon="plus" class="stress-add stress-add-load" @click="engine.ui.panels.addStressLoad()">{{
      t("stress.setup.addLoad")
    }}</Button>

    <div class="stress-field stress-weight">
      <label class="stress-gravity" :title="t('stress.setup.ownWeightTip')">
        <Switch v-model="setup.gravity.on" class="stress-gravity-on" :label="t('stress.setup.ownWeight')" />
        <span class="stress-swatch" :style="{ background: gravityColor }" />
        <span class="measure-k">{{ t("stress.setup.ownWeight") }}</span>
      </label>
      <Select
        v-if="setup.gravity.on"
        v-model="setup.gravity.direction"
        :options="gravityOptions"
        :label="t('stress.setup.whichWayDown')"
        class="stress-gravity-dir"
        :title="t('stress.setup.whichWayDown')"
      />
    </div>

    <div class="rd-head stress-caption">{{ t("stress.setup.material") }}</div>
    <StressMaterialFields :setup="setup" />

    <Button variant="ghost" size="sm" class="stress-more" :aria-expanded="moreOpen" @click="moreOpen = !moreOpen">
      <template #icon><Icon :name="moreOpen ? 'caretDown' : 'caretRight'" :size="12" /></template
      >{{ t("stress.setup.more") }}
    </Button>
    <div v-show="moreOpen" class="stress-fold stress-more-body">
      <div class="stress-field">
        <span class="measure-k">{{ t("stress.setup.meshDetail") }}</span>
        <Select
          v-model="setup.refine"
          :options="MESH_DETAIL_CHOICES"
          :label="t('stress.setup.meshDetail')"
          class="stress-detail"
          :title="t('stress.setup.meshDetailTip')"
        />
      </div>
      <div class="sm-hint">{{ t("stress.setup.meshHint") }}</div>
    </div>

    <div v-if="panels.stress?.error" ref="errorLine" class="measure-hint stress-error">{{ panels.stress.error }}</div>
    <Button v-if="finer" variant="primary" size="sm" class="stress-finer" @click="engine.ui.panels.runStress(true)">{{
      finerLabel(finer.seconds)
    }}</Button>
  </div>
</template>
