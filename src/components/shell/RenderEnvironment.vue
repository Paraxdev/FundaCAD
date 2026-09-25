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
  ENVIRONMENTS_LIST, MAX_BRIGHTNESS, MIN_BRIGHTNESS,
  onRenderPrefsChange, performanceModeOn, renderPrefs, setRenderPref,
  type Background, type Environment,
} from "../../ui/renderPrefs";
import { DEFAULT_KEY } from "../../viewport/keyLight";
import { formatTurn } from "../../viewport/rotateDial";
import { useEngine } from "../../app/engineKey";

const engine = useEngine();
const prefs = ref({ ...renderPrefs() });
const aiming = ref(false);
let off: (() => void) | null = null;
onMounted(() => { off = onRenderPrefsChange(() => { prefs.value = { ...renderPrefs() }; }); });
onUnmounted(() => off?.());

const BACKGROUNDS: { id: Background; label: string }[] = [
  { id: "theme", label: "Theme" },
  { id: "dark", label: "Dark" },
  { id: "grey", label: "Mid grey" },
  { id: "light", label: "Light" },
];

const pickEnv = (id: Environment) => setRenderPref("environment", id);
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
        reaches a material with Glow up and a hard specular highlight, so an
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
