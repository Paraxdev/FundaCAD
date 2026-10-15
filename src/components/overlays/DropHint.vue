<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { installDesktopDrop } from "../../io/desktopDrop";

const engine = useEngine();
const shown = ref(false);
let uninstall: (() => void) | null = null;
onMounted(() => { uninstall = installDesktopDrop(engine, (on) => { shown.value = on; }); });
onUnmounted(() => uninstall?.());
</script>

<template>
  <Teleport to="body">
    <div v-if="shown" class="drophint" data-testid="drop-hint" aria-hidden="true">
      <div class="drophint-card">
        <strong>Drop to open or import</strong>
        <span>A FundaCAD document opens, STEP, STL, 3MF and the other model files import into this one.</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* pointer-events none, or the hint becomes the drop target and the window
   sees a dragleave the moment it appears. */
.drophint {
  position: fixed;
  inset: 0;
  z-index: 9000;
  pointer-events: none;
  display: grid;
  place-items: center;
  background: var(--accent-tint);
  outline: 2px dashed var(--accent);
  outline-offset: -10px;
}
.drophint-card {
  display: grid;
  gap: 6px;
  max-width: 360px;
  padding: 16px 20px;
  border-radius: 14px;
  background: var(--float-bg-solid);
  border: 1px solid var(--float-line);
  color: var(--text);
  text-align: center;
}
.drophint-card span {
  opacity: 0.75;
  font-size: 12px;
}
</style>
