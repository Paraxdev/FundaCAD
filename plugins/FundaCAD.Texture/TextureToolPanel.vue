<script setup lang="ts">
// Docked top right, since the tool can span a whole body and has no point to anchor to. Escape is not handled here:
// TextureTool owns it from the rollback before this panel opens until after a refused commit.

import { computed, reactive, ref, watch } from "vue";
import {
  TEXTURE_KIND_GROUPS,
  basename,
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

const EDGE_TIP = "Edge blend: mm the pattern fades over at a face boundary. 0 = a clean machined cut-off.";
const SLOPE_TIP =
  "Keep the texture only where the surface's angle from up (0 = a flat top, 90 = a vertical wall, 180 = a flat underside) is in this band. 0 to 180 masks nothing.";

const NUM_HEAD: NumDef[] = [
  { key: "depth", label: "Depth", unit: "mm", step: 0.1, min: 0 },
  { key: "scale", label: "Scale", unit: "mm", step: 0.5, min: 0 },
  { key: "angle", label: "Angle", unit: "deg", step: 5 },
  { key: "sharpness", label: "Sharpness", unit: null, step: 0.1, min: 0, max: 1 },
];
const NUM_ADVANCED: NumDef[] = [
  { key: "offset", label: "Offset", unit: "mm", step: 0.1, tip: EDGE_TIP },
  { key: "edgeBlend", label: "Edge blend", unit: "mm", step: 0.1, min: 0, tip: EDGE_TIP },
  { key: "slopeMin", label: "Slope min", unit: "deg", step: 5, min: 0, max: 180, tip: SLOPE_TIP },
  { key: "slopeMax", label: "Slope max", unit: "deg", step: 5, min: 0, max: 180, tip: SLOPE_TIP },
  {
    key: "targetEdge",
    label: "Mesh detail",
    unit: "mm",
    step: 0.1,
    min: 0,
    tip: "Target edge length in mm for the sampling mesh (0 = automatic). A coarser edge keeps a heavy texture light.",
  },
  {
    key: "triBudget",
    label: "Max triangles",
    unit: null,
    step: 1000,
    min: 0,
    tip: "A hard per-face triangle budget (0 = off). A tighter budget keeps a heavy texture light.",
  },
];

const SLIDERS: { key: PctKey; label: string; tip: string }[] = [
  {
    key: "seamBlend",
    label: "Seam blend",
    tip: "How softly the three world planes blend on a triplanar projection. Higher is a broader, gentler blend.",
  },
  {
    key: "seamBand",
    label: "Seam band",
    tip: "How wide the transition band is where two box-projection axes meet. Higher is a wider, softer band.",
  },
  {
    key: "grime",
    label: "Grime",
    tip: "Bleeds a fading noise onto the faces next to the textured ones, like dirt or wear that crept off the edge. 0 = a clean boundary.",
  },
  {
    key: "smooth",
    label: "Soften",
    tip: "Blurs the height field before it displaces: 0 = crisp relief, higher = softer and more rounded.",
  },
  {
    key: "amplitude",
    label: "Amplitude",
    tip: "Master trim on the depth: 100% is the full depth, lower scales the whole relief down.",
  },
];

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
  refused[k] = why && `${label}: ${why}`;
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

const kindOptions = TEXTURE_KIND_GROUPS.flatMap((g) =>
  g.kinds.map((k) => ({ value: k.value, label: k.label, hint: g.label })),
);
const profileOptions: { value: TextureForm["profile"]; label: string }[] = [
  { value: "facet", label: "Faceted (hard surface)" },
  { value: "round", label: "Smooth" },
];
const directionOptions: { value: TextureForm["direction"]; label: string }[] = [
  { value: "out", label: "Out (emboss)" },
  { value: "in", label: "In (deboss)" },
  { value: "both", label: "Both" },
];
const projectionOptions: { value: TextureForm["projection"]; label: string }[] = [
  { value: "triplanar", label: "Triplanar" },
  { value: "box", label: "Box" },
  { value: "auto", label: "Planar" },
];
const colorOptions = computed(() => [
  { value: "", label: "Body color" },
  ...palette.value.map((s, i) => ({ value: String(i), label: `${s.name} (slot ${i + 1})` })),
]);
const modeOptions: { value: TextureMode; label: string }[] = [
  { value: "faces", label: "Faces" },
  { value: "body", label: "Whole Body" },
];

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
  const path = await openDialog({
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "bmp"] }],
  });
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
  <Panel :open="!!panel.request.value" title="Texture">
    <!-- `data-panel` is the one hook an e2e script holds. -->
    <div data-panel="texture" :style="WIDTH">
      <!-- Its own ref, not the request, so the per-tick rewrite cannot re-render the form and steal focus. -->
      <div class="measure-hint" :style="{ marginTop: 0, marginBottom: '6px' }">{{ panel.summary.value }}</div>

      <Segmented
        label="Texture target"
        size="sm"
        :style="FILL"
        :options="modeOptions"
        :model-value="panel.mode.value"
        @update:model-value="chooseMode"
      />

      <FieldRow v-slot="{ id }" layout="param" label="Kind" :label-width="LABEL_WIDTH">
        <Select
          :id="id"
          label="Kind"
          size="sm"
          :options="kindOptions"
          :model-value="form.kind"
          @update:model-value="pick('kind', $event)"
        />
      </FieldRow>

      <!-- Hard surface is the default, planar facets and creases are what a printer reproduces. -->
      <FieldRow v-slot="{ id }" layout="param" label="Profile" :label-width="LABEL_WIDTH">
        <Select
          :id="id"
          label="Profile"
          size="sm"
          :options="profileOptions"
          :model-value="form.profile"
          @update:model-value="pick('profile', $event)"
        />
      </FieldRow>

      <FieldRow
        v-for="n in NUM_HEAD"
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
      <FieldRow v-slot="{ id }" layout="param" label="Direction" :label-width="LABEL_WIDTH">
        <Select
          :id="id"
          label="Direction"
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
        label="Projection"
        title="How a curved (freeform) face lays out the pattern. Triplanar keeps one size across the curve; Box favours the nearest axis; Planar projects along one direction and foreshortens. Flat, cylindrical and conical faces use their exact chart regardless."
        :label-width="LABEL_WIDTH"
      >
        <Select
          :id="id"
          label="Projection"
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
        v-for="s in SLIDERS"
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

      <FieldRow v-show="rows.seed" v-slot="{ id }" layout="param" label="Seed" :label-width="LABEL_WIDTH">
        <NumberField
          :id="id"
          label="Seed"
          unitless
          size="sm"
          commit="live"
          limits="arrows"
          nullable
          :parse="readPlain"
          :min="0"
          :model-value="numOf('seed')"
          @update:model-value="setNum('seed', $event)"
          @error="refuse('seed', 'Seed', $event)"
        />
        <IconButton icon="dice" tip="Randomize seed" size="sm" variant="plain" @click="randomize" />
      </FieldRow>

      <div v-show="rows.image" :style="LINE">
        <Button size="sm" @click="browse">Browse…</Button>
        <span class="measure-k" :style="PATH">{{ form.imagePath ? basename(form.imagePath) : "No file chosen" }}</span>
      </div>
      <FieldRow v-show="rows.image" v-slot="{ id }" layout="param" label="Invert" :label-width="LABEL_WIDTH">
        <Switch :id="id" label="Invert" :model-value="form.invert" @update:model-value="pick('invert', $event)" />
      </FieldRow>

      <!-- Shown only when the caller passed a palette, i.e. in a document with bodies. -->
      <FieldRow v-show="palette.length" v-slot="{ id }" layout="param" label="Print color" :label-width="LABEL_WIDTH">
        <Select
          :id="id"
          label="Print color"
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
        <template #icon><Icon :name="advanced ? 'caretDown' : 'caretRight'" :size="12" /></template>Advanced
      </Button>
      <div v-show="advanced" id="texture-advanced">
        <FieldRow
          v-for="n in NUM_ADVANCED"
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

      <div class="measure-hint">Preview is real geometry at display resolution, exports keep full detail.</div>

      <div v-for="msg in problems" :key="msg" role="alert" :style="PROBLEM" data-testid="texture-field-error">{{
        msg
      }}</div>

      <div :style="ACTIONS">
        <Button variant="primary" @pointerdown.prevent.stop="add" @click="byKey($event, add)">
          <template #icon><Icon name="check" :size="13" /></template>{{ editing ? "Apply" : "Add" }}
        </Button>
        <Button @pointerdown.prevent.stop="panel.cancel()" @click="byKey($event, panel.cancel)">
          <template #icon><Icon name="close" :size="13" /></template>Cancel
        </Button>
      </div>
    </div>
  </Panel>
</template>
