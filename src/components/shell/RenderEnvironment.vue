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

import { onMounted, onUnmounted, ref } from "vue";
import {
  BLOOM_SETTINGS, ENVIRONMENTS_LIST, MAX_BRIGHTNESS, MIN_BRIGHTNESS,
  onRenderPrefsChange, renderPrefs, setRenderPref,
  type Background, type Bloom, type Environment,
} from "../../ui/renderPrefs";

const prefs = ref({ ...renderPrefs() });
let off: (() => void) | null = null;
onMounted(() => { off = onRenderPrefsChange(() => { prefs.value = { ...renderPrefs() }; }); });
onUnmounted(() => off?.());

const BACKGROUNDS: { id: Background; label: string }[] = [
  { id: "theme", label: "Theme" },
  { id: "dark", label: "Dark" },
  { id: "grey", label: "Mid grey" },
  { id: "light", label: "Light" },
];

const BLOOMS: { id: Bloom; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "subtle", label: "Subtle" },
  { id: "strong", label: "Strong" },
];

const pickEnv = (id: Environment) => setRenderPref("environment", id);
const onBrightness = (e: Event) =>
  setRenderPref("brightness", Number.parseFloat((e.target as HTMLInputElement).value));
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
      <h3 class="rd-head">Bloom</h3>
      <div class="rd-chips" role="group" aria-label="Bloom">
        <button
          v-for="b in BLOOMS"
          :key="b.id"
          class="rd-chip"
          :class="{ active: prefs.bloom === b.id }"
          :data-bloom="b.id"
          @click="setRenderPref('bloom', b.id)"
        >{{ b.label }}</button>
      </div>
      <div class="sm-hint">
        Light spilling off the brightest parts of the image. Subtle only reaches
        a material with Glow turned up and a hard specular highlight
        <template v-if="prefs.bloom === 'subtle'">
          (anything brighter than {{ BLOOM_SETTINGS.subtle.threshold }})</template>, so
        an ordinary part looks the same either way.
      </div>
    </section>

    <section class="rd-section">
      <h3 class="rd-head">Performance</h3>
      <div class="rd-chips" role="group" aria-label="Performance mode">
        <button
          class="rd-chip"
          :class="{ active: prefs.performanceMode }"
          data-perf="mode"
          :aria-pressed="prefs.performanceMode"
          @click="setRenderPref('performanceMode', !prefs.performanceMode)"
        >{{ prefs.performanceMode ? "On" : "Off" }}</button>
      </div>
      <div class="sm-hint">
        Drop the heavy effects, glass refraction, a high pixel ratio and the
        extra emitter lights, for a lighter render. On automatically on a weak
        GPU; turn it on by hand if the viewport stutters or a laptop runs hot.
      </div>
    </section>
  </div>
</template>
