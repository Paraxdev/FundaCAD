<script setup lang="ts">
// The floating column of view controls down the right edge: snapping, the grid
// and units, standard views, display and analysis, a screenshot, and the
// history panel toggle. Each opens a popover; only settings the app has are
// offered.

import { computed, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
import { useEngine } from "../../app/engineKey";
import { useBuildValue } from "../../app/useDoc";
import { useUiStore } from "../../stores/ui";
import { useShellStore } from "../../stores/shell";
import { useDialogStore } from "../../stores/dialogs";
import { useSketchPaletteStore } from "../../stores/sketchPalette";
import { fmtLength, getUnit, onUnitChange, setUnit, asUnit, type Unit } from "../../ui/units";
import { saveRenderedImage } from "../../io/files";
import { toast } from "../../ui/toast";
import type { ProjectionMode } from "../../viewport/cameras";
import IconButton from "../ui/IconButton.vue";
import Popover from "../ui/Popover.vue";
import Toggle from "../ui/Toggle.vue";
import ChoiceList from "../ui/ChoiceList.vue";
import Tabs from "../ui/Tabs.vue";

const engine = useEngine();
const ui = useUiStore();
const shell = useShellStore();
const dialogs = useDialogStore();
const sketchPalette = useSketchPaletteStore();

const root = useTemplateRef<HTMLElement>("root");
const anchors = new Map<string, HTMLElement>();
const anchorOf = (id: string) => anchors.get(id) ?? null;
function open(id: string, ev: MouseEvent) {
  anchors.set(id, ev.currentTarget as HTMLElement);
  shell.togglePopover(`vc:${id}`);
}
const isOpen = (id: string) => shell.popover === `vc:${id}`;

// The view cube is drawn into the canvas, so it is told how much of the right
// edge the floating cards take (this column, and the history or palette beside it).
let ro: ResizeObserver | null = null;
function reportInset() {
  const el = root.value?.parentElement ?? root.value;
  if (!el) return;
  const canvas = engine.canvas.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  engine.viewport.setViewCubeInset(Math.max(0, Math.round(canvas.right - r.left)));
}
onMounted(() => {
  ro = new ResizeObserver(reportInset);
  const side = root.value?.parentElement;
  if (side) ro.observe(side);
  if (root.value) ro.observe(root.value);
  reportInset();
});
onUnmounted(() => {
  ro?.disconnect();
  engine.viewport.setViewCubeInset(0);
});

// --- live values the engine does not publish --------------------------------

const pulse = ref(0);
const bump = () => requestAnimationFrame(() => pulse.value++);
onMounted(() => window.addEventListener("pointerup", bump));
onUnmounted(() => window.removeEventListener("pointerup", bump));

const unit = ref<Unit>(getUnit());
const offUnit = onUnitChange(() => { unit.value = getUnit(); });
onUnmounted(offUnit);

const UNITS = [
  { value: "mm" as Unit, label: "Millimeter" },
  { value: "cm" as Unit, label: "Centimeter" },
  { value: "in" as Unit, label: "Inch" },
];
function pickUnit(u: Unit) {
  const ok = asUnit(u);
  if (ok) setUnit(ok);
}

const gridLabel = computed(() => fmtLength(ui.gridStepMm));

const VIEWS = [
  { view: "top", label: "Top" },
  { view: "bottom", label: "Bottom" },
  { view: "front", label: "Front" },
  { view: "back", label: "Back" },
  { view: "right", label: "Right" },
  { view: "left", label: "Left" },
] as const;
const viewTab = ref<"views" | "appearance">("views");

const projection = computed<ProjectionMode>(() => { pulse.value; return engine.viewport.projection; });
const PROJECTIONS = [
  { value: "persp" as ProjectionMode, label: "Perspective" },
  { value: "ortho" as ProjectionMode, label: "Orthographic" },
  { value: "auto" as ProjectionMode, label: "Automatic", hint: "orthographic when looking straight on" },
];
function pickProjection(m: ProjectionMode) {
  engine.viewport.setProjection(m);
  ui.projLabel = m === "auto" ? "Auto" : m === "ortho" ? "Ortho" : "Persp";
  pulse.value++;
}

const SELECT_MODES = [
  { value: "faces" as const, label: "Faces" },
  { value: "bodies" as const, label: "Bodies" },
];
function pickSelectMode(m: "faces" | "bodies") {
  engine.handleAction(m === "bodies" ? "selmode-bodies" : "selmode-faces");
}

const analysis = computed(() => {
  pulse.value;
  const vp = engine.viewport;
  return { zebra: vp.zebraOn, curvature: vp.combsOn, overhang: vp.analysis === "draft", colors: vp.analysis === "component" };
});
function runAndRefresh(action: string) {
  engine.handleAction(action);
  pulse.value++;
}

const errorCount = useBuildValue((b) => {
  const ids = new Set((b.result?.featureErrors ?? []).map((e) => e.feature_id).filter(Boolean));
  if (b.errorFeatureId) ids.add(b.errorFeatureId);
  return ids.size;
});

const saving = ref(false);
async function screenshot() {
  if (saving.value) return;
  saving.value = true;
  try {
    // Note: read the pixels in the same task as the render, before any await.
    const url = engine.viewport.renderStill(1, { edges: true });
    const base = engine.store.fileName === "Untitled" ? "screenshot" : engine.store.fileName;
    const path = await saveRenderedImage(url, `${base}.png`);
    if (path) toast(`Saved ${path}`);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div id="viewcontrols" ref="root" class="float-column">
    <div class="float-group">
      <IconButton icon="magnet" title="Snapping" :active="isOpen('snap')" @click="open('snap', $event)" />
      <button
        type="button"
        class="icon-btn grid-btn"
        :class="{ active: isOpen('grid') }"
        title="Grid and units"
        @click="open('grid', $event)"
      >{{ gridLabel }}</button>
      <IconButton icon="views" title="Views" :active="isOpen('views')" @click="open('views', $event)" />
    </div>
    <div class="float-group">
      <IconButton icon="shaded" title="Display" :active="isOpen('display') || ui.xray" @click="open('display', $event)" />
      <IconButton icon="camera" title="Screenshot" :active="saving" @click="screenshot()" />
      <IconButton
        icon="history"
        title="History (Ctrl Alt H)"
        :active="shell.historyOpen"
        :badge="errorCount || null"
        @click="shell.toggleHistory()"
      />
    </div>
    <div v-if="dialogs.bugDeps" class="float-group">
      <IconButton icon="bug" title="Report a bug" @click="dialogs.bugReport = true" />
    </div>

    <Popover v-if="isOpen('snap')" :anchor="anchorOf('snap')" side="left" kind="vc-pop" @close="shell.closePopover()">
      <div class="pop-section">Snap to</div>
      <Toggle
        :model-value="sketchPalette.state.snap"
        label="Grid"
        @update:model-value="sketchPalette.set('snap', $event)"
      />
      <div class="pop-rule"></div>
      <div class="pop-section">Show</div>
      <Toggle
        :model-value="sketchPalette.state.grid"
        label="Sketch grid"
        @update:model-value="sketchPalette.set('grid', $event)"
      />
      <Toggle
        :model-value="sketchPalette.state.constraints"
        label="Constraints"
        @update:model-value="sketchPalette.set('constraints', $event)"
      />
      <Toggle
        :model-value="sketchPalette.state.dimensions"
        label="Dimensions"
        @update:model-value="sketchPalette.set('dimensions', $event)"
      />
    </Popover>

    <Popover v-if="isOpen('grid')" :anchor="anchorOf('grid')" side="left" kind="vc-pop" @close="shell.closePopover()">
      <div class="pop-section">Units</div>
      <ChoiceList :options="UNITS" :model-value="unit" @update:model-value="pickUnit" />
      <div class="pop-rule"></div>
      <div class="pop-section">Grid</div>
      <p class="pop-note">One square is {{ gridLabel }} at this zoom. Zoom in for a finer grid, and the move gizmo steps by a tenth of a square.</p>
    </Popover>

    <Popover v-if="isOpen('views')" :anchor="anchorOf('views')" side="left" kind="vc-pop" @close="shell.closePopover()">
      <Tabs
        v-model="viewTab"
        :tabs="[{ value: 'views', label: 'Views' }, { value: 'appearance', label: 'Appearance' }]"
      />
      <template v-if="viewTab === 'views'">
        <button type="button" class="pop-wide" @click="engine.handleAction('iso')">Default View</button>
        <button type="button" class="pop-wide ghost" @click="engine.handleAction('fit')">Fit to Model</button>
        <div class="pop-rule"></div>
        <button
          v-for="v in VIEWS"
          :key="v.view"
          type="button"
          class="opt-row"
          @click="engine.viewport.setStandardView(v.view)"
        ><span class="opt-label">{{ v.label }}</span></button>
      </template>
      <template v-else>
        <div class="pop-section">Projection</div>
        <ChoiceList :options="PROJECTIONS" :model-value="projection" @update:model-value="pickProjection" />
        <div class="pop-rule"></div>
        <div class="pop-section">Select</div>
        <ChoiceList :options="SELECT_MODES" :model-value="ui.selMode" @update:model-value="pickSelectMode" />
      </template>
    </Popover>

    <Popover v-if="isOpen('display')" :anchor="anchorOf('display')" side="left" kind="vc-pop" @close="shell.closePopover()">
      <div class="pop-section">Shading</div>
      <Toggle :model-value="ui.xray" label="X-Ray" @update:model-value="engine.handleAction('toggle-xray')" />
      <div class="pop-rule"></div>
      <div class="pop-section">Surface analysis</div>
      <Toggle :model-value="analysis.zebra" label="Zebra" @update:model-value="runAndRefresh('zebra')" />
      <Toggle :model-value="analysis.curvature" label="Curvature combs" @update:model-value="runAndRefresh('curvature')" />
      <Toggle :model-value="analysis.overhang" label="Overhang" @update:model-value="runAndRefresh('draft-analysis')" />
      <Toggle :model-value="analysis.colors" label="Body colors" @update:model-value="runAndRefresh('component-colors')" />
    </Popover>
  </div>
</template>
