<script setup lang="ts">
import { fmtKeys } from "../../input/platform";
import { markRaw, ref, onMounted, onUnmounted } from "vue";
import { useEngine } from "../../app/engineKey";
import { useUiStore } from "../../stores/ui";
import { useHomeStore } from "../../stores/home";
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
const home = useHomeStore();

// The wordmark SVG is light on dark and an <img> cannot be recoloured from CSS, so light themes get a dark-ink asset.
const brandLockup = ref(themeMode(getTheme()) === "light" ? brandLockupLight : brandLockupDark);

// Rebuilt on what plugins contribute, not on the switch: rows arrive only after activate() runs, so the switch left the
// menu one step behind. In-menu state is thunks MenuBar re-runs on open. markRaw since onClick closes over the engine.
const menus = ref(markRaw(buildMenubar(engine)));
let offPlugins: (() => void) | null = null;
let offTheme: (() => void) | null = null;
onMounted(() => {
  offPlugins = onContribChange(() => {
    menus.value = markRaw(buildMenubar(engine));
  });
  offTheme = onThemeChange(() => {
    brandLockup.value = themeMode(getTheme()) === "light" ? brandLockupLight : brandLockupDark;
  });
});
onUnmounted(() => {
  offPlugins?.();
  offTheme?.();
});
</script>

<template>
  <header id="titlebar" :class="{ 'home-up': home.shown }">
    <span class="brand" :inert="home.shown"><img :src="brandLockup" alt="FundaCAD" /></span>
    <button
      id="home-btn"
      class="tb-btn"
      :class="{ active: home.shown }"
      title="Home"
      aria-label="Home"
      :aria-pressed="home.shown"
      @click="engine.ui.home.toggle()"
      ><Icon name="home" :size="15"
    /></button>
    <!-- display: contents, so the bar's flex row and its narrow window rules see the controls as before. -->
    <div class="tb-rest" :inert="home.shown">
      <MenuBar :menus="menus" />
      <button
        id="undo-btn"
        class="tb-btn"
        :title="fmtKeys('Undo (Ctrl+Z)')"
        aria-label="Undo"
        :disabled="!ui.canUndo"
        @click="engine.doUndo()"
        ><Icon name="undo" :size="15"
      /></button>
      <button
        id="redo-btn"
        class="tb-btn"
        :title="fmtKeys('Redo (Ctrl+Y)')"
        aria-label="Redo"
        :disabled="!ui.canRedo"
        @click="engine.doRedo()"
        ><Icon name="redo" :size="15"
      /></button>
      <span id="context-tab" class="context-tab" :class="{ sketch: ui.sketchActive }">
        {{ ui.sketchActive ? "SKETCH" : "SOLID" }}
      </span>
      <span id="docname" class="docname" :class="{ dirty: ui.dirty }">
        <!-- After the name, never before: a prefix moved the filename sideways when the document went dirty. -->
        {{ ui.docName }}<span v-if="ui.dirty" class="dirty-mark" title="Unsaved changes">*</span>
      </span>
      <!-- Beside the name because it is about this document, renders nothing unless an assistant is attached. -->
      <LiveSessionPill />
      <ErrorNotice />
      <WorkspaceToggle />
    </div>
  </header>
</template>
