<script setup lang="ts">
import RenderSections from "./RenderSections.vue";
// The lens, and the picture taken through it.
//
// Two things on one tab because they are the same job: everything above the
// button changes what the frame looks like, and the button writes that frame to
// a file. Putting the export anywhere else would mean tuning a shot in one place
// and taking it in another.

import { computed, onMounted, onUnmounted, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { useUiStore } from "../../stores/ui";
import { toast } from "../../ui/toast";
import { saveRenderedImage } from "../../io/files";
import {
  APERTURE_STOPS, MAX_FOV, MIN_FOV, onRenderPrefsChange, renderPrefs, setRenderPref,
} from "../../ui/renderPrefs";

const engine = useEngine();
const ui = useUiStore();
const prefs = ref({ ...renderPrefs() });
let off: (() => void) | null = null;
// The tracer can be ready without its state changing, so the offer is re-read now and then.
const tick = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  off = onRenderPrefsChange(() => { prefs.value = { ...renderPrefs() }; });
  timer = setInterval(() => tick.value++, 1000);
});
onUnmounted(() => {
  off?.();
  if (timer) clearInterval(timer);
  abort?.abort();
});

/** How many times the viewport's own size the saved picture is. Not a pixel
 *  count, because the frame is whatever shape the window is and a fixed width
 *  would either crop it or letterbox it; a multiple keeps the composition on
 *  screen exactly the composition in the file. */
const scale = ref(2);
const SCALES = [1, 2, 3, 4];
const saving = ref(false);
/** Whether the black outline on every silhouette goes in the picture. Off,
 *  because it is the single thing that most makes a render look like a
 *  screenshot of a CAD package; on for anybody who wants exactly that. */
const edges = ref(false);
/** Reference images are there to draw over, so a picture leaves them out unless asked. */
const references = ref(false);
const hasReferences = ref(false);
const offReferences = engine.store.onReferenceImagesChange((l) => { hasReferences.value = l.length > 0; });
onUnmounted(offReferences);

/** Path traced pictures: samples per pixel, then the large denoise weights. */
const SAMPLES = [64, 256, 1024];
const samples = ref(256);
const tracedWanted = ref(true);
const progress = ref(0);
const tracing = ref(false);
let abort: AbortController | null = null;

const tracedSize = computed(() => {
  void tick.value;
  void ui.traceState;
  void ui.viewMode;
  return engine.viewport.tracedPictureSize(scale.value);
});
const traced = computed(() => tracedWanted.value && tracedSize.value !== null);

const shotSize = computed(() => {
  const t = traced.value ? tracedSize.value : null;
  if (t) return `${t.width} × ${t.height}`;
  const c = engine.canvas.getBoundingClientRect();
  return `${Math.round(c.width * scale.value)} × ${Math.round(c.height * scale.value)}`;
});

const buttonText = computed(() => {
  if (!saving.value) return "Save picture…";
  return tracing.value ? `Cancel, ${progress.value} of ${samples.value} samples` : "Rendering…";
});

const onFov = (e: Event) =>
  setRenderPref("fov", Number.parseFloat((e.target as HTMLInputElement).value));
const onBlur = (e: Event) =>
  setRenderPref("focusBlur", Number.parseFloat((e.target as HTMLInputElement).value));
const onAperture = (e: Event) =>
  setRenderPref("aperture", Number.parseFloat((e.target as HTMLSelectElement).value));

async function render(): Promise<string | null> {
  if (traced.value) {
    abort = new AbortController();
    progress.value = 0;
    tracing.value = true;
    try {
      const url = await engine.viewport.renderTracedPicture({
        scale: scale.value, samples: samples.value, signal: abort.signal, onProgress: (n) => { progress.value = n; },
      });
      if (url) return url;
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast(`The traced picture failed: ${(e as Error).message}`);
      return null;
    } finally {
      abort = null;
      tracing.value = false;
    }
  }
  // Rendered BEFORE the dialog, and read as a string, because the pixels are
  // only valid in the same task as the render that produced them. Awaiting a
  // file dialog first would hand the writer a blank canvas.
  return engine.viewport.renderStill(scale.value, { edges: edges.value, realtime: true, references: references.value && hasReferences.value });
}

async function takePicture() {
  if (saving.value) {
    abort?.abort();
    return;
  }
  saving.value = true;
  try {
    const url = await render();
    if (!url) return;
    const base = engine.store.fileName === "Untitled" ? "render" : engine.store.fileName;
    const path = await saveRenderedImage(url, `${base}.png`);
    if (path) toast(`Saved ${path}`);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="rd-scroll">
    <section class="rd-section">
      <h3 class="rd-head">Lens</h3>
      <label class="prefs-row">
        <span class="prefs-label">Field of view</span>
        <input
          id="rd-fov"
          class="sm-slider"
          type="range"
          :min="MIN_FOV" :max="MAX_FOV" step="1"
          :value="prefs.fov"
          @input="onFov"
        />
        <span class="rd-value">{{ Math.round(prefs.fov) }}°</span>
      </label>
      <div class="sm-hint">
        A long lens (low numbers) keeps a part's edges nearly parallel, which is
        the honest look for an engineering drawing. A wide one throws the near
        corner at you, which flatters a product shot. Straight-on views are drawn
        with no lens at all, so this does nothing there.
      </div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Depth of field</h3>
      <label class="prefs-row">
        <span class="prefs-label">Blur</span>
        <input
          id="rd-blur"
          class="sm-slider"
          type="range" min="0" max="1" step="0.02"
          :value="prefs.focusBlur"
          @input="onBlur"
        />
        <span class="rd-value">{{ prefs.focusBlur === 0 ? "off" : prefs.focusBlur.toFixed(2) }}</span>
      </label>
      <label class="prefs-row">
        <span class="prefs-label">Aperture</span>
        <select
          id="rd-aperture"
          class="sm-select"
          :disabled="prefs.focusBlur === 0"
          :value="String(prefs.aperture)"
          @change="onAperture"
        >
          <option v-for="f in APERTURE_STOPS" :key="f" :value="String(f)">f/{{ f }}</option>
        </select>
      </label>
      <div class="sm-hint">
        Whatever the view is centred on stays sharp, so the way to move the focus
        is to aim at what you want in focus. Off at zero, and off entirely on a
        straight-on view: a parallel projection has no lens, so it can have no
        depth of field.
      </div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Picture</h3>
      <div class="rd-chips" role="group" aria-label="Render size">
        <button
          v-for="s in SCALES"
          :key="s"
          class="rd-chip"
          :class="{ active: scale === s }"
          :data-scale="s"
          @click="scale = s"
        >{{ s }}×</button>
      </div>
      <div class="sm-hint">{{ shotSize }} pixels, the view as it is framed now.</div>
      <template v-if="tracedSize">
        <label class="prefs-row">
          <span class="prefs-label">Path traced</span>
          <input id="rd-traced" type="checkbox" :checked="tracedWanted" @change="tracedWanted = !tracedWanted" />
        </label>
        <div v-if="traced" class="rd-chips" role="group" aria-label="Samples">
          <button
            v-for="n in SAMPLES"
            :key="n"
            class="rd-chip"
            :class="{ active: samples === n }"
            :data-samples="n"
            @click="samples = n"
          >{{ n }}</button>
        </div>
      </template>
      <label v-if="!traced" class="prefs-row">
        <span class="prefs-label">Edge lines</span>
        <input id="rd-edges" type="checkbox" :checked="edges" @change="edges = !edges" />
      </label>
      <label v-if="!traced && hasReferences" class="prefs-row">
        <span class="prefs-label">Reference images</span>
        <input id="rd-references" type="checkbox" :checked="references" @change="references = !references" />
      </label>
      <div class="mats-actions">
        <button
          id="rd-take-picture"
          class="btn btn-primary"
          :disabled="saving && !tracing"
          @click="takePicture()"
        >{{ buttonText }}</button>
      </div>
      <div v-if="traced" class="sm-hint">
        Traced to the samples picked, then cleaned with the high quality denoise.
        More samples take longer and keep finer detail. Edge lines and reference images are not traced.
      </div>
      <div class="sm-hint">
        The grid, the origin arrows and the sketch planes are left out: they are
        on screen because you are working, not because they are part of the
        model. Everything else is exactly what you are looking at.
      </div>
    </section>
    <RenderSections tab="camera" />
  </div>
</template>
