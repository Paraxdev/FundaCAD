<script setup lang="ts">
// Below the plugin's declared settings: what the buttons do now, the radial
// menu's items and the keys. A key goes to any command the palette offers, by
// the same id.

import { computed, onUnmounted, ref } from "vue";
import {
  SHORTCUTS, activeShortcuts, allCommands, bindingRows, checkShortcut, describeShortcutProblem, formatShortcut,
  type Shortcut, type ShortcutOverride,
} from "fundacad";
import { RADIAL_ACTION, RADIAL_CONTEXTS, RING_SLOTS, keymapFor, tableFor, type RadialContext } from "./navigation";
import { navState, updateConfig } from "./state";

const cfg = computed(() => navState.cfg);
const rows = computed(() => bindingRows(tableFor(cfg.value).table));

const commands = computed(() => {
  const seen = new Set<string>();
  return allCommands().filter((c) => !seen.has(c.id) && seen.add(c.id));
});

function setItem(ctx: RadialContext, slot: number, id: string) {
  const list = [...cfg.value.items[ctx]];
  while (list.length <= slot) list.push("");
  list[slot] = id;
  while (list.length && !list[list.length - 1]) list.pop();
  updateConfig({ items: { ...cfg.value.items, [ctx]: list } });
}

// --- keys --------------------------------------------------------------------

/** One row per action, in the table's order, plus the radial key while it is on. */
const keyRows = computed(() => {
  void cfg.value.keys;
  const table = activeShortcuts();
  const out: { action: string; label: string; context: Shortcut["context"]; key: string }[] = [];
  const seen = new Set<string>();
  for (const s of [...SHORTCUTS, ...table]) {
    if (seen.has(s.action) || s.action === "shortcut-help") continue;
    seen.add(s.action);
    const now = table.find((t) => t.action === s.action);
    out.push({ action: s.action, label: s.label, context: s.context, key: now ? formatShortcut(now) : "" });
  }
  if (cfg.value.radial && !seen.has(RADIAL_ACTION)) {
    const k = keymapFor(cfg.value).find((o) => o.action === RADIAL_ACTION);
    out.unshift({ action: RADIAL_ACTION, label: "Radial menu", context: "global", key: k ? formatShortcut({ ...k, context: "global", label: "" }) : "" });
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
    notes.value = { ...notes.value, [action]: describeShortcutProblem(p) };
    return;
  }
  const { alt: _alt, ...kept } = o;
  store(kept, action);
  notes.value = { ...notes.value, [action]: p ? `${describeShortcutProblem(p)}, this one is preferred over it` : "" };
}

function listen(action: string) {
  stopListening();
  listening.value = action;
  window.addEventListener("keydown", onCapture, true);
}
function stopListening() {
  listening.value = null;
  window.removeEventListener("keydown", onCapture, true);
}
function resetKey(action: string) {
  store(null, action);
  notes.value = { ...notes.value, [action]: "" };
}
onUnmounted(stopListening);

const moved = (action: string) => cfg.value.keys.some((k) => k.action === action);
</script>

<template>
  <div class="prefs-grid" data-navigation-prefs>
    <div class="pref-card wide">
      <p class="pref-hint" data-nav-bindings>
        <template v-for="(r, i) in rows" :key="i"><b>{{ r.key }}</b>: {{ r.label.toLowerCase() }}. </template>
      </p>
    </div>

    <div v-if="cfg.radial" class="pref-card wide">
      <div class="pref-head"><span class="pref-title">Radial menu items</span></div>
      <p v-if="navState.problem" class="pref-hint" role="status">{{ navState.problem }}</p>
      <details v-for="c in RADIAL_CONTEXTS" :key="c.id">
        <summary>{{ c.label }}</summary>
        <div v-for="slot in RING_SLOTS + 2" :key="slot" class="pref-head">
          <label class="pref-title" :for="`nav-${c.id}-${slot}`">{{ slot <= RING_SLOTS ? `Slot ${slot}` : `More ${slot - RING_SLOTS}` }}</label>
          <select :id="`nav-${c.id}-${slot}`" :value="cfg.items[c.id][slot - 1] ?? ''" @change="setItem(c.id, slot - 1, ($event.target as HTMLSelectElement).value)">
            <option value="">Nothing</option>
            <option v-for="cmd in commands" :key="cmd.id" :value="cmd.id">{{ cmd.label }}</option>
          </select>
        </div>
      </details>
    </div>

    <div class="pref-card wide">
      <div class="pref-head"><span class="pref-title">Keyboard shortcuts</span></div>
      <p class="pref-hint">
        Click a key, then press the new one. Undo, save, Escape, Tab and ? stay where they are, and Alt is left to the tools.
        The pattern tool reads the arrow keys itself while it is open, wherever the view steps are.
      </p>
      <div v-for="r in keyRows" :key="r.action" class="pref-head" style="flex-wrap: wrap; gap: 6px">
        <span class="pref-title">{{ r.label }}<small v-if="r.context !== 'global'"> ({{ r.context }})</small></span>
        <button type="button" class="btn" :aria-pressed="listening === r.action" @click="listen(r.action)">
          {{ listening === r.action ? "Press a key" : r.key || "None" }}
        </button>
        <button v-if="moved(r.action)" type="button" class="btn" @click="resetKey(r.action)">Reset</button>
        <span v-if="notes[r.action]" class="pref-hint" role="status">{{ notes[r.action] }}</span>
      </div>
      <div class="prefs-actions">
        <button type="button" class="btn" @click="updateConfig({ keys: [] })">Reset all keys</button>
      </div>
    </div>
  </div>
</template>

