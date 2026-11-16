<script setup lang="ts">
// Mirrors the setting modules (ui/theme, icons, units, renderPrefs) with no store of its own, every change applies live.
// The mirrors re-read on each module's subscription, the modules stay Vue-free so the headless suite can import them.

import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch, type Directive } from "vue";
import { useDialogStore } from "../../stores/dialogs";
import { pluginFocus } from "../../plugins/settingsFocus";
import Button from "../ui/Button.vue";
import Checkbox from "../ui/Checkbox.vue";
import Dialog from "../ui/Dialog.vue";
import Segmented from "../ui/Segmented.vue";
import Select from "../ui/Select.vue";
import Slider from "../ui/Slider.vue";
import Tabs from "../ui/Tabs.vue";
import { tabPanelAttrs } from "../ui/tabIds";
import LanguageCard from "./LanguageCard.vue";
import McpSection from "./McpSection.vue";
import DenoiserRow from "../shell/DenoiserRow.vue";
import LargerTargetsRow from "./LargerTargetsRow.vue";
import NoticeTimeRow from "./NoticeTimeRow.vue";
import PluginsSection from "./PluginsSection.vue";
import ExperimentalSection from "./ExperimentalSection.vue";
import UpdatesSection from "./UpdatesSection.vue";
import A11yContrastRows from "./A11yContrastRows.vue";
import A11ySizeRows from "./A11ySizeRows.vue";
import {
  addCustomTheme,
  asThemeId,
  getTheme,
  onThemeChange,
  removeCustomTheme,
  setTheme,
  SYSTEM_THEME_ID,
  themes,
} from "../../ui/theme";
import { t } from "../../i18n";
import { confirmDanger } from "../../ui/choice";
import { ACCESSIBILITY_PAGE, openExternal } from "../../ui/welcome";
import { toast } from "../../ui/toast";
import { describeFailures } from "../../ui/contrast";
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
  SCREEN_READER_PRESET,
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
// The contrast pairs the last accepted upload misses.
const themeWarning = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const homeBg = ref(getHomeBackground());
const homeImageInput = ref<HTMLInputElement | null>(null);
const homeImageError = ref("");
// Only an uploaded palette is removable; the built-in theme and the shipped
// ones (Dracula, Solarized Light) sit in the picker the same way but stay put.
const activeIsCustom = computed(() => themeList.value.some((t) => t.custom && t.id === theme.value));
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
      const prefs = a11y.value;
      if (presetKeys.some((k) => prefs[k] !== SCREEN_READER_PRESET[k])) presetNote.value = "";
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
  { value: "appearance", label: t("prefs.tab.appearance") },
  { value: "viewport", label: t("prefs.tab.viewport") },
  { value: "navigation", label: t("prefs.tab.navigation") },
  { value: "access", label: t("prefs.tab.access") },
  { value: "updates", label: t("prefs.tab.updates") },
  { value: "mcp", label: t("prefs.tab.mcp") },
  { value: "plugins", label: t("prefs.tab.plugins") },
  { value: "experimental", label: t("prefs.tab.experimental") },
]);
const known = (id: string | null) => categories.value.find((c) => c.value === id)?.value;
const category = ref(pluginFocus.value ? "plugins" : (known(dialogs.prefsCategory) ?? "appearance"));
// Taken once, so an open that sets `preferences` directly, as the Live session pill does, lands on Appearance.
dialogs.prefsCategory = null;
const panes = ref<HTMLElement | null>(null);
const panesId = useId();
const pane = (id: string) => ({
  ...tabPanelAttrs(panesId, id),
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

const ANIMATIONS = computed(() => [
  { value: "system", label: t("prefs.animations.system") },
  { value: "on", label: t("prefs.animations.on") },
  { value: "off", label: t("prefs.animations.off") },
]);
const VERBOSITY = computed(() => [
  { value: "off", label: t("prefs.verbosity.off") },
  { value: "errors", label: t("prefs.verbosity.errors") },
  { value: "normal", label: t("prefs.verbosity.normal") },
  { value: "verbose", label: t("prefs.verbosity.verbose") },
]);
const a11yChanged = computed(
  () =>
    a11y.value.contrast !== DEFAULT_A11Y.contrast ||
    a11y.value.solidPanels !== DEFAULT_A11Y.solidPanels ||
    a11y.value.animations !== DEFAULT_A11Y.animations ||
    a11y.value.verbosity !== DEFAULT_A11Y.verbosity ||
    a11y.value.singleKeys !== DEFAULT_A11Y.singleKeys ||
    a11y.value.targets !== DEFAULT_A11Y.targets ||
    a11y.value.unitsInFull !== DEFAULT_A11Y.unitsInFull ||
    a11y.value.noticeTime !== DEFAULT_A11Y.noticeTime ||
    a11y.value.interfaceSize !== DEFAULT_A11Y.interfaceSize ||
    a11y.value.comfortableText !== DEFAULT_A11Y.comfortableText ||
    a11y.value.viewportLabels !== DEFAULT_A11Y.viewportLabels ||
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
async function onResetA11y() {
  const ok = await confirmDanger(
    t("prefs.access.resetTitle"),
    t("prefs.access.resetAction"),
    t("prefs.access.resetBody"),
  );
  if (!ok) return;
  resetA11yPrefs();
  toast(t("prefs.access.resetDone"));
}

const presetNote = ref("");
const presetKeys = Object.keys(SCREEN_READER_PRESET) as (keyof typeof SCREEN_READER_PRESET)[];
async function screenReaderPreset() {
  applyScreenReaderPreset();
  // Emptied for a tick first, so a second press changes the live region and is spoken again.
  presetNote.value = "";
  await nextTick();
  presetNote.value = t("prefs.access.presetNote");
}

// Note: Slider puts fallthrough attributes on its wrapper and repeats aria-valuetext in its output,
// so the range takes the hint here and the output is hidden from screen readers.
const vRangeHint: Directive<HTMLElement, string> = {
  mounted(el, { value }) {
    el.querySelector("input[type=range]")?.setAttribute("aria-describedby", value);
    el.querySelector("output")?.setAttribute("aria-hidden", "true");
  },
};
// Checkbox puts fallthrough attributes on its label, so the box itself takes the hint here.
const vCheckHint: Directive<HTMLElement, string> = {
  mounted(el, { value }) {
    el.querySelector("input[type=checkbox]")?.setAttribute("aria-describedby", value);
  },
};

const UNITS = [
  { value: "mm", label: "mm" },
  { value: "cm", label: "cm" },
  { value: "in", label: "in" },
];
const BACKGROUNDS = computed(() => [
  { value: "theme", label: t("prefs.background.theme") },
  { value: "dark", label: t("prefs.background.dark") },
  { value: "grey", label: t("prefs.background.grey") },
  { value: "light", label: t("prefs.background.light") },
]);
const TRACERS = computed(() => [
  { value: "auto", label: t("prefs.tracer.auto") },
  { value: "native", label: t("prefs.tracer.native") },
  { value: "webgpu", label: t("prefs.tracer.webgpu") },
]);
const TANGENT = computed(() => [
  { value: "show", label: t("prefs.tangent.show") },
  { value: "faint", label: t("prefs.tangent.faint") },
  { value: "hide", label: t("prefs.tangent.hide") },
]);

const WHEEL_DEVICES = computed(() => [
  { value: "auto", label: t("prefs.scrolling.auto") },
  { value: "touchpad", label: t("prefs.scrolling.touchpad") },
  { value: "mouse", label: t("prefs.scrolling.mouse") },
]);
const ORBIT_PIVOTS = computed(() => [
  { value: "auto", label: t("prefs.orbitPivot.auto") },
  { value: "origin", label: t("prefs.orbitPivot.origin") },
  { value: "selection", label: t("prefs.orbitPivot.selection") },
]);
const TOUCHPAD_SCROLL = computed(() => [
  { value: "orbit", label: t("prefs.twoFinger.orbit") },
  { value: "pan", label: t("prefs.twoFinger.pan") },
]);

const HOME_BACKGROUND_OPTIONS = computed(() => HOME_BACKGROUNDS.map((b) => ({ value: b.id, label: b.label })));

// Only the System entry is a built-in line, the other theme names are the palettes' own and stay as they are.
const themeOptions = computed(() =>
  themeList.value.map((x) => ({ value: x.id, label: x.id === SYSTEM_THEME_ID ? t("prefs.theme.system") : x.label })),
);
const packOptions = computed(() => iconPacks().map((p) => ({ value: p.id, label: p.label })));
const motionState = computed(() => (reducesMotion.value ? "off" : "on"));
const wheelSeen = computed(() => (nav.value.wheelDevice !== "auto" ? "none" : (detectedWheel.value ?? "unseen")));
const environmentOptions = computed(() =>
  ENVIRONMENTS_LIST.map((e) => ({ value: e.id, label: e.label, hint: e.note })),
);

// Every write goes through the module's own gate, so a choice that no longer
// matches anything is refused at the same place a corrupt stored value is.
function onTheme(id: string) {
  const v = asThemeId(id);
  if (v) setTheme(v);
}

// A real button opens the native picker, a bare file input reads as a mystery control on a settings screen.
function pickThemeFile() {
  themeError.value = "";
  themeWarning.value = "";
  fileInput.value?.click();
}

async function onUpload(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  // Reset at once so picking the same file again, after fixing it, still fires change.
  input.value = "";
  if (!file) return;
  themeError.value = "";
  themeWarning.value = "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    themeError.value = t("prefs.theme.invalidJson");
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
  const shortfall = describeFailures(res.failing);
  if (!shortfall) return;
  // The status line empties for a tick first, so the same file uploaded again is spoken again.
  await nextTick();
  themeWarning.value = t("prefs.theme.added", { name: res.theme.label, shortfall });
}

async function onRemoveTheme() {
  themeError.value = "";
  themeWarning.value = "";
  const gone = themeList.value.find((t) => t.custom && t.id === theme.value);
  if (!gone) return;
  if (
    !(await confirmDanger(
      t("prefs.theme.removeTitle", { name: gone.label }),
      t("prefs.theme.remove"),
      t("prefs.theme.removeBody"),
    ))
  )
    return;
  // Removing the active palette falls back to the built-in one in the module, whose onThemeChange refreshes both refs.
  removeCustomTheme(gone.id);
  toast(t("prefs.theme.removeDone", { name: gone.label }));
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
    :title="t('prefs.title')"
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
        :label="t('prefs.categories')"
        :panels="panesId"
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
          <h3 class="prefs-pane-title" tabindex="-1">{{ t("prefs.tab.appearance") }}</h3>
          <div class="prefs-grid">
            <LanguageCard />
            <div class="pref-card wide">
              <div class="pref-head">
                <label class="pref-title" for="prefs-theme">{{ t("prefs.theme.title") }}</label>
                <Select
                  id="prefs-theme"
                  :label="t('prefs.theme.title')"
                  aria-describedby="prefs-theme-hint"
                  :model-value="theme"
                  :options="themeOptions"
                  @update:model-value="onTheme"
                />
              </div>
              <p id="prefs-theme-hint" class="pref-hint">{{ t("prefs.theme.hint") }}</p>
              <div class="prefs-actions">
                <input
                  ref="fileInput"
                  id="prefs-theme-file"
                  class="hidden"
                  type="file"
                  accept="application/json,.json"
                  @change="onUpload"
                />
                <Button @click="pickThemeFile">{{ t("prefs.theme.upload") }}</Button>
                <Button v-if="activeIsCustom" @click="onRemoveTheme">{{ t("prefs.theme.remove") }}</Button>
              </div>
              <p id="prefs-theme-error" class="pref-hint prefs-theme-error" role="alert">{{ themeError }}</p>
              <p id="prefs-theme-warning" class="pref-hint prefs-theme-warning" role="status">{{ themeWarning }}</p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <label class="pref-title" for="prefs-iconpack">{{ t("prefs.icons.title") }}</label>
                <Select
                  id="prefs-iconpack"
                  :label="t('prefs.icons.title')"
                  :model-value="pack"
                  :options="packOptions"
                  @update:model-value="onPack"
                />
              </div>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">{{ t("prefs.units.title") }}</span>
                <Segmented
                  id="prefs-unit"
                  aria-describedby="prefs-unit-hint"
                  :label="t('prefs.units.title')"
                  :model-value="unit"
                  :options="UNITS"
                  @update:model-value="pickUnit"
                />
              </div>
              <p id="prefs-unit-hint" class="pref-hint">{{ t("prefs.units.hint") }}</p>
            </div>
            <div class="pref-card wide">
              <div class="pref-head">
                <span class="pref-title">{{ t("prefs.homeBackground.title") }}</span>
                <Segmented
                  id="prefs-home-background"
                  aria-describedby="prefs-home-background-hint"
                  :label="t('prefs.homeBackground.title')"
                  :model-value="homeBg"
                  :options="HOME_BACKGROUND_OPTIONS"
                  @pointerdown="notePointer(true)"
                  @keydown.capture="notePointer(false)"
                  @update:model-value="pickHomeBackground"
                />
              </div>
              <p id="prefs-home-background-hint" class="pref-hint">{{ t("prefs.homeBackground.hint") }}</p>
              <div v-if="homeBg === 'image'" class="prefs-actions">
                <Button @click="homeImageInput?.click()">{{ t("prefs.homeBackground.choose") }}</Button>
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
          <h3 class="prefs-pane-title" tabindex="-1">{{ t("prefs.tab.viewport") }}</h3>
          <div class="prefs-grid">
            <div class="pref-card">
              <div class="pref-head">
                <label class="pref-title" for="prefs-environment">{{ t("prefs.reflections.title") }}</label>
                <Select
                  id="prefs-environment"
                  :label="t('prefs.reflections.title')"
                  :model-value="render.environment"
                  :options="environmentOptions"
                  aria-describedby="prefs-environment-hint"
                  @update:model-value="onEnvironment"
                />
              </div>
              <p id="prefs-environment-hint" class="pref-hint">{{ t("prefs.reflections.hint") }}</p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">{{ t("prefs.background.title") }}</span>
                <Segmented
                  id="prefs-background"
                  :label="t('prefs.background.title')"
                  :model-value="render.background"
                  :options="BACKGROUNDS"
                  @update:model-value="pickBackground"
                />
              </div>
            </div>
            <div class="pref-card">
              <Slider
                id="prefs-brightness"
                v-range-hint="'prefs-brightness-hint'"
                :label="t('prefs.brightness.title')"
                unit="%"
                show-value
                :min="BRIGHTNESS_PCT.min"
                :max="BRIGHTNESS_PCT.max"
                :step="5"
                :model-value="Math.round(render.brightness * 100)"
                @update:model-value="onBrightness"
              />
              <p id="prefs-brightness-hint" class="pref-hint">{{ t("prefs.brightness.hint") }}</p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">{{ t("prefs.tangent.title") }}</span>
                <Segmented
                  id="prefs-tangent-edges"
                  aria-describedby="prefs-tangent-edges-hint"
                  :label="t('prefs.tangent.title')"
                  :model-value="render.tangentEdges"
                  :options="TANGENT"
                  @update:model-value="pickTangent"
                />
              </div>
              <p id="prefs-tangent-edges-hint" class="pref-hint">{{ t("prefs.tangent.hint") }}</p>
            </div>
            <div class="pref-card">
              <Slider
                id="prefs-bloom"
                v-range-hint="'prefs-bloom-hint'"
                :label="t('prefs.bloom.title')"
                unit="%"
                show-value
                :min="0"
                :max="100"
                :step="5"
                :model-value="Math.round(render.bloom * 100)"
                @update:model-value="onBloom"
              />
              <p id="prefs-bloom-hint" class="pref-hint">{{ t("prefs.bloom.hint") }}</p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">{{ t("prefs.tracer.title") }}</span>
                <Segmented
                  id="prefs-tracer"
                  aria-describedby="prefs-tracer-hint"
                  :label="t('prefs.tracer.title')"
                  :model-value="render.tracer"
                  :options="TRACERS"
                  @update:model-value="pickTracer"
                />
              </div>
              <p id="prefs-tracer-hint" class="pref-hint">{{ t("prefs.tracer.hint") }}</p>
              <DenoiserRow hint-class="pref-hint" button-class="btn btn-md" />
            </div>
            <div class="pref-card">
              <Checkbox
                id="prefs-performance-mode"
                class="pref-head pref-check"
                :model-value="performanceModeOn(render)"
                :disabled="render.potatoMode"
                @update:model-value="onPerformanceMode"
                ><span class="pref-title">{{ t("prefs.performance.title") }}</span></Checkbox
              >
              <p class="pref-hint">{{ t("prefs.performance.hint") }}</p>
              <Checkbox
                id="prefs-potato-mode"
                class="pref-head pref-sub pref-check"
                :tip="t('prefs.potato.tip')"
                :model-value="render.potatoMode"
                @update:model-value="onPotatoMode"
                ><span class="pref-title">{{ t("prefs.potato.title") }}</span></Checkbox
              >
              <p class="pref-hint">{{ t("prefs.potato.hint") }}</p>
            </div>
          </div>
        </section>

        <section v-show="category === 'navigation'" v-bind="pane('navigation')" class="prefs-pane">
          <h3 class="prefs-pane-title" tabindex="-1">{{ t("prefs.tab.navigation") }}</h3>
          <div class="prefs-grid">
            <div class="pref-card">
              <Slider
                id="prefs-smoothing"
                v-range-hint="'prefs-smoothing-hint'"
                :label="t('prefs.smoothing.title')"
                unit="ms"
                show-value
                :min="0"
                :max="300"
                :step="5"
                :model-value="Math.round(nav.smoothTime * 1000)"
                @update:model-value="onSmoothing"
              />
              <p id="prefs-smoothing-hint" class="pref-hint">{{ t("prefs.smoothing.hint") }}</p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">{{ t("prefs.orbitPivot.title") }}</span>
                <Segmented
                  id="prefs-orbit-pivot"
                  aria-describedby="prefs-orbit-pivot-hint"
                  :label="t('prefs.orbitPivot.title')"
                  :model-value="nav.orbitPivot"
                  :options="ORBIT_PIVOTS"
                  @update:model-value="pickOrbitPivot"
                />
              </div>
              <p id="prefs-orbit-pivot-hint" class="pref-hint">{{ t("prefs.orbitPivot.hint") }}</p>
            </div>
            <div class="pref-card">
              <Checkbox
                id="prefs-inertia"
                class="pref-head pref-check"
                :model-value="nav.inertia"
                @update:model-value="onInertia"
                ><span class="pref-title">{{ t("prefs.inertia.title") }}</span></Checkbox
              >
              <p class="pref-hint">{{ t("prefs.inertia.hint") }}</p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">{{ t("prefs.scrolling.title") }}</span>
                <Segmented
                  id="prefs-wheel-device"
                  aria-describedby="prefs-wheel-device-hint"
                  :label="t('prefs.scrolling.title')"
                  :model-value="nav.wheelDevice"
                  :options="WHEEL_DEVICES"
                  @update:model-value="pickWheelDevice"
                />
              </div>
              <p id="prefs-wheel-device-hint" class="pref-hint">{{ t("prefs.scrolling.hint", { seen: wheelSeen }) }}</p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">{{ t("prefs.twoFinger.title") }}</span>
                <Segmented
                  id="prefs-touchpad-scroll"
                  aria-describedby="prefs-touchpad-scroll-hint"
                  :label="t('prefs.twoFinger.title')"
                  :model-value="nav.touchpadScroll"
                  :options="TOUCHPAD_SCROLL"
                  @update:model-value="pickTouchpadScroll"
                />
              </div>
              <p id="prefs-touchpad-scroll-hint" class="pref-hint">{{ t("prefs.twoFinger.hint") }}</p>
            </div>
            <div class="pref-card">
              <Checkbox
                id="prefs-classic-camera"
                class="pref-head pref-check"
                :model-value="classicCamera"
                @update:model-value="onClassicCamera"
                ><span class="pref-title">{{ t("prefs.classic.title") }}</span></Checkbox
              >
              <p class="pref-hint">{{ t("prefs.classic.hint") }}</p>
            </div>
          </div>
        </section>

        <section v-show="category === 'access'" v-bind="pane('access')" class="prefs-pane">
          <h3 class="prefs-pane-title" tabindex="-1">{{ t("prefs.tab.access") }}</h3>
          <div class="prefs-a11y-actions">
            <Button data-a11y-preset aria-describedby="prefs-a11y-actions-hint" @click="screenReaderPreset">{{
              t("prefs.access.preset")
            }}</Button>
            <Button
              :disabled="!a11yChanged"
              data-a11y-reset
              aria-describedby="prefs-a11y-actions-hint"
              @click="onResetA11y"
              >{{ t("prefs.access.reset") }}</Button
            >
            <span id="prefs-a11y-preset-status" class="prefs-a11y-status" role="status">{{ presetNote }}</span>
            <p id="prefs-a11y-actions-hint" class="pref-hint">{{ t("prefs.access.hint") }}</p>
            <Button variant="ghost" size="sm" data-a11y-manual @click="void openExternal(ACCESSIBILITY_PAGE)">{{
              t("prefs.accessibility.manualLink")
            }}</Button>
          </div>

          <div class="prefs-group" role="group" aria-labelledby="prefs-a11y-vision">
            <h4 id="prefs-a11y-vision" class="prefs-group-title">{{ t("prefs.group.vision") }}</h4>
            <div class="prefs-grid">
              <div class="pref-card">
                <div class="pref-head">
                  <span class="pref-title">{{ t("prefs.access.theme.title") }}</span>
                  <Button
                    data-a11y-appearance
                    aria-describedby="prefs-a11y-theme-hint"
                    @click="showPane('appearance')"
                    >{{ t("prefs.access.theme.open") }}</Button
                  >
                </div>
                <p id="prefs-a11y-theme-hint" class="pref-hint">{{ t("prefs.access.theme.hint") }}</p>
              </div>
              <A11yContrastRows />
              <A11ySizeRows />
            </div>
          </div>

          <div class="prefs-group" role="group" aria-labelledby="prefs-a11y-speech">
            <h4 id="prefs-a11y-speech" class="prefs-group-title">{{ t("prefs.group.speech") }}</h4>
            <div class="prefs-grid">
              <div class="pref-card wide">
                <div class="pref-head pref-wrap">
                  <span class="pref-title">{{ t("prefs.verbosity.title") }}</span>
                  <Segmented
                    id="prefs-verbosity"
                    :label="t('prefs.verbosity.title')"
                    aria-describedby="prefs-verbosity-hint"
                    :model-value="a11y.verbosity"
                    :options="VERBOSITY"
                    @update:model-value="pickVerbosity"
                  />
                </div>
                <p id="prefs-verbosity-hint" class="pref-hint">{{ t("prefs.verbosity.hint") }}</p>
              </div>
              <div class="pref-card">
                <Checkbox
                  id="prefs-units-in-full"
                  v-check-hint="'prefs-units-in-full-hint'"
                  class="pref-head pref-check"
                  :model-value="a11y.unitsInFull"
                  @update:model-value="(on: boolean) => setA11yPref('unitsInFull', on)"
                  ><span class="pref-title">{{ t("prefs.unitsFull.title") }}</span></Checkbox
                >
                <p id="prefs-units-in-full-hint" class="pref-hint">{{ t("prefs.unitsFull.hint") }}</p>
              </div>
            </div>
          </div>

          <div class="prefs-group" role="group" aria-labelledby="prefs-a11y-input">
            <h4 id="prefs-a11y-input" class="prefs-group-title">{{ t("prefs.group.input") }}</h4>
            <div class="prefs-grid">
              <div class="pref-card">
                <Slider
                  id="prefs-hover-dwell"
                  v-range-hint="'prefs-hover-dwell-hint'"
                  :label="t('prefs.hover.title')"
                  unit="ms"
                  show-value
                  :min="MIN_DWELL_MS"
                  :max="MAX_DWELL_MS"
                  :step="50"
                  :model-value="dwell"
                  @update:model-value="setHoverDwellMs"
                />
                <p id="prefs-hover-dwell-hint" class="pref-hint">{{ t("prefs.hover.hint") }}</p>
              </div>
              <NoticeTimeRow />
              <div class="pref-card">
                <Checkbox
                  id="prefs-single-keys"
                  v-check-hint="'prefs-single-keys-hint'"
                  class="pref-head pref-check"
                  :model-value="a11y.singleKeys"
                  @update:model-value="(on: boolean) => setA11yPref('singleKeys', on)"
                  ><span class="pref-title">{{ t("prefs.singleKeys.title") }}</span></Checkbox
                >
                <p id="prefs-single-keys-hint" class="pref-hint">{{ t("prefs.singleKeys.hint") }}</p>
              </div>
              <LargerTargetsRow />
            </div>
          </div>

          <div class="prefs-group" role="group" aria-labelledby="prefs-a11y-motion">
            <h4 id="prefs-a11y-motion" class="prefs-group-title">{{ t("prefs.group.motion") }}</h4>
            <div class="prefs-grid">
              <div class="pref-card">
                <div class="pref-head">
                  <span class="pref-title">{{ t("prefs.animations.title") }}</span>
                  <Segmented
                    id="prefs-motion"
                    :label="t('prefs.animations.title')"
                    aria-describedby="prefs-motion-hint"
                    :model-value="a11y.animations"
                    :options="ANIMATIONS"
                    @update:model-value="pickAnimations"
                  />
                </div>
                <p id="prefs-motion-hint" class="pref-hint">
                  {{ t("prefs.animations.hint") }}
                  <template v-if="a11y.animations === 'system'">{{
                    t("prefs.animations.systemNow", { state: motionState })
                  }}</template>
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
      <Button variant="primary" @click="close()">{{ t("prefs.done") }}</Button>
    </template>
  </Dialog>
</template>
