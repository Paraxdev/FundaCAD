<script setup lang="ts">
import { fmtKeys, isMac } from "../../input/platform";
import { computed, nextTick, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { claimEscape } from "../../ui/escapeClaim";
import { useCommandPaletteStore } from "../../stores/commandPalette";
import { allCommands } from "../../ui/commands";
import { score } from "../../ui/commandScore";
import { announce, cancelAnnouncement } from "../../ui/announce";
import Combobox from "../ui/Combobox.vue";
import { focusReturn } from "../ui/focusables";
import { inertOthers } from "../../composables/useModalGate";

const cmdk = useCommandPaletteStore();
const input = useTemplateRef<{ focus: () => void }>("input");
const card = useTemplateRef<HTMLElement>("card");
const backdrop = useTemplateRef<HTMLElement>("backdrop");
const query = ref("");
const active = ref(0);
const COUNT = "cmdk-count";
const ARROWS: Record<string, string> = { Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };

const results = computed(() => {
  if (!cmdk.open) return [];
  const q = query.value.trim().toLowerCase();
  return allCommands()
    .filter((c) => c.context === "global" || c.context === cmdk.context)
    .map((c) => ({ c, s: score(q, c.label.toLowerCase()) }))
    .filter((x) => q === "" || x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 40)
    .map((x) => x.c);
});

// aria-keyshortcuts spells out the modifier and lists alternatives with a space: "Home / F6" is "Home F6".
function ariaShortcut(hint: string): string {
  const ctrl = isMac() ? "Meta" : "Control";
  return hint
    .split(/\s*\/\s*/)
    .map((k) =>
      k
        .split("+")
        .map((p) => (p === "Ctrl" ? ctrl : (ARROWS[p] ?? p)))
        .join("+"),
    )
    .join(" ");
}

const options = computed(() =>
  results.value.map((c) => ({
    value: c.id,
    label: c.label,
    keyshortcuts: c.key ? ariaShortcut(c.key) : undefined,
  })),
);

watch(results, () => {
  active.value = 0;
});

// The query is cleared on close, so opening says nothing and only typing speaks the count.
watch(query, () => {
  if (!cmdk.open) return;
  const n = results.value.length;
  const text = n === 0 ? "No matching command" : n === 1 ? "1 command" : `${n} commands`;
  announce(text, "polite", { key: COUNT, delay: 300 });
});

// Escape is claimed so a screen under the palette, such as Home, leaves it alone. The input mounts in the same flush
// as the open, so focus and the inert page wait for it. The page is live again before focus goes back, since an
// inert opener cannot take it.
let releaseEscape: (() => void) | null = null;
let releaseInert: (() => void) | null = null;
let back: ReturnType<typeof focusReturn> | null = null;
onUnmounted(() => {
  releaseEscape?.();
  releaseInert?.();
  cancelAnnouncement(COUNT);
});
watch(
  () => cmdk.open,
  async (isOpen) => {
    if (!isOpen) {
      cancelAnnouncement(COUNT);
      query.value = "";
      releaseEscape?.();
      releaseEscape = null;
      releaseInert?.();
      releaseInert = null;
      back?.restore((n) => !!card.value?.contains(n));
      back = null;
      return;
    }
    releaseEscape ??= claimEscape();
    back ??= focusReturn();
    active.value = 0;
    await nextTick();
    if (cmdk.open && backdrop.value) releaseInert ??= inertOthers(backdrop.value);
    input.value?.focus();
  },
);

// The Combobox has already taken the arrows and Enter on a row.
function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  if (e.key === "Enter") {
    e.preventDefault();
  } else if (e.key === "Tab") {
    // The input is the palette's one Tab stop, so Tab stays on it rather than leaving for the page underneath.
    e.preventDefault();
  } else if (e.key === "Escape") {
    // Also stopPropagation: Escape is the global cancel key too, and closing the palette must not cancel what is under it.
    e.preventDefault();
    e.stopPropagation();
    cmdk.close();
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="cmdk.open" ref="backdrop" class="cmdk-backdrop" @pointerdown.self="cmdk.close()">
      <div ref="card" class="cmdk-card" role="dialog" aria-modal="true" aria-label="Command palette">
        <Combobox
          ref="input"
          v-model="query"
          v-model:active="active"
          class="cmdk-input"
          list-class="cmdk-list"
          option-class="cmdk-item"
          :options="options"
          placeholder="Search commands…"
          label="Search commands"
          spellcheck="false"
          @keydown="onKey"
          @pick="cmdk.runCommand($event)"
        >
          <!-- The commas are for the option name, which a screen reader reads as one line. -->
          <template #default="{ index }">
            <span class="cmdk-label">{{ results[index]?.label }}</span>
            <span class="sr-only">, </span>
            <span class="cmdk-group">{{ results[index]?.group }}</span>
            <template v-if="results[index]?.key">
              <span class="sr-only">, </span>
              <span class="cmdk-key">{{ fmtKeys(results[index]!.key!) }}</span>
            </template>
          </template>
          <template #empty><div class="cmdk-empty">No matching command</div></template>
        </Combobox>
      </div>
    </div>
  </Teleport>
</template>
