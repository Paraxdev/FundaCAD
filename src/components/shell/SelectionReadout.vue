<script setup lang="ts">
import { watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { SELECTION_SPEECH_DELAY } from "../../app/planePick";
import { useSelectionOffers } from "../../composables/useSelectionOffers";
import { announce } from "../../ui/announce";

const sel = useSelectionOffers(useEngine(), { words: true });

watch(
  () => (sel.toolOwns.value ? null : sel.speech.value),
  (said) => {
    if (!said) return;
    announce(said.text, "polite", {
      key: "selection",
      delay: SELECTION_SPEECH_DELAY,
      ...(said.verbose ? { verbose: true } : {}),
    });
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
    var(--fs-micro)/1.4 ui-monospace,
    "SF Mono",
    Menlo,
    Consolas,
    monospace;
  font-variant-numeric: tabular-nums;
  color: var(--text);
  white-space: nowrap;
  max-width: calc(50% - 64px - var(--s-4));
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  z-index: 15;
}
</style>
