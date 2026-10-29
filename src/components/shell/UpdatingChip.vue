<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { watchSlowBuild } from "../../app/staleModel";
import { motionOn, onMotionChange } from "../../ui/motion";

const engine = useEngine();
const shown = ref(false);
// A spinner frozen by Animations off reads as a hung app, so it goes and the text stays.
const spinning = ref(motionOn());
let off: (() => void) | null = null;
let offMotion: (() => void) | null = null;
onMounted(() => {
  off = watchSlowBuild(engine.store, (on) => {
    shown.value = on;
  });
  offMotion = onMotionChange(() => {
    spinning.value = motionOn();
  });
});
onUnmounted(() => {
  off?.();
  offMotion?.();
});
</script>

<template>
  <div
    v-if="shown"
    class="updating-chip"
    role="status"
    title="The model is rebuilding, the one on screen can still be picked"
    data-testid="updating-chip"
  >
    <span v-if="spinning" class="updating-spin" aria-hidden="true"></span>
    <span>Updating</span>
  </div>
</template>
