<script setup lang="ts">
import { spellFixed } from "../../ui/measure";
import RenderSections from "./RenderSections.vue";
import DenoiserRow from "./DenoiserRow.vue";
import Button from "../ui/Button.vue";
import Checkbox from "../ui/Checkbox.vue";
import Listbox from "../ui/Listbox.vue";
import Segmented from "../ui/Segmented.vue";
import Slider from "../ui/Slider.vue";
import TextField from "../ui/TextField.vue";
// The same settings are also in Preferences on purpose: here you try six in ten seconds while looking at the part,
// which a swatch grid suits and a dropdown in a modal does not.

import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from "vue";
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
import { t } from "../../i18n";
import { onHdrRegistered } from "../../viewport/hdrRegistry";
import { DEFAULT_KEY } from "../../viewport/keyLight";
import { formatTurn } from "../../viewport/rotateDial";
import { useEngine } from "../../app/engineKey";
import { confirmDanger } from "../../ui/choice";
import { toast } from "../../ui/toast";
import { highRefusal } from "../../viewport/realtimePipeline";

const engine = useEngine();
const prefs = ref({ ...renderPrefs() });
const ws = ref(workspace());
const ground = computed(() => prefs.value[groundKey(ws.value)]);
const GROUND_CHOICES = computed<readonly { id: Ground; label: string }[]>(() => [
  { id: "none", label: t("render.ground.none") },
  { id: "shadow", label: t("render.ground.shadow") },
]);
const qualityLabel = (q: RealtimeQualityPref) =>
  q === "auto" ? t("render.quality.auto") : q === "high" ? t("render.quality.high") : t("render.quality.standard");
// Dev builds only until High looks different from Standard.
const showQuality = import.meta.env.DEV;
const highReason = ref<string | null>(highRefusal(engine.viewport.qualityTier()));
const aiming = ref(false);
const saved = ref<EnvEntry[]>([]);
const activeSaved = ref<string | null>(activeSavedId());
const notice = ref<string | null>(null);
const naming = ref<{ id: string | null; text: string } | null>(null);
let namingFrom: HTMLElement | null = null;
const howtoId = useId();
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
  notice.value = t("render.reading", { name: file.name });
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
  namingFrom = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  naming.value = { id, text };
  void nextTick(() => nameInput?.focus());
};
// Only Enter and Escape hand focus back: a blur means it already went somewhere on purpose.
const focusNamingFrom = () => {
  const el = namingFrom;
  namingFrom = null;
  if (el?.isConnected) el.focus();
};
const onNameEnter = () => {
  void finishNaming();
  focusNamingFrom();
};
const onNameEscape = () => {
  naming.value = null;
  focusNamingFrom();
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
const saveName = () => (hdrLabel.value ?? t("render.myEnvironment")).replace(/\.(hdr|exr)$/i, "");
const removeSaved = async (entry: EnvEntry, then?: () => void) => {
  const ok = await confirmDanger(
    t("render.delete.title", { name: entry.name }),
    t("render.delete.action"),
    t("render.delete.body"),
  );
  if (!ok) return;
  then?.();
  try {
    await deleteSavedEnvironment(entry.id);
    toast(t("render.delete.done", { name: entry.name }));
  } catch (err) {
    fail(err);
  }
};

type SavedItem = { value: string; label: string; entry: EnvEntry | null };
const savedItems = computed<SavedItem[]>(() => [
  ...(hdrHash.value && !activeSaved.value
    ? [{ value: "hdr", label: hdrLabel.value ?? t("render.hdr.imported"), entry: null }]
    : []),
  ...saved.value.map((s) => ({ value: `saved:${s.id}`, label: s.name, entry: s })),
]);
const savedValue = computed(() => (activeSaved.value ? `saved:${activeSaved.value}` : hdrHash.value ? "hdr" : null));
const activeEntry = computed(() => saved.value.find((s) => s.id === activeSaved.value) ?? null);
const pickSavedValue = (v: string | string[]) => {
  const entry = savedItems.value.find((it) => it.value === v)?.entry;
  if (entry) pickSaved(entry);
};
// The window's Delete removes a selected face or feature, so the tile keeps its keys to itself.
const onSavedKey = (e: KeyboardEvent, entry: EnvEntry) => {
  if (e.key !== "F2" && e.key !== "Delete" && e.key !== "Backspace") return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "F2") return startNaming(entry.id, entry.name);
  const tile = e.currentTarget as HTMLElement;
  const next = [tile.nextElementSibling, tile.previousElementSibling].find((el) => el?.matches("[data-roving]"));
  void removeSaved(entry, () => (next as HTMLElement | undefined)?.focus());
};
const thumbStyle = (thumb: string) =>
  thumb.startsWith("data:") ? { backgroundImage: `url("${thumb}")`, backgroundSize: "cover" } : { background: thumb };
const toggleBehind = () => {
  setRenderPref("envBackground", !prefs.value.envBackground);
};

const BACKGROUNDS = computed<{ id: Background; label: string }[]>(() => [
  { id: "theme", label: t("prefs.background.theme") },
  { id: "dark", label: t("prefs.background.dark") },
  { id: "grey", label: t("render.background.grey") },
  { id: "light", label: t("prefs.background.light") },
]);

const pickEnv = (id: Environment) => {
  chooseBuiltInEnvironment(engine.store, id);
};
const STUDIO_ITEMS = computed(() => ENVIRONMENTS_LIST.map((e) => ({ value: e.id, label: e.label, e })));
const studioValue = computed(
  () => STUDIO_ITEMS.value.find((it) => it.value === prefs.value.environment)?.value ?? null,
);
const DENOISES = computed<{ id: Denoise; label: string }[]>(() => [
  { id: "off", label: t("render.denoise.off") },
  { id: "standard", label: t("render.denoise.standard") },
  { id: "high", label: t("render.denoise.high") },
]);
const TRACERS = computed<{ id: TracerPref; label: string }[]>(() => [
  { id: "auto", label: t("prefs.tracer.auto") },
  { id: "native", label: t("prefs.tracer.native") },
  { id: "webgpu", label: t("prefs.tracer.webgpu") },
]);
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

const BACKDROP_CHOICES = computed(() =>
  BACKGROUNDS.value.map((b) => ({ value: b.id, label: b.label, attrs: { "data-background": b.id } })),
);
const FLOOR_CHOICES = computed(() =>
  GROUND_CHOICES.value.map((g) => ({ value: g.id, label: g.label, attrs: { "data-ground": g.id } })),
);
const DENOISE_CHOICES = computed(() =>
  DENOISES.value.map((d) => ({ value: d.id, label: d.label, attrs: { "data-denoise": d.id } })),
);
const TRACER_CHOICES = computed(() =>
  TRACERS.value.map((c) => ({ value: c.id, label: c.label, attrs: { "data-tracer": c.id } })),
);
const evText = (value: number) =>
  t("render.exposure.value", { value: `${value > 0 ? "+" : ""}${spellFixed(value, 2)}` });
const qualityChoices = computed(() =>
  REALTIME_QUALITY_PREFS.map((q) => {
    const refused = q === "high" ? highReason.value : null;
    return {
      value: q,
      label: qualityLabel(q),
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
      <h3 class="rd-head">{{ t("render.studio.title") }}</h3>
      <Listbox
        class="rd-grid"
        :label="t('render.environment.label')"
        :items="STUDIO_ITEMS"
        :model-value="studioValue"
        @update:model-value="(v) => typeof v === 'string' && pickEnv(v)"
        @apply="pickEnv"
      >
        <template #option="{ item: { e }, selected, attrs }">
          <button
            v-bind="attrs"
            class="rd-tile"
            :class="{ 'is-selected': selected }"
            :aria-label="t('render.studio.tile', { label: e.label, note: e.note })"
            :aria-describedby="`${howtoId}-studio`"
            :data-environment="e.id"
            :title="e.note"
            @click.prevent="pickEnv(e.id)"
          >
            <span class="rd-ball" :style="{ background: e.swatch }"></span>
            <span class="rd-tile-name">{{ e.label }}</span>
            <span class="rd-sub">{{ e.note }}</span>
          </button>
        </template>
      </Listbox>
      <span :id="`${howtoId}-studio`" class="sr-only">{{ t("render.studio.howto") }}</span>
      <p class="sm-hint">{{ t("render.studio.hint") }}</p>
    </section>

    <section class="rd-section" data-env-custom>
      <h3 class="rd-head">{{ t("render.custom.title") }}</h3>
      <Listbox
        v-if="savedItems.length"
        class="rd-grid"
        :label="t('render.saved.label')"
        :items="savedItems"
        :model-value="savedValue"
        @update:model-value="pickSavedValue"
        @apply="pickSavedValue"
      >
        <template #option="{ item: { entry, label }, selected, attrs }">
          <button
            v-if="entry"
            v-bind="attrs"
            class="rd-tile"
            :class="{ 'is-selected': selected }"
            :aria-describedby="`${howtoId}-saved`"
            :data-saved-environment="entry.name"
            :title="entry.name"
            @click.prevent="pickSaved(entry)"
            @keydown="onSavedKey($event, entry)"
          >
            <span class="rd-ball" :style="thumbStyle(entry.thumb)"></span>
            <span class="rd-tile-name">{{ entry.name }}</span>
          </button>
          <button
            v-else
            v-bind="attrs"
            class="rd-tile is-selected"
            :aria-label="t('render.saved.importedAria', { name: label })"
            data-environment="hdr"
            :title="label"
          >
            <span
              class="rd-ball"
              :class="{ 'rd-ball-hdr': !hdrPicture }"
              :style="hdrPicture ? thumbStyle(hdrPicture) : undefined"
            ></span>
            <span class="rd-tile-name">{{ label }}</span>
            <span class="rd-sub">{{ t("render.saved.imported") }}</span>
          </button>
        </template>
      </Listbox>
      <span :id="`${howtoId}-saved`" class="sr-only">{{ t("render.saved.howto") }}</span>
      <div class="rd-chips" role="group" :aria-label="t('render.custom.title')">
        <Button size="sm" data-env-import @click="fileInput?.click()">{{ t("render.import") }}</Button>
        <Button size="sm" data-env-save @click="startNaming(null, saveName())">{{ t("render.saveAs") }}</Button>
        <template v-if="activeEntry">
          <Button
            size="sm"
            :aria-label="t('render.rename.aria', { name: activeEntry.name })"
            :data-rename="activeEntry.name"
            @click="startNaming(activeEntry.id, activeEntry.name)"
            >{{ t("render.rename.action") }}</Button
          >
          <Button
            size="sm"
            :aria-label="t('render.delete.aria', { name: activeEntry.name })"
            :data-delete="activeEntry.name"
            @click="void removeSaved(activeEntry)"
            >{{ t("render.delete.action") }}</Button
          >
        </template>
        <input ref="fileInput" type="file" accept=".hdr,.exr" hidden data-env-file @change="onFilePicked" />
      </div>
      <TextField
        v-if="naming"
        :ref="setNameInput"
        v-model="naming.text"
        class="rd-name"
        size="sm"
        select-on-focus
        :label="naming.id ? t('render.name.rename') : t('render.name.new')"
        maxlength="60"
        data-env-name
        @keydown.enter.prevent="onNameEnter"
        @keydown.escape.prevent="onNameEscape"
        @blur="finishNaming"
      />
      <div v-if="notice" class="sm-hint rd-notice" role="status" data-env-notice>{{ notice }}</div>
      <template v-if="hdrHash">
        <Slider
          id="rd-env-rotation"
          class="prefs-row"
          :label="t('render.rotation')"
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
          :label="t('render.exposure')"
          :min="MIN_EXPOSURE"
          :max="MAX_EXPOSURE"
          :step="0.25"
          :model-value="prefs.envExposure"
          @update:model-value="setRenderPref('envExposure', $event)"
        >
          <template #value="{ value }">{{ evText(value) }}</template>
        </Slider>
        <div class="rd-chips" role="group" :aria-label="t('render.behind.group')">
          <Button size="sm" data-env-behind :pressed="prefs.envBackground" @click="toggleBehind">{{
            prefs.envBackground ? t("render.behind.shown") : t("render.behind.colour")
          }}</Button>
        </div>
        <div class="sm-hint">{{ t("render.exposure.hint") }}</div>
      </template>
      <p class="sm-hint">{{ t("render.custom.hint") }}</p>
    </section>

    <section class="rd-section" data-env-brightness>
      <h3 class="rd-head">{{ t("prefs.brightness.title") }}</h3>
      <Slider
        id="rd-brightness"
        class="prefs-row"
        :label="t('render.amount')"
        :min="MIN_BRIGHTNESS"
        :max="MAX_BRIGHTNESS"
        :step="0.05"
        :model-value="prefs.brightness"
        @update:model-value="setRenderPref('brightness', $event)"
      >
        <template #value="{ value }">{{ spellFixed(value, 2) }}x</template>
      </Slider>
      <div class="sm-hint">{{ t("prefs.brightness.hint") }}</div>
    </section>

    <section class="rd-section" data-ground>
      <h3 class="rd-head">{{ t("render.ground.title") }}</h3>
      <div class="prefs-row rd-chip-row">
        <span class="prefs-label">{{ t("render.backdrop") }}</span>
        <Segmented
          class="rd-chips"
          variant="chips"
          size="sm"
          :label="t('render.backdrop.label')"
          :options="BACKDROP_CHOICES"
          :model-value="prefs.background"
          @update:model-value="setRenderPref('background', $event)"
        />
      </div>
      <div class="prefs-row rd-chip-row">
        <span class="prefs-label">{{ t("render.floor") }}</span>
        <Segmented
          class="rd-chips"
          variant="chips"
          size="sm"
          :label="t('render.floor.label')"
          :options="FLOOR_CHOICES"
          :model-value="ground"
          @update:model-value="setRenderPref(groundKey(ws), $event)"
        />
      </div>
      <div class="sm-hint">{{ t("render.ground.hint") }}</div>
    </section>

    <section v-if="showQuality" class="rd-section">
      <h3 class="rd-head">{{ t("render.quality.title") }}</h3>
      <Segmented
        class="rd-chips"
        variant="chips"
        size="sm"
        :label="t('render.quality.title')"
        :options="qualityChoices"
        :model-value="prefs.realtimeQuality"
        @update:model-value="setRenderPref('realtimeQuality', $event)"
      />
    </section>

    <section class="rd-section" data-key-light-section>
      <h3 class="rd-head">{{ t("render.keyLight.title") }}</h3>
      <template v-if="hdrHash">
        <div class="sm-hint" data-key-light="hdr">{{ t("render.keyLight.hdr") }}</div>
      </template>
      <template v-else>
        <div class="rd-chips" role="group" :aria-label="t('render.keyLight.title')">
          <Button size="sm" data-key-light="aim" :pressed="aiming" @click="aimKey">{{
            t("render.keyLight.aim")
          }}</Button>
          <Button size="sm" data-key-light="reset" @click="resetKey">{{ t("render.keyLight.reset") }}</Button>
        </div>
        <div class="sm-hint" data-key-light="angles">
          {{
            t("render.keyLight.angles", {
              azimuth: formatTurn(prefs.keyAzimuth),
              elevation: formatTurn(prefs.keyElevation),
            })
          }}
        </div>
      </template>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">{{ t("prefs.bloom.title") }}</h3>
      <Slider
        id="rd-bloom"
        class="prefs-row"
        :label="t('render.amount')"
        :min="0"
        :max="1"
        :step="0.05"
        :model-value="prefs.bloom"
        :data-bloom="prefs.bloom"
        @update:model-value="setRenderPref('bloom', $event)"
      />
      <div class="sm-hint">{{ t("prefs.bloom.hint") }}</div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">{{ t("render.shadows.title") }}</h3>
      <Checkbox
        class="rd-check"
        data-shadows="mode"
        :label="t('render.shadows.cast')"
        :model-value="prefs.shadows"
        @update:model-value="setRenderPref('shadows', $event)"
      />
      <div class="sm-hint">{{ hdrHash ? t("render.shadows.hintHdr") : t("render.shadows.hint") }}</div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">{{ t("render.denoise.title") }}</h3>
      <Segmented
        class="rd-chips"
        variant="chips"
        size="sm"
        :label="t('render.denoise.title')"
        :options="DENOISE_CHOICES"
        :model-value="prefs.denoise"
        @update:model-value="setRenderPref('denoise', $event)"
      />
      <div class="sm-hint">{{ t("render.denoise.hint") }}</div>
      <DenoiserRow hint-class="sm-hint" size="sm" />
    </section>

    <section class="rd-section">
      <h3 class="rd-head">{{ t("render.tracer.title") }}</h3>
      <Segmented
        class="rd-chips"
        variant="chips"
        size="sm"
        :label="t('prefs.tracer.title')"
        :options="TRACER_CHOICES"
        :model-value="prefs.tracer"
        @update:model-value="setRenderPref('tracer', $event)"
      />
      <div class="sm-hint">{{ t("render.tracer.hint") }}</div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">{{ t("render.performance.title") }}</h3>
      <Checkbox
        class="rd-check"
        data-perf="mode"
        :label="t('prefs.performance.title')"
        :model-value="performanceModeOn(prefs)"
        :disabled="prefs.potatoMode"
        :disabled-reason="t('render.performance.potatoReason')"
        @update:model-value="setRenderPref('performanceMode', $event)"
      />
      <div class="sm-hint">{{ t("render.performance.hint") }}</div>
    </section>

    <section class="rd-section" :title="t('prefs.potato.tip')">
      <h3 class="rd-head">{{ t("prefs.potato.title") }}</h3>
      <Checkbox
        class="rd-check"
        data-potato="mode"
        :label="t('prefs.potato.title')"
        :model-value="prefs.potatoMode"
        @update:model-value="setRenderPref('potatoMode', $event)"
      />
      <div class="sm-hint">{{ t("prefs.potato.hint") }}</div>
    </section>
    <RenderSections tab="environment" />
  </div>
</template>
