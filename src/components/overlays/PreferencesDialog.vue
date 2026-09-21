<script setup lang="ts">
// Preferences: one surface for the settings that were scattered across the
// title bar (theme, icons, units) plus the shell arrangement, which had no
// surface at all. Categories down the side, each one a grid of cards.
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
//
// Every pane stays in the DOM (v-show), so a control keeps its id whichever
// category is open.

import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { contributedSettings, onContribChange } from "../../plugins/contrib";
import { useDialogStore } from "../../stores/dialogs";
import { useModalGate } from "../../composables/useModalGate";
import ModalFrame from "./ModalFrame.vue";
import Select from "../ui/Select.vue";
import McpSection from "./McpSection.vue";
import PluginsSection from "./PluginsSection.vue";
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
  getHoverDwellMs,
  MAX_DWELL_MS,
  MIN_DWELL_MS,
  onHoverDwellChange,
  setHoverDwellMs,
} from "../../ui/interactionPrefs";
import {
  asBackground,
  asBloom,
  asEnvironment,
  asTangentEdges,
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
// Only an uploaded palette is removable; the built-in theme and the shipped
// ones (Dracula, Solarized Light) sit in the picker the same way but stay put.
const activeIsCustom = computed(() => customThemes().some((t) => t.id === theme.value));
const pack = ref(getIconPack());
const unit = ref(getUnit());
const render = ref(renderPrefs());
const dwell = ref(getHoverDwellMs());
const motion = ref(motionOn());

const sections = shallowRef(contributedSettings());

const stops: (() => void)[] = [];
onMounted(() => {
  stops.push(
    onThemeChange(() => { theme.value = getTheme(); themeList.value = themes(); }),
    onIconPackChange(() => { pack.value = getIconPack(); }),
    onUnitChange(() => { unit.value = getUnit(); }),
    onRenderPrefsChange(() => { render.value = renderPrefs(); }),
    onHoverDwellChange(() => { dwell.value = getHoverDwellMs(); }),
    onMotionChange(() => { motion.value = motionOn(); }),
    onContribChange(() => { sections.value = contributedSettings(); }),
  );
});
onUnmounted(() => { for (const stop of stops) stop(); });

// Plugin sections come after the core categories, in the order the plugins
// registered them, and the plugin list itself is last.
const categories = computed(() => [
  { id: "appearance", label: "Appearance" },
  { id: "viewport", label: "Viewport" },
  { id: "access", label: "Accessibility" },
  { id: "mcp", label: "AI assistants" },
  ...sections.value.map((x) => ({ id: `plugin:${x.key}`, label: x.section.title })),
  { id: "plugins", label: "Plugins" },
]);
const category = ref("appearance");

const UNITS = [
  { id: "mm", label: "mm" },
  { id: "cm", label: "cm" },
  { id: "in", label: "in" },
];
const BACKGROUNDS = [
  { id: "theme", label: "Theme" },
  { id: "dark", label: "Dark" },
  { id: "grey", label: "Grey" },
  { id: "light", label: "Light" },
];
const TANGENT = [
  { id: "show", label: "Show" },
  { id: "faint", label: "Faint" },
  { id: "hide", label: "Hide" },
];

const value = (ev: Event) => (ev.target as HTMLSelectElement).value;

// The pickers take {value,label}; these rosters are all keyed by id.
const themeOptions = computed(() => themeList.value.map((t) => ({ value: t.id, label: t.label })));
const packOptions = computed(() => iconPacks().map((p) => ({ value: p.id, label: p.label })));
const environmentOptions = ENVIRONMENTS_LIST.map((e) => ({ value: e.id, label: e.label, hint: e.note }));

// Every write goes through the module's own gate, so a choice that no longer
// matches anything is refused at the same place a corrupt stored value is.
function onTheme(id: string) { const v = asThemeId(id); if (v) setTheme(v); }

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
function onPack(id: string) { const v = asIconPackId(id); if (v) setIconPack(v); }
function pickUnit(id: string) { const v = asUnit(id); if (v) setUnit(v); }
function onEnvironment(id: string) { const v = asEnvironment(id); if (v) setRenderPref("environment", v); }
function pickBackground(id: string) { const v = asBackground(id); if (v) setRenderPref("background", v); }
function onBrightness(ev: Event) { setRenderPref("brightness", Number.parseFloat(value(ev))); }
function onDwell(ev: Event) { setHoverDwellMs(Number.parseFloat(value(ev))); }
function onBloom(ev: Event) { const v = asBloom(value(ev)); if (v !== null) setRenderPref("bloom", v); }
function pickTangent(id: string) { const v = asTangentEdges(id); if (v) setRenderPref("tangentEdges", v); }
function onPerformanceMode(ev: Event) { setRenderPref("performanceMode", (ev.target as HTMLInputElement).checked); }
function onMotion(ev: Event) { setMotion((ev.target as HTMLInputElement).checked); }
</script>

<template>
  <ModalFrame panel-class="prefs-panel" @close="close()">
    <template #title>Preferences</template>

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
        >{{ c.label }}</button>
      </nav>

      <div class="prefs-panes">
        <section v-show="category === 'appearance'" class="prefs-pane">
          <h3 class="prefs-pane-title">Appearance</h3>
          <div class="prefs-grid">
            <div class="pref-card wide">
              <div class="pref-head">
                <label class="pref-title" for="prefs-theme">Theme</label>
                <Select id="prefs-theme" :model-value="theme" :options="themeOptions" @update:model-value="onTheme" />
              </div>
              <p class="pref-hint">
                FundaCAD Noir, Dracula, Solarized Light and the Noir Blue/Red/Orange tints ship
                with FundaCAD. Upload a JSON palette to add your own, it is stored in this
                browser's preferences. Keys are colour tokens like <code>--bg</code> and
                <code>--accent</code>, values are hex or rgb().
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
                <button type="button" class="btn" @click="pickThemeFile">Upload theme…</button>
                <button v-if="activeIsCustom" type="button" class="btn" @click="onRemoveTheme">Remove</button>
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
                <div id="prefs-unit" class="pref-seg" role="radiogroup" aria-label="Units">
                  <button
                    v-for="u in UNITS"
                    :key="u.id"
                    type="button"
                    role="radio"
                    :aria-checked="unit === u.id"
                    :class="{ on: unit === u.id }"
                    @click="pickUnit(u.id)"
                  >{{ u.label }}</button>
                </div>
              </div>
              <p class="pref-hint">Geometry is always stored in millimetres, this is display only.</p>
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
                A metal is almost entirely reflection, so with none it renders nearly
                black. Flat is the clearer way to read shape.
              </p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">Background</span>
                <div id="prefs-background" class="pref-seg" role="radiogroup" aria-label="Background">
                  <button
                    v-for="b in BACKGROUNDS"
                    :key="b.id"
                    type="button"
                    role="radio"
                    :aria-checked="render.background === b.id"
                    :class="{ on: render.background === b.id }"
                    @click="pickBackground(b.id)"
                  >{{ b.label }}</button>
                </div>
              </div>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <label class="pref-title" for="prefs-brightness">Brightness</label>
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
              <p class="pref-hint">Lights and reflections together, so the two stay in step.</p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <span class="pref-title">Tangent edges</span>
                <div id="prefs-tangent-edges" class="pref-seg" role="radiogroup" aria-label="Tangent edges">
                  <button
                    v-for="t in TANGENT"
                    :key="t.id"
                    type="button"
                    role="radio"
                    :aria-checked="render.tangentEdges === t.id"
                    :class="{ on: render.tangentEdges === t.id }"
                    @click="pickTangent(t.id)"
                  >{{ t.label }}</button>
                </div>
              </div>
              <p class="pref-hint">
                Where two faces meet smoothly, like the borders of a fillet, there is no
                corner to see, only a line across one continuous surface.
              </p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <label class="pref-title" for="prefs-bloom">Bloom</label>
              </div>
              <input id="prefs-bloom" class="sm-slider pref-slider" type="range" min="0" max="1" step="0.05"
                :value="render.bloom" @input="onBloom" />
              <p class="pref-hint">
                Light spilling off the brightest parts of the image. The lower half reaches
                a material with Glow turned up and a hard specular highlight and nothing
                else, so an ordinary part looks the same; turn it up to catch everyday
                highlights too.
              </p>
            </div>
            <div class="pref-card">
              <label class="pref-head">
                <span class="pref-title">Performance mode</span>
                <span class="param-switch">
                  <input
                    id="prefs-performance-mode"
                    type="checkbox"
                    :checked="render.performanceMode"
                    @change="onPerformanceMode"
                  />
                  <span class="track"><span class="knob"></span></span>
                </span>
              </label>
              <p class="pref-hint">
                Drops glass refraction, the high pixel ratio and the emitter shadows for a
                lighter render. Weak GPUs get it automatically; turn it on if the viewport
                stutters or a laptop runs hot.
              </p>
            </div>
          </div>
        </section>

        <section v-show="category === 'access'" class="prefs-pane">
          <h3 class="prefs-pane-title">Accessibility</h3>
          <div class="prefs-grid">
            <div class="pref-card">
              <label class="pref-head">
                <span class="pref-title">Animations</span>
                <span class="param-switch">
                  <input id="prefs-motion" type="checkbox" :checked="motion" @change="onMotion" />
                  <span class="track"><span class="knob"></span></span>
                </span>
              </label>
              <p class="pref-hint">
                Off makes every transition instant: menus, panels, the error notice
                and camera moves all jump straight to where they end. Follows the
                system's reduce motion setting until changed here.
              </p>
            </div>
            <div class="pref-card">
              <div class="pref-head">
                <label class="pref-title" for="prefs-hover-dwell">Hover delay</label>
                <span class="prefs-readout">{{ (dwell / 1000).toFixed(2) }} s</span>
              </div>
              <input id="prefs-hover-dwell" class="sm-slider pref-slider" type="range" :min="MIN_DWELL_MS"
                :max="MAX_DWELL_MS" step="50" :value="dwell" @input="onDwell" />
              <p class="pref-hint">
                How long the pointer rests on a part before its face is highlighted
                instead of the whole part. A click selects whatever is highlighted, so a
                longer delay makes it easier to select whole parts.
              </p>
            </div>
          </div>
        </section>

        <section v-show="category === 'mcp'" class="prefs-pane prefs-pane-flow">
          <McpSection />
        </section>

        <!-- What the running plugins ask about. A plugin that is not installed
             leaves no category behind. -->
        <section
          v-for="x in sections"
          v-show="category === `plugin:${x.key}`"
          :key="x.key"
          class="prefs-pane prefs-pane-flow"
        >
          <h3 class="prefs-pane-title">{{ x.section.title }}</h3>
          <component :is="x.section.component" />
        </section>

        <section v-show="category === 'plugins'" class="prefs-pane prefs-pane-flow">
          <PluginsSection />
        </section>
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn btn-primary" @click="close()">Done</button>
    </div>
  </ModalFrame>
</template>
