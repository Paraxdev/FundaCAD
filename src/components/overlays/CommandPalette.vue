<script setup lang="ts">
// Cmd/Ctrl-K command palette: fuzzy-search every command and run it. The
// discoverability safety net (mainstream MCAD's "S" key equivalent), so nothing
// is lost when the ribbon collapses tools into overflow, and shortcut-less /
// right-click-only commands become findable by name.

import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { useCommandPaletteStore } from "../../stores/commandPalette";
import { allCommands } from "../../ui/commands";
import { score } from "../../ui/commandScore";

const cmdk = useCommandPaletteStore();
const input = useTemplateRef<HTMLInputElement>("input");
const query = ref("");
const active = ref(0);

// Item elements for scrollIntoView only. A PLAIN array, deliberately not a ref:
// these are write-only DOM handles, and making 40 of them reactive per keystroke
// would buy nothing.
let itemEls: (HTMLElement | null)[] = [];
function setItemEl(i: number, el: unknown) {
  itemEls[i] = (el as HTMLElement | null) ?? null;
}

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

// Every re-filter puts the highlight back on the best match, exactly as the
// imperative refresh() did by rebuilding the list with `active = 0`.
watch(results, () => {
  active.value = 0;
  itemEls = [];
});

// Reset and focus on open. The input is created in the same flush, so focus has
// to wait for it; on close the query is cleared so the next Ctrl+K starts fresh
// (the old implementation got this by destroying the DOM).
watch(
  () => cmdk.open,
  async (isOpen) => {
    if (!isOpen) return;
    query.value = "";
    active.value = 0;
    await nextTick();
    input.value?.focus();
  },
);

function setActive(i: number) {
  if (i < 0 || i >= results.value.length) return;
  active.value = i;
  void nextTick(() => itemEls[i]?.scrollIntoView({ block: "nearest" }));
}

function runIndex(i: number) {
  const cmd = results.value[i];
  if (cmd) cmdk.runCommand(cmd.id);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    setActive(Math.min(active.value + 1, results.value.length - 1));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    setActive(Math.max(active.value - 1, 0));
  } else if (e.key === "Enter") {
    e.preventDefault();
    runIndex(active.value);
  } else if (e.key === "Escape") {
    // stopPropagation as well as preventDefault: Escape is also the global
    // "clear selection / cancel tool" key, and dismissing the palette must not
    // additionally cancel whatever is underneath it.
    e.preventDefault();
    e.stopPropagation();
    cmdk.close();
  }
}
</script>

<template>
  <Teleport to="body">
    <!-- .self: only a click on the backdrop itself dismisses, never one that
         bubbled up out of the card. -->
    <div v-if="cmdk.open" class="cmdk-backdrop" @pointerdown.self="cmdk.close()">
      <div class="cmdk-card">
        <input
          ref="input"
          v-model="query"
          class="cmdk-input"
          placeholder="Search commands…"
          spellcheck="false"
          @keydown="onKey"
        />
        <div class="cmdk-list">
          <div
            v-for="(c, i) in results"
            :key="c.id"
            :ref="(el) => setItemEl(i, el)"
            class="cmdk-item"
            :class="{ active: i === active }"
            @pointermove="setActive(i)"
            @click="runIndex(i)"
          >
            <span class="cmdk-label">{{ c.label }}</span>
            <span class="cmdk-group">{{ c.group }}</span>
            <span v-if="c.key" class="cmdk-key">{{ c.key }}</span>
          </div>
          <div v-if="!results.length" class="cmdk-empty">No matching command</div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
