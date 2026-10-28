<script setup lang="ts">
import { watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { useSelectionOffers } from "../../composables/useSelectionOffers";
import { announce } from "../../ui/announce";

const sel = useSelectionOffers(useEngine());

// Once per settled selection: a Ctrl-click run or a box select changes it many times in a row.
watch(
  () => (sel.toolOwns.value ? undefined : sel.readout.value),
  (text, was) => {
    if (text) announce(text, "polite", { key: "selection", delay: 250 });
    else if (text !== undefined && was)
      announce("Nothing selected", "polite", { key: "selection", delay: 250, verbose: true });
  },
);
</script>

<template>
  <div v-if="sel.readout.value && !sel.toolOwns.value" class="sel-readout" data-testid="selection-readout">
    {{ sel.readout.value }}
  </div>
</template>

<style scoped>
.sel-readout {
  position: absolute;
  left: calc(50% + 64px);
  bottom: var(--s-4);
  padding: var(--s-0) var(--s-3);
  font:
    11px/1.4 ui-monospace,
    "SF Mono",
    Menlo,
    Consolas,
    monospace;
  font-variant-numeric: tabular-nums;
  color: var(--text);
  white-space: nowrap;
  pointer-events: none;
  z-index: 15;
}
</style>
