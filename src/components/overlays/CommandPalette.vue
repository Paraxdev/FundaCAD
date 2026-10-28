<script setup lang="ts">
import { fmtKeys } from "../../input/platform";
import { computed, nextTick, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { claimEscape } from "../../ui/escapeClaim";
import { useCommandPaletteStore } from "../../stores/commandPalette";
import { allCommands } from "../../ui/commands";
import { score } from "../../ui/commandScore";
import TextField from "../ui/TextField.vue";
import { focusReturn } from "../ui/focusables";

const cmdk = useCommandPaletteStore();
const input = useTemplateRef<InstanceType<typeof TextField>>("input");
const card = useTemplateRef<HTMLElement>("card");
const query = ref("");
const active = ref(0);

// A plain array, not a ref: write-only DOM handles for scrollIntoView, reactivity per keystroke buys nothing.
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

watch(results, () => {
  active.value = 0;
  itemEls = [];
});

// Escape is claimed so a screen under the palette, such as Home, leaves it alone. The input mounts in the same flush
// as the open, so focus waits for it. Focus goes back to where it was on close, the palette is gone by then.
let releaseEscape: (() => void) | null = null;
let back: ReturnType<typeof focusReturn> | null = null;
onUnmounted(() => releaseEscape?.());
watch(
  () => cmdk.open,
  async (isOpen) => {
    if (!isOpen) {
      releaseEscape?.();
      releaseEscape = null;
      back?.restore((n) => !!card.value?.contains(n));
      back = null;
      return;
    }
    releaseEscape ??= claimEscape();
    back ??= focusReturn();
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
    <div v-if="cmdk.open" class="cmdk-backdrop" @pointerdown.self="cmdk.close()">
      <div ref="card" class="cmdk-card" role="dialog" aria-modal="true" aria-label="Command palette">
        <TextField
          ref="input"
          v-model="query"
          class="cmdk-input"
          placeholder="Search commands…"
          label="Search commands"
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
            <span v-if="c.key" class="cmdk-key">{{ fmtKeys(c.key) }}</span>
          </div>
          <div v-if="!results.length" class="cmdk-empty">No matching command</div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
