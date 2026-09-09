<script setup lang="ts">
// Preferences: one surface for the settings that were scattered across the
// title bar (theme, icons, units) plus the shell arrangement, which had no
// surface at all.
//
// A surface over the existing setting modules, NOT a store of its own. Every
// value here already persists itself and already notifies its own subscribers,
// ui/theme.ts, ui/icons.ts, ui/units.ts, ui/layoutPrefs.ts, so this component
// holds only the mirror it renders from, and every change is applied live.
// Copying them into local state and writing back on "OK" would put a second
// copy of each setting in the app, and the title bar's selects read the first.
//
// The mirrors are refs re-read from each module's own subscription rather than
// bound with v-model, because those modules are deliberately Vue-free (that is
// what lets the headless suite import them) and so nothing tracks them.

import { onMounted, onUnmounted, ref, shallowRef } from "vue";
import { contributedSettings, onContribChange } from "../../plugins/contrib";
import { useDialogStore } from "../../stores/dialogs";
import { useModalGate } from "../../composables/useModalGate";
import ModalFrame from "./ModalFrame.vue";
import PluginsSection from "./PluginsSection.vue";
import { THEMES, asThemeId, getTheme, onThemeChange, setTheme } from "../../ui/theme";
import { asIconPackId, getIconPack, iconPacks, onIconPackChange, setIconPack } from "../../ui/icons";
import { asUnit, getUnit, onUnitChange, setUnit } from "../../ui/units";
import {
  asHistorySide,
  asRibbonSide,
  layoutPrefs,
  onLayoutPrefsChange,
  setLayoutPref,
} from "../../ui/layoutPrefs";
import {
  asBackground,
  asEnvironment,
  MAX_BRIGHTNESS,
  MIN_BRIGHTNESS,
  onRenderPrefsChange,
  renderPrefs,
  setRenderPref,
} from "../../ui/renderPrefs";

const dialogs = useDialogStore();
const close = () => { dialogs.preferences = false; };

// Unlike the 3D-mouse dialog, this one DOES gate global shortcuts: it is full of
// text-sized targets and single-letter tool keys would fire underneath it.
useModalGate();

const theme = ref(getTheme());
const pack = ref(getIconPack());
const unit = ref(getUnit());
const layout = ref(layoutPrefs());
const render = ref(renderPrefs());

// The blocks the running plugins add. An "Assistants" block used to be written
// out below, configuring what an assistant connected over MCP may do to the
// open document, a question that decides nothing when no such plugin is
// installed, and a control that decides nothing is worse than a missing one.
// It is contributed now, by the plugin it is about.
const sections = shallowRef(contributedSettings());

const stops: (() => void)[] = [];
onMounted(() => {
  stops.push(
    onThemeChange(() => { theme.value = getTheme(); }),
    onIconPackChange(() => { pack.value = getIconPack(); }),
    onUnitChange(() => { unit.value = getUnit(); }),
    onLayoutPrefsChange(() => { layout.value = layoutPrefs(); }),
    onRenderPrefsChange(() => { render.value = renderPrefs(); }),
    onContribChange(() => { sections.value = contributedSettings(); }),
  );
});
onUnmounted(() => { for (const stop of stops) stop(); });

const value = (ev: Event) => (ev.target as HTMLSelectElement).value;

// Every write goes through the module's own gate, so an <option> that no longer
// matches anything is refused at the same place a corrupt stored value is.
function onTheme(ev: Event) { const v = asThemeId(value(ev)); if (v) setTheme(v); }
function onPack(ev: Event) { const v = asIconPackId(value(ev)); if (v) setIconPack(v); }
function onUnit(ev: Event) { const v = asUnit(value(ev)); if (v) setUnit(v); }
function onRibbon(ev: Event) { const v = asRibbonSide(value(ev)); if (v) setLayoutPref("ribbon", v); }
function onHistory(ev: Event) { const v = asHistorySide(value(ev)); if (v) setLayoutPref("history", v); }
function onEnvironment(ev: Event) { const v = asEnvironment(value(ev)); if (v) setRenderPref("environment", v); }
function onBackground(ev: Event) { const v = asBackground(value(ev)); if (v) setRenderPref("background", v); }
function onBrightness(ev: Event) { setRenderPref("brightness", Number.parseFloat(value(ev))); }
</script>

<template>
  <ModalFrame @close="close()">
    <template #title>Preferences</template>

    <div class="modal-body prefs">
      <div class="sm-section">Appearance</div>
      <label class="prefs-row">
        <span class="prefs-label">Theme</span>
        <select id="prefs-theme" class="sm-select" :value="theme" @change="onTheme">
          <option v-for="t in THEMES" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
      </label>
      <label class="prefs-row">
        <span class="prefs-label">Icons</span>
        <select id="prefs-iconpack" class="sm-select" :value="pack" @change="onPack">
          <option v-for="p in iconPacks()" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
      </label>
      <label class="prefs-row">
        <span class="prefs-label">Units</span>
        <select id="prefs-unit" class="sm-select" :value="unit" @change="onUnit">
          <option value="mm">Millimetres</option>
          <option value="cm">Centimetres</option>
          <option value="in">Inches</option>
        </select>
      </label>
      <div class="sm-hint">Geometry is always stored in millimetres, this is display only.</div>

      <div class="sm-section">Layout</div>
      <label class="prefs-row">
        <span class="prefs-label">Ribbon</span>
        <select id="prefs-ribbon" class="sm-select" :value="layout.ribbon" @change="onRibbon">
          <option value="top">Along the top</option>
          <option value="left">Down the side</option>
        </select>
      </label>
      <label class="prefs-row">
        <span class="prefs-label">History</span>
        <select id="prefs-history" class="sm-select" :value="layout.history" @change="onHistory">
          <option value="bottom">Along the bottom</option>
          <option value="right">Down the right</option>
        </select>
      </label>
      <div class="sm-hint">Applied straight away, and remembered.</div>

      <div class="sm-section">Viewport</div>
      <label class="prefs-row">
        <span class="prefs-label">Reflections</span>
        <select id="prefs-environment" class="sm-select" :value="render.environment" @change="onEnvironment">
          <option value="studio">Studio</option>
          <option value="none">None (flat)</option>
        </select>
      </label>
      <div class="sm-hint">
        A metal is almost entirely reflection, so with none it renders nearly
        black. Flat is the clearer way to read shape.
      </div>
      <label class="prefs-row">
        <span class="prefs-label">Background</span>
        <select id="prefs-background" class="sm-select" :value="render.background" @change="onBackground">
          <option value="theme">Follow the theme</option>
          <option value="dark">Dark</option>
          <option value="grey">Mid grey</option>
          <option value="light">Light</option>
        </select>
      </label>
      <label class="prefs-row">
        <span class="prefs-label">Brightness</span>
        <input
          id="prefs-brightness"
          class="sm-slider"
          type="range"
          :min="MIN_BRIGHTNESS"
          :max="MAX_BRIGHTNESS"
          step="0.05"
          :value="render.brightness"
          @input="onBrightness"
        />
      </label>
      <div class="sm-hint">Lights and reflections together, so the two stay in step.</div>

      <!-- What the running plugins ask about. Each brings its own heading, so a
           plugin that is not installed leaves no gap where its block was. -->
      <template v-for="s in sections" :key="s.key">
        <div class="sm-section">{{ s.section.title }}</div>
        <component :is="s.section.component" />
      </template>

      <PluginsSection />
    </div>

    <div class="modal-foot">
      <button class="btn btn-primary" @click="close()">Done</button>
    </div>
  </ModalFrame>
</template>
