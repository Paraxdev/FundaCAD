<script setup lang="ts">
import Button from "../ui/Button.vue";
import { useSketchPaletteStore } from "../../stores/sketchPalette";

const palette = useSketchPaletteStore();
</script>

<template>
  <Button
    v-if="palette.visible && palette.offNormal"
    size="sm"
    class="normal-to-sketch"
    data-testid="normal-to-sketch"
    tip="Square the view to the sketch plane"
    @click="palette.lookAt()"
    >Normal to Sketch</Button
  >
</template>
