<script setup lang="ts">
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
import { FieldRow, Select } from "fundacad/ui";

const cfg = reactive<GamepadConfig>(structuredClone(getGamepadConfig()));

const off = settings.onChange(() => Object.assign(cfg, structuredClone(getGamepadConfig())));
onUnmounted(off);

function bind(i: number, v: string) {
  cfg.buttons[i] = v;
  setGamepadConfig({ buttons: { [i]: v } });
}

// A button binds to a palette command by its id, so it never names a command the app lacks, and a command a plugin
// adds shows up the moment that plugin is on. Grouped the way the palette groups them.
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

const options = computed(() => [
  { value: "", label: "Nothing" },
  { value: CURSOR, label: "Cursor on / off" },
  ...KEY_CHOICES.map((k) => ({ value: k.value, label: k.label, hint: "Keys" })),
  ...groups.value.flatMap(([group, cmds]) => cmds.map((c) => ({ value: c.id, label: c.label, hint: group }))),
]);
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

    <div class="pref-card wide" role="group" aria-labelledby="gp-buttons-title">
      <div class="pref-head">
        <span id="gp-buttons-title" class="pref-title">Buttons</span>
      </div>
      <p class="pref-hint">
        With the cursor on, the left stick moves it and A clicks, so faces can be picked without a mouse.
      </p>
      <FieldRow v-for="i in BINDABLE" :key="i" v-slot="{ id }" :for="`gp-btn-${i}`" :label="BUTTON_LABELS[i] ?? ''">
        <Select
          :id="id"
          size="sm"
          :label="BUTTON_LABELS[i] ?? ''"
          :options="options"
          :model-value="cfg.buttons[i] ?? ''"
          @update:model-value="bind(i, $event)"
        />
      </FieldRow>
    </div>
  </div>
</template>
