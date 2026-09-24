<script setup lang="ts">
// Last rebuild round trip, sent -> reply received -> meshes drawn, stacked
// above the frame-rate readout (FpsReadout.vue) it shares a corner with. A
// diagnostic you glance at, same as that one: this renders its own text
// straight from diagnostics/rebuildTiming's ring rather than touching a
// store, since nothing else in the app needs to react to it.

import { onMounted, onUnmounted, ref } from "vue";
import { lastRoundTripMs, onRoundTrip, type RoundTrip } from "../../diagnostics/rebuildTiming";

function label(ms: number | null): string {
  return ms == null ? "rebuild –" : `rebuild ${ms.toFixed(0)}ms`;
}

const text = ref(label(lastRoundTripMs()));
let unsub: (() => void) | null = null;

onMounted(() => {
  unsub = onRoundTrip((rt: RoundTrip) => { text.value = label(rt.drawnAt - rt.sentAt); });
});
onUnmounted(() => unsub?.());
</script>

<template>
  <div
    class="roundtrip"
    :title="'Time from the rebuild request going out to its meshes landing on screen, the last completed one this session.'"
  >{{ text }}</div>
</template>

<style scoped>
.roundtrip {
  position: absolute;
  right: var(--s-4);
  bottom: calc(var(--s-4) + 26px);
  padding: var(--s-0) var(--s-3);
  font: 11px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  color: var(--text-mute);
  background: rgba(22, 24, 29, 0.55);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  cursor: default;
  user-select: none;
  z-index: 15;
}
</style>
