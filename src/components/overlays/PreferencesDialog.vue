<script setup lang="ts">
// Preferences: one surface for the settings that were scattered across the
// title bar (theme, icons, units) plus the shell arrangement, which had no
// surface at all.
//
// A surface over the existing setting modules, NOT a store of its own. Every
// value here already persists itself and already notifies its own subscribers,
// ui/theme.ts, ui/icons.ts, ui/units.ts, ui/renderPrefs.ts, so this component
// holds only the mirror it renders from, and every change is applied live.
// Copying them into local state and writing back on "OK" would put a second
// copy of each setting in the app, and the title bar's selects read the first.
//
// The mirrors are refs re-read from each module's own subscription rather than
// bound with v-model, because those modules are deliberately Vue-free (that is
// what lets the headless suite import them) and so nothing tracks them.

import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { contributedSettings, onContribChange } from "../../plugins/contrib";
import { useDialogStore } from "../../stores/dialogs";
import { useModalGate } from "../../composables/useModalGate";
import ModalFrame from "./ModalFrame.vue";
import PluginsSection from "./PluginsSection.vue";
import {
  addCustomTheme,
  asThemeId,
  BUILTIN_THEME,
  getTheme,
  onThemeChange,
  removeCustomTheme,
  setTheme,
  themes,
} from "../../ui/theme";
import { asIconPackId, getIconPack, iconPacks, onIconPackChange, setIconPack } from "../../ui/icons";
import { asUnit, getUnit, onUnitChange, setUnit } from "../../ui/units";
import {
  asBackground,
  asBloom,
  asEnvironment,
  MAX_BRIGHTNESS,
  MIN_BRIGHTNESS,
  onRenderPrefsChange,
  ENVIRONMENTS_LIST,
  renderPrefs,
  setRenderPref,
} from "../../ui/renderPrefs";

const dialogs = useDialogStore();
const close = () => { dialogs.preferences = false; };

// Unlike the 3D-mouse dialog, this one DOES gate global shortcuts: it is full of
// text-sized targets and single-letter tool keys would fire underneath it.
useModalGate();

const theme = ref(getTheme());
// The roster is no longer a constant, uploading and removing a palette grows and
// shrinks it, so it is mirrored in a ref and re-read whenever the library moves.
const themeList = ref(themes());
// The last upload's rejection reason, shown under the picker. Empty when the
// last upload was fine or there has not been one.
const themeError = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const activeIsCustom = computed(() => theme.value !== BUILTIN_THEME.id);
const pack = ref(getIconPack());
const unit = ref(getUnit());
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
    onThemeChange(() => { theme.value = getTheme(); themeList.value = themes(); }),
    onIconPackChange(() => { pack.value = getIconPack(); }),
    onUnitChange(() => { unit.value = getUnit(); }),
    onRenderPrefsChange(() => { render.value = renderPrefs(); }),
    onContribChange(() => { sections.value = contributedSettings(); }),
  );
});
onUnmounted(() => { for (const stop of stops) stop(); });

const value = (ev: Event) => (ev.target as HTMLSelectElement).value;

// Every write goes through the module's own gate, so an <option> that no longer
// matches anything is refused at the same place a corrupt stored value is.
function onTheme(ev: Event) { const v = asThemeId(value(ev)); if (v) setTheme(v); }

// Opening the native file picker from a real button, the <input> itself is
// hidden: a bare file input reads as a mystery control on a settings screen,
// and "Upload theme…" says what it is for.
function pickThemeFile() { themeError.value = ""; fileInput.value?.click(); }

async function onUpload(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  // Reset immediately so choosing the SAME file twice fires change again, the
  // usual gotcha with a file input, someone re-picks after fixing the file and
  // nothing happens.
  input.value = "";
  if (!file) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    themeError.value = "That file is not valid JSON.";
    return;
  }
  const res = addCustomTheme(parsed, file.name);
  if (!res.ok) {
    themeError.value = res.error;
    return;
  }
  themeError.value = "";
  themeList.value = themes();
  // Adding a palette does not switch to it (the module leaves that to us), and a
  // user who just uploaded one wants to see it, so make it active.
  setTheme(res.theme.id);
}

function onRemoveTheme() {
  themeError.value = "";
  // Only the active theme can be the one on screen to remove; removing it falls
  // back to the built-in palette inside the module, which fires onThemeChange
  // and refreshes both refs.
  if (activeIsCustom.value) removeCustomTheme(theme.value);
}
function onPack(ev: Event) { const v = asIconPackId(value(ev)); if (v) setIconPack(v); }
function onUnit(ev: Event) { const v = asUnit(value(ev)); if (v) setUnit(v); }
function onEnvironment(ev: Event) { const v = asEnvironment(value(ev)); if (v) setRenderPref("environment", v); }
function onBackground(ev: Event) { const v = asBackground(value(ev)); if (v) setRenderPref("background", v); }
function onBrightness(ev: Event) { setRenderPref("brightness", Number.parseFloat(value(ev))); }
function onBloom(ev: Event) { const v = asBloom(value(ev)); if (v !== null) setRenderPref("bloom", v); }
</script>

<template>
  <ModalFrame @close="close()">
    <template #title>Preferences</template>

    <div class="modal-body prefs">
      <div class="sm-section">Appearance</div>
      <label class="prefs-row">
        <span class="prefs-label">Theme</span>
        <select id="prefs-theme" class="sm-select" :value="theme" @change="onTheme">
          <option v-for="t in themeList" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
      </label>
      <div class="prefs-row">
        <span class="prefs-label"></span>
        <div class="prefs-actions">
          <input
            ref="fileInput"
            id="prefs-theme-file"
            class="hidden"
            type="file"
            accept="application/json,.json"
            @change="onUpload"
          />
          <button type="button" class="btn" @click="pickThemeFile">Upload theme…</button>
          <button v-if="activeIsCustom" type="button" class="btn" @click="onRemoveTheme">Remove</button>
        </div>
      </div>
      <div v-if="themeError" class="sm-hint prefs-theme-error">{{ themeError }}</div>
      <div class="sm-hint">
        One theme ships with FundaCAD. Upload a JSON palette to add your own, it
        is stored in this browser's preferences. Keys are colour tokens like
        <code>--bg</code> and <code>--accent</code>, values are hex or rgb().
      </div>
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

      <div class="sm-section">Viewport</div>
      <label class="prefs-row">
        <span class="prefs-label">Reflections</span>
        <select id="prefs-environment" class="sm-select" :value="render.environment" @change="onEnvironment">
          <option v-for="e in ENVIRONMENTS_LIST" :key="e.id" :value="e.id">{{ e.label }}</option>
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
      <label class="prefs-row">
        <span class="prefs-label">Bloom</span>
        <input id="prefs-bloom" class="sm-slider" type="range" min="0" max="1" step="0.05"
          :value="render.bloom" @input="onBloom" />
      </label>
      <div class="sm-hint">
        Light spilling off the brightest parts of the image. The lower half reaches
        a material with Glow turned up and a hard specular highlight and nothing
        else, so an ordinary part looks the same; turn it up to catch everyday
        highlights too.
      </div>

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
