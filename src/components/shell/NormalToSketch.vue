<script setup lang="ts">
import { useSketchPaletteStore } from "../../stores/sketchPalette";

const palette = useSketchPaletteStore();
</script>

<template>
  <button
    v-if="palette.visible && palette.offNormal"
    class="normal-to-sketch"
    data-testid="normal-to-sketch"
    title="Square the view to the sketch plane"
    @click="palette.lookAt()"
    >Normal to Sketch</button
  >
</template>

<style scoped>
.normal-to-sketch {
  padding: var(--s-1) var(--s-3);
  font: 600 12px/1.4 var(--ui);
  color: var(--text);
  cursor: pointer;
}
</style>
