<script setup lang="ts">
import { onMounted, useTemplateRef } from "vue";
import { useEngine } from "../../app/engineKey";
import ViewControls from "./ViewControls.vue";
import PromptBanner from "./PromptBanner.vue";
import FpsReadout from "./FpsReadout.vue";
import GridReadout from "./GridReadout.vue";
import SketchPalette from "./SketchPalette.vue";

const engine = useEngine();
const host = useTemplateRef<HTMLDivElement>("host");

// The <canvas> is created imperatively in main.ts and handed to the Viewport
// before Vue exists, because Viewport, DocumentStore, SketchMode and all ten
// tools must be fully constructed before any component's setup() runs. Adopting
// it here is safe on both counts that matter:
//   * reparenting a canvas does not lose its WebGL context;
//   * it is 0x0 while detached, but viewport.ts already observes it with a
//     ResizeObserver, so the size self-corrects on the frame it is inserted.
//
// prepend, not append: #canvas has to be the first child so the absolutely
// positioned overlays below it (.palette, #prompt, #viewcontrols, .gridscale,
// .fps) paint on top.
onMounted(() => host.value!.prepend(engine.canvas));
</script>

<template>
  <div id="viewport" ref="host">
    <SketchPalette />
    <PromptBanner />
    <ViewControls />
    <GridReadout />
    <FpsReadout />
  </div>
</template>
