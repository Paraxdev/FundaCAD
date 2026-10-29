<script setup lang="ts">
import RenderSections from "./RenderSections.vue";
import Button from "../ui/Button.vue";
import Checkbox from "../ui/Checkbox.vue";
import Segmented from "../ui/Segmented.vue";
import Select from "../ui/Select.vue";
import Slider from "../ui/Slider.vue";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { useUiStore } from "../../stores/ui";
import { toast } from "../../ui/toast";
import { saveRenderedImage } from "../../io/files";
import {
  APERTURE_STOPS,
  MAX_FOV,
  MIN_FOV,
  onRenderPrefsChange,
  renderPrefs,
  setRenderPref,
} from "../../ui/renderPrefs";

const engine = useEngine();
const ui = useUiStore();
const prefs = ref({ ...renderPrefs() });
let off: (() => void) | null = null;
// The tracer can be ready without its state changing, so the offer is re-read now and then.
const tick = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  off = onRenderPrefsChange(() => {
    prefs.value = { ...renderPrefs() };
  });
  timer = setInterval(() => tick.value++, 1000);
});
onUnmounted(() => {
  off?.();
  if (timer) clearInterval(timer);
  abort?.abort();
});

/** A multiple of the viewport size, not a pixel count: the frame is the window's shape, so the file keeps the
 *  on-screen composition. */
const scale = ref(2);
const SCALES = [1, 2, 3, 4];
const saving = ref(false);
/** The silhouette outline is off by default, it is what most makes a render look like a CAD screenshot. */
const edges = ref(false);
/** Reference images are there to draw over, so a picture leaves them out unless asked. */
const references = ref(false);
const hasReferences = ref(false);
const offReferences = engine.store.onReferenceImagesChange((l) => {
  hasReferences.value = l.length > 0;
});
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

const APERTURES = APERTURE_STOPS.map((f) => ({ value: String(f), label: `f/${f}` }));
const SCALE_CHOICES = SCALES.map((n) => ({ value: n, label: `${n}×`, attrs: { "data-scale": String(n) } }));
const SAMPLE_CHOICES = SAMPLES.map((n) => ({ value: n, label: String(n), attrs: { "data-samples": String(n) } }));

async function render(): Promise<string | null> {
  if (traced.value) {
    abort = new AbortController();
    progress.value = 0;
    tracing.value = true;
    try {
      const url = await engine.viewport.renderTracedPicture({
        scale: scale.value,
        samples: samples.value,
        signal: abort.signal,
        onProgress: (n) => {
          progress.value = n;
        },
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
  // Rendered before the dialog and read as a string: the pixels are valid only in the task that rendered them, so
  // awaiting a file dialog first would hand the writer a blank canvas.
  return engine.viewport.renderStill(scale.value, {
    edges: edges.value,
    realtime: true,
    references: references.value && hasReferences.value,
  });
}

async function takePicture() {
  if (saving.value) {
    abort?.abort();
    return;
  }
  saving.value = true;
  try {
    const session = engine.store.session;
    const base = engine.store.fileName === "Untitled" ? "render" : engine.store.fileName;
    const url = await render();
    if (!url || !session.alive) return;
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
      <Slider
        id="rd-fov"
        class="prefs-row"
        label="Field of view"
        :min="MIN_FOV"
        :max="MAX_FOV"
        :step="1"
        :model-value="prefs.fov"
        @update:model-value="setRenderPref('fov', $event)"
      >
        <template #value="{ value }">{{ Math.round(value) }}°</template>
      </Slider>
      <div class="sm-hint">
        A long lens (low numbers) keeps a part's edges nearly parallel, which is the honest look for an engineering
        drawing. A wide one throws the near corner at you, which flatters a product shot. Straight-on views are drawn
        with no lens at all, so this does nothing there.
      </div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Depth of field</h3>
      <Slider
        id="rd-blur"
        class="prefs-row"
        label="Blur"
        :min="0"
        :max="1"
        :step="0.02"
        :model-value="prefs.focusBlur"
        @update:model-value="setRenderPref('focusBlur', $event)"
      >
        <template #value="{ value }">{{ value === 0 ? "off" : value.toFixed(2) }}</template>
      </Slider>
      <div class="prefs-row">
        <label class="prefs-label" for="rd-aperture">Aperture</label>
        <Select
          id="rd-aperture"
          size="sm"
          tip="Aperture"
          :options="APERTURES"
          :disabled="prefs.focusBlur === 0"
          disabled-reason="Turn Blur up from zero to pick an aperture"
          :model-value="String(prefs.aperture)"
          @update:model-value="setRenderPref('aperture', Number.parseFloat($event))"
        />
      </div>
      <div class="sm-hint">
        Whatever the view is centred on stays sharp, so the way to move the focus is to aim at what you want in focus.
        Off at zero, and off entirely on a straight-on view: a parallel projection has no lens, so it can have no depth
        of field.
      </div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Picture</h3>
      <Segmented
        v-model="scale"
        class="rd-chips"
        variant="chips"
        size="sm"
        label="Render size"
        :options="SCALE_CHOICES"
      />
      <div class="sm-hint">{{ shotSize }} pixels, the view as it is framed now.</div>
      <template v-if="tracedSize">
        <Checkbox id="rd-traced" v-model="tracedWanted" class="rd-check" label="Path traced" />
        <Segmented
          v-if="traced"
          v-model="samples"
          class="rd-chips"
          variant="chips"
          size="sm"
          label="Samples"
          :options="SAMPLE_CHOICES"
        />
      </template>
      <Checkbox v-if="!traced" id="rd-edges" v-model="edges" class="rd-check" label="Edge lines" />
      <Checkbox
        v-if="!traced && hasReferences"
        id="rd-references"
        v-model="references"
        class="rd-check"
        label="Reference images"
      />
      <div class="mats-actions">
        <Button id="rd-take-picture" variant="primary" :disabled="saving && !tracing" @click="takePicture()">{{
          buttonText
        }}</Button>
      </div>
      <div v-if="traced" class="sm-hint">
        Traced to the samples picked, then cleaned with the high quality denoise. More samples take longer and keep
        finer detail. Edge lines and reference images are not traced.
      </div>
      <div class="sm-hint">
        The grid, the origin arrows and the sketch planes are left out: they are on screen because you are working, not
        because they are part of the model. Everything else is exactly what you are looking at.
      </div>
    </section>
    <RenderSections tab="camera" />
  </div>
</template>
