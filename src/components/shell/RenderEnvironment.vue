<script setup lang="ts">
import RenderSections from "./RenderSections.vue";
import DenoiserRow from "./DenoiserRow.vue";
// The same settings are also in Preferences on purpose: here you try six in ten seconds while looking at the part,
// which a swatch grid suits and a dropdown in a modal does not.

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  ENVIRONMENTS_LIST,
  REALTIME_QUALITY_PREFS,
  MAX_BRIGHTNESS,
  MAX_EXPOSURE,
  MIN_BRIGHTNESS,
  MIN_EXPOSURE,
  hdrHashOf,
  groundKey,
  onRenderPrefsChange,
  performanceModeOn,
  renderPrefs,
  setRenderPref,
  type Background,
  type Denoise,
  type Environment,
  type Ground,
  type RealtimeQualityPref,
  type TracerPref,
} from "../../ui/renderPrefs";
import { onWorkspaceChange, workspace } from "../../ui/workspace";
import {
  activeSavedId,
  applySavedEnvironment,
  chooseBuiltInEnvironment,
  deleteSavedEnvironment,
  envLibrary,
  hdrName,
  hdrThumb,
  importEnvironmentFile,
  onEnvLibraryChange,
  renameSavedEnvironment,
  saveEnvironmentAs,
} from "../../ui/environmentImport";
import type { EnvEntry } from "../../ui/environmentLibrary";
import { onHdrRegistered } from "../../viewport/hdrRegistry";
import { DEFAULT_KEY } from "../../viewport/keyLight";
import { formatTurn } from "../../viewport/rotateDial";
import { useEngine } from "../../app/engineKey";
import { highRefusal } from "../../viewport/realtimePipeline";

const engine = useEngine();
const prefs = ref({ ...renderPrefs() });
const ws = ref(workspace());
const ground = computed(() => prefs.value[groundKey(ws.value)]);
const GROUND_CHOICES: readonly { id: Ground; label: string }[] = [
  { id: "none", label: "None" },
  { id: "shadow", label: "Shadow catcher" },
];
const QUALITY_LABELS: Record<RealtimeQualityPref, string> = { auto: "Auto", standard: "Standard", high: "High" };
// Dev builds only until High looks different from Standard.
const showQuality = import.meta.env.DEV;
const highReason = ref<string | null>(highRefusal(engine.viewport.qualityTier()));
const aiming = ref(false);
const saved = ref<EnvEntry[]>([]);
const activeSaved = ref<string | null>(activeSavedId());
const notice = ref<string | null>(null);
const naming = ref<{ id: string | null; text: string } | null>(null);
let nameInput: HTMLInputElement | null = null;
const setNameInput = (el: unknown) => {
  nameInput = el as HTMLInputElement | null;
};
const fileInput = ref<HTMLInputElement | null>(null);
const hdrLabel = ref<string | null>(null);
const hdrPicture = ref("");
const hdrHash = computed(() => hdrHashOf(prefs.value.environment));
const offs: (() => void)[] = [];
const loadSaved = () => {
  activeSaved.value = activeSavedId();
  void envLibrary()
    .list()
    .then((l) => {
      saved.value = l;
    })
    .catch(() => {
      saved.value = [];
    });
};
const syncLabel = () => {
  hdrLabel.value = hdrHash.value ? hdrName(hdrHash.value) : null;
  hdrPicture.value = hdrHash.value ? hdrThumb(hdrHash.value) : "";
};
onMounted(() => {
  offs.push(
    onRenderPrefsChange(() => {
      prefs.value = { ...renderPrefs() };
      highReason.value = highRefusal(engine.viewport.qualityTier());
      syncLabel();
    }),
  );
  offs.push(
    engine.viewport.onRenderTierChange(() => {
      highReason.value = highRefusal(engine.viewport.qualityTier());
    }),
  );
  offs.push(
    onWorkspaceChange((w) => {
      ws.value = w;
    }),
  );
  offs.push(onEnvLibraryChange(loadSaved));
  offs.push(onHdrRegistered(syncLabel));
  loadSaved();
  syncLabel();
});
onUnmounted(() => {
  for (const off of offs) off();
});

const fail = (err: unknown) => {
  notice.value = err instanceof Error ? err.message : String(err);
};

const importFile = async (file: File) => {
  notice.value = `Reading ${file.name}...`;
  let note: string | null = null;
  const refused = await importEnvironmentFile(engine.store, file, { onNote: (n) => (note = n) });
  notice.value = refused ?? note;
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
  void nextTick(() => {
    nameInput?.focus();
    nameInput?.select();
  });
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
  tool.start(() => {
    aiming.value = false;
  });
};
watch(hdrHash, (h) => {
  if (h && engine.tools.lightAim.active) engine.tools.lightAim.cancel();
});
const resetKey = () => {
  setRenderPref("keyAzimuth", DEFAULT_KEY.azimuth);
  setRenderPref("keyElevation", DEFAULT_KEY.elevation);
};
const onBrightness = (e: Event) => setRenderPref("brightness", Number.parseFloat((e.target as HTMLInputElement).value));
const onBloom = (e: Event) => setRenderPref("bloom", Number.parseFloat((e.target as HTMLInputElement).value));
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
        Every one of these is built in the renderer out of a few lit panels, so none of them is a file to download. A
        metal is almost entirely reflection, which is why the choice changes so much.
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
          <span
            class="rd-ball"
            :class="{ 'rd-ball-hdr': !hdrPicture }"
            :style="hdrPicture ? thumbStyle(hdrPicture) : undefined"
          ></span>
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
            :ref="setNameInput"
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
        :ref="setNameInput"
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
            min="-180"
            max="180"
            step="5"
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
            :min="MIN_EXPOSURE"
            :max="MAX_EXPOSURE"
            step="0.25"
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
            >{{ prefs.envBackground ? "Shown behind the model" : "Backdrop colour behind" }}</button
          >
        </div>
        <div class="sm-hint">Exposure evens out how bright the file itself is, in stops.</div>
      </template>
      <p class="sm-hint">
        Import an .hdr or .exr panorama, or drop one on the window. Save as keeps the whole look under a name. A
        document lit by one of these carries it, so it opens with the same light elsewhere.
      </p>
    </section>

    <section class="rd-section" data-env-brightness>
      <h3 class="rd-head">Environment brightness</h3>
      <label class="prefs-row">
        <span class="prefs-label">Amount</span>
        <input
          id="rd-brightness"
          class="sm-slider"
          type="range"
          :min="MIN_BRIGHTNESS"
          :max="MAX_BRIGHTNESS"
          step="0.05"
          :value="prefs.brightness"
          @input="onBrightness"
        />
        <span class="rd-value">{{ prefs.brightness.toFixed(2) }}x</span>
      </label>
      <div class="sm-hint">
        How strongly the environment lights the model and shows in its reflections, an imported HDR included.
      </div>
    </section>

    <section class="rd-section" data-ground>
      <h3 class="rd-head">Backdrop and floor</h3>
      <div class="prefs-row rd-chip-row">
        <span class="prefs-label">Backdrop</span>
        <div class="rd-chips" role="group" aria-label="Backdrop colour">
          <button
            v-for="b in BACKGROUNDS"
            :key="b.id"
            class="rd-chip"
            :class="{ active: prefs.background === b.id }"
            :data-background="b.id"
            :aria-pressed="prefs.background === b.id"
            @click="setRenderPref('background', b.id)"
            >{{ b.label }}</button
          >
        </div>
      </div>
      <div class="prefs-row rd-chip-row">
        <span class="prefs-label">Floor</span>
        <div class="rd-chips" role="group" aria-label="Floor under the model">
          <button
            v-for="g in GROUND_CHOICES"
            :key="g.id"
            class="rd-chip"
            :class="{ active: ground === g.id }"
            :data-ground="g.id"
            :aria-pressed="ground === g.id"
            @click="setRenderPref(groundKey(ws), g.id)"
            >{{ g.label }}</button
          >
        </div>
      </div>
      <div class="sm-hint">
        The colour behind the model, and an invisible floor under it that shows only the model's shadow. The floor is
        off on the lightweight render.
      </div>
    </section>

    <section v-if="showQuality" class="rd-section">
      <h3 class="rd-head">Realtime quality</h3>
      <div class="rd-chips" role="group" aria-label="Realtime quality">
        <button
          v-for="q in REALTIME_QUALITY_PREFS"
          :key="q"
          class="rd-chip"
          :class="{ active: prefs.realtimeQuality === q }"
          :data-realtime-quality="q"
          :aria-pressed="prefs.realtimeQuality === q"
          :disabled="q === 'high' && highReason !== null"
          :title="q === 'high' && highReason !== null ? highReason : undefined"
          @click="setRenderPref('realtimeQuality', q)"
          >{{ QUALITY_LABELS[q] }}</button
        >
      </div>
    </section>

    <section class="rd-section" data-key-light-section>
      <h3 class="rd-head">Key light</h3>
      <template v-if="hdrHash">
        <div class="sm-hint" data-key-light="hdr">
          An imported HDR lights the scene on its own, with no key light added. Pick a built in room to aim one.
        </div>
      </template>
      <template v-else>
        <div class="rd-chips" role="group" aria-label="Key light">
          <button
            class="rd-chip"
            :class="{ active: aiming }"
            data-key-light="aim"
            :aria-pressed="aiming"
            @click="aimKey"
            >Aim</button
          >
          <button class="rd-chip" data-key-light="reset" @click="resetKey">Reset</button>
        </div>
        <div class="sm-hint" data-key-light="angles">
          From {{ formatTurn(prefs.keyAzimuth) }} round, {{ formatTurn(prefs.keyElevation) }} up. Aim drags a sun on the
          model to swing the light that casts the shadows.
        </div>
      </template>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Bloom</h3>
      <label class="prefs-row">
        <span class="prefs-label">Amount</span>
        <input
          id="rd-bloom"
          class="sm-slider"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="prefs.bloom"
          :data-bloom="prefs.bloom"
          @input="onBloom"
        />
      </label>
      <div class="sm-hint">
        Light spilling off faces with Emission turned up. In the path traced view bright highlights spill too.
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
          >{{ prefs.shadows ? "On" : "Off" }}</button
        >
      </div>
      <div class="sm-hint">
        Ground every part with a real cast shadow from the key light, not just the soft light an emissive part throws.
        Off on the lightweight render{{ hdrHash ? ", and with an imported HDR, which has no key light" : "" }}.
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
          >{{ d.label }}</button
        >
      </div>
      <div class="sm-hint">
        Path traced cleans the grain out of the finished picture. High quality takes a few seconds longer.
      </div>
      <DenoiserRow hint-class="sm-hint" button-class="rd-chip" />
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
          >{{ t.label }}</button
        >
      </div>
      <div class="sm-hint">
        Where Path traced runs: in the app itself or in the web view. Auto picks the faster one this computer has.
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
          >{{ performanceModeOn(prefs) ? "On" : "Off" }}</button
        >
      </div>
      <div class="sm-hint">
        Drop the heavy effects, glass refraction, a high pixel ratio and the extra emitter lights, for a lighter render.
        On automatically on a weak GPU; turn it on by hand if the viewport stutters or a laptop runs hot.
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
          >{{ prefs.potatoMode ? "On" : "Off" }}</button
        >
      </div>
      <div class="sm-hint">
        Lowest quality, for slow or virtual machines. Flat shading, thin edges, half resolution, no glass blur and no
        effects or camera animations. Includes performance mode.
      </div>
    </section>
    <RenderSections tab="environment" />
  </div>
</template>
