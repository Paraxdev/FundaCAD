<script setup lang="ts">
import Button from "../ui/Button.vue";
import { useSketchPaletteStore } from "../../stores/sketchPalette";
import { t } from "../../i18n";

const palette = useSketchPaletteStore();
</script>

<template>
  <Button
    v-if="palette.visible && palette.offNormal"
    size="sm"
    class="normal-to-sketch"
    data-testid="normal-to-sketch"
    :tip="t('sketchPalette.lookAtTip')"
    @click="palette.lookAt()"
    >{{ t("sketchPalette.normalToSketch") }}</Button
  >
</template>
