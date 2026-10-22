<script setup lang="ts">
// Below the controller's declared settings: which pad is being read, and what
// each button does.
//
// A button binds to any command the palette offers, by the same id, so this
// list can never name a command the app does not have, and a command a plugin
// adds shows up here the moment that plugin is on.

import { computed, onUnmounted, reactive } from "vue";
import {
  BINDABLE,
  BUTTON_LABELS,
  CURSOR,
  KEY_CHOICES,
  getGamepadConfig,
  setGamepadConfig,
  settings,
  type GamepadConfig,
} from "./gamepad";
import { padState } from "./state";
import { allCommands } from "fundacad";

const cfg = reactive<GamepadConfig>(structuredClone(getGamepadConfig()));

const off = settings.onChange(() => Object.assign(cfg, structuredClone(getGamepadConfig())));
onUnmounted(off);

function bind(i: number, v: string) {
  cfg.buttons[i] = v;
  setGamepadConfig({ buttons: { [i]: v } });
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
</script>

<template>
  <div class="prefs-grid">
    <div class="pref-card wide">
      <div class="pref-head">
        <span class="pref-title">Controller</span>
      </div>
      <p class="pref-hint">
        <template v-if="padState.name"
          >Reading <b>{{ padState.name }}</b
          >.</template
        >
        <template v-else>
          No controller seen yet. Plug one in and press any button, the webview only reports a pad after its first
          press.
        </template>
        Left stick pans, right stick rotates, the triggers zoom. On a Steam Deck, start FundaCAD from Steam so the Deck
        shows up as a controller; its trackpads keep working as a mouse.
      </p>
    </div>

    <div class="pref-card wide">
      <div class="pref-head">
        <span class="pref-title">Buttons</span>
      </div>
      <p class="pref-hint">
        With the cursor on, the left stick moves it and A clicks, so faces can be picked without a mouse.
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
    </div>
  </div>
</template>
