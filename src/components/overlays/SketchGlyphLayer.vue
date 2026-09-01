<script setup lang="ts">
// On-canvas constraint glyphs: small badges projected onto the sketch, mirroring
// SketchDimLayer. Each shows a constraint's type; clicking one (in the select
// tool) deletes that constraint. Conflicting constraints render red.
//
// Replaces the DOM half of sketch/sketchGlyphs.ts, which stays as the facade
// SketchMode talks to. Read that file's header for the split; the short version
// is that Vue owns WHICH glyphs exist and the rAF loop below owns WHERE they are.

import * as THREE from "three";
import { onUnmounted, watch } from "vue";
import { camHash } from "../../viewport/camHash";
import { screenTransform } from "../../sketch/annotationFormat";
import { useSketchAnnotationStore } from "../../stores/sketchAnnotations";
import type { GlyphItem } from "../../sketch/sketchGlyphs";

const s = useSketchAnnotationStore();

// --- position: deliberately outside reactivity ----------------------------
// A plain array, not a ref and not reactive(), filled by the :ref function on
// each badge. `scratch`, `lastCamHash` and `raf` are plain locals for the same
// reason: this loop runs on every frame the camera moves and writes one style
// property per glyph, and nothing about that benefits from being tracked.
const els: (HTMLElement | null)[] = [];
const scratch = new THREE.Vector3();
let lastCamHash = "";
let raf = 0;

function loop() {
  raf = requestAnimationFrame(loop);
  const plane = s.glyphPlane;
  const vp = s.glyphViewport;
  if (!plane || !vp) return;
  // skip the per-glyph projection + DOM writes when the camera hasn't moved
  const hash = camHash(vp.camera);
  if (hash === lastCamHash) return;
  lastCamHash = hash;
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

// The loop only runs while a sketch is open, exactly as the class did — an
// always-on rAF callback that early-returns is a frame budget nobody asked for.
watch(
  () => s.glyphPlane,
  (plane) => {
    if (!plane) stop();
    else if (!raf) loop();
  },
  { immediate: true },
);

// A new glyph set is at the same camera as the old one, so the hash check would
// skip it forever. flush: "post" so the :ref functions have run.
watch(() => s.glyphItems, () => { lastCamHash = ""; }, { flush: "post" });

onUnmounted(stop);

// --- interaction ---------------------------------------------------------
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
  s.glyphHooks?.del(g.cIndex);
}

/** Same as the dimension layer: a constraint badge that has taken the pointer
 *  has also taken the wheel, and hands it back to the viewport. */
function onWheel(e: WheelEvent) {
  s.glyphViewport?.forwardWheel(e);
}
</script>

<template>
  <!-- Teleported to body because that is where the class appended itself, and
       .sketch-glyphs is `position: absolute; inset: 0` against the initial
       containing block. Inside #app's grid it would inherit a stacking context
       and land behind the canvas. -->
  <Teleport to="body">
    <div
      class="sketch-glyphs"
      :class="{ 'glyphs-passive': s.glyphsPassive }"
      @wheel="onWheel"
    >
      <div
        v-for="(g, i) in s.glyphItems"
        :key="i"
        :ref="(el) => (els[i] = el as HTMLElement | null)"
        :class="g.cls"
        :title="g.title"
        @pointerdown="onDown"
        @click="onClick($event, g)"
      >{{ g.label }}</div>
    </div>
  </Teleport>
</template>
