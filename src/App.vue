<script setup lang="ts">
import TitleBar from "./components/shell/TitleBar.vue";
import SafeModeBanner from "./components/shell/SafeModeBanner.vue";
import ViewportPane from "./components/shell/ViewportPane.vue";
import RenderDock from "./components/shell/RenderDock.vue";
import ToastStack from "./components/overlays/ToastStack.vue";
import GuideLayer from "./components/overlays/GuideLayer.vue";
import ModalHost from "./components/overlays/ModalHost.vue";
import ShortcutsDialog from "./components/overlays/ShortcutsDialog.vue";
import ContextMenuHost from "./components/overlays/ContextMenuHost.vue";
import RadialMenuHost from "./components/overlays/RadialMenuHost.vue";
import TargetEditPanel from "./components/overlays/TargetEditPanel.vue";
import ConsolePanel from "./components/overlays/ConsolePanel.vue";
import AreaFilterChip from "./components/overlays/AreaFilterChip.vue";
import DropHint from "./components/overlays/DropHint.vue";
import CommandPalette from "./components/overlays/CommandPalette.vue";
import ToolRail from "./components/shell/ToolRail.vue";
import TimelineBar from "./components/shell/TimelineBar.vue";
import BrowserPane from "./components/shell/BrowserPane.vue";
import ViewportControls from "./components/shell/ViewportControls.vue";
import SketchPalette from "./components/shell/SketchPalette.vue";
import { useShellStore } from "./stores/shell";
import { useUiStore } from "./stores/ui";
import PropertiesPanel from "./components/overlays/PropertiesPanel.vue";
import InterferencePanel from "./components/overlays/InterferencePanel.vue";
import StressPanel from "./components/overlays/StressPanel.vue";
import OverhangPanel from "./components/overlays/OverhangPanel.vue";
import ParamsDialog from "./components/overlays/ParamsDialog.vue";
import PreferencesDialog from "./components/overlays/PreferencesDialog.vue";
import ExportDialog from "./components/overlays/ExportDialog.vue";
import BugReportDialog from "./components/overlays/BugReportDialog.vue";
import SketchDimLayer from "./components/overlays/SketchDimLayer.vue";
import SketchGlyphLayer from "./components/overlays/SketchGlyphLayer.vue";
import TextToolPanel from "./components/overlays/TextToolPanel.vue";
import MirrorToolPanel from "./components/overlays/MirrorToolPanel.vue";
import FilletMembers from "./components/overlays/FilletMembers.vue";
import ProjectFilterBar from "./components/overlays/ProjectFilterBar.vue";
import MeasureReadout from "./components/overlays/MeasureReadout.vue";
import { onMounted, onUnmounted, ref, shallowRef, useTemplateRef, watch } from "vue";
import { useEngine } from "./app/engineKey";
import { isNarrowStage } from "./ui/layoutBreakpoints";
import { useDialogStore } from "./stores/dialogs";
import { useHomeStore } from "./stores/home";
import HomeScreen from "./components/home/HomeScreen.vue";
import { useExportDialogStore } from "./stores/exportDialog";
import { useToolPanelStore } from "./stores/toolPanels";
import { contributedOverlays, onContribChange } from "./plugins/contrib";

const dialogs = useDialogStore();
const home = useHomeStore();
const exportDialog = useExportDialogStore();
const toolPanels = useToolPanelStore();
const shell = useShellStore();
const ui = useUiStore();
const engine = useEngine();
// Unmounted while the overlay is off, so their reprojection loops stop with it.
const sketchLabelsShown = ref(engine.viewport.overlayDrawn("sketchLabels"));
onUnmounted(
  engine.viewport.watchOverlays(() => {
    sketchLabelsShown.value = engine.viewport.overlayDrawn("sketchLabels");
  }),
);

// Plugin overlays decide their own visibility. The registry is Vue free for the headless suite, so this mirrors it;
// shallowRef because component definitions must not become reactive proxies.
const overlays = shallowRef(contributedOverlays());
let offContrib: (() => void) | null = null;
onMounted(() => {
  offContrib = onContribChange(() => {
    overlays.value = contributedOverlays();
  });
});
onUnmounted(() => offContrib?.());

const stage = useTemplateRef<HTMLElement>("stage");
let stageRo: ResizeObserver | null = null;
onMounted(() => {
  if (!stage.value || typeof ResizeObserver === "undefined") return;
  stageRo = new ResizeObserver(([entry]) => {
    if (entry) shell.setNarrow(isNarrowStage(entry.contentRect.width));
  });
  stageRo.observe(stage.value);
});
onUnmounted(() => stageRo?.disconnect());
// A drawer left open over the rail would hide the tools the new mode brings.
watch(
  () => ui.sketchActive,
  () => shell.closeDrawer(),
);
</script>

<template>
  <!-- src/styles/_layout.scss and the e2e suite select on these element ids and class names. -->
  <TitleBar />
  <SafeModeBanner />
  <div id="main">
    <!-- The float layer takes no pointer events, only its cards do, so the model stays pickable between them. -->
    <div id="stage" ref="stage" :class="{ narrow: shell.narrow }">
      <!-- Inert under Home, so Tab and screen readers stay on what is on screen. -->
      <ViewportPane :inert="home.shown" />
      <div id="float-layer" :inert="home.shown">
        <div class="float-left">
          <div class="float-left-stack">
            <BrowserPane v-if="shell.itemsShown" />
            <FilletMembers />
            <TargetEditPanel />
          </div>
          <ToolRail />
        </div>
        <div class="float-right">
          <ViewportControls />
          <SketchPalette v-if="ui.sketchActive && (!shell.narrow || shell.historyShown)" />
          <TimelineBar v-else-if="!ui.sketchActive && shell.historyShown" />
        </div>
      </div>
      <!-- Covers the canvas rather than hiding it, so the viewport keeps its size. -->
      <HomeScreen v-if="home.shown" />
    </div>
    <!-- Mounts nothing outside the Render workspace, so the grid track collapses. -->
    <RenderDock />
  </div>

  <!-- Each Teleports to body, so none inherits a stacking context from #app's grid. -->
  <ToastStack />
  <ModalHost />
  <GuideLayer />
  <ContextMenuHost />
  <RadialMenuHost />
  <ConsolePanel />
  <AreaFilterChip />
  <DropHint />
  <CommandPalette />

  <!-- Independent popups: Properties and the Overhang settings can be on screen together. -->
  <PropertiesPanel />
  <InterferencePanel />
  <StressPanel />
  <OverhangPanel />
  <ParamsDialog />
  <MeasureReadout />

  <!-- Tool panels are keyed, so reopening a tool remounts fresh form state with no reset path. -->
  <SketchDimLayer v-if="sketchLabelsShown" />
  <SketchGlyphLayer v-if="sketchLabelsShown" />
  <TextToolPanel v-if="toolPanels.text" :key="toolPanels.text.id" :req="toolPanels.text" />
  <MirrorToolPanel v-if="toolPanels.mirror" :key="toolPanels.mirror.id" :view="toolPanels.mirror" />
  <ProjectFilterBar v-if="toolPanels.projectAnchor" />

  <!-- v-if, not an open prop: mount is open, so useModalGate.ts can count modal depth in mount hooks without leaks. -->
  <PreferencesDialog v-if="dialogs.preferences" />
  <ShortcutsDialog v-if="dialogs.shortcuts" />
  <ExportDialog v-if="exportDialog.request" />
  <BugReportDialog v-if="dialogs.bugReport && dialogs.bugDeps" />

  <!-- Plugin overlays last, so they open above the app's own, keyed so turning one off unmounts exactly its parts. -->
  <component :is="o.component" v-for="o in overlays" :key="o.key" />
</template>
