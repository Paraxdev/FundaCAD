<script setup lang="ts">
// What one grid square is worth, at the zoom you are currently at.
//
// The grid rescales as you zoom (viewport/scene.ts, sketch/planeGrid.ts), which
// makes it a ruler whose markings keep changing size, and a ruler with no number
// on it is decoration. Inside a sketch the same lattice is where the cursor
// lands, so the number is also the placement resolution.
//
// Quiet on purpose, and next to the frame-rate readout, because it is a thing
// you glance at rather than a control. Like that one it does take pointer
// events, so its `title` can explain itself on hover.

import { computed, onUnmounted, ref } from "vue";
import { useUiStore } from "../../stores/ui";
import { fmtLength, getUnit, onUnitChange } from "../../ui/units";

const ui = useUiStore();
const unit = ref(getUnit());
const stop = onUnitChange(() => { unit.value = getUnit(); });
onUnmounted(stop);

// `unit` is read so the label recomputes when the display unit changes: the
// conversion lives in module state inside ui/units, which Vue cannot see.
const label = computed(() => (unit.value && ui.gridStepMm > 0 ? fmtLength(ui.gridStepMm) : ""));
</script>

<template>
  <div v-if="label" class="gridscale" title="One grid square at this zoom">
    Grid {{ label }}
  </div>
</template>
