<script setup lang="ts">
import TitleBar from "./components/shell/TitleBar.vue";
import ViewportPane from "./components/shell/ViewportPane.vue";
import RenderDock from "./components/shell/RenderDock.vue";
import ToastStack from "./components/overlays/ToastStack.vue";
import ModalHost from "./components/overlays/ModalHost.vue";
import ShortcutHud from "./components/overlays/ShortcutHud.vue";
import ContextMenuHost from "./components/overlays/ContextMenuHost.vue";
import TargetEditPanel from "./components/overlays/TargetEditPanel.vue";
import ConsolePanel from "./components/overlays/ConsolePanel.vue";
import AreaFilterChip from "./components/overlays/AreaFilterChip.vue";
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
import OverhangPanel from "./components/overlays/OverhangPanel.vue";
import ParamsDialog from "./components/overlays/ParamsDialog.vue";
import WelcomeModal from "./components/overlays/WelcomeModal.vue";
import PreferencesDialog from "./components/overlays/PreferencesDialog.vue";
import ExportDialog from "./components/overlays/ExportDialog.vue";
import BugReportDialog from "./components/overlays/BugReportDialog.vue";
import SketchDimLayer from "./components/overlays/SketchDimLayer.vue";
import SketchGlyphLayer from "./components/overlays/SketchGlyphLayer.vue";
import TextToolPanel from "./components/overlays/TextToolPanel.vue";
import FilletMembers from "./components/overlays/FilletMembers.vue";
import ProjectFilterBar from "./components/overlays/ProjectFilterBar.vue";
import MeasureReadout from "./components/overlays/MeasureReadout.vue";
import { onMounted, onUnmounted, shallowRef, useTemplateRef, watch } from "vue";
import { isNarrowStage } from "./ui/layoutBreakpoints";
import { useDialogStore } from "./stores/dialogs";
import { useExportDialogStore } from "./stores/exportDialog";
import { useToolPanelStore } from "./stores/toolPanels";
import { contributedOverlays, onContribChange } from "./plugins/contrib";

const dialogs = useDialogStore();
const exportDialog = useExportDialogStore();
const toolPanels = useToolPanelStore();
const shell = useShellStore();
const ui = useUiStore();

// The overlays the running plugins add, mounted at the end of the stack.
//
// This file used to name four of them, each a capability's own window, and
// carry three
// mirrored capability flags to decide which to draw. That was the app knowing
// what its capabilities ARE, spelled out in the one file that should be able to
// say least about them, and it was four more edits for anybody adding a fifth.
//
// Now it draws what it was given and asks nothing about any of it. A component
// arrives already knowing when it should be visible, because the plugin that
// contributed it is the only thing that could know; a plugin that is off
// contributed nothing and there is nothing to hide. `shallowRef`, because these
// are component definitions and must not become reactive proxies.
//
// The registry is deliberately Vue-free, which is what lets the headless suite
// import it, so its changes reach the template through this mirror.
const overlays = shallowRef(contributedOverlays());
let offContrib: (() => void) | null = null;
onMounted(() => {
  offContrib = onContribChange(() => { overlays.value = contributedOverlays(); });
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
watch(() => ui.sketchActive, () => shell.closeDrawer());
</script>

<template>
  <!-- The application shell, formerly the static markup inside <div id="app">
       in index.html. Element ids and class names are unchanged: every layout
       rule in src/styles/_layout.scss is id-scoped to these, and the e2e suite
       selects on them. -->
  <TitleBar />
  <div id="main">
    <!-- The viewport fills the stage and everything else floats over it. The
         float layer takes no pointer events itself, only its cards do, so the
         model can be picked through every gap between them. -->
    <div id="stage" ref="stage" :class="{ narrow: shell.narrow }">
      <ViewportPane />
      <div id="float-layer">
        <div class="float-left">
          <!-- Items on top, the blend's edge list docked under it (shrinking
               Items while a fillet/chamfer is being edited), the rail beside. -->
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
    </div>
    <!-- Present only in the Render workspace; it mounts nothing in the other
         one, so the grid track collapses. -->
    <RenderDock />
  </div>

  <!-- Global overlays. Each Teleports to body, which is where the imperative
       versions appended themselves, they must not inherit a stacking context
       from #app's grid. -->
  <ToastStack />
  <ModalHost />
  <ShortcutHud />
  <ContextMenuHost />
  <ConsolePanel />
  <AreaFilterChip />
  <CommandPalette />

  <!-- Floating "measure-panel" popups. Independent of one another: Properties
       and the Overhang settings are legitimately on screen together. -->
  <PropertiesPanel />
  <InterferencePanel />
  <OverhangPanel />
  <ParamsDialog />
  <MeasureReadout />

  <!-- In-canvas overlays, driven entirely by imperative tool code through the
       facades in sketch/ and features/. The two annotation LAYERS are always
       mounted (they render nothing until a sketch is open) because each owns a
       rAF reprojection loop it starts and stops itself; the three tool PANELS
       are v-if'd and keyed, so reopening a tool remounts one with fresh form
       state instead of needing a reset path. -->
  <SketchDimLayer />
  <SketchGlyphLayer />
  <TextToolPanel v-if="toolPanels.text" :key="toolPanels.text.id" :req="toolPanels.text" />
  <ProjectFilterBar v-if="toolPanels.projectAnchor" />

  <!-- Modal dialogs. v-if rather than an `open` prop on purpose: mount IS open
       and unmount IS closed, which is what lets the ones that gate global
       shortcuts push/pop the modal depth in onMounted/onUnmounted and never
       leak a count (composables/useModalGate.ts). They are independent because
       they genuinely stack, the welcome screen opens sign-in over itself. -->
  <WelcomeModal v-if="dialogs.welcome && dialogs.welcomeCallbacks" />
  <PreferencesDialog v-if="dialogs.preferences" />
  <ExportDialog v-if="exportDialog.request" />
  <BugReportDialog v-if="dialogs.bugReport && dialogs.bugDeps" />

  <!-- Whatever the running plugins add. Last, so a capability's window opens
       over the app's own rather than under it, and keyed by contributor so
       switching one off unmounts exactly its components. -->
  <component :is="o.component" v-for="o in overlays" :key="o.key" />
</template>
