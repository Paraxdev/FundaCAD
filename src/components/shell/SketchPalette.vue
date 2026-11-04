<script setup lang="ts">
import SketchRelationsList from "./SketchRelationsList.vue";
import Button from "../ui/Button.vue";
import Checkbox from "../ui/Checkbox.vue";
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
    <h2 id="palette-heading" class="palette-title">Sketch palette</h2>
    <div class="palette-section">Options</div>
    <Button block class="palette-btn" tip="Square the view to the sketch plane" @click="palette.lookAt()"
      >Look At</Button
    >
    <Checkbox
      v-for="t in PALETTE_TOGGLES"
      :key="t.key"
      class="palette-row"
      :label="t.label"
      :model-value="palette.state[t.key]"
      @update:model-value="(on: boolean) => palette.set(t.key, on)"
    />

    <!-- Relations answer what holds this sketch, the canvas glyphs what holds this line. It follows Show Constraints. -->
    <template v-if="rel.visible">
      <div class="palette-section palette-section-gap">Relations</div>
      <SketchRelationsList />
    </template>
  </aside>
</template>
