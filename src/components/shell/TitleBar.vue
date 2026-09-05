<script setup lang="ts">
import { toggleConsole } from "../../ui/logStore";
import { markRaw, ref, onMounted, onUnmounted } from "vue";
import { useEngine } from "../../app/engineKey";
import { useUiStore } from "../../stores/ui";
import { getUnit, setUnit, asUnit, onUnitChange, type Unit } from "../../ui/units";
import { THEMES, getTheme, setTheme, asThemeId, onThemeChange } from "../../ui/theme";
import { iconPacks, getIconPack, setIconPack, asIconPackId, onIconPackChange } from "../../ui/icons";
import { buildMenubar } from "../../app/menubarDef";
import Icon from "./Icon.vue";
import MenuBar from "./MenuBar.vue";
import LiveSessionPill from "./LiveSessionPill.vue";
import brandLockup from "../../../assets/brand/fundacad-lockup-app.svg";

const engine = useEngine();
const ui = useUiStore();

// Built once. The tree is static; everything dynamic about it (Undo greying
// out, the SpaceMouse mode checkmarks, Sign in/out) is a thunk that MenuBar
// re-evaluates each time a menu opens. markRaw because every onClick closes
// over the raw engine.
const menus = markRaw(buildMenubar(engine));

// units.ts is a module-level observable with its own listener set and a
// localStorage backing. Rather than move that state into Pinia (it is read
// synchronously at draw time by the viewport, eight feature tools and the
// sketch dimension labels, none of which are Vue), mirror it into a ref.
const unit = ref<Unit>(getUnit());
let offUnit: (() => void) | null = null;
onMounted(() => { offUnit = onUnitChange(() => { unit.value = getUnit(); }); });
onUnmounted(() => offUnit?.());

function onUnitInput(ev: Event) {
  // asUnit is a mandatory narrowing gate, not a formality — see units.ts:15-22.
  const u = asUnit((ev.target as HTMLSelectElement).value);
  if (u) setUnit(u);
}

// Theme and icon pack are the same shape of setting as units — a module-level
// observable with a listener set and localStorage behind it — so they are
// mirrored the same way rather than through Pinia. The viewport reads the theme
// synchronously while painting manipulators, which is the same reason units is
// not in the store.
const theme = ref(getTheme());
const pack = ref(getIconPack());
let offTheme: (() => void) | null = null;
let offPack: (() => void) | null = null;
onMounted(() => {
  offTheme = onThemeChange(() => { theme.value = getTheme(); });
  offPack = onIconPackChange(() => { pack.value = getIconPack(); });
});
onUnmounted(() => { offTheme?.(); offPack?.(); });

function onThemeInput(ev: Event) {
  const id = asThemeId((ev.target as HTMLSelectElement).value);
  if (id) setTheme(id);
}
function onPackInput(ev: Event) {
  const id = asIconPackId((ev.target as HTMLSelectElement).value);
  if (id) setIconPack(id);
}
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
      <!-- The unsaved mark is an ICON in its own slot, not a character glued
           to the front of the name: as a prefix it moved the whole filename
           sideways the instant the document went dirty, which is a jump the eye
           reads as the name having changed. -->
      <Icon v-if="ui.dirty" name="dot" :size="8" class="dirty-dot" />{{ ui.docName }}
    </span>
    <!-- Beside the document name, because what it is saying is about THIS
         document: someone else is in it. It renders nothing at all unless an
         assistant is actually attached. -->
    <LiveSessionPill />
    <div class="spacer"></div>
    <label class="units" title="Display units (geometry is stored in mm)">
      Units
      <select id="unit" :value="unit" @change="onUnitInput">
        <option value="mm">mm</option>
        <option value="cm">cm</option>
        <option value="in">in</option>
      </select>
    </label>
    <label class="units" title="Colour theme">
      Theme
      <select id="theme" :value="theme" @change="onThemeInput">
        <option v-for="t in THEMES" :key="t.id" :value="t.id">{{ t.label }}</option>
      </select>
    </label>
    <label class="units" title="Icon set">
      Icons
      <select id="iconpack" :value="pack" @change="onPackInput">
        <option v-for="p in iconPacks()" :key="p.id" :value="p.id">{{ p.label }}</option>
      </select>
    </label>
    <!-- A button, not a span, because this is where a failure is first seen and
         it is the one place in the app guaranteed to be showing a CLIPPED
         version of it — the pill is narrow and the sentence is long, so the
         tail that says what to do is exactly what gets cut. Clicking opens the
         console, which keeps it whole. -->
    <button
      id="status"
      type="button"
      class="status"
      :class="ui.statusClass"
      :title="ui.statusText + ', click for the full text'"
      @click="toggleConsole()"
    >{{ ui.statusText }}</button>
  </header>
</template>
