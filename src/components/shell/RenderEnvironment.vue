<script setup lang="ts">
import RenderSections from "./RenderSections.vue";
import DenoiserRow from "./DenoiserRow.vue";
import Button from "../ui/Button.vue";
import Checkbox from "../ui/Checkbox.vue";
import Segmented from "../ui/Segmented.vue";
import Slider from "../ui/Slider.vue";
import TextField from "../ui/TextField.vue";
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
  adoptSavedForCurrentLook,
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
let nameInput: { focus: () => void } | null = null;
const setNameInput = (el: unknown) => {
  nameInput = el as { focus: () => void } | null;
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
  void adoptSavedForCurrentLook();
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
  void nextTick(() => nameInput?.focus());
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

const BACKDROP_CHOICES = BACKGROUNDS.map((b) => ({ value: b.id, label: b.label, attrs: { "data-background": b.id } }));
const FLOOR_CHOICES = GROUND_CHOICES.map((g) => ({ value: g.id, label: g.label, attrs: { "data-ground": g.id } }));
const DENOISE_CHOICES = DENOISES.map((d) => ({ value: d.id, label: d.label, attrs: { "data-denoise": d.id } }));
const TRACER_CHOICES = TRACERS.map((t) => ({ value: t.id, label: t.label, attrs: { "data-tracer": t.id } }));
const qualityChoices = computed(() =>
  REALTIME_QUALITY_PREFS.map((q) => {
    const refused = q === "high" ? highReason.value : null;
    return {
      value: q,
      label: QUALITY_LABELS[q],
      disabled: refused !== null,
      tip: refused ?? undefined,
      attrs: { "data-realtime-quality": q },
    };
  }),
);
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
          <TextField
            v-if="naming && naming.id === s.id"
            :ref="setNameInput"
            v-model="naming.text"
            class="rd-name"
            size="sm"
            select-on-focus
            aria-label="Environment name"
            maxlength="60"
            @keydown.enter.prevent="finishNaming"
            @keydown.escape.prevent="naming = null"
            @blur="finishNaming"
          />
          <div v-else class="rd-saved-actions">
            <Button size="sm" variant="ghost" :data-rename="s.name" @click="startNaming(s.id, s.name)">Rename</Button>
            <Button size="sm" variant="ghost" :data-delete="s.name" @click="removeSaved(s)">Delete</Button>
          </div>
        </div>
      </div>
      <div class="rd-chips" role="group" aria-label="Your environments">
        <Button size="sm" data-env-import @click="fileInput?.click()">Import HDR...</Button>
        <Button size="sm" data-env-save @click="startNaming(null, saveName())">Save as...</Button>
        <input ref="fileInput" type="file" accept=".hdr,.exr" hidden data-env-file @change="onFilePicked" />
      </div>
      <TextField
        v-if="naming && naming.id === null"
        :ref="setNameInput"
        v-model="naming.text"
        class="rd-name"
        size="sm"
        select-on-focus
        aria-label="Name for this environment"
        maxlength="60"
        data-env-name
        @keydown.enter.prevent="finishNaming"
        @keydown.escape.prevent="naming = null"
        @blur="finishNaming"
      />
      <div v-if="notice" class="sm-hint rd-notice" role="status" data-env-notice>{{ notice }}</div>
      <template v-if="hdrHash">
        <Slider
          id="rd-env-rotation"
          class="prefs-row"
          label="Rotation"
          :min="-180"
          :max="180"
          :step="5"
          :model-value="prefs.envRotation"
          @update:model-value="setRenderPref('envRotation', $event)"
        >
          <template #value="{ value }">{{ Math.round(value) }}&deg;</template>
        </Slider>
        <Slider
          id="rd-env-exposure"
          class="prefs-row"
          label="Exposure"
          :min="MIN_EXPOSURE"
          :max="MAX_EXPOSURE"
          :step="0.25"
          :model-value="prefs.envExposure"
          @update:model-value="setRenderPref('envExposure', $event)"
        >
          <template #value="{ value }">{{ value > 0 ? "+" : "" }}{{ value.toFixed(2) }} EV</template>
        </Slider>
        <div class="rd-chips" role="group" aria-label="Panorama behind the model">
          <Button size="sm" data-env-behind :pressed="prefs.envBackground" @click="toggleBehind">{{
            prefs.envBackground ? "Shown behind the model" : "Backdrop colour behind"
          }}</Button>
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
      <Slider
        id="rd-brightness"
        class="prefs-row"
        label="Amount"
        :min="MIN_BRIGHTNESS"
        :max="MAX_BRIGHTNESS"
        :step="0.05"
        :model-value="prefs.brightness"
        @update:model-value="setRenderPref('brightness', $event)"
      >
        <template #value="{ value }">{{ value.toFixed(2) }}x</template>
      </Slider>
      <div class="sm-hint">
        How strongly the environment lights the model and shows in its reflections, an imported HDR included.
      </div>
    </section>

    <section class="rd-section" data-ground>
      <h3 class="rd-head">Backdrop and floor</h3>
      <div class="prefs-row rd-chip-row">
        <span class="prefs-label">Backdrop</span>
        <Segmented
          class="rd-chips"
          variant="chips"
          size="sm"
          label="Backdrop colour"
          :options="BACKDROP_CHOICES"
          :model-value="prefs.background"
          @update:model-value="setRenderPref('background', $event)"
        />
      </div>
      <div class="prefs-row rd-chip-row">
        <span class="prefs-label">Floor</span>
        <Segmented
          class="rd-chips"
          variant="chips"
          size="sm"
          label="Floor under the model"
          :options="FLOOR_CHOICES"
          :model-value="ground"
          @update:model-value="setRenderPref(groundKey(ws), $event)"
        />
      </div>
      <div class="sm-hint">
        The colour behind the model, and an invisible floor under it that shows only the model's shadow. The floor is
        off on the lightweight render.
      </div>
    </section>

    <section v-if="showQuality" class="rd-section">
      <h3 class="rd-head">Realtime quality</h3>
      <Segmented
        class="rd-chips"
        variant="chips"
        size="sm"
        label="Realtime quality"
        :options="qualityChoices"
        :model-value="prefs.realtimeQuality"
        @update:model-value="setRenderPref('realtimeQuality', $event)"
      />
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
          <Button size="sm" data-key-light="aim" :pressed="aiming" @click="aimKey">Aim</Button>
          <Button size="sm" data-key-light="reset" @click="resetKey">Reset</Button>
        </div>
        <div class="sm-hint" data-key-light="angles">
          From {{ formatTurn(prefs.keyAzimuth) }} round, {{ formatTurn(prefs.keyElevation) }} up. Aim drags a sun on the
          model to swing the light that casts the shadows.
        </div>
      </template>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Bloom</h3>
      <Slider
        id="rd-bloom"
        class="prefs-row"
        label="Amount"
        :min="0"
        :max="1"
        :step="0.05"
        :model-value="prefs.bloom"
        :data-bloom="prefs.bloom"
        @update:model-value="setRenderPref('bloom', $event)"
      />
      <div class="sm-hint">
        Light spilling off faces with Emission turned up. In the path traced view bright highlights spill too.
      </div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Shadows</h3>
      <Checkbox
        class="rd-check"
        data-shadows="mode"
        label="Cast shadows"
        :model-value="prefs.shadows"
        @update:model-value="setRenderPref('shadows', $event)"
      />
      <div class="sm-hint">
        Ground every part with a real cast shadow from the key light, not just the soft light an emissive part throws.
        Off on the lightweight render{{ hdrHash ? ", and with an imported HDR, which has no key light" : "" }}.
      </div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Denoise</h3>
      <Segmented
        class="rd-chips"
        variant="chips"
        size="sm"
        label="Denoise"
        :options="DENOISE_CHOICES"
        :model-value="prefs.denoise"
        @update:model-value="setRenderPref('denoise', $event)"
      />
      <div class="sm-hint">
        Path traced cleans the grain out of the finished picture. High quality takes a few seconds longer.
      </div>
      <DenoiserRow hint-class="sm-hint" />
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Tracer</h3>
      <Segmented
        class="rd-chips"
        variant="chips"
        size="sm"
        label="Path tracer"
        :options="TRACER_CHOICES"
        :model-value="prefs.tracer"
        @update:model-value="setRenderPref('tracer', $event)"
      />
      <div class="sm-hint">
        Where Path traced runs: in the app itself or in the web view. Auto picks the faster one this computer has.
      </div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Performance</h3>
      <Checkbox
        class="rd-check"
        data-perf="mode"
        label="Performance mode"
        :model-value="performanceModeOn(prefs)"
        :disabled="prefs.potatoMode"
        disabled-reason="Potato mode includes performance mode"
        @update:model-value="setRenderPref('performanceMode', $event)"
      />
      <div class="sm-hint">
        Drop the heavy effects, glass refraction, a high pixel ratio and the extra emitter lights, for a lighter render.
        On automatically on a weak GPU; turn it on by hand if the viewport stutters or a laptop runs hot.
      </div>
    </section>

    <section class="rd-section" title="Lowest quality, for slow or virtual machines">
      <h3 class="rd-head">Potato mode</h3>
      <Checkbox
        class="rd-check"
        data-potato="mode"
        label="Potato mode"
        :model-value="prefs.potatoMode"
        @update:model-value="setRenderPref('potatoMode', $event)"
      />
      <div class="sm-hint">
        Lowest quality, for slow or virtual machines. Flat shading, thin edges, half resolution, no glass blur and no
        effects or camera animations. Includes performance mode.
      </div>
    </section>
    <RenderSections tab="environment" />
  </div>
</template>
