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
import { t } from "./lines";
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

// One fixed width, so every select shares its right edge and a long command ellipses inside it: the settings card caps
// a select at 60% of a width that follows each row's own label.
const S = { select: { width: "240px", maxWidth: "100%" } } as const;

// The device name sits in bold between the two halves of one translated sentence.
const reading = computed(() => t("pad.reading", { name: "" }).split("") as [string, string]);

const options = computed(() => [
  { value: "", label: t("option.nothing") },
  { value: CURSOR, label: t("option.cursor") },
  ...KEY_CHOICES.map((k) => ({ value: k.value, label: k.label, hint: t("option.keys") })),
  ...groups.value.flatMap(([group, cmds]) => cmds.map((c) => ({ value: c.id, label: c.label, hint: group }))),
]);
</script>

<template>
  <div class="prefs-grid">
    <div class="pref-card wide">
      <div class="pref-head">
        <span class="pref-title">{{ t("pad.controller") }}</span>
      </div>
      <p class="pref-hint">
        <template v-if="padState.name"
          >{{ reading[0] }}<b>{{ padState.name }}</b
          >{{ reading[1] }}</template
        >
        <template v-else>{{ t("pad.none") }}</template>
        {{ t("pad.usage") }}
      </p>
    </div>

    <div class="pref-card wide" role="group" aria-labelledby="gp-buttons-title">
      <div class="pref-head">
        <span id="gp-buttons-title" class="pref-title">{{ t("pad.buttons") }}</span>
      </div>
      <p class="pref-hint">{{ t("pad.cursorHint") }}</p>
      <FieldRow v-for="i in BINDABLE" :key="i" v-slot="{ id }" :for="`gp-btn-${i}`" :label="BUTTON_LABELS[i] ?? ''">
        <Select
          :id="id"
          size="sm"
          :style="S.select"
          :label="BUTTON_LABELS[i] ?? ''"
          :options="options"
          :model-value="cfg.buttons[i] ?? ''"
          @update:model-value="bind(i, $event)"
        />
      </FieldRow>
    </div>
  </div>
</template>
