<script setup lang="ts">
// Docked top right, since the tool can span a whole body and has no point to anchor to. Escape is not handled here:
// TextureTool owns it from the rollback before this panel opens until after a refused commit.

import { computed, reactive, ref, watch } from "vue";
import {
  TEXTURE_KIND_GROUPS,
  basename,
  imageFilters,
  initialTextureForm,
  sharpnessLabel,
  textureRows,
  toTextureValues,
  type TextureForm,
  type TextureMode,
} from "./textureForm";
import { Button, FieldRow, Icon, IconButton, NumberField, Panel, Segmented, Select, Slider, Switch } from "fundacad/ui";
import { fieldNumber, openDialog, readAs, spellNumber } from "fundacad";
import * as panel from "./panel";
import { t } from "./lines";

// Reseeded whenever the tool opens a new request: a permanently mounted overlay has no key to remount it, so a reopen
// would show the last run's values.
const form = reactive(initialTextureForm(panel.request.value?.initial ?? {}));

// The form keeps its strings, so a half typed number and a parameter value keep their meaning, and a NumberField
// reads them in and writes them back at this boundary. Its own refusal of typed text lands here, by field.
const refused = reactive<Record<string, string | null>>({});
const problems = computed(() => Object.values(refused).filter((why): why is string => !!why));
watch(
  () => panel.request.value?.id,
  () => {
    Object.assign(form, initialTextureForm(panel.request.value?.initial ?? {}));
    for (const k of Object.keys(refused)) delete refused[k];
  },
);

const rows = computed(() => textureRows(form));
// Read through the request so they follow a reopen. An empty palette is how a document with no palette looks, and the
// row hides itself.
const palette = computed(() => panel.request.value?.palette ?? []);
const editing = computed(() => panel.request.value?.editing ?? false);
const sharpLabel = computed(() => sharpnessLabel(form.profile));
const advanced = ref(false);

type NumKey =
  | "depth"
  | "scale"
  | "angle"
  | "sharpness"
  | "seed"
  | "offset"
  | "edgeBlend"
  | "slopeMin"
  | "slopeMax"
  | "targetEdge"
  | "triBudget";
type PctKey = "grime" | "smooth" | "seamBlend" | "seamBand" | "amplitude";
type PickKey = "kind" | "profile" | "direction" | "projection" | "colorSlot" | "invert";

interface NumDef {
  key: NumKey;
  label: string;
  unit: "mm" | "deg" | null;
  step: number;
  min?: number;
  max?: number;
  tip?: string;
}

const numHead = computed<NumDef[]>(() => [
  { key: "depth", label: t("field.depth"), unit: "mm", step: 0.1, min: 0 },
  { key: "scale", label: t("field.scale"), unit: "mm", step: 0.5, min: 0 },
  { key: "angle", label: t("field.angle"), unit: "deg", step: 5 },
  { key: "sharpness", label: t("field.sharpness"), unit: null, step: 0.1, min: 0, max: 1 },
]);
const numAdvanced = computed<NumDef[]>(() => [
  { key: "offset", label: t("field.offset"), unit: "mm", step: 0.1, tip: t("tip.offset") },
  { key: "edgeBlend", label: t("field.edgeBlend"), unit: "mm", step: 0.1, min: 0, tip: t("tip.edge") },
  { key: "slopeMin", label: t("field.slopeMin"), unit: "deg", step: 5, min: 0, max: 180, tip: t("tip.slope") },
  { key: "slopeMax", label: t("field.slopeMax"), unit: "deg", step: 5, min: 0, max: 180, tip: t("tip.slope") },
  { key: "targetEdge", label: t("field.meshDetail"), unit: "mm", step: 0.1, min: 0, tip: t("tip.meshDetail") },
  { key: "triBudget", label: t("field.maxTriangles"), unit: null, step: 1000, min: 0, tip: t("tip.maxTriangles") },
]);

const sliders = computed<{ key: PctKey; label: string; tip: string }[]>(() => [
  { key: "seamBlend", label: t("field.seamBlend"), tip: t("tip.seamBlend") },
  { key: "seamBand", label: t("field.seamBand"), tip: t("tip.seamBand") },
  { key: "grime", label: t("field.grime"), tip: t("tip.grime") },
  { key: "smooth", label: t("field.soften"), tip: t("tip.soften") },
  { key: "amplitude", label: t("field.amplitude"), tip: t("tip.amplitude") },
]);

const shownNum = (k: NumKey) => (k === "angle" ? rows.value.angle : k === "sharpness" ? rows.value.sharpness : true);
const shownSlider = (k: PctKey) =>
  k === "seamBlend" ? rows.value.seamBlend : k === "seamBand" ? rows.value.seamBand : true;
const labelOf = (n: NumDef) => (n.key === "sharpness" ? sharpLabel.value.text : n.label);
const tipOf = (n: NumDef) => (n.key === "sharpness" ? sharpLabel.value.title : n.tip);

const readLength = readAs("length");
const readAngle = readAs("angle");
const readPlain = readAs(null);
const readerOf = (n: NumDef) => (n.unit === "mm" ? readLength : n.unit === "deg" ? readAngle : readPlain);

function numOf(k: NumKey): number | null {
  const n = fieldNumber(form[k]);
  return Number.isNaN(n) ? null : n;
}

function setNum(k: NumKey, v: number | null) {
  form[k] = v === null ? "" : spellNumber(v);
  emitChange();
}

function refuse(k: string, label: string, why: string | null) {
  refused[k] = why && t("panel.refused", { label, why });
}

const pctOf = (k: PctKey) => Math.max(0, Math.min(100, Math.round((fieldNumber(form[k]) || 0) * 100)));

function setPct(k: PctKey, v: number) {
  form[k] = spellNumber(v / 100);
  emitChange();
}

function pick<K extends PickKey>(k: K, v: TextureForm[K]) {
  form[k] = v;
  emitChange();
}

const kindOptions = computed(() =>
  TEXTURE_KIND_GROUPS.flatMap((g) => g.kinds.map((k) => ({ value: k.value, label: k.label, hint: g.label }))),
);
const profileOptions = computed<{ value: TextureForm["profile"]; label: string }[]>(() => [
  { value: "facet", label: t("panel.profileFaceted") },
  { value: "round", label: t("option.smooth") },
]);
const directionOptions = computed<{ value: TextureForm["direction"]; label: string }[]>(() => [
  { value: "out", label: t("panel.directionOut") },
  { value: "in", label: t("panel.directionIn") },
  { value: "both", label: t("panel.directionBoth") },
]);
const projectionOptions = computed<{ value: TextureForm["projection"]; label: string }[]>(() => [
  { value: "triplanar", label: t("option.triplanar") },
  { value: "box", label: t("option.box") },
  { value: "auto", label: t("option.planar") },
]);
const colorOptions = computed(() => [
  { value: "", label: t("panel.bodyColor") },
  ...palette.value.map((s, i) => ({ value: String(i), label: t("panel.slot", { name: s.name, n: i + 1 }) })),
]);
const modeOptions = computed<{ value: TextureMode; label: string }[]>(() => [
  { value: "faces", label: t("option.faces") },
  { value: "body", label: t("panel.wholeBody") },
]);

function emitChange() {
  panel.request.value?.onChange(toTextureValues(form));
}

function chooseMode(m: TextureMode) {
  panel.mode.value = m;
  panel.request.value?.onModeChange(m);
}

function randomize() {
  form.seed = String(Math.floor(Math.random() * 1_000_000));
  emitChange();
}

const isTauri = () => "__TAURI_INTERNALS__" in window;

async function browse() {
  if (!isTauri()) {
    console.warn("a heightmap needs the native app (a real filesystem path)");
    return;
  }
  // The host's dialog: importing @tauri-apps/plugin-dialog would bundle a second copy into the plugin. files.read runs
  // only after the person pressed Browse and chose something.
  const path = await openDialog({ filters: imageFilters() });
  if (path === null) return;
  form.imagePath = path;
  emitChange();
}

const add = () => panel.commit(toTextureValues(form));
// A press commits on pointerdown so the viewport tool keeps its focus. A keyboard click has no pointer, detail 0.
const byKey = (e: MouseEvent, run: () => void) => {
  if (e.detail === 0) run();
};

// A plugin ships no stylesheet, so the layout is written here, and every look comes from the base controls.
const WIDTH = { width: "290px", maxWidth: "100%" } as const;
const LABEL_WIDTH = "96px";
const FILL = { width: "100%", marginBottom: "6px" } as const;
const LINE = { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" } as const;
const GROW = { flex: "1 1 auto", minWidth: 0 } as const;
const PATH = { ...GROW, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;
const PROBLEM = { color: "var(--error)", fontSize: "var(--fs-small)", marginBottom: "4px" } as const;
const ACTIONS = { display: "flex", gap: "6px", justifyContent: "flex-end", marginTop: "8px" } as const;
</script>

<template>
  <!-- Mounted for the plugin's whole life, drawn only while the tool runs. -->
  <Panel :open="!!panel.request.value" :title="t('tool.texture')">
    <!-- `data-panel` is the one hook an e2e script holds. -->
    <div data-panel="texture" :style="WIDTH">
      <!-- Its own ref, not the request, so the per-tick rewrite cannot re-render the form and steal focus. -->
      <div class="measure-hint" :style="{ marginTop: 0, marginBottom: '6px' }">{{ panel.summary.value }}</div>

      <Segmented
        :label="t('panel.target')"
        size="sm"
        :style="FILL"
        :options="modeOptions"
        :model-value="panel.mode.value"
        @update:model-value="chooseMode"
      />

      <FieldRow v-slot="{ id }" layout="param" :label="t('panel.kind')" :label-width="LABEL_WIDTH">
        <Select
          :id="id"
          :label="t('panel.kind')"
          size="sm"
          :options="kindOptions"
          :model-value="form.kind"
          @update:model-value="pick('kind', $event)"
        />
      </FieldRow>

      <!-- Hard surface is the default, planar facets and creases are what a printer reproduces. -->
      <FieldRow v-slot="{ id }" layout="param" :label="t('panel.profile')" :label-width="LABEL_WIDTH">
        <Select
          :id="id"
          :label="t('panel.profile')"
          size="sm"
          :options="profileOptions"
          :model-value="form.profile"
          @update:model-value="pick('profile', $event)"
        />
      </FieldRow>

      <FieldRow
        v-for="n in numHead"
        v-show="shownNum(n.key)"
        :key="n.key"
        v-slot="{ id }"
        layout="param"
        :label="labelOf(n)"
        :title="tipOf(n)"
        :label-width="LABEL_WIDTH"
      >
        <NumberField
          :id="id"
          :label="labelOf(n)"
          :unit="n.unit"
          :unitless="!n.unit"
          size="sm"
          commit="live"
          limits="arrows"
          nullable
          :parse="readerOf(n)"
          :step="n.step"
          :min="n.min"
          :max="n.max"
          :model-value="numOf(n.key)"
          @update:model-value="setNum(n.key, $event)"
          @error="refuse(n.key, labelOf(n), $event)"
        />
      </FieldRow>

      <!-- Every kind honours direction, the engine applies it to the height field (out = h, in = h-1, both = centred). -->
      <FieldRow v-slot="{ id }" layout="param" :label="t('field.direction')" :label-width="LABEL_WIDTH">
        <Select
          :id="id"
          :label="t('field.direction')"
          size="sm"
          :options="directionOptions"
          :model-value="form.direction"
          @update:model-value="pick('direction', $event)"
        />
      </FieldRow>

      <!-- Triplanar keeps the cells one size on a freeform face, exact charts ignore it. Hidden for a heightmap. -->
      <FieldRow
        v-show="rows.projection"
        v-slot="{ id }"
        layout="param"
        :label="t('field.projection')"
        :title="t('panel.projection.tip')"
        :label-width="LABEL_WIDTH"
      >
        <Select
          :id="id"
          :label="t('field.projection')"
          size="sm"
          :options="projectionOptions"
          :model-value="form.projection"
          @update:model-value="pick('projection', $event)"
        />
      </FieldRow>

      <!-- Seam blend and band: only the control the active mode reads is shown. Grime bleeds noise onto the
           neighbouring faces, so the wear seems to creep off the edge. Soften is named apart from the "Smooth"
           profile, which is the continuous field rather than this blur. -->
      <FieldRow
        v-for="s in sliders"
        v-show="shownSlider(s.key)"
        :key="s.key"
        v-slot="{ labelId }"
        layout="param"
        :for="null"
        :label="s.label"
        :title="s.tip"
        :label-width="LABEL_WIDTH"
      >
        <Slider
          :labelledby="labelId"
          :style="GROW"
          :min="0"
          :max="100"
          :step="5"
          unit="%"
          show-value
          :model-value="pctOf(s.key)"
          @update:model-value="setPct(s.key, $event)"
        />
      </FieldRow>

      <FieldRow v-show="rows.seed" v-slot="{ id }" layout="param" :label="t('field.seed')" :label-width="LABEL_WIDTH">
        <NumberField
          :id="id"
          :label="t('field.seed')"
          unitless
          size="sm"
          commit="live"
          limits="arrows"
          nullable
          :parse="readPlain"
          :min="0"
          :model-value="numOf('seed')"
          @update:model-value="setNum('seed', $event)"
          @error="refuse('seed', t('field.seed'), $event)"
        />
        <IconButton icon="dice" :tip="t('panel.randomize')" size="sm" variant="plain" @click="randomize" />
      </FieldRow>

      <div v-show="rows.image" :style="LINE">
        <Button size="sm" @click="browse">{{ t("panel.browse") }}</Button>
        <span class="measure-k" :style="PATH">{{ form.imagePath ? basename(form.imagePath) : t("panel.noFile") }}</span>
      </div>
      <FieldRow
        v-show="rows.image"
        v-slot="{ id }"
        layout="param"
        :label="t('panel.invert')"
        :label-width="LABEL_WIDTH"
      >
        <Switch
          :id="id"
          :label="t('panel.invert')"
          :model-value="form.invert"
          @update:model-value="pick('invert', $event)"
        />
      </FieldRow>

      <!-- Shown only when the caller passed a palette, i.e. in a document with bodies. -->
      <FieldRow
        v-show="palette.length"
        v-slot="{ id }"
        layout="param"
        :label="t('panel.printColor')"
        :label-width="LABEL_WIDTH"
      >
        <Select
          :id="id"
          :label="t('panel.printColor')"
          size="sm"
          :options="colorOptions"
          :model-value="form.colorSlot"
          @update:model-value="pick('colorSlot', $event)"
        />
      </FieldRow>

      <Button
        variant="ghost"
        size="sm"
        :aria-expanded="advanced"
        aria-controls="texture-advanced"
        :style="{ marginBottom: '4px' }"
        @click="advanced = !advanced"
      >
        <template #icon><Icon :name="advanced ? 'caretDown' : 'caretRight'" :size="12" /></template
        >{{ t("panel.advanced") }}
      </Button>
      <div v-show="advanced" id="texture-advanced">
        <FieldRow
          v-for="n in numAdvanced"
          :key="n.key"
          v-slot="{ id }"
          layout="param"
          :label="n.label"
          :title="n.tip"
          :label-width="LABEL_WIDTH"
        >
          <NumberField
            :id="id"
            :label="n.label"
            :unit="n.unit"
            :unitless="!n.unit"
            size="sm"
            commit="live"
            limits="arrows"
            nullable
            :parse="readerOf(n)"
            :step="n.step"
            :min="n.min"
            :max="n.max"
            :model-value="numOf(n.key)"
            @update:model-value="setNum(n.key, $event)"
            @error="refuse(n.key, n.label, $event)"
          />
        </FieldRow>
      </div>

      <div class="measure-hint">{{ t("panel.previewNote") }}</div>

      <div v-for="msg in problems" :key="msg" role="alert" :style="PROBLEM" data-testid="texture-field-error">{{
        msg
      }}</div>

      <div :style="ACTIONS">
        <Button variant="primary" @pointerdown.prevent.stop="add" @click="byKey($event, add)">
          <template #icon><Icon name="check" :size="13" /></template>{{ editing ? t("panel.apply") : t("panel.add") }}
        </Button>
        <Button @pointerdown.prevent.stop="panel.cancel()" @click="byKey($event, panel.cancel)">
          <template #icon><Icon name="close" :size="13" /></template>{{ t("panel.cancel") }}
        </Button>
      </div>
    </div>
  </Panel>
</template>
