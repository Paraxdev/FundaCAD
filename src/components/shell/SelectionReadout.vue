<script setup lang="ts">
import { useEngine } from "../../app/engineKey";
import { useSelectionOffers } from "../../composables/useSelectionOffers";

const sel = useSelectionOffers(useEngine());
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
  font: 11px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  color: var(--text);
  background: rgba(22, 24, 29, 0.55);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  white-space: nowrap;
  pointer-events: none;
  z-index: 15;
}
</style>
