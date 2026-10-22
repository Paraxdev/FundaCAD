<script setup lang="ts">
// Constraint glyphs on the sketch canvas. Vue owns which glyphs exist, the rAF loop below owns where they are
// (sketch/sketchGlyphs.ts has the split).

import Icon from "../shell/Icon.vue";
import * as THREE from "three";
import { onUnmounted, watch } from "vue";
import { screenTransform } from "../../sketch/annotationFormat";
import { useSketchAnnotationStore } from "../../stores/sketchAnnotations";
import type { GlyphItem } from "../../sketch/sketchGlyphs";

const s = useSketchAnnotationStore();

// els, scratch, lastPose and raf stay outside reactivity: the loop writes one style per glyph on every camera frame.
const els: (HTMLElement | null)[] = [];
const scratch = new THREE.Vector3();
let lastPose = -1;
let raf = 0;

function loop() {
  raf = requestAnimationFrame(loop);
  const plane = s.glyphPlane;
  const vp = s.glyphViewport;
  if (!plane || !vp) return;
  // skip the per-glyph projection + DOM writes when the camera hasn't moved
  const pose = vp.rig.poseVersion();
  if (pose === lastPose) return;
  lastPose = pose;
  const items = s.glyphItems;
  for (let i = 0; i < items.length; i++) {
    const el = els[i];
    const g = items[i];
    if (!el || !g) continue;
    plane.to3D(g.pos.x, g.pos.y, scratch);
    const p = vp.projectToScreen(scratch);
    el.style.transform = screenTransform(p.x, p.y);
  }
}

function stop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

// The loop runs only while a sketch is open, an always-on rAF that early-returns wastes frame budget.
watch(
  () => s.glyphPlane,
  (plane) => {
    if (!plane) stop();
    else if (!raf) loop();
  },
  { immediate: true },
);

// A new glyph set is at the same camera as the old one, so the pose check would
// skip it forever. flush: "post" so the :ref functions have run.
watch(
  () => s.glyphItems,
  () => {
    lastPose = -1;
  },
  { flush: "post" },
);

onUnmounted(stop);

/** set by the pointerdown hook below; consumed by the click that follows */
let suppressDelete = false;

function onDown(e: PointerEvent) {
  e.stopPropagation();
  suppressDelete = s.glyphHooks?.overlapPick(e) ?? false;
}

function onClick(e: MouseEvent, g: GlyphItem) {
  e.stopPropagation();
  if (suppressDelete) {
    suppressDelete = false;
    return;
  }
  if (g.patternId) s.glyphHooks?.editPattern(g.patternId);
  else s.glyphHooks?.del(g.cIndex);
}

/** Same as the dimension layer: a constraint badge that has taken the pointer
 *  has also taken the wheel, and hands it back to the viewport. */
function onWheel(e: WheelEvent) {
  s.glyphViewport?.forwardWheel(e);
}
</script>

<template>
  <!-- Teleported: .sketch-glyphs is absolute, inset 0 against the initial containing block, and inside #app's grid
  it would land behind the canvas. -->
  <Teleport to="body">
    <div class="sketch-glyphs" :class="{ 'glyphs-passive': s.glyphsPassive }" @wheel="onWheel">
      <div
        v-for="(g, i) in s.glyphItems"
        :key="i"
        :ref="(el) => (els[i] = el as HTMLElement | null)"
        :class="g.cls"
        :title="g.title"
        @pointerdown="onDown"
        @click="onClick($event, g)"
        ><Icon :name="g.icon" :size="12"
      /></div>
    </div>
  </Teleport>
</template>
