<script setup lang="ts">
// Renders nothing unless there are bodies and a machine answered about filament: the palette is what a machine's
// toolheads hold, not a colour scheme, and a control that cannot do its job is worse present than absent.

import { computed, onUnmounted, ref, watch } from "vue";
import { FILAMENTS, staleSlots, type FilamentSource } from "./palette";
import { service, useBrowserStore, useBuildValue, useEngine } from "fundacad";
import { Icon, InlineLabel } from "fundacad/ui";

const engine = useEngine();
const store = engine.store;
const browser = useBrowserStore();

/** Whoever can talk to a machine, or null in a build where nobody can. Read once per mount, since the provider's
 *  capability starting or stopping remounts the browser's contributed sections anyway. */
const filaments = service<FilamentSource>(FILAMENTS);

const hasBodies = useBuildValue(() => (store.buildState.result?.bodies ?? []).length > 0);

/** Whether a machine answered the last probe. null = never asked, or asked and
 *  the answer has not come back. */
const online = ref<boolean | null>(null);
const stale = ref<number[]>([]);

const shown = computed(() => hasBodies.value && online.value === true);

const isStale = computed(() => online.value === true && stale.value.length > 0);
const collapsed = computed(() => browser.isCollapsed("Palette"));

const dotStyle = computed(() => ({
  width: "8px",
  height: "8px",
  borderRadius: "50%",
  background: online.value == null ? "#888" : !online.value ? "#d23b30" : isStale.value ? "#d2a83b" : "#3ba55d",
  display: "inline-block",
  marginRight: "6px",
}));
const dotTitle = computed(() =>
  isStale.value
    ? `Printer filaments changed since sync (slot${stale.value.length > 1 ? "s" : ""} ${stale.value.map((i) => i + 1).join(", ")}), click the sync button to re-sync`
    : "Printer connection",
);

// Passive checks, armed once when bodies first appear: a one-shot probe that lights the dot and a single 30s
// staleness poll that re-diffs WITHOUT applying. Guarded, since hasBodies flips on every New and Open.
let probedOnce = false;
let pollTimer: number | null = null;

function arm() {
  if (!filaments) return;
  if (!probedOnce) {
    probedOnce = true;
    void filaments.probe().then((ok) => {
      online.value = ok;
    });
  }
  if (pollTimer == null) pollTimer = window.setInterval(() => void poll(), 30_000);
}

async function poll() {
  if (document.visibilityState !== "visible" || collapsed.value || !filaments) return;
  try {
    const loaded = await filaments.read();
    online.value = true;
    stale.value = staleSlots(store.colorPalette, loaded);
  } catch {
    online.value = false;
    stale.value = [];
  }
}

async function sync() {
  if (!filaments) return;
  const wrote = await filaments.sync(store);
  online.value = true;
  // Matches the machine by construction now, whether or not anything changed.
  if (wrote) stale.value = [];
}

watch(
  hasBodies,
  (v) => {
    if (v) arm();
  },
  { immediate: true },
);
onUnmounted(() => {
  if (pollTimer != null) clearInterval(pollTimer);
});
</script>

<template>
  <template v-if="shown">
    <!-- Own markup rather than TreeFolder: the dot and sync button sit where a folder's eye would, and the label has
         no .tree-label class on purpose (the e2e panel dump reads that). -->
    <div class="tree-folder" :aria-expanded="!collapsed" @click="browser.toggle('Palette')">
      <span class="tree-caret"><Icon :name="collapsed ? 'caretRight' : 'caretDown'" :size="11" /></span>
      <span class="feature-icon"><Icon name="filament" :size="14" /></span>
      <span>Palette</span>
      <span style="flex: 1"></span>
      <span class="pal-dot" :title="dotTitle" :style="dotStyle"></span>
      <!-- .stop: the button lives in the header but must not also toggle it -->
      <button
        class="pal-sync"
        title="Sync filaments from printer"
        style="
          background: none;
          border: none;
          color: inherit;
          cursor: pointer;
          font-size: 13px;
          padding: 0 4px;
          margin-right: 6px;
        "
        @click.stop="sync()"
        ><Icon name="sync" :size="14"
      /></button>
      <span class="tree-count">{{ store.colorPalette.length }}</span>
    </div>

    <template v-if="!collapsed">
      <div
        v-for="(slot, i) in store.colorPalette"
        :key="`pal:${i}`"
        class="feature-row tree-child"
        :title="`Filament slot ${i + 1} → toolhead ${i + 1}${slot.material ? ` (${slot.material})` : ''}`"
      >
        <input
          type="color"
          class="pal-swatch"
          style="
            width: 18px;
            height: 18px;
            border: none;
            background: none;
            padding: 0;
            cursor: pointer;
            vertical-align: middle;
          "
          :value="slot.color"
          @change="store.setPaletteSlot(i, { color: ($event.target as HTMLInputElement).value })"
        />
        <InlineLabel
          :text="slot.name"
          :label-style="{ marginLeft: '7px' }"
          rename-on-dblclick
          :rename="(name: string) => store.setPaletteSlot(i, { name })"
        />
        <span v-if="slot.material" class="pal-material" style="margin-left: 6px; opacity: 0.55; font-size: 11px">{{
          slot.material
        }}</span>
      </div>
    </template>
  </template>
</template>
