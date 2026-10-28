<script setup lang="ts">
import { markRaw, ref, onMounted, onUnmounted } from "vue";
import { useEngine } from "../../app/engineKey";
import { useUiStore } from "../../stores/ui";
import { useHomeStore } from "../../stores/home";
import { buildMenubar } from "../../app/menubarDef";
import { onContribChange } from "../../plugins/contrib";
import IconButton from "../ui/IconButton.vue";
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
    <IconButton
      id="home-btn"
      icon="home"
      tip="Home"
      size="sm"
      variant="plain"
      :icon-size="15"
      :active="home.shown"
      @click="engine.ui.home.toggle()"
    />
    <!-- display: contents, so the bar's flex row and its narrow window rules see the controls as before. -->
    <div class="tb-rest" :inert="home.shown">
      <MenuBar :menus="menus" />
      <!-- The name leaves the keys out, they are in the tooltip and a screen reader need not say them. -->
      <IconButton
        id="undo-btn"
        icon="undo"
        tip="Undo"
        keys="Ctrl+Z"
        aria-label="Undo"
        size="sm"
        variant="plain"
        :icon-size="15"
        :disabled="!ui.canUndo"
        @click="engine.doUndo()"
      />
      <IconButton
        id="redo-btn"
        icon="redo"
        tip="Redo"
        keys="Ctrl+Y"
        aria-label="Redo"
        size="sm"
        variant="plain"
        :icon-size="15"
        :disabled="!ui.canRedo"
        @click="engine.doRedo()"
      />
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
