<script setup lang="ts">
import { computed, ref, watch } from "vue";
import ListRow from "../ui/ListRow.vue";
import Button from "../ui/Button.vue";
import { useSketchPaletteStore } from "../../stores/sketchPalette";
import { useSketchRelationsStore } from "../../stores/sketchRelations";

const palette = useSketchPaletteStore();
const rel = useSketchRelationsStore();

const listId = "palette-shapes-list";
const label = computed(() => `Shapes (${rel.shapeCount})`);

function toggle() {
  palette.shapesOpen = !palette.shapesOpen;
  rel.hooks?.shapes(palette.shapesOpen);
}

// Pointer and focus both light a shape, leaving one falls back to the other.
const pointerId = ref<string | null>(null);
const focusId = ref<string | null>(null);

function light(id: string | null) {
  rel.hooks?.hover(id === null ? null : [id]);
}
function enter(id: string) {
  pointerId.value = id;
  light(id);
}
function leave(id: string) {
  if (pointerId.value === id) pointerId.value = null;
  light(focusId.value);
}
function focusIn(id: string) {
  focusId.value = id;
  light(id);
}
function focusOut(id: string) {
  if (focusId.value === id) focusId.value = null;
  light(pointerId.value);
}

watch(
  () => rel.hooks,
  () => {
    pointerId.value = null;
    focusId.value = null;
  },
);
</script>

<template>
  <Button
    block
    class="palette-btn palette-section-gap"
    :aria-expanded="palette.shapesOpen"
    :aria-controls="palette.shapesOpen ? listId : undefined"
    tip="Which shapes can still move"
    @click="toggle"
    >{{ label }}</Button
  >
  <ul v-if="palette.shapesOpen && rel.shapes.length" :id="listId" class="rel-list">
    <li
      v-for="s in rel.shapes"
      :key="s.id"
      class="rel-row"
      @pointerenter="enter(s.id)"
      @pointerleave="leave(s.id)"
      @focusin="focusIn(s.id)"
      @focusout="focusOut(s.id)"
    >
      <ListRow :label="s.label" :hint="s.hint || undefined" :aria-label="s.spoken" @click="rel.hooks?.select([s.id])" />
    </li>
  </ul>
  <p v-else-if="palette.shapesOpen" :id="listId" class="rel-empty">Nothing is drawn yet.</p>
</template>
