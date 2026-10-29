<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { watchSlowBuild } from "../../app/staleModel";

const engine = useEngine();
const shown = ref(false);
let off: (() => void) | null = null;
onMounted(() => {
  off = watchSlowBuild(engine.store, (on) => {
    shown.value = on;
  });
});
onUnmounted(() => off?.());
</script>

<template>
  <div
    v-if="shown"
    class="updating-chip"
    role="status"
    title="The model is rebuilding, the one on screen can still be picked"
    data-testid="updating-chip"
  >
    <span class="updating-spin" aria-hidden="true"></span>
    <span>Updating</span>
  </div>
</template>
