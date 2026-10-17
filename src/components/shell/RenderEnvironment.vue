<script setup lang="ts">
// What the model is lit by and drawn against.
//
// Together on one tab because they are one decision. Choosing a dark room and
// leaving a light background gives a part lit from a room it is plainly not in;
// the two are read as one picture and are best chosen as one.
//
// The same settings are also in Preferences, and that is deliberate rather than
// a duplication to be tidied away. Preferences is where you go to say how the
// app should behave; this is where you go while looking at the part, and the
// gesture here is trying six of them in ten seconds. A grid of swatches is the
// right control for that and a dropdown in a modal is not.

import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import {
  ENVIRONMENTS_LIST, MAX_BRIGHTNESS, MAX_EXPOSURE, MIN_BRIGHTNESS, MIN_EXPOSURE, hdrHashOf,
  onRenderPrefsChange, performanceModeOn, renderPrefs, setRenderPref,
  type Background, type Denoise, type Environment, type TracerPref,
} from "../../ui/renderPrefs";
import {
  activeSavedId, applySavedEnvironment, chooseBuiltInEnvironment, deleteSavedEnvironment, envLibrary, hdrName,
  importEnvironmentFile, onEnvLibraryChange, renameSavedEnvironment, saveEnvironmentAs,
} from "../../ui/environmentImport";
import type { EnvEntry } from "../../ui/environmentLibrary";
import { onHdrRegistered } from "../../viewport/hdrRegistry";
import { DEFAULT_KEY } from "../../viewport/keyLight";
import { formatTurn } from "../../viewport/rotateDial";
import { useEngine } from "../../app/engineKey";

const engine = useEngine();
const prefs = ref({ ...renderPrefs() });
const aiming = ref(false);
const saved = ref<EnvEntry[]>([]);
const activeSaved = ref<string | null>(activeSavedId());
const notice = ref<string | null>(null);
const naming = ref<{ id: string | null; text: string } | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const hdrLabel = ref<string | null>(null);
const hdrHash = computed(() => hdrHashOf(prefs.value.environment));
const offs: (() => void)[] = [];
const loadSaved = () => {
  activeSaved.value = activeSavedId();
  void envLibrary().list().then((l) => { saved.value = l; }).catch(() => { saved.value = []; });
};
const syncLabel = () => { hdrLabel.value = hdrHash.value ? hdrName(hdrHash.value) : null; };
onMounted(() => {
  offs.push(onRenderPrefsChange(() => { prefs.value = { ...renderPrefs() }; syncLabel(); }));
  offs.push(onEnvLibraryChange(loadSaved));
  offs.push(onHdrRegistered(syncLabel));
  loadSaved();
  syncLabel();
});
onUnmounted(() => { for (const off of offs) off(); });

const fail = (err: unknown) => { notice.value = err instanceof Error ? err.message : String(err); };

const importFile = async (file: File) => {
  notice.value = `Reading ${file.name}...`;
  const refused = await importEnvironmentFile(engine.store, file);
  notice.value = refused;
};
const onFilePicked = (e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) void importFile(file);
};
const pickSaved = (entry: EnvEntry) => {
  notice.value = null;
  void applySavedEnvironment(engine.store, entry).catch(fail);
};
const startNaming = (id: string | null, text: string) => {
  naming.value = { id, text };
  void nextTick(() => { nameInput.value?.focus(); nameInput.value?.select(); });
};
const finishNaming = async () => {
  const n = naming.value;
  if (!n) return;
  naming.value = null;
  try {
    if (n.id) await renameSavedEnvironment(n.id, n.text);
    else await saveEnvironmentAs(engine.store, n.text);
    notice.value = null;
  } catch (err) {
    fail(err);
  }
};
const saveName = () => (hdrLabel.value ?? "My environment").replace(/\.(hdr|exr)$/i, "");
const removeSaved = (entry: EnvEntry) => {
  void deleteSavedEnvironment(entry.id).catch(fail);
};
const thumbStyle = (thumb: string) =>
  thumb.startsWith("data:") ? { backgroundImage: `url("${thumb}")`, backgroundSize: "cover" } : { background: thumb };
const onRotation = (e: Event) => {
  setRenderPref("envRotation", Number.parseFloat((e.target as HTMLInputElement).value));
};
const onExposure = (e: Event) => {
  setRenderPref("envExposure", Number.parseFloat((e.target as HTMLInputElement).value));
};
const toggleBehind = () => {
  setRenderPref("envBackground", !prefs.value.envBackground);
};

const BACKGROUNDS: { id: Background; label: string }[] = [
  { id: "theme", label: "Theme" },
  { id: "dark", label: "Dark" },
  { id: "grey", label: "Mid grey" },
  { id: "light", label: "Light" },
];

const pickEnv = (id: Environment) => {
  chooseBuiltInEnvironment(engine.store, id);
};
const DENOISES: { id: Denoise; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "standard", label: "Standard" },
  { id: "high", label: "High quality" },
];
const TRACERS: { id: TracerPref; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "native", label: "Native" },
  { id: "webgpu", label: "WebGPU" },
];
const aimKey = () => {
  const tool = engine.tools.lightAim;
  if (tool.active) {
    tool.cancel();
    return;
  }
  aiming.value = true;
  tool.start(() => { aiming.value = false; });
};
const resetKey = () => {
  setRenderPref("keyAzimuth", DEFAULT_KEY.azimuth);
  setRenderPref("keyElevation", DEFAULT_KEY.elevation);
};
const onBrightness = (e: Event) =>
  setRenderPref("brightness", Number.parseFloat((e.target as HTMLInputElement).value));
const onBloom = (e: Event) =>
  setRenderPref("bloom", Number.parseFloat((e.target as HTMLInputElement).value));
</script>

<template>
  <div class="rd-scroll">
    <section class="rd-section">
      <h3 class="rd-head">Studio</h3>
      <div class="rd-grid" role="listbox" aria-label="Environment">
        <button
          v-for="e in ENVIRONMENTS_LIST"
          :key="e.id"
          class="rd-tile"
          :class="{ 'is-selected': prefs.environment === e.id }"
          role="option"
          :aria-selected="prefs.environment === e.id"
          :data-environment="e.id"
          :title="e.note"
          @click="pickEnv(e.id)"
        >
          <span class="rd-ball" :style="{ background: e.swatch }"></span>
          <span class="rd-tile-name">{{ e.label }}</span>
          <span class="rd-sub">{{ e.note }}</span>
        </button>
      </div>
      <p class="sm-hint">
        Every one of these is built in the renderer out of a few lit panels, so
        none of them is a file to download. A metal is almost entirely
        reflection, which is why the choice changes so much.
      </p>
    </section>

    <section class="rd-section" data-env-custom>
      <h3 class="rd-head">Your environments</h3>
      <div v-if="saved.length || hdrHash" class="rd-grid" role="listbox" aria-label="Saved environments">
        <button
          v-if="hdrHash && !activeSaved"
          class="rd-tile is-selected"
          role="option"
          aria-selected="true"
          data-environment="hdr"
          :title="hdrLabel ?? 'Imported HDR'"
        >
          <span class="rd-ball rd-ball-hdr"></span>
          <span class="rd-tile-name">{{ hdrLabel ?? "Imported HDR" }}</span>
          <span class="rd-sub">Imported, not saved yet</span>
        </button>
        <div v-for="s in saved" :key="s.id" class="rd-saved">
          <button
            class="rd-tile"
            :class="{ 'is-selected': activeSaved === s.id }"
            role="option"
            :aria-selected="activeSaved === s.id"
            :data-saved-environment="s.name"
            :title="s.name"
            @click="pickSaved(s)"
          >
            <span class="rd-ball" :style="thumbStyle(s.thumb)"></span>
            <span class="rd-tile-name">{{ s.name }}</span>
          </button>
          <input
            v-if="naming && naming.id === s.id"
            ref="nameInput"
            v-model="naming.text"
            class="rd-name"
            aria-label="Environment name"
            maxlength="60"
            @keydown.enter.prevent="finishNaming"
            @keydown.escape.prevent="naming = null"
            @blur="finishNaming"
          />
          <div v-else class="rd-saved-actions">
            <button class="rd-mini" :data-rename="s.name" @click="startNaming(s.id, s.name)">Rename</button>
            <button class="rd-mini" :data-delete="s.name" @click="removeSaved(s)">Delete</button>
          </div>
        </div>
      </div>
      <div class="rd-chips" role="group" aria-label="Your environments">
        <button class="rd-chip" data-env-import @click="fileInput?.click()">Import HDR...</button>
        <button class="rd-chip" data-env-save @click="startNaming(null, saveName())">Save as...</button>
        <input ref="fileInput" type="file" accept=".hdr,.exr" hidden data-env-file @change="onFilePicked" />
      </div>
      <input
        v-if="naming && naming.id === null"
        ref="nameInput"
        v-model="naming.text"
        class="rd-name"
        aria-label="Name for this environment"
        maxlength="60"
        data-env-name
        @keydown.enter.prevent="finishNaming"
        @keydown.escape.prevent="naming = null"
        @blur="finishNaming"
      />
      <div v-if="notice" class="sm-hint rd-notice" role="status" data-env-notice>{{ notice }}</div>
      <template v-if="hdrHash">
        <label class="prefs-row">
          <span class="prefs-label">Rotation</span>
          <input
            id="rd-env-rotation"
            class="sm-slider"
            type="range"
            min="-180" max="180" step="5"
            :value="prefs.envRotation"
            @change="onRotation"
          />
        </label>
        <label class="prefs-row">
          <span class="prefs-label">Exposure</span>
          <input
            id="rd-env-exposure"
            class="sm-slider"
            type="range"
            :min="MIN_EXPOSURE" :max="MAX_EXPOSURE" step="0.25"
            :value="prefs.envExposure"
            @change="onExposure"
          />
        </label>
        <div class="rd-chips" role="group" aria-label="Panorama behind the model">
          <button
            class="rd-chip"
            :class="{ active: prefs.envBackground }"
            data-env-behind
            :aria-pressed="prefs.envBackground"
            @click="toggleBehind"
          >{{ prefs.envBackground ? "Shown behind the model" : "Ground colour behind" }}</button>
        </div>
      </template>
      <p class="sm-hint">
        Import an .hdr or .exr panorama, or drop one on the window. Save as keeps
        the whole look under a name. A document lit by one of these carries it,
        so it opens with the same light elsewhere.
      </p>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Ground</h3>
      <div class="rd-chips" role="group" aria-label="Background">
        <button
          v-for="b in BACKGROUNDS"
          :key="b.id"
          class="rd-chip"
          :class="{ active: prefs.background === b.id }"
          :data-background="b.id"
          @click="setRenderPref('background', b.id)"
        >{{ b.label }}</button>
      </div>
      <label class="prefs-row">
        <span class="prefs-label">Brightness</span>
        <input
          id="rd-brightness"
          class="sm-slider"
          type="range"
          :min="MIN_BRIGHTNESS" :max="MAX_BRIGHTNESS" step="0.05"
          :value="prefs.brightness"
          @input="onBrightness"
        />
      </label>
      <div class="sm-hint">Lights and reflections together, so the two stay in step.</div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Key light</h3>
      <div class="rd-chips" role="group" aria-label="Key light">
        <button
          class="rd-chip"
          :class="{ active: aiming }"
          data-key-light="aim"
          :aria-pressed="aiming"
          @click="aimKey"
        >Aim</button>
        <button class="rd-chip" data-key-light="reset" @click="resetKey">Reset</button>
      </div>
      <div class="sm-hint" data-key-light="angles">
        From {{ formatTurn(prefs.keyAzimuth) }} round, {{ formatTurn(prefs.keyElevation) }} up.
        Aim drags a sun on the model to swing the light that casts the shadows.
      </div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Bloom</h3>
      <label class="prefs-row">
        <span class="prefs-label">Amount</span>
        <input
          id="rd-bloom"
          class="sm-slider"
          type="range"
          min="0" max="1" step="0.05"
          :value="prefs.bloom"
          :data-bloom="prefs.bloom"
          @input="onBloom"
        />
      </label>
      <div class="sm-hint">
        Light spilling off the brightest parts of the image. The lower half only
        reaches a material with Emission up and a hard specular highlight, so an
        ordinary part looks the same; turn it up to catch everyday highlights too.
      </div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Shadows</h3>
      <div class="rd-chips" role="group" aria-label="Shadows">
        <button
          class="rd-chip"
          :class="{ active: prefs.shadows }"
          data-shadows="mode"
          :aria-pressed="prefs.shadows"
          @click="setRenderPref('shadows', !prefs.shadows)"
        >{{ prefs.shadows ? "On" : "Off" }}</button>
      </div>
      <div class="sm-hint">
        Ground every part with a real cast shadow from the key light, not just the
        soft light an emissive part throws. Off on the lightweight render.
      </div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Denoise</h3>
      <div class="rd-chips" role="group" aria-label="Denoise">
        <button
          v-for="d in DENOISES"
          :key="d.id"
          class="rd-chip"
          :class="{ active: prefs.denoise === d.id }"
          :data-denoise="d.id"
          @click="setRenderPref('denoise', d.id)"
        >{{ d.label }}</button>
      </div>
      <div class="sm-hint">
        Path traced cleans the grain out of the finished picture. High quality
        takes a few seconds longer.
      </div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Tracer</h3>
      <div class="rd-chips" role="group" aria-label="Path tracer">
        <button
          v-for="t in TRACERS"
          :key="t.id"
          class="rd-chip"
          :class="{ active: prefs.tracer === t.id }"
          :data-tracer="t.id"
          @click="setRenderPref('tracer', t.id)"
        >{{ t.label }}</button>
      </div>
      <div class="sm-hint">
        Where Path traced runs: in the app itself or in the web view. Auto picks
        the faster one this computer has.
      </div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Performance</h3>
      <div class="rd-chips" role="group" aria-label="Performance mode">
        <button
          class="rd-chip"
          :class="{ active: performanceModeOn(prefs) }"
          data-perf="mode"
          :aria-pressed="performanceModeOn(prefs)"
          :disabled="prefs.potatoMode"
          :title="prefs.potatoMode ? 'Potato mode includes performance mode' : undefined"
          @click="setRenderPref('performanceMode', !prefs.performanceMode)"
        >{{ performanceModeOn(prefs) ? "On" : "Off" }}</button>
      </div>
      <div class="sm-hint">
        Drop the heavy effects, glass refraction, a high pixel ratio and the
        extra emitter lights, for a lighter render. On automatically on a weak
        GPU; turn it on by hand if the viewport stutters or a laptop runs hot.
      </div>
    </section>

    <section class="rd-section" title="Lowest quality, for slow or virtual machines">
      <h3 class="rd-head">Potato mode</h3>
      <div class="rd-chips" role="group" aria-label="Potato mode">
        <button
          class="rd-chip"
          :class="{ active: prefs.potatoMode }"
          data-potato="mode"
          :aria-pressed="prefs.potatoMode"
          @click="setRenderPref('potatoMode', !prefs.potatoMode)"
        >{{ prefs.potatoMode ? "On" : "Off" }}</button>
      </div>
      <div class="sm-hint">
        Lowest quality, for slow or virtual machines. Flat shading, thin edges,
        half resolution, no glass blur and no effects or camera animations.
        Includes performance mode.
      </div>
    </section>
  </div>
</template>
