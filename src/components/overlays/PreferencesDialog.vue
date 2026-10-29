<script setup lang="ts">
// Mirrors the setting modules (ui/theme, icons, units, renderPrefs) with no store of its own, every change applies live.
// The mirrors re-read on each module's subscription, the modules stay Vue-free so the headless suite can import them.

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useDialogStore } from "../../stores/dialogs";
import { pluginFocus } from "../../plugins/settingsFocus";
import Button from "../ui/Button.vue";
import Checkbox from "../ui/Checkbox.vue";
import Dialog from "../ui/Dialog.vue";
import Segmented from "../ui/Segmented.vue";
import Select from "../ui/Select.vue";
import Slider from "../ui/Slider.vue";
import Tabs from "../ui/Tabs.vue";
import McpSection from "./McpSection.vue";
import DenoiserRow from "../shell/DenoiserRow.vue";
import PluginsSection from "./PluginsSection.vue";
import ExperimentalSection from "./ExperimentalSection.vue";
import UpdatesSection from "./UpdatesSection.vue";
import {
  addCustomTheme,
  asThemeId,
  customThemes,
  getTheme,
  onThemeChange,
  removeCustomTheme,
  setTheme,
  themes,
} from "../../ui/theme";
import { asIconPackId, getIconPack, iconPacks, onIconPackChange, setIconPack } from "../../ui/icons";
import { asUnit, getUnit, onUnitChange, setUnit } from "../../ui/units";
import {
  a11yPrefs,
  applyScreenReaderPreset,
  asAnimations,
  asVerbosity,
  DEFAULT_A11Y,
  onA11yPrefsChange,
  resetA11yPrefs,
  setA11yPref,
  systemReducesMotion,
} from "../../ui/a11yPrefs";
import {
  getHomeBackground,
  HOME_BACKGROUNDS,
  HOME_IMAGE_TYPES,
  loadHomeImage,
  onHomeBackgroundChange,
  setHomeBackground,
  storeHomeImage,
  type HomeBackground,
} from "../../ui/homeBackground";
import {
  asOrbitPivot,
  asTouchpadScroll,
  asWheelDevice,
  DEFAULT_DWELL_MS,
  getDetectedWheel,
  getHoverDwellMs,
  getNavPrefs,
  MAX_DWELL_MS,
  MIN_DWELL_MS,
  navigatorChoice,
  onDetectedWheelChange,
  onHoverDwellChange,
  onNavPrefsChange,
  setHoverDwellMs,
  setNavigatorChoice,
  setNavPrefs,
} from "../../ui/interactionPrefs";
import {
  asBackground,
  asBloom,
  asEnvironment,
  asTangentEdges,
  asTracerPref,
  MAX_BRIGHTNESS,
  MIN_BRIGHTNESS,
  onRenderPrefsChange,
  ENVIRONMENTS_LIST,
  performanceModeOn,
  renderPrefs,
  setRenderPref,
} from "../../ui/renderPrefs";

const dialogs = useDialogStore();
const close = () => {
  dialogs.preferences = false;
};

const theme = ref(getTheme());
// Uploading and removing a palette changes the roster, so it is mirrored and re-read when the library moves.
const themeList = ref(themes());
// The last upload's rejection reason, empty when it was fine.
const themeError = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const homeBg = ref(getHomeBackground());
const homeImageInput = ref<HTMLInputElement | null>(null);
const homeImageError = ref("");
// Only an uploaded palette is removable; the built-in theme and the shipped
// ones (Dracula, Solarized Light) sit in the picker the same way but stay put.
const activeIsCustom = computed(() => customThemes().some((t) => t.id === theme.value));
const pack = ref(getIconPack());
const unit = ref(getUnit());
const render = ref(renderPrefs());
const dwell = ref(getHoverDwellMs());
const a11y = ref(a11yPrefs());
const reducesMotion = ref(systemReducesMotion());
const nav = ref(getNavPrefs());
const detectedWheel = ref(getDetectedWheel());
const classicCamera = ref(navigatorChoice() === "legacy");

const stops: (() => void)[] = [];
onMounted(() => {
  stops.push(
    onThemeChange(() => {
      theme.value = getTheme();
      themeList.value = themes();
    }),
    onIconPackChange(() => {
      pack.value = getIconPack();
    }),
    onUnitChange(() => {
      unit.value = getUnit();
    }),
    onRenderPrefsChange(() => {
      render.value = renderPrefs();
    }),
    onHoverDwellChange(() => {
      dwell.value = getHoverDwellMs();
    }),
    onA11yPrefsChange(() => {
      a11y.value = a11yPrefs();
      reducesMotion.value = systemReducesMotion();
    }),
    onNavPrefsChange(() => {
      nav.value = getNavPrefs();
    }),
    onDetectedWheelChange(() => {
      detectedWheel.value = getDetectedWheel();
    }),
    onHomeBackgroundChange(() => {
      homeBg.value = getHomeBackground();
    }),
  );
});
onUnmounted(() => {
  for (const stop of stops) stop();
});

// A plugin's settings are under its own row in Plugins, not a category here.
const categories = computed(() => [
  { value: "appearance", label: "Appearance" },
  { value: "viewport", label: "Viewport" },
  { value: "navigation", label: "Navigation" },
  { value: "access", label: "Accessibility" },
  { value: "updates", label: "Updates" },
  { value: "mcp", label: "AI assistants" },
  { value: "plugins", label: "Plugins" },
  { value: "experimental", label: "Experimental" },
]);
const known = (id: string | null) => categories.value.find((c) => c.value === id)?.value;
const category = ref(pluginFocus.value ? "plugins" : (known(dialogs.prefsCategory) ?? "appearance"));
// Taken once, so an open that sets `preferences` directly, as the Live session pill does, lands on Appearance.
dialogs.prefsCategory = null;
const panes = ref<HTMLElement | null>(null);
const pane = (id: string) => ({
  id: `prefs-pane-${id}`,
  role: "tabpanel",
  "aria-label": categories.value.find((c) => c.value === id)?.label,
  "data-pane": id,
  // AI assistants and Plugins have no title, so the pane itself takes the focus.
  tabindex: id === "mcp" || id === "plugins" ? -1 : undefined,
});
// A click or Enter on a category focuses its title so a screen reader says where it went, the arrows stay on the tabs.
async function focusPane() {
  await nextTick();
  const el = panes.value?.querySelector<HTMLElement>(`[data-pane="${category.value}"]`);
  (el?.querySelector<HTMLElement>(".prefs-pane-title[tabindex]") ?? el)?.focus();
}
function revealPane(e: MouseEvent) {
  if ((e.target as Element).closest("[role=tab]")) void focusPane();
}
function showPane(id: string) {
  category.value = id;
  void focusPane();
}
watch(pluginFocus, (id) => {
  if (id) category.value = "plugins";
});
watch(
  () => dialogs.prefsCategory,
  (id) => {
    const asked = known(id);
    dialogs.prefsCategory = null;
    if (asked) showPane(asked);
  },
);

const ANIMATIONS = [
  { value: "system", label: "Follow system" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];
const VERBOSITY = [
  { value: "off", label: "Off" },
  { value: "errors", label: "Errors" },
  { value: "normal", label: "Normal" },
  { value: "verbose", label: "Verbose" },
];
const a11yChanged = computed(
  () =>
    a11y.value.animations !== DEFAULT_A11Y.animations ||
    a11y.value.verbosity !== DEFAULT_A11Y.verbosity ||
    dwell.value !== DEFAULT_DWELL_MS,
);
function pickAnimations(id: string) {
  const v = asAnimations(id);
  if (v) setA11yPref("animations", v);
}
function pickVerbosity(id: string) {
  const v = asVerbosity(id);
  if (v) setA11yPref("verbosity", v);
}

const UNITS = [
  { value: "mm", label: "mm" },
  { value: "cm", label: "cm" },
  { value: "in", label: "in" },
];
const BACKGROUNDS = [
  { value: "theme", label: "Theme" },
  { value: "dark", label: "Dark" },
  { value: "grey", label: "Grey" },
  { value: "light", label: "Light" },
];
const TRACERS = [
  { value: "auto", label: "Auto" },
  { value: "native", label: "Native" },
  { value: "webgpu", label: "WebGPU" },
];
const TANGENT = [
  { value: "show", label: "Show" },
  { value: "faint", label: "Faint" },
  { value: "hide", label: "Hide" },
];

const WHEEL_DEVICES = [
  { value: "auto", label: "Automatic" },
  { value: "touchpad", label: "Touchpad" },
  { value: "mouse", label: "Mouse" },
];
const ORBIT_PIVOTS = [
  { value: "auto", label: "Under cursor" },
  { value: "origin", label: "Origin" },
  { value: "selection", label: "Selection" },
];
const TOUCHPAD_SCROLL = [
  { value: "orbit", label: "Orbits" },
  { value: "pan", label: "Pans" },
];

const HOME_BACKGROUND_OPTIONS = HOME_BACKGROUNDS.map((b) => ({ value: b.id, label: b.label }));

const themeOptions = computed(() => themeList.value.map((t) => ({ value: t.id, label: t.label })));
const packOptions = computed(() => iconPacks().map((p) => ({ value: p.id, label: p.label })));
const environmentOptions = ENVIRONMENTS_LIST.map((e) => ({ value: e.id, label: e.label, hint: e.note }));

// Every write goes through the module's own gate, so a choice that no longer
// matches anything is refused at the same place a corrupt stored value is.
function onTheme(id: string) {
  const v = asThemeId(id);
  if (v) setTheme(v);
}

// A real button opens the native picker, a bare file input reads as a mystery control on a settings screen.
function pickThemeFile() {
  themeError.value = "";
  fileInput.value?.click();
}

async function onUpload(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  // Reset at once so picking the same file again, after fixing it, still fires change.
  input.value = "";
  if (!file) return;
  themeError.value = "";
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
  // Adding a palette does not switch to it, and a user who just uploaded one wants to see it.
  setTheme(res.theme.id);
}

function onRemoveTheme() {
  themeError.value = "";
  // Removing the active palette falls back to the built-in one in the module, whose onThemeChange refreshes both refs.
  if (activeIsCustom.value) removeCustomTheme(theme.value);
}
function onPack(id: string) {
  const v = asIconPackId(id);
  if (v) setIconPack(v);
}
function pickUnit(id: string) {
  const v = asUnit(id);
  if (v) setUnit(v);
}

// Segmented picks on the arrows too: only a pointer pick of the image opens the file picker, a key pick shows the
// Choose image button instead, so the keyboard can pass through the group.
let pointerPick = false;
const notePointer = (on: boolean) => {
  pointerPick = on;
};
async function pickHomeBackground(id: HomeBackground) {
  const viaPointer = pointerPick;
  pointerPick = false;
  homeImageError.value = "";
  if (id === "image" && viaPointer && !(await loadHomeImage())) {
    homeImageInput.value?.click();
    return;
  }
  setHomeBackground(id);
}

async function onHomeImage(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  homeImageError.value = "";
  const res = await storeHomeImage(file);
  if (!res.ok) {
    homeImageError.value = res.error;
    return;
  }
  homeImageError.value = "";
  setHomeBackground("image");
}
function onEnvironment(id: string) {
  const v = asEnvironment(id);
  if (v) setRenderPref("environment", v);
}
function pickBackground(id: string) {
  const v = asBackground(id);
  if (v) setRenderPref("background", v);
}
// Brightness and Bloom are shown and spoken in percent, Smoothing in milliseconds, the stores keep their own units.
const BRIGHTNESS_PCT = { min: Math.round(MIN_BRIGHTNESS * 100), max: Math.round(MAX_BRIGHTNESS * 100) };
function onBrightness(pct: number) {
  setRenderPref("brightness", pct / 100);
}
function onBloom(pct: number) {
  const v = asBloom(pct / 100);
  if (v !== null) setRenderPref("bloom", v);
}
function pickTracer(id: string) {
  const v = asTracerPref(id);
  if (v) setRenderPref("tracer", v);
}
function pickTangent(id: string) {
  const v = asTangentEdges(id);
  if (v) setRenderPref("tangentEdges", v);
}
function onPerformanceMode(on: boolean) {
  setRenderPref("performanceMode", on);
}
function onPotatoMode(on: boolean) {
  setRenderPref("potatoMode", on);
}
function onInertia(on: boolean) {
  setNavPrefs({ inertia: on });
}
function pickWheelDevice(id: string) {
  const v = asWheelDevice(id);
  if (v) setNavPrefs({ wheelDevice: v });
}
function pickOrbitPivot(id: string) {
  const v = asOrbitPivot(id);
  if (v) setNavPrefs({ orbitPivot: v });
}
function pickTouchpadScroll(id: string) {
  const v = asTouchpadScroll(id);
  if (v) setNavPrefs({ touchpadScroll: v });
}
function onSmoothing(ms: number) {
  setNavPrefs({ smoothTime: ms / 1000 });
}
function onClassicCamera(on: boolean) {
  classicCamera.value = on;
  setNavigatorChoice(classicCamera.value ? "legacy" : "v2");
}
</script>

<template>
  <!-- Escape, the modal gate and focus are the frame's: it gates global shortcuts, since single letter tool keys would
       fire under a screen full of text sized targets. -->
  <Dialog
    title="Preferences"
    panel-class="prefs-panel"
    :body="false"
    initial-focus=".prefs-cats [role=tab][aria-selected=true]"
    @close="close()"
  >
    <div class="modal-body prefs">
      <Tabs
        v-model="category"
        :tabs="categories"
        variant="bar"
        orientation="vertical"
        label="Preference categories"
        class="prefs-nav prefs-cats"
        @click="revealPane"
      >
        <template #tab="{ tab, selected }">
          <span class="prefs-nav-btn" :class="{ active: selected }" :data-category="tab.value">{{ tab.label }}</span>
        </template>
      </Tabs>

      <div ref="panes" class="prefs-panes">
        <!-- v-show, so a control keeps its id whichever category is open. -->
        <section v-show="category === 'appearance'" v-bind="pane('appearance')" class="prefs-pane">
          <h3 class="prefs-pane-title" tabindex="-1">Appearance</h3>
          <div class="prefs-grid">
            <div class="pref-card wide">
              <div class="pref-head">
                <label class="pref-title" for="prefs-theme">Theme</label>
                <Select
                  id="prefs-theme"
                  aria-describedby="prefs-theme-hint"
                  :model-value="theme"
                  :options="themeOptions"
                  @update:model-value="onTheme"
                />
              </div>
              <p id="prefs-theme-hint" class="pref-hint">
                FundaCAD Noir, Dracula, Solarized Light and the Noir Blue/Red/Orange tints ship with FundaCAD. Upload a
                JSON palette to add your own, it is stored in this browser's preferences. Keys are colour tokens like
                <code>--bg</code> and <code>--accent</code>, values are hex or rgb().
              </p>
              <div class="prefs-actions">
                <input
                  ref="fileInput"
                  id="prefs-theme-file"
                  class="hidden"
                  type="file"
                  accept="application/json,.json"
                  @change="onUpload"
                />
                <Button @click="pickThemeFile">Upload theme…</Button>
                <Button v-if="activeIsCustom" @click="onRemoveTheme">Remove</Button>
              </div>
              <p id="prefs-theme-error" class="pref-hint prefs-theme-error" role="alert">{{ themeError }}</p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <label class="pref-title" for="prefs-iconpack">Icons</label>
                <Select id="prefs-iconpack" :model-value="pack" :options="packOptions" @update:model-value="onPack" />
              </div>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">Units</span>
                <Segmented
                  id="prefs-unit"
                  aria-describedby="prefs-unit-hint"
                  label="Units"
                  :model-value="unit"
                  :options="UNITS"
                  @update:model-value="pickUnit"
                />
              </div>
              <p id="prefs-unit-hint" class="pref-hint"
                >Geometry is always stored in millimetres, this is display only.</p
              >
            </div>
            <div class="pref-card wide">
              <div class="pref-head">
                <span class="pref-title">Home background</span>
                <Segmented
                  id="prefs-home-background"
                  aria-describedby="prefs-home-background-hint"
                  label="Home background"
                  :model-value="homeBg"
                  :options="HOME_BACKGROUND_OPTIONS"
                  @pointerdown="notePointer(true)"
                  @keydown.capture="notePointer(false)"
                  @update:model-value="pickHomeBackground"
                />
              </div>
              <p id="prefs-home-background-hint" class="pref-hint"
                >What Home sits on. Workspace shows your model dimmed behind it.</p
              >
              <div v-if="homeBg === 'image'" class="prefs-actions">
                <Button @click="homeImageInput?.click()">Choose image…</Button>
              </div>
              <input
                ref="homeImageInput"
                id="prefs-home-image"
                class="hidden"
                type="file"
                :accept="HOME_IMAGE_TYPES.join(',')"
                @change="onHomeImage"
              />
              <p id="prefs-home-image-error" class="pref-hint prefs-theme-error" role="alert">{{ homeImageError }}</p>
            </div>
          </div>
        </section>

        <section v-show="category === 'viewport'" v-bind="pane('viewport')" class="prefs-pane">
          <h3 class="prefs-pane-title" tabindex="-1">Viewport</h3>
          <div class="prefs-grid">
            <div class="pref-card">
              <div class="pref-head">
                <label class="pref-title" for="prefs-environment">Reflections</label>
                <Select
                  id="prefs-environment"
                  aria-describedby="prefs-environment-hint"
                  :model-value="render.environment"
                  :options="environmentOptions"
                  @update:model-value="onEnvironment"
                />
              </div>
              <p id="prefs-environment-hint" class="pref-hint">
                A metal is almost entirely reflection, so with none it renders nearly black. Flat is the clearer way to
                read shape.
              </p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">Background</span>
                <Segmented
                  id="prefs-background"
                  label="Background"
                  :model-value="render.background"
                  :options="BACKGROUNDS"
                  @update:model-value="pickBackground"
                />
              </div>
            </div>
            <div class="pref-card">
              <Slider
                id="prefs-brightness"
                label="Environment brightness"
                unit="%"
                show-value
                :min="BRIGHTNESS_PCT.min"
                :max="BRIGHTNESS_PCT.max"
                :step="5"
                :model-value="Math.round(render.brightness * 100)"
                @update:model-value="onBrightness"
              />
              <p class="pref-hint">
                How strongly the environment lights the model and shows in its reflections, an imported HDR included.
              </p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">Tangent edges</span>
                <Segmented
                  id="prefs-tangent-edges"
                  aria-describedby="prefs-tangent-edges-hint"
                  label="Tangent edges"
                  :model-value="render.tangentEdges"
                  :options="TANGENT"
                  @update:model-value="pickTangent"
                />
              </div>
              <p id="prefs-tangent-edges-hint" class="pref-hint">
                Where two faces meet smoothly, like the borders of a fillet, there is no corner to see, only a line
                across one continuous surface.
              </p>
            </div>
            <div class="pref-card">
              <Slider
                id="prefs-bloom"
                label="Bloom"
                unit="%"
                show-value
                :min="0"
                :max="100"
                :step="5"
                :model-value="Math.round(render.bloom * 100)"
                @update:model-value="onBloom"
              />
              <p class="pref-hint">
                Light spilling off faces with Emission turned up. In the path traced view bright highlights spill too.
              </p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">Path tracer</span>
                <Segmented
                  id="prefs-tracer"
                  aria-describedby="prefs-tracer-hint"
                  label="Path tracer"
                  :model-value="render.tracer"
                  :options="TRACERS"
                  @update:model-value="pickTracer"
                />
              </div>
              <p id="prefs-tracer-hint" class="pref-hint">
                Where Path traced runs. Native traces in the app itself, WebGPU in the viewport's web view; Auto picks
                the faster one this computer has. If the one picked is missing, the other is used.
              </p>
              <DenoiserRow hint-class="pref-hint" button-class="btn btn-md" />
            </div>
            <div class="pref-card">
              <Checkbox
                id="prefs-performance-mode"
                class="pref-head pref-check"
                :model-value="performanceModeOn(render)"
                :disabled="render.potatoMode"
                @update:model-value="onPerformanceMode"
                ><span class="pref-title">Performance mode</span></Checkbox
              >
              <p class="pref-hint">
                Drops glass refraction, the high pixel ratio and the emitter shadows for a lighter render. Weak GPUs get
                it automatically; turn it on if the viewport stutters or a laptop runs hot.
              </p>
              <Checkbox
                id="prefs-potato-mode"
                class="pref-head pref-sub pref-check"
                tip="Lowest quality, for slow or virtual machines"
                :model-value="render.potatoMode"
                @update:model-value="onPotatoMode"
                ><span class="pref-title">Potato mode</span></Checkbox
              >
              <p class="pref-hint">
                Lowest quality, for slow or virtual machines. Flat shading, thin edges, half resolution, no glass blur
                and no effects or camera animations. Includes performance mode.
              </p>
            </div>
          </div>
        </section>

        <section v-show="category === 'navigation'" v-bind="pane('navigation')" class="prefs-pane">
          <h3 class="prefs-pane-title" tabindex="-1">Navigation</h3>
          <div class="prefs-grid">
            <div class="pref-card">
              <Slider
                id="prefs-smoothing"
                label="Smoothing"
                unit="ms"
                show-value
                :min="0"
                :max="300"
                :step="5"
                :model-value="Math.round(nav.smoothTime * 1000)"
                @update:model-value="onSmoothing"
              />
              <p class="pref-hint">
                How long a zoom or a drag takes to catch up with the hand. 0 follows the mouse exactly; whatever it is
                set to, the point under the cursor stays under it on every frame.
              </p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">Orbit pivot</span>
                <Segmented
                  id="prefs-orbit-pivot"
                  aria-describedby="prefs-orbit-pivot-hint"
                  label="Orbit pivot"
                  :model-value="nav.orbitPivot"
                  :options="ORBIT_PIVOTS"
                  @update:model-value="pickOrbitPivot"
                />
              </div>
              <p id="prefs-orbit-pivot-hint" class="pref-hint">
                What a drag turns the view about. Under cursor takes the model point you press on, Origin always turns
                about the world origin, and Selection about the centre of what is selected (under the cursor while
                nothing is). The arrow keys turn about the same point, 15° a press, 5° with Shift.
              </p>
            </div>
            <div class="pref-card">
              <Checkbox
                id="prefs-inertia"
                class="pref-head pref-check"
                :model-value="nav.inertia"
                @update:model-value="onInertia"
                ><span class="pref-title">Orbit inertia</span></Checkbox
              >
              <p class="pref-hint">
                A flicked orbit keeps turning for a moment after the button comes up, about the same point.
              </p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">Scrolling</span>
                <Segmented
                  id="prefs-wheel-device"
                  aria-describedby="prefs-wheel-device-hint"
                  label="Scrolling"
                  :model-value="nav.wheelDevice"
                  :options="WHEEL_DEVICES"
                  @update:model-value="pickWheelDevice"
                />
              </div>
              <p id="prefs-wheel-device-hint" class="pref-hint">
                A mouse wheel zooms; a touchpad's two fingers turn or move the view and a pinch zooms. Automatic tells
                them apart each time you scroll<template v-if="nav.wheelDevice === 'auto' && detectedWheel"
                  >, and took the last one for a {{ detectedWheel }}</template
                >. Pick one if it guesses wrong.
              </p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">Two-finger scroll</span>
                <Segmented
                  id="prefs-touchpad-scroll"
                  aria-describedby="prefs-touchpad-scroll-hint"
                  label="Two-finger scroll"
                  :model-value="nav.touchpadScroll"
                  :options="TOUCHPAD_SCROLL"
                  @update:model-value="pickTouchpadScroll"
                />
              </div>
              <p id="prefs-touchpad-scroll-hint" class="pref-hint">
                On a touchpad, what two fingers scrolling do to the view. Shift with the scroll does the other, and a
                pinch zooms toward the pointer.
              </p>
            </div>
            <div class="pref-card">
              <Checkbox
                id="prefs-classic-camera"
                class="pref-head pref-check"
                :model-value="classicCamera"
                @update:model-value="onClassicCamera"
                ><span class="pref-title">Classic camera</span></Checkbox
              >
              <p class="pref-hint">
                The camera from before this release, kept for one release in case the new one gets in your way. Takes
                effect after a restart.
              </p>
            </div>
          </div>
        </section>

        <section v-show="category === 'access'" v-bind="pane('access')" class="prefs-pane">
          <h3 class="prefs-pane-title" tabindex="-1">Accessibility</h3>
          <div class="prefs-a11y-actions">
            <Button data-a11y-preset aria-describedby="prefs-a11y-actions-hint" @click="applyScreenReaderPreset"
              >Screen reader preset</Button
            >
            <Button
              :disabled="!a11yChanged"
              data-a11y-reset
              aria-describedby="prefs-a11y-actions-hint"
              @click="resetA11yPrefs"
              >Reset to defaults</Button
            >
            <p id="prefs-a11y-actions-hint" class="pref-hint">
              Screen reader preset sets Announcements to Verbose, the setup that suits NVDA, VoiceOver and other screen
              readers. Reset to defaults clears every choice below, so Animations follows the system again.
            </p>
          </div>

          <div class="prefs-group" role="group" aria-labelledby="prefs-a11y-vision">
            <h4 id="prefs-a11y-vision" class="prefs-group-title">Vision</h4>
            <div class="prefs-grid">
              <div class="pref-card">
                <div class="pref-head">
                  <span class="pref-title">Theme</span>
                  <Button data-a11y-appearance aria-describedby="prefs-a11y-theme-hint" @click="showPane('appearance')"
                    >Open Appearance</Button
                  >
                </div>
                <p id="prefs-a11y-theme-hint" class="pref-hint">
                  Themes are picked under Appearance. Colour-Blind Safe draws the axes, planes and gizmos in vermilion,
                  yellow and sky blue, and Solarized Light is a light theme.
                </p>
              </div>
            </div>
          </div>

          <div class="prefs-group" role="group" aria-labelledby="prefs-a11y-speech">
            <h4 id="prefs-a11y-speech" class="prefs-group-title">Speech</h4>
            <div class="prefs-grid">
              <div class="pref-card wide">
                <div class="pref-head pref-wrap">
                  <span class="pref-title">Announcements</span>
                  <Segmented
                    id="prefs-verbosity"
                    label="Announcements"
                    aria-describedby="prefs-verbosity-hint"
                    :model-value="a11y.verbosity"
                    :options="VERBOSITY"
                    @update:model-value="pickVerbosity"
                  />
                </div>
                <p id="prefs-verbosity-hint" class="pref-hint">
                  How much the app tells a screen reader: nothing, errors only, prompts and results, or every change as
                  well.
                </p>
              </div>
            </div>
          </div>

          <div class="prefs-group" role="group" aria-labelledby="prefs-a11y-input">
            <h4 id="prefs-a11y-input" class="prefs-group-title">Keyboard and pointer</h4>
            <div class="prefs-grid">
              <div class="pref-card">
                <Slider
                  id="prefs-hover-dwell"
                  label="Hover delay"
                  unit="ms"
                  show-value
                  :min="MIN_DWELL_MS"
                  :max="MAX_DWELL_MS"
                  :step="50"
                  :model-value="dwell"
                  @update:model-value="setHoverDwellMs"
                />
                <p class="pref-hint">
                  How long the pointer rests on a part before its face is highlighted instead of the whole part. A click
                  selects whatever is highlighted, so a longer delay makes it easier to select whole parts.
                </p>
              </div>
            </div>
          </div>

          <div class="prefs-group" role="group" aria-labelledby="prefs-a11y-motion">
            <h4 id="prefs-a11y-motion" class="prefs-group-title">Motion</h4>
            <div class="prefs-grid">
              <div class="pref-card">
                <div class="pref-head">
                  <span class="pref-title">Animations</span>
                  <Segmented
                    id="prefs-motion"
                    label="Animations"
                    aria-describedby="prefs-motion-hint"
                    :model-value="a11y.animations"
                    :options="ANIMATIONS"
                    @update:model-value="pickAnimations"
                  />
                </div>
                <p id="prefs-motion-hint" class="pref-hint">
                  Off makes every transition instant: menus, panels, the error notice and camera moves all jump straight
                  to where they end. Follow system takes Animation effects on Windows, Reduce motion on macOS or Reduce
                  animation on GNOME, and changes the moment the system does.
                  <template v-if="a11y.animations === 'system'"
                    >The system has them {{ reducesMotion ? "off" : "on" }} right now.</template
                  >
                </p>
              </div>
            </div>
          </div>
        </section>

        <section v-show="category === 'updates'" v-bind="pane('updates')" class="prefs-pane">
          <UpdatesSection />
        </section>

        <section v-show="category === 'mcp'" v-bind="pane('mcp')" class="prefs-pane prefs-pane-flow">
          <McpSection />
        </section>

        <section v-show="category === 'plugins'" v-bind="pane('plugins')" class="prefs-pane prefs-pane-flow">
          <PluginsSection />
        </section>

        <section
          v-show="category === 'experimental'"
          v-bind="pane('experimental')"
          class="prefs-pane"
          data-prefs-experimental
        >
          <ExperimentalSection />
        </section>
      </div>
    </div>

    <template #footer>
      <Button variant="primary" @click="close()">Done</Button>
    </template>
  </Dialog>
</template>
