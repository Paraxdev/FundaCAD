<script setup lang="ts">
// Mirrors the setting modules (ui/theme, icons, units, renderPrefs) with no store of its own, every change applies live.
// The mirrors re-read on each module's subscription, the modules stay Vue-free so the headless suite can import them.

import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useDialogStore } from "../../stores/dialogs";
import { pluginFocus } from "../../plugins/settingsFocus";
import Button from "../ui/Button.vue";
import Checkbox from "../ui/Checkbox.vue";
import Dialog from "../ui/Dialog.vue";
import Segmented from "../ui/Segmented.vue";
import Select from "../ui/Select.vue";
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
import { motionOn, onMotionChange, setMotion } from "../../ui/motion";
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
const motion = ref(motionOn());
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
    onMotionChange(() => {
      motion.value = motionOn();
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
  { id: "appearance", label: "Appearance" },
  { id: "viewport", label: "Viewport" },
  { id: "navigation", label: "Navigation" },
  { id: "access", label: "Accessibility" },
  { id: "updates", label: "Updates" },
  { id: "mcp", label: "AI assistants" },
  { id: "plugins", label: "Plugins" },
  { id: "experimental", label: "Experimental" },
]);
const category = ref(pluginFocus.value ? "plugins" : "appearance");
watch(pluginFocus, (id) => {
  if (id) category.value = "plugins";
});

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

const value = (ev: Event) => (ev.target as HTMLSelectElement).value;

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

async function pickHomeBackground(id: HomeBackground) {
  homeImageError.value = "";
  if (id === "image" && !(await loadHomeImage())) {
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
function onBrightness(ev: Event) {
  setRenderPref("brightness", Number.parseFloat(value(ev)));
}
function onDwell(ev: Event) {
  setHoverDwellMs(Number.parseFloat(value(ev)));
}
function onBloom(ev: Event) {
  const v = asBloom(Number.parseFloat(value(ev)));
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
function onSmoothing(ev: Event) {
  setNavPrefs({ smoothTime: Number.parseFloat(value(ev)) });
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
    initial-focus=".prefs-nav-btn.active"
    @close="close()"
  >
    <div class="modal-body prefs">
      <nav class="prefs-nav" aria-label="Preference categories">
        <button
          v-for="c in categories"
          :key="c.id"
          type="button"
          class="prefs-nav-btn"
          :class="{ active: category === c.id }"
          :aria-current="category === c.id ? 'page' : undefined"
          :data-category="c.id"
          @click="category = c.id"
          >{{ c.label }}</button
        >
      </nav>

      <div class="prefs-panes">
        <!-- v-show, so a control keeps its id whichever category is open. -->
        <section v-show="category === 'appearance'" class="prefs-pane">
          <h3 class="prefs-pane-title">Appearance</h3>
          <div class="prefs-grid">
            <div class="pref-card wide">
              <div class="pref-head">
                <label class="pref-title" for="prefs-theme">Theme</label>
                <Select id="prefs-theme" :model-value="theme" :options="themeOptions" @update:model-value="onTheme" />
              </div>
              <p class="pref-hint">
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
              <p v-if="themeError" class="pref-hint prefs-theme-error">{{ themeError }}</p>
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
                  label="Units"
                  :model-value="unit"
                  :options="UNITS"
                  @update:model-value="pickUnit"
                />
              </div>
              <p class="pref-hint">Geometry is always stored in millimetres, this is display only.</p>
            </div>
            <div class="pref-card wide">
              <div class="pref-head">
                <span class="pref-title">Home background</span>
                <Segmented
                  id="prefs-home-background"
                  label="Home background"
                  :model-value="homeBg"
                  :options="HOME_BACKGROUND_OPTIONS"
                  @update:model-value="pickHomeBackground"
                />
              </div>
              <p class="pref-hint">What Home sits on. Workspace shows your model dimmed behind it.</p>
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
              <p v-if="homeImageError" class="pref-hint prefs-theme-error">{{ homeImageError }}</p>
            </div>
          </div>
        </section>

        <section v-show="category === 'viewport'" class="prefs-pane">
          <h3 class="prefs-pane-title">Viewport</h3>
          <div class="prefs-grid">
            <div class="pref-card">
              <div class="pref-head">
                <label class="pref-title" for="prefs-environment">Reflections</label>
                <Select
                  id="prefs-environment"
                  :model-value="render.environment"
                  :options="environmentOptions"
                  @update:model-value="onEnvironment"
                />
              </div>
              <p class="pref-hint">
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
              <div class="pref-head">
                <label class="pref-title" for="prefs-brightness">Environment brightness</label>
              </div>
              <input
                id="prefs-brightness"
                class="sm-slider pref-slider"
                type="range"
                :min="MIN_BRIGHTNESS"
                :max="MAX_BRIGHTNESS"
                step="0.05"
                :value="render.brightness"
                @input="onBrightness"
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
                  label="Tangent edges"
                  :model-value="render.tangentEdges"
                  :options="TANGENT"
                  @update:model-value="pickTangent"
                />
              </div>
              <p class="pref-hint">
                Where two faces meet smoothly, like the borders of a fillet, there is no corner to see, only a line
                across one continuous surface.
              </p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <label class="pref-title" for="prefs-bloom">Bloom</label>
              </div>
              <input
                id="prefs-bloom"
                class="sm-slider pref-slider"
                type="range"
                min="0"
                max="1"
                step="0.05"
                :value="render.bloom"
                @input="onBloom"
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
                  label="Path tracer"
                  :model-value="render.tracer"
                  :options="TRACERS"
                  @update:model-value="pickTracer"
                />
              </div>
              <p class="pref-hint">
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

        <section v-show="category === 'navigation'" class="prefs-pane">
          <h3 class="prefs-pane-title">Navigation</h3>
          <div class="prefs-grid">
            <div class="pref-card">
              <div class="pref-head">
                <label class="pref-title" for="prefs-smoothing">Smoothing</label>
                <span class="prefs-readout">{{ nav.smoothTime.toFixed(3) }} s</span>
              </div>
              <input
                id="prefs-smoothing"
                class="sm-slider pref-slider"
                type="range"
                min="0"
                max="0.3"
                step="0.005"
                :value="nav.smoothTime"
                @input="onSmoothing"
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
                  label="Orbit pivot"
                  :model-value="nav.orbitPivot"
                  :options="ORBIT_PIVOTS"
                  @update:model-value="pickOrbitPivot"
                />
              </div>
              <p class="pref-hint">
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
                  label="Scrolling"
                  :model-value="nav.wheelDevice"
                  :options="WHEEL_DEVICES"
                  @update:model-value="pickWheelDevice"
                />
              </div>
              <p class="pref-hint">
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
                  label="Two-finger scroll"
                  :model-value="nav.touchpadScroll"
                  :options="TOUCHPAD_SCROLL"
                  @update:model-value="pickTouchpadScroll"
                />
              </div>
              <p class="pref-hint">
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

        <section v-show="category === 'access'" class="prefs-pane">
          <h3 class="prefs-pane-title">Accessibility</h3>
          <div class="prefs-grid">
            <div class="pref-card">
              <Checkbox
                id="prefs-motion"
                class="pref-head pref-check"
                :model-value="motion"
                @update:model-value="setMotion"
                ><span class="pref-title">Animations</span></Checkbox
              >
              <p class="pref-hint">
                Off makes every transition instant: menus, panels, the error notice and camera moves all jump straight
                to where they end. Follows the system's reduce motion setting until changed here.
              </p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <label class="pref-title" for="prefs-hover-dwell">Hover delay</label>
                <span class="prefs-readout">{{ (dwell / 1000).toFixed(2) }} s</span>
              </div>
              <input
                id="prefs-hover-dwell"
                class="sm-slider pref-slider"
                type="range"
                :min="MIN_DWELL_MS"
                :max="MAX_DWELL_MS"
                step="50"
                :value="dwell"
                @input="onDwell"
              />
              <p class="pref-hint">
                How long the pointer rests on a part before its face is highlighted instead of the whole part. A click
                selects whatever is highlighted, so a longer delay makes it easier to select whole parts.
              </p>
            </div>
          </div>
        </section>

        <section v-show="category === 'updates'" class="prefs-pane">
          <UpdatesSection />
        </section>

        <section v-show="category === 'mcp'" class="prefs-pane prefs-pane-flow">
          <McpSection />
        </section>

        <section v-show="category === 'plugins'" class="prefs-pane prefs-pane-flow">
          <PluginsSection />
        </section>

        <section v-show="category === 'experimental'" class="prefs-pane" data-prefs-experimental>
          <ExperimentalSection />
        </section>
      </div>
    </div>

    <template #footer>
      <Button variant="primary" @click="close()">Done</Button>
    </template>
  </Dialog>
</template>
