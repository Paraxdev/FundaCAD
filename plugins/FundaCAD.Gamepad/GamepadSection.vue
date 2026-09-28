<script setup lang="ts">
// The controller's page in Preferences: which pad is being read, how fast the
// sticks move things, and what each button does.
//
// A button binds to any command the palette offers, by the same id, so this
// list can never name a command the app does not have, and a command a plugin
// adds shows up here the moment that plugin is on.

import { computed, reactive } from "vue";
import {
  BINDABLE,
  BUTTON_LABELS,
  CURSOR,
  KEY_CHOICES,
  getGamepadConfig,
  resetGamepadConfig,
  setGamepadConfig,
  type GamepadConfig,
} from "./gamepad";
import { padState } from "./state";
import { allCommands } from "fundacad";

const cfg = reactive<GamepadConfig>(structuredClone(getGamepadConfig()));

function set<K extends keyof GamepadConfig>(k: K, v: GamepadConfig[K]) {
  cfg[k] = v;
  setGamepadConfig({ [k]: v } as Partial<GamepadConfig>);
}

function bind(i: number, v: string) {
  cfg.buttons[i] = v;
  setGamepadConfig({ buttons: { [i]: v } });
}

function reset() {
  resetGamepadConfig();
  Object.assign(cfg, structuredClone(getGamepadConfig()));
}

/** The palette's commands, grouped the way the palette groups them. */
const groups = computed(() => {
  const out = new Map<string, { id: string; label: string }[]>();
  const seen = new Set<string>();
  for (const c of allCommands()) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const g = out.get(c.group) ?? [];
    g.push({ id: c.id, label: c.label });
    out.set(c.group, g);
  }
  return [...out.entries()];
});

const SLIDERS: { key: "panSens" | "orbitSens" | "zoomSens" | "cursorSpeed" | "deadzone"; label: string; min: number; max: number; step: number }[] = [
  { key: "panSens", label: "Pan speed", min: 0.1, max: 5, step: 0.1 },
  { key: "orbitSens", label: "Rotate speed", min: 0.2, max: 8, step: 0.1 },
  { key: "zoomSens", label: "Zoom speed", min: 0.2, max: 6, step: 0.1 },
  { key: "cursorSpeed", label: "Cursor speed", min: 100, max: 3000, step: 50 },
  { key: "deadzone", label: "Stick deadzone", min: 0, max: 0.5, step: 0.01 },
];
</script>

<template>
  <div class="prefs-grid">
    <div class="pref-card wide">
      <div class="pref-head">
        <span class="pref-title">Controller</span>
      </div>
      <p class="pref-hint">
        <template v-if="padState.name">Reading <b>{{ padState.name }}</b>.</template>
        <template v-else>
          No controller seen yet. Plug one in and press any button, the webview only reports a
          pad after its first press.
        </template>
        Left stick pans, right stick rotates, the triggers zoom. On a Steam Deck, start FundaCAD
        from Steam so the Deck shows up as a controller; its trackpads keep working as a mouse.
      </p>
    </div>

    <div v-for="s in SLIDERS" :key="s.key" class="pref-card">
      <div class="pref-head">
        <label class="pref-title" :for="`gp-${s.key}`">{{ s.label }}</label>
      </div>
      <input
        :id="`gp-${s.key}`"
        class="sm-slider pref-slider"
        type="range"
        :min="s.min"
        :max="s.max"
        :step="s.step"
        :value="cfg[s.key]"
        @input="set(s.key, Number(($event.target as HTMLInputElement).value))"
      />
    </div>

    <div class="pref-card">
      <label class="pref-head">
        <span class="pref-title">Invert rotate left and right</span>
        <input type="checkbox" :checked="cfg.invertOrbitX" @change="set('invertOrbitX', ($event.target as HTMLInputElement).checked)" />
      </label>
      <label class="pref-head">
        <span class="pref-title">Invert rotate up and down</span>
        <input type="checkbox" :checked="cfg.invertOrbitY" @change="set('invertOrbitY', ($event.target as HTMLInputElement).checked)" />
      </label>
    </div>

    <div class="pref-card wide">
      <div class="pref-head">
        <span class="pref-title">Buttons</span>
      </div>
      <p class="pref-hint">
        With the cursor on, the left stick moves it and A clicks, so faces can be picked without
        a mouse.
      </p>
      <div v-for="i in BINDABLE" :key="i" class="pref-head">
        <label class="pref-title" :for="`gp-btn-${i}`">{{ BUTTON_LABELS[i] }}</label>
        <select
          :id="`gp-btn-${i}`"
          :value="cfg.buttons[i] ?? ''"
          @change="bind(i, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">Nothing</option>
          <option :value="CURSOR">Cursor on / off</option>
          <optgroup label="Keys">
            <option v-for="k in KEY_CHOICES" :key="k.value" :value="k.value">{{ k.label }}</option>
          </optgroup>
          <optgroup v-for="[group, cmds] in groups" :key="group" :label="group">
            <option v-for="c in cmds" :key="c.id" :value="c.id">{{ c.label }}</option>
          </optgroup>
        </select>
      </div>
      <div class="prefs-actions">
        <button type="button" class="btn" @click="reset">Reset to defaults</button>
      </div>
    </div>
  </div>
</template>
