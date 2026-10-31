<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  useId,
  useTemplateRef,
  type ComponentPublicInstance,
} from "vue";
import { useEngine } from "../../app/engineKey";
import { useBuildValue } from "../../app/useDoc";
import { useUiStore } from "../../stores/ui";
import { useShellStore } from "../../stores/shell";
import { useDialogStore } from "../../stores/dialogs";
import { useSketchPaletteStore } from "../../stores/sketchPalette";
import { fmtGridStep, fmtLengthCompact, getUnit, onUnitChange, setUnit, asUnit, type Unit } from "../../ui/units";
import { saveRenderedImage } from "../../io/files";
import { MATCAP_STYLES, onRenderPrefsChange, renderPrefs, setRenderPref } from "../../ui/renderPrefs";
import { matcapSwatchUrl } from "../../ui/matcapSwatch";
import {
  VIEW_MODES,
  pathTracedBlock,
  savedOverlays,
  setOverlay,
  setOverlaysOn,
  type ViewMode,
} from "../../ui/viewMode";
import { onWorkspaceChange } from "../../ui/workspace";
import { keyHint } from "../../input/shortcuts";
import { chordsOf } from "../../input/platform";
import { OVERLAY_KINDS, OVERLAY_LABELS } from "../../viewport/overlayKinds";
import { isRenderLowPower } from "../../viewport/render";
import { toast } from "../../ui/toast";
import { featureFailures } from "../../ui/featureNotes";
import { useScrollCue } from "../../composables/useScrollCue";
import type { ProjectionMode } from "../../viewport/cameras";
import { ZEBRA_WIDTH_MAX, ZEBRA_WIDTH_MIN, type ZebraDirection } from "../../viewport/zebraStripes";
import IconButton from "../ui/IconButton.vue";
import Button from "../ui/Button.vue";
import ListRow from "../ui/ListRow.vue";
import Segmented, { type SegmentedOption } from "../ui/Segmented.vue";
import Slider from "../ui/Slider.vue";
import Toolbar from "../ui/Toolbar.vue";
import Icon from "./Icon.vue";
import VersionsPanel from "./VersionsPanel.vue";
import Popover from "../ui/Popover.vue";
import Toggle from "../ui/Toggle.vue";
import ChoiceList from "../ui/ChoiceList.vue";
import Tabs from "../ui/Tabs.vue";
import TabPanel from "../ui/TabPanel.vue";
import type { SelectPolicy } from "../../viewport/clickIntent";

const engine = useEngine();
const ui = useUiStore();
const shell = useShellStore();
const dialogs = useDialogStore();
const sketchPalette = useSketchPaletteStore();

const bar = useTemplateRef<ComponentPublicInstance>("bar");
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
const scroller = computed(() => (bar.value?.$el as HTMLElement | undefined) ?? null);
/** The controls are taller than the column's room, so the list clips at the column and scrolls. */
const scrolls = ref(false);
const cue = useScrollCue(scroller);
function measureFit() {
  const list = scroller.value;
  const room = root.value?.parentElement?.clientHeight;
  if (!list || !room) return;
  const cs = getComputedStyle(list);
  const content = list.scrollHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  scrolls.value = content > room + 1;
  void nextTick(cue.update);
}
onMounted(() => {
  ro = new ResizeObserver(() => {
    reportInset();
    measureFit();
  });
  const side = root.value?.parentElement;
  if (side) ro.observe(side);
  if (root.value) ro.observe(root.value);
  reportInset();
  void nextTick(measureFit);
});
// A group that comes or goes (narrow stage, low performance, bug report) leaves a capped column the same size. The
// groups render in the toolbar's slot, so the toolbar updates and this component does not.
const remeasure = () => void nextTick(measureFit);
onUnmounted(() => {
  ro?.disconnect();
  engine.viewport.setViewCubeInset(0);
});

// Live values the engine does not publish.
const pulse = ref(0);
const bump = () => requestAnimationFrame(() => pulse.value++);
onMounted(() => window.addEventListener("pointerup", bump));
onUnmounted(() => window.removeEventListener("pointerup", bump));

const unit = ref<Unit>(getUnit());
const offUnit = onUnitChange(() => {
  unit.value = getUnit();
});
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

const gridLabel = computed(() => fmtGridStep(ui.gridStepMm));
const gridLabelCompact = computed(() => fmtLengthCompact(ui.gridStepMm));

const VIEWS = [
  { view: "top", label: "Top" },
  { view: "bottom", label: "Bottom" },
  { view: "front", label: "Front" },
  { view: "back", label: "Back" },
  { view: "right", label: "Right" },
  { view: "left", label: "Left" },
] as const;
const viewTab = ref<"views" | "appearance">("views");
const viewPages = useId();

const projection = computed<ProjectionMode>(() => {
  pulse.value;
  return engine.viewport.projection;
});
const PROJECTIONS = [
  { value: "persp" as ProjectionMode, label: "Perspective" },
  { value: "ortho" as ProjectionMode, label: "Orthographic" },
  {
    value: "auto" as ProjectionMode,
    label: "Automatic",
    hint: "orthographic when looking straight on from outside the model",
  },
];
function pickProjection(m: ProjectionMode) {
  engine.viewport.setProjection(m);
  ui.projLabel = m === "auto" ? "Auto" : m === "ortho" ? "Ortho" : "Persp";
  pulse.value++;
}

const SELECT_MODES = [
  {
    value: "auto" as const,
    label: "Body, then face",
    hint: "click a body to take it, click it again for a face or edge",
  },
  { value: "faces" as const, label: "Faces" },
  { value: "bodies" as const, label: "Bodies" },
];
function pickSelectMode(m: SelectPolicy) {
  engine.handleAction(`selmode-${m}`);
}

const analysis = computed(() => {
  pulse.value;
  const vp = engine.viewport;
  return {
    zebra: vp.zebraOn,
    curvature: vp.combsOn,
    overhang: vp.analysis === "draft",
    colors: vp.analysis === "component",
  };
});
function runAndRefresh(action: string) {
  engine.handleAction(action);
  pulse.value++;
}

// The tier is read again on every prefs change, after the viewport has applied it.
const tier = ref(engine.viewport.renderTier);
const matcap = ref({ style: renderPrefs().matcapStyle, tint: renderPrefs().matcapTint });
const overlays = ref(savedOverlays());
const realtimeWhileMoving = ref(renderPrefs().realtimeWhileMoving);
const zebraOf = () => ({ direction: renderPrefs().zebraDirection, width: renderPrefs().zebraWidth });
const zebra = ref(zebraOf());
const zebraDirectionOptions: SegmentedOption<ZebraDirection>[] = [
  { value: "horizontal", label: "Horizontal" },
  { value: "vertical", label: "Vertical" },
];
const matcapOptions = MATCAP_STYLES.map((m) => ({
  value: m,
  tip: m,
  attrs: { class: "matcap-swatch", "data-matcap": m },
}));
const offTier = onRenderPrefsChange(() => {
  tier.value = engine.viewport.renderTier;
  matcap.value = { style: renderPrefs().matcapStyle, tint: renderPrefs().matcapTint };
  realtimeWhileMoving.value = renderPrefs().realtimeWhileMoving;
  zebra.value = zebraOf();
  overlays.value = savedOverlays();
});
onUnmounted(offTier);
onUnmounted(
  onWorkspaceChange(() => {
    overlays.value = savedOverlays();
  }),
);
const cleanKey = keyHint("clean-view");
const offTierChange = engine.viewport.onRenderTierChange(() => {
  tier.value = engine.viewport.renderTier;
});
onUnmounted(offTierChange);
const PAUSED_HINT: Record<string, string> = {
  "paused:section": "paused: section view",
  "paused:xray": "paused: x-ray",
  "paused:wireframe": "paused: wireframe",
  "paused:sketch": "paused: sketch open",
};
const viewModes = computed(() =>
  VIEW_MODES.map((v) => {
    const block = v.id === "pathtraced" ? pathTracedBlock(tier.value) : null;
    const hint = v.id === "pathtraced" ? PAUSED_HINT[ui.traceState] : undefined;
    const name = hint ? `${v.label} (Z), ${hint}` : `${v.label} (Z)`;
    const title = block ? block.tooltip : name;
    return { ...v, disabled: block !== null, softBlock: block?.reason === "perf", name, title };
  }),
);
const viewModeOptions = computed<SegmentedOption<ViewMode>[]>(() =>
  viewModes.value.map((v) => ({
    value: v.id,
    label: v.label,
    icon: v.icon,
    tip: v.name,
    disabled: v.disabled,
    disabledReason: v.title,
    clickable: v.softBlock,
    attrs: { "data-view-mode": v.id },
  })),
);
const viewModeChoices = computed(() =>
  viewModes.value.map((v) => ({
    value: v.id,
    label: v.label,
    disabled: v.disabled,
    clickable: v.softBlock,
    title: v.disabled ? v.title : undefined,
  })),
);
function pickViewMode(m: ViewMode) {
  const mode = viewModes.value.find((v) => v.id === m);
  if (mode?.disabled && !mode.softBlock) return;
  engine.handleAction(`viewmode-${m}`);
}

const errorCount = useBuildValue((b) => featureFailures({ ...b, featureErrors: b.result?.featureErrors }).size);

function enablePerformanceMode() {
  shell.closePopover();
  setRenderPref("performanceMode", true);
  toast("Performance mode is on, you can turn it off in Preferences");
}
function enablePotatoMode() {
  shell.closePopover();
  setRenderPref("potatoMode", true);
  toast("Potato mode is on, you can turn it off in Preferences");
}
function dismissPerformanceWarning() {
  shell.closePopover();
  ui.lowPerformanceDismissed = true;
}

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
  <div id="viewcontrols" ref="root" :class="{ scrolls, 'more-above': cue.above.value, 'more-below': cue.below.value }">
    <Toolbar
      ref="bar"
      class="float-column vc-scroll"
      label="View controls"
      orientation="vertical"
      @scroll.passive="cue.update()"
      @focusin="cue.reveal"
      @vue:updated="remeasure"
    >
      <div v-if="ui.lowPerformance && !ui.lowPerformanceDismissed" class="float-group perf-warn-group">
        <IconButton
          icon="warning"
          tip="Low performance"
          class="perf-warn"
          popup="dialog"
          :expanded="isOpen('perf')"
          :active="isOpen('perf')"
          @click="open('perf', $event)"
        />
      </div>
      <!-- On a narrow stage Items and History are drawers, and their switches
           go first, where a short column cannot scroll them out of sight. -->
      <div v-if="shell.narrow" class="float-group">
        <IconButton
          icon="items"
          tip="Items"
          :keys="chordsOf('items')"
          :active="shell.itemsShown"
          @click="shell.toggleItems()"
        />
        <IconButton
          icon="history"
          :tip="ui.sketchActive ? 'Sketch options' : 'History'"
          :keys="chordsOf('history')"
          :active="shell.historyShown"
          :badge="errorCount || null"
          @click="shell.toggleHistory()"
        />
      </div>
      <div class="float-group">
        <IconButton
          icon="magnet"
          tip="Snapping"
          popup="dialog"
          :expanded="isOpen('snap')"
          :active="isOpen('snap')"
          @click="open('snap', $event)"
        />
        <!-- A reading, not an icon, so a Button: its text is the name and the tip only the tooltip. -->
        <Button
          variant="ghost"
          size="sm"
          class="grid-btn"
          tip="Grid and units"
          popup="dialog"
          :expanded="isOpen('grid')"
          :pressed="isOpen('grid')"
          @click="open('grid', $event)"
          >{{ gridLabelCompact }}</Button
        >
        <IconButton
          icon="views"
          tip="Views"
          popup="dialog"
          :expanded="isOpen('views')"
          :active="isOpen('views')"
          @click="open('views', $event)"
        />
        <IconButton
          icon="view-reset"
          tip="Reset camera"
          keys="Shift+Home"
          @click="engine.handleAction('reset-camera')"
        />
      </div>
      <!-- Manual: arrowing onto Path traced must not start a trace, and no wrap lets the arrows go on along the column. -->
      <Segmented
        class="float-group view-modes"
        label="View mode"
        :options="viewModeOptions"
        :model-value="ui.viewMode"
        size="lg"
        variant="tile"
        icon-only
        orientation="vertical"
        activation="manual"
        :wrap="false"
        @update:model-value="pickViewMode"
      />
      <div class="float-group">
        <IconButton
          icon="shaded"
          tip="Display"
          popup="dialog"
          :expanded="isOpen('display')"
          :active="isOpen('display') || ui.xray || ui.wireframe"
          @click="open('display', $event)"
        />
        <IconButton icon="camera" tip="Screenshot" :active="saving" @click="screenshot()" />
        <IconButton
          icon="versions"
          tip="Versions"
          popup="dialog"
          :expanded="isOpen('versions')"
          :active="isOpen('versions')"
          @click="open('versions', $event)"
        />
        <IconButton
          v-if="!shell.narrow"
          icon="history"
          tip="History"
          :keys="chordsOf('history')"
          :active="shell.historyOpen"
          :badge="errorCount || null"
          @click="shell.toggleHistory()"
        />
      </div>
      <div v-if="dialogs.bugDeps" class="float-group">
        <IconButton icon="bug" tip="Report a problem" @click="dialogs.bugReport = true" />
      </div>

      <Popover
        v-if="isOpen('perf')"
        :anchor="anchorOf('perf')"
        side="left"
        kind="vc-pop perf-pop"
        label="Low performance"
        @close="shell.closePopover()"
      >
        <div class="perf-pop-title">Low performance</div>
        <p class="perf-pop-text">Detected stutters, your machine may have problems with displaying the models.</p>
        <p v-if="!isRenderLowPower()" class="perf-pop-text">
          Consider enabling
          <Button variant="ghost" size="sm" class="perf-pop-link" @click="enablePerformanceMode()"
            >performance mode</Button
          >
        </p>
        <p class="perf-pop-text" title="Lowest quality, for slow or virtual machines">
          {{ isRenderLowPower() ? "Performance mode is on, consider enabling" : "or, on a slow or virtual machine," }}
          <Button variant="ghost" size="sm" class="perf-pop-link" @click="enablePotatoMode()">potato mode</Button>
        </p>
        <Button variant="ghost" block class="vc-pop-btn" @click="dismissPerformanceWarning()">Dismiss</Button>
      </Popover>

      <Popover
        v-if="isOpen('versions')"
        :anchor="anchorOf('versions')"
        side="left"
        kind="vc-pop versions-pop"
        label="Versions"
        @close="shell.closePopover()"
      >
        <VersionsPanel />
      </Popover>

      <Popover
        v-if="isOpen('snap')"
        :anchor="anchorOf('snap')"
        side="left"
        kind="vc-pop"
        label="Snapping"
        @close="shell.closePopover()"
      >
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

      <Popover
        v-if="isOpen('grid')"
        :anchor="anchorOf('grid')"
        side="left"
        kind="vc-pop"
        label="Grid and units"
        @close="shell.closePopover()"
      >
        <div class="pop-section">Units</div>
        <ChoiceList label="Units" :options="UNITS" :model-value="unit" @update:model-value="pickUnit" />
        <div class="pop-rule"></div>
        <div class="pop-section">Grid</div>
        <p class="pop-note"
          >One square is {{ gridLabel }} at this zoom. Zoom in for a finer grid, and the move gizmo steps by a tenth of
          a square.</p
        >
      </Popover>

      <Popover
        v-if="isOpen('views')"
        :anchor="anchorOf('views')"
        side="left"
        kind="vc-pop"
        label="Views"
        @close="shell.closePopover()"
      >
        <Tabs
          v-model="viewTab"
          label="Views"
          :panels="viewPages"
          :tabs="[
            { value: 'views', label: 'Views' },
            { value: 'appearance', label: 'Appearance' },
          ]"
        />
        <TabPanel v-if="viewTab === 'views'" :panels="viewPages" value="views">
          <Button block class="vc-pop-btn" @click="engine.handleAction('iso')"
            ><template #icon><Icon name="view-iso" :size="16" /></template>Default View</Button
          >
          <Button variant="ghost" block class="vc-pop-btn" @click="engine.handleAction('fit')"
            ><template #icon><Icon name="view-fit" :size="16" /></template>Fit to Model</Button
          >
          <div class="pop-rule"></div>
          <ListRow v-for="v in VIEWS" :key="v.view" :label="v.label" @click="engine.viewport.setStandardView(v.view)"
            ><template #leading><Icon class="ui-list-row-icon" :name="`view-${v.view}`" :size="18" /></template
          ></ListRow>
        </TabPanel>
        <TabPanel v-else :panels="viewPages" value="appearance">
          <div class="pop-section">Projection</div>
          <ChoiceList
            label="Projection"
            :options="PROJECTIONS"
            :model-value="projection"
            @update:model-value="pickProjection"
          />
          <div class="pop-rule"></div>
          <div class="pop-section">Select</div>
          <ChoiceList
            label="Select mode"
            :options="SELECT_MODES"
            :model-value="ui.selMode"
            @update:model-value="pickSelectMode"
          />
        </TabPanel>
      </Popover>

      <Popover
        v-if="isOpen('display')"
        :anchor="anchorOf('display')"
        side="left"
        kind="vc-pop"
        label="Display"
        @close="shell.closePopover()"
      >
        <div class="pop-section">Shading</div>
        <ChoiceList
          label="Shading"
          :options="viewModeChoices"
          :model-value="ui.viewMode"
          @update:model-value="pickViewMode"
        />
        <template v-if="ui.viewMode === 'matcap'">
          <Segmented
            class="matcap-swatches"
            variant="chips"
            label="Matcap"
            icon-only
            :model-value="matcap.style"
            :options="matcapOptions"
            @update:model-value="setRenderPref('matcapStyle', $event)"
          >
            <template #option="{ option }"
              ><span class="matcap-ball" :style="{ backgroundImage: `url(${matcapSwatchUrl(option.value)})` }"></span
            ></template>
          </Segmented>
          <Toggle
            :model-value="matcap.tint"
            label="Tint with body colors"
            @update:model-value="setRenderPref('matcapTint', $event)"
          />
        </template>
        <Toggle
          v-if="ui.viewMode === 'pathtraced'"
          :model-value="realtimeWhileMoving"
          label="Realtime while moving"
          title="Off keeps the traced view up while the view moves, noisy until it rests"
          data-pt-moving
          @update:model-value="setRenderPref('realtimeWhileMoving', $event)"
        />
        <div class="pop-rule"></div>
        <div class="pop-section">Overlays</div>
        <Toggle
          :model-value="overlays.on"
          label="Show overlays"
          data-overlay="all"
          @update:model-value="setOverlaysOn($event)"
        />
        <Toggle
          v-for="k in OVERLAY_KINDS"
          :key="k"
          :model-value="overlays.kinds[k]"
          :label="OVERLAY_LABELS[k]"
          :disabled="!overlays.on"
          :data-overlay="k"
          @update:model-value="setOverlay(k, $event)"
        />
        <p class="pop-note">A running tool still shows its gizmo, and a hidden outline still selects its edge.</p>
        <Button
          variant="ghost"
          block
          class="vc-pop-btn"
          data-action="clean-view"
          @click="engine.handleAction('clean-view')"
          >{{ overlays.on ? "Clean view" : "Bring overlays back" }}
          <template v-if="cleanKey" #trailing
            ><span class="pop-key">{{ cleanKey }}</span></template
          ></Button
        >
        <div class="pop-rule"></div>
        <Toggle :model-value="ui.xray" label="X-Ray" @update:model-value="engine.handleAction('toggle-xray')" />
        <Toggle
          :model-value="ui.wireframe"
          label="Wireframe"
          @update:model-value="engine.handleAction('toggle-wireframe')"
        />
        <div class="pop-rule"></div>
        <div class="pop-section">Surface analysis</div>
        <Toggle :model-value="analysis.zebra" label="Zebra" @update:model-value="runAndRefresh('zebra')" />
        <div v-if="analysis.zebra" class="zebra-opts">
          <Segmented
            size="sm"
            label="Stripe direction"
            data-testid="zebra-direction"
            :options="zebraDirectionOptions"
            :model-value="zebra.direction"
            @update:model-value="setRenderPref('zebraDirection', $event)"
          />
          <Slider
            label="Stripe width"
            data-testid="zebra-width"
            :min="ZEBRA_WIDTH_MIN"
            :max="ZEBRA_WIDTH_MAX"
            :step="1"
            show-value
            :model-value="zebra.width"
            @update:model-value="setRenderPref('zebraWidth', $event)"
          />
        </div>
        <Toggle
          :model-value="analysis.curvature"
          label="Curvature combs"
          @update:model-value="runAndRefresh('curvature')"
        />
        <Toggle
          :model-value="analysis.overhang"
          label="Overhang"
          @update:model-value="runAndRefresh('draft-analysis')"
        />
        <Toggle
          :model-value="analysis.colors"
          label="Body colors"
          @update:model-value="runAndRefresh('component-colors')"
        />
      </Popover>
    </Toolbar>

    <IconButton
      v-if="cue.above.value"
      class="vc-more vc-more-up"
      icon="caretDown"
      tip="More view controls above"
      size="md"
      tabindex="-1"
      @click="cue.page(-1)"
    />
    <IconButton
      v-if="cue.below.value"
      class="vc-more vc-more-down"
      icon="caretDown"
      tip="More view controls below"
      size="md"
      tabindex="-1"
      @click="cue.page(1)"
    />
  </div>
</template>
