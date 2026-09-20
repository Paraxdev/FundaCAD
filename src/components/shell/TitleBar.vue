<script setup lang="ts">
import { markRaw, ref, onMounted, onUnmounted } from "vue";
import { useEngine } from "../../app/engineKey";
import { useUiStore } from "../../stores/ui";
import { buildMenubar } from "../../app/menubarDef";
import { onContribChange } from "../../plugins/contrib";
import Icon from "./Icon.vue";
import WorkspaceToggle from "./WorkspaceToggle.vue";
import MenuBar from "./MenuBar.vue";
import LiveSessionPill from "./LiveSessionPill.vue";
import ErrorNotice from "./ErrorNotice.vue";
import { getTheme, onThemeChange, themeMode } from "../../ui/theme";
import brandLockupDark from "../../../assets/brand/fundacad-lockup-app.svg";
import brandLockupLight from "../../../assets/brand/fundacad-lockup-app-light.svg";

const engine = useEngine();
const ui = useUiStore();

// The wordmark is baked as light-on-dark text (fundacad-lockup-app.svg): fine
// for FundaCAD Noir and Dracula, invisible against a light theme's panel. An
// <img> can't repaint from CSS across the SVG boundary, so the fix is a second
// asset with dark-text ink, picked from the theme's mode.
const brandLockup = ref(themeMode(getTheme()) === "light" ? brandLockupLight : brandLockupDark);

// Rebuilt only when what the plugins contribute changes. Everything dynamic
// WITHIN the tree (Undo greying out, a capability's own mode checkmarks) is a
// thunk MenuBar re-evaluates each time a menu opens, so this does not need to be
// reactive for those. What a thunk cannot express is a row that should not exist
// at all, and a menu left with no rows.
//
// The CONTRIBUTIONS, not the on/off state. Those are different moments and the
// difference is visible: a capability is switched on, and only some
// milliseconds later, after its module has been fetched and its activate() has
// run, does it have rows to add. Watching the switch rebuilt the menu while the
// capability that owns the rows was still loading, so the menubar was always one
// step behind, showing the last capability's rows and not this one's. Watching
// what was actually contributed cannot be early.
//
// markRaw because every onClick closes over the raw engine.
const menus = ref(markRaw(buildMenubar(engine)));
let offPlugins: (() => void) | null = null;
let offTheme: (() => void) | null = null;
onMounted(() => {
  offPlugins = onContribChange(() => { menus.value = markRaw(buildMenubar(engine)); });
  offTheme = onThemeChange(() => {
    brandLockup.value = themeMode(getTheme()) === "light" ? brandLockupLight : brandLockupDark;
  });
});
onUnmounted(() => { offPlugins?.(); offTheme?.(); });

</script>

<template>
  <header id="titlebar">
    <span class="brand"><img :src="brandLockup" alt="FundaCAD" /></span>
    <MenuBar :menus="menus" />
    <button
      id="undo-btn"
      class="tb-btn"
      title="Undo (Ctrl+Z)"
      :disabled="!ui.canUndo"
      @click="engine.doUndo()"
    ><Icon name="undo" :size="15" /></button>
    <button
      id="redo-btn"
      class="tb-btn"
      title="Redo (Ctrl+Y)"
      :disabled="!ui.canRedo"
      @click="engine.doRedo()"
    ><Icon name="redo" :size="15" /></button>
    <span id="context-tab" class="context-tab" :class="{ sketch: ui.sketchActive }">
      {{ ui.sketchActive ? "SKETCH" : "SOLID" }}
    </span>
    <span id="docname" class="docname" :class="{ dirty: ui.dirty }">
      <!-- After the name, never before it: a prefix moved the whole filename
           sideways the instant the document went dirty. -->
      {{ ui.docName }}<span v-if="ui.dirty" class="dirty-mark" title="Unsaved changes">*</span>
    </span>
    <!-- Beside the document name, because what it is saying is about THIS
         document: someone else is in it. It renders nothing at all unless an
         assistant is actually attached. -->
    <LiveSessionPill />
    <ErrorNotice />
    <WorkspaceToggle />
  </header>
</template>
