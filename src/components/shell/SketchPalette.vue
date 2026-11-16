<script setup lang="ts">
import SketchDimensionsList from "./SketchDimensionsList.vue";
import SketchShapesList from "./SketchShapesList.vue";
import SketchRelationsList from "./SketchRelationsList.vue";
import Button from "../ui/Button.vue";
import Checkbox from "../ui/Checkbox.vue";
import { t } from "../../i18n";
import { useSketchPaletteStore, PALETTE_TOGGLES } from "../../stores/sketchPalette";
import { useSketchRelationsStore } from "../../stores/sketchRelations";

const palette = useSketchPaletteStore();
const rel = useSketchRelationsStore();
</script>

<template>
  <!-- `.hidden` rather than v-if, so the panel keeps its DOM and CSS transition between sketches. -->
  <aside
    id="palette"
    class="palette"
    :class="{ hidden: !palette.visible }"
    aria-labelledby="palette-heading"
    data-keeps-delete
  >
    <h2 id="palette-heading" class="palette-title">{{ t("sketchPalette.title") }}</h2>
    <div class="palette-section">{{ t("sketchPalette.options") }}</div>
    <Button block class="palette-btn" :tip="t('sketchPalette.lookAtTip')" @click="palette.lookAt()">{{
      t("sketchPalette.lookAt")
    }}</Button>
    <Checkbox
      v-for="def in PALETTE_TOGGLES"
      :key="def.key"
      class="palette-row"
      :label="def.label"
      :model-value="palette.state[def.key]"
      @update:model-value="(on: boolean) => palette.set(def.key, on)"
    />

    <SketchShapesList v-if="rel.visible" />

    <template v-if="palette.state.dimensions">
      <div class="palette-section palette-section-gap">{{ t("sketchPalette.dimensions") }}</div>
      <SketchDimensionsList />
    </template>

    <!-- Relations answer what holds this sketch, the canvas glyphs what holds this line. It follows Show Constraints. -->
    <template v-if="rel.visible">
      <div class="palette-section palette-section-gap">{{ t("sketchPalette.relations") }}</div>
      <SketchRelationsList />
    </template>
  </aside>
</template>
