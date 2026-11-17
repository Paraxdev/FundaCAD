<script setup lang="ts">
// A key goes to any command the palette offers, by the same id.

import { computed, nextTick, onUnmounted, ref } from "vue";
import {
  SHORTCUTS,
  activeShortcuts,
  allCommands,
  checkShortcut,
  formatShortcut,
  shortcutLabel,
  type Shortcut,
  type ShortcutOverride,
} from "fundacad";
import { Button, FieldRow, Select, announce } from "fundacad/ui";
import {
  DEFAULT_CONFIG,
  RADIAL_ACTION,
  RADIAL_CONTEXTS,
  RING_SLOTS,
  bindingRows as bindingRowsOf,
  keymapFor,
  problemText,
  tableFor,
  type RadialContext,
} from "./navigation";
import { navState, updateConfig } from "./state";
import { t } from "./lines";

const cfg = computed(() => navState.cfg);
const tabled = computed(() => tableFor(cfg.value));
const rows = computed(() => bindingRowsOf(tabled.value.table));
const problem = computed(() => tabled.value.problem ?? navState.problem);
const contextName = (c: Shortcut["context"]) => (c === "sketch" ? t("context.sketch") : t("context.model"));

const commands = computed(() => {
  const seen = new Set<string>();
  return allCommands().filter((c) => !seen.has(c.id) && seen.add(c.id));
});

// Two shipped slots, wireframe and hide selected, are key actions with no palette command. The ring runs them and
// names them by their keys (main.ts), so they are offered here under the same names.
const keyOnlyDefaults = computed(() => {
  const known = new Set(commands.value.map((c) => c.id));
  const ids = new Set(Object.values(DEFAULT_CONFIG.items).flat());
  return SHORTCUTS.filter((s) => ids.has(s.action) && !known.has(s.action) && known.add(s.action));
});

const commandOptions = computed(() => [
  { value: "", label: t("option.nothing") },
  ...commands.value.map((c) => ({ value: c.id, label: c.label, hint: c.group })),
  ...keyOnlyDefaults.value.map((s) => ({ value: s.action, label: s.label, hint: t("option.keys") })),
]);

// One fixed width, so every slot's select shares its right edge: the settings card caps a select at 60% of a width
// that follows each row's own label.
const S = { select: { width: "240px", maxWidth: "100%" } } as const;

function setItem(ctx: RadialContext, slot: number, id: string) {
  const list = [...cfg.value.items[ctx]];
  while (list.length <= slot) list.push("");
  list[slot] = id;
  while (list.length && !list[list.length - 1]) list.pop();
  updateConfig({ items: { ...cfg.value.items, [ctx]: list } });
}

/** One row per action, in the table's order, plus the radial key while it is on. */
const keyRows = computed(() => {
  void cfg.value.keys;
  const table = activeShortcuts();
  const out: { action: string; label: string; context: Shortcut["context"]; key: string }[] = [];
  const seen = new Set<string>();
  for (const s of [...SHORTCUTS, ...table]) {
    if (seen.has(s.action) || s.action === "shortcut-help") continue;
    seen.add(s.action);
    const now = table.find((o) => o.action === s.action);
    out.push({ action: s.action, label: shortcutLabel(s), context: s.context, key: now ? formatShortcut(now) : "" });
  }
  if (cfg.value.radial && !seen.has(RADIAL_ACTION)) {
    const k = keymapFor(cfg.value).find((o) => o.action === RADIAL_ACTION);
    out.unshift({
      action: RADIAL_ACTION,
      label: t("radial.name"),
      context: "global",
      key: k ? formatShortcut({ ...k, context: "global", label: "" }) : "",
    });
  }
  return out;
});

const listening = ref<string | null>(null);
const notes = ref<Record<string, string>>({});

function store(o: ShortcutOverride | null, action: string) {
  const keys = cfg.value.keys.filter((k) => k.action !== action);
  updateConfig({ keys: o ? [...keys, o] : keys });
}

function onCapture(e: KeyboardEvent) {
  const action = listening.value;
  if (!action || ["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  stopListening();
  const o: ShortcutOverride = {
    action,
    key: e.key.toLowerCase(),
    ...(e.shiftKey && e.key !== "?" ? { shift: true } : {}),
    ...(e.ctrlKey || e.metaKey ? { ctrl: true } : {}),
    ...(e.altKey ? { alt: true } : {}),
  };
  const p = checkShortcut(o);
  if (p && !("conflict" in p)) {
    notes.value = { ...notes.value, [action]: t("note.error", { problem: problemText(p) }) };
    return;
  }
  const { alt: _alt, ...kept } = o;
  store(kept, action);
  notes.value = {
    ...notes.value,
    [action]: p ? t("note.warning", { problem: problemText(p) }) : "",
  };
  if (!p) {
    const key = formatShortcut({ ...kept, context: "global", label: "" });
    announce(t("key.announceNow", { label: labelOf(action), key }));
  }
}

const labelOf = (action: string) => keyRows.value.find((r) => r.action === action)?.label ?? action;

function listen(action: string) {
  stopListening();
  listening.value = action;
  window.addEventListener("keydown", onCapture, true);
}
function stopListening() {
  listening.value = null;
  window.removeEventListener("keydown", onCapture, true);
}
// The Reset button leaves with the override, so focus goes to the key it reset.
async function resetKey(action: string) {
  store(null, action);
  notes.value = { ...notes.value, [action]: "" };
  await nextTick();
  document.querySelector<HTMLElement>(`[data-nav-key="${CSS.escape(action)}"]`)?.focus();
  announce(t("key.announceBack", { label: labelOf(action) }));
}

function resetAll() {
  updateConfig({ keys: [] });
  announce(t("key.announceReset"));
}

function stopListeningOn(action: string) {
  if (listening.value === action) stopListening();
}
onUnmounted(stopListening);

const moved = (action: string) => cfg.value.keys.some((k) => k.action === action);
</script>

<template>
  <div class="prefs-grid" data-navigation-prefs>
    <div class="pref-card wide">
      <p class="pref-hint" data-nav-bindings>
        <template v-for="(r, i) in rows" :key="i"
          ><b>{{ r.key }}</b
          >{{ t("binding.after", { label: r.label }) }}
        </template>
      </p>
    </div>

    <div v-if="cfg.radial" class="pref-card wide" role="group" aria-labelledby="nav-radial-title">
      <div class="pref-head"
        ><span id="nav-radial-title" class="pref-title">{{ t("nav.radialItems") }}</span></div
      >
      <p v-if="problem" class="pref-hint" role="alert">{{ t("panel.warning", { problem }) }}</p>
      <details v-for="c in RADIAL_CONTEXTS" :key="c.id">
        <summary :id="`nav-ctx-${c.id}`">{{ c.label }}</summary>
        <div role="group" :aria-labelledby="`nav-ctx-${c.id}`">
          <FieldRow
            v-for="slot in RING_SLOTS + 2"
            :key="slot"
            v-slot="{ id }"
            :for="`nav-${c.id}-${slot}`"
            :label="slot <= RING_SLOTS ? t('slot.number', { n: slot }) : t('slot.more', { n: slot - RING_SLOTS })"
          >
            <Select
              :id="id"
              size="sm"
              :label="slot <= RING_SLOTS ? t('slot.number', { n: slot }) : t('slot.more', { n: slot - RING_SLOTS })"
              :style="S.select"
              :options="commandOptions"
              :placeholder="t('option.notAvailable')"
              :model-value="cfg.items[c.id][slot - 1] ?? ''"
              @update:model-value="setItem(c.id, slot - 1, $event)"
            />
          </FieldRow>
        </div>
      </details>
    </div>

    <div class="pref-card wide" role="group" aria-labelledby="nav-keys-title">
      <div class="pref-head"
        ><span id="nav-keys-title" class="pref-title">{{ t("nav.keysTitle") }}</span></div
      >
      <p class="pref-hint">{{ t("nav.hint") }}</p>
      <div role="list" :aria-label="t('nav.shortcutKeys')" style="display: contents">
        <div v-for="r in keyRows" :key="r.action" role="listitem" class="pref-head" style="flex-wrap: wrap; gap: 6px">
          <span class="pref-title"
            >{{ r.label }}<small v-if="r.context !== 'global'"> ({{ contextName(r.context) }})</small></span
          >
          <Button
            size="sm"
            :data-nav-key="r.action"
            :pressed="listening === r.action"
            :aria-label="
              listening === r.action
                ? t('key.pressFor', { label: r.label })
                : r.key
                  ? t('key.changeSet', { label: r.label, key: r.key })
                  : t('key.changeUnset', { label: r.label })
            "
            @click="listen(r.action)"
            @blur="stopListeningOn(r.action)"
          >
            {{ listening === r.action ? t("key.press") : r.key || t("key.none") }}
          </Button>
          <Button
            v-if="moved(r.action)"
            size="sm"
            :aria-label="t('key.resetOf', { label: r.label })"
            @click="resetKey(r.action)"
            >{{ t("key.reset") }}</Button
          >
          <span v-if="notes[r.action]" class="pref-hint" role="alert">{{ notes[r.action] }}</span>
        </div>
      </div>
      <div class="prefs-actions">
        <Button size="sm" @click="resetAll()">{{ t("key.resetAll") }}</Button>
      </div>
    </div>
  </div>
</template>
