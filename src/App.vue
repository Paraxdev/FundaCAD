<script setup lang="ts">
import TitleBar from "./components/shell/TitleBar.vue";
import ViewportPane from "./components/shell/ViewportPane.vue";
import ToastStack from "./components/overlays/ToastStack.vue";
import ModalHost from "./components/overlays/ModalHost.vue";
import PrintStatusPill from "./components/overlays/PrintStatusPill.vue";
import ShortcutHud from "./components/overlays/ShortcutHud.vue";
import ContextMenuHost from "./components/overlays/ContextMenuHost.vue";
import TargetEditPanel from "./components/overlays/TargetEditPanel.vue";
import ConsolePanel from "./components/overlays/ConsolePanel.vue";
import SelectionToolbar from "./components/overlays/SelectionToolbar.vue";
import CommandPalette from "./components/overlays/CommandPalette.vue";
import RibbonBar from "./components/shell/RibbonBar.vue";
import TimelineBar from "./components/shell/TimelineBar.vue";
import BrowserPane from "./components/shell/BrowserPane.vue";
import PropertiesPanel from "./components/overlays/PropertiesPanel.vue";
import InterferencePanel from "./components/overlays/InterferencePanel.vue";
import OverhangPanel from "./components/overlays/OverhangPanel.vue";
import CameraPanel from "./components/overlays/CameraPanel.vue";
import ParamsDialog from "./components/overlays/ParamsDialog.vue";
import WelcomeModal from "./components/overlays/WelcomeModal.vue";
import SpaceMouseModal from "./components/overlays/SpaceMouseModal.vue";
import PreferencesDialog from "./components/overlays/PreferencesDialog.vue";
import BugReportButton from "./components/overlays/BugReportButton.vue";
import BugReportDialog from "./components/overlays/BugReportDialog.vue";
import FilamentMappingDialog from "./components/overlays/FilamentMappingDialog.vue";
import SketchDimLayer from "./components/overlays/SketchDimLayer.vue";
import SketchGlyphLayer from "./components/overlays/SketchGlyphLayer.vue";
import TextToolPanel from "./components/overlays/TextToolPanel.vue";
import ProjectFilterBar from "./components/overlays/ProjectFilterBar.vue";
import TextureToolPanel from "./components/overlays/TextureToolPanel.vue";
import MeasureReadout from "./components/overlays/MeasureReadout.vue";
import { useDialogStore } from "./stores/dialogs";
import { useToolPanelStore } from "./stores/toolPanels";

const dialogs = useDialogStore();
const toolPanels = useToolPanelStore();
</script>

<template>
  <!-- The application shell, formerly the static markup inside <div id="app">
       in index.html. Element ids and class names are unchanged: every layout
       rule in src/styles/_layout.scss is id-scoped to these, and the e2e suite
       selects on them. -->
  <TitleBar />
  <RibbonBar />
  <!-- Two columns: what is in the document, and the document. The tool rail
       that used to stand left of the browser is gone — it was a second copy of
       the ribbon's tools one column away from the ribbon itself, so whichever
       of the two you reached for, the other was redundant chrome eating picking
       width. The ribbon carries every tool, on the top edge or the left one.

       The Parameters inspector that used to close the row on the right is gone
       too: a feature's values now live under its own entry in the history,
       where the thing being changed is already named. Document parameters are
       Modify > Parameters, which is where they could always be added and
       renamed. -->
  <div id="main">
    <BrowserPane />
    <ViewportPane />
  </div>
  <TimelineBar />

  <!-- Global overlays. Each Teleports to body, which is where the imperative
       versions appended themselves — they must not inherit a stacking context
       from #app's grid. -->
  <ToastStack />
  <ModalHost />
  <PrintStatusPill />
  <ShortcutHud />
  <ContextMenuHost />
  <ConsolePanel />
  <TargetEditPanel />
  <SelectionToolbar />
  <CommandPalette />

  <!-- Floating "measure-panel" popups. Independent of one another: Properties
       and the Overhang settings are legitimately on screen together. -->
  <PropertiesPanel />
  <InterferencePanel />
  <OverhangPanel />
  <CameraPanel />
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
  <TextureToolPanel v-if="toolPanels.texture" :key="toolPanels.texture.id" :req="toolPanels.texture" />

  <!-- Modal dialogs. v-if rather than an `open` prop on purpose: mount IS open
       and unmount IS closed, which is what lets the ones that gate global
       shortcuts push/pop the modal depth in onMounted/onUnmounted and never
       leak a count (composables/useModalGate.ts). They are independent because
       they genuinely stack — the welcome screen opens sign-in over itself. -->
  <WelcomeModal v-if="dialogs.welcome && dialogs.welcomeCallbacks" />
  <SpaceMouseModal v-if="dialogs.spaceMouse" />
  <PreferencesDialog v-if="dialogs.preferences" />
  <FilamentMappingDialog v-if="dialogs.filament" :req="dialogs.filament" />
  <BugReportButton />
  <BugReportDialog v-if="dialogs.bugReport && dialogs.bugDeps" />
</template>
