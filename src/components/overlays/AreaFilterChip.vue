<script setup lang="ts">
// What the box being dragged will take, said on the box, while it is still
// being dragged.
//
// The filter has always existed and has always been cyclable with Tab, but the
// only thing that ever said so was a sentence in the status prompt at the far
// edge of the window, read once and then never again while the eyes are on the
// model. So a box thrown over a filleted corner took the four faces when edges
// were wanted, and the way to find out was to release it and look at what
// happened. A mark on the box answers it where the question is being asked.
//
// It knows by LOOKING once a frame, the same way the selection toolbar does, and
// for the same reason: onAreaDrag is a single-slot callback already owned by
// app/viewportWiring.ts. The loop starts on a primary-button press and stops on
// the first frame with no box, so it costs nothing except during a drag.

import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import Icon from "../shell/Icon.vue";
import { useEngine } from "../../app/engineKey";
import { areaFilterIcon, type AreaFilter, type AreaMode } from "../../viewport/areaSelect";

const engine = useEngine();

/** Kept clear of the cursor, and of the box. */
const GAP_PX = 18;
/** The size to assume for the FIRST frame only, before the chip has been laid
 *  out: happy-dom has no layout, and neither does the frame a drag starts in.
 *  Every frame after that measures the real thing, because the width changes
 *  with the word in it and a chip clamped by a guess hangs off the edge of the
 *  screen exactly when the cursor is nearest it. */
const WIDTH_PX = 190;
const HEIGHT_PX = 30;

const el = ref<HTMLElement | null>(null);
const at = ref<{ x: number; y: number } | null>(null);
const filter = shallowRef<AreaFilter>("all");
const mode = shallowRef<AreaMode>("window");

/** Reads as the object of the sentence the box is making: "taking EDGES". The
 *  prompt says the whole sentence; this says the word that changes. */
const label = computed(() => {
  const f = filter.value;
  return f === "all" ? "Everything" : f === "faces" ? "Faces" : f === "edges" ? "Edges" : "Bodies";
});

/** Window or crossing, which the box already says in its own border, so this is
 *  the short form and it is there to be read together with the filter: what,
 *  and how much of it has to be inside. */
const verdict = computed(() => (mode.value === "window" ? "fully inside" : "touched"));

function refresh(): boolean {
  const drag = engine.viewport.areaDragState;
  if (!drag) {
    at.value = null;
    return false;
  }
  filter.value = engine.viewport.areaTakes;
  mode.value = drag.mode;
  // On the far side of the cursor FROM the box, so it never covers the geometry
  // the box is being drawn around, whichever of the four ways it was drawn.
  const w = el.value?.offsetWidth || WIDTH_PX;
  const h = el.value?.offsetHeight || HEIGHT_PX;
  const right = drag.at.x >= drag.from.x;
  const down = drag.at.y >= drag.from.y;
  const x = right ? drag.at.x + GAP_PX : drag.at.x - GAP_PX - w;
  const y = down ? drag.at.y + GAP_PX : drag.at.y - GAP_PX - h;
  at.value = {
    x: Math.min(Math.max(x, 4), Math.max(window.innerWidth - w - 4, 4)),
    y: Math.min(Math.max(y, 4), Math.max(window.innerHeight - h - 4, 4)),
  };
  return true;
}

let raf = 0;

function tick() {
  raf = 0;
  if (refresh()) raf = requestAnimationFrame(tick);
}

function wake() {
  if (!raf) raf = requestAnimationFrame(tick);
}

// A box can only begin with the primary button down, so that is the only thing
// that has to wake the loop. Capture phase, because the viewport's own handler
// may stop propagation, and passive because this never wants the event.
const onDown = (e: PointerEvent) => {
  if (e.button === 0) wake();
};

onMounted(() => window.addEventListener("pointerdown", onDown, { capture: true, passive: true }));
onUnmounted(() => {
  window.removeEventListener("pointerdown", onDown, { capture: true });
  if (raf) cancelAnimationFrame(raf);
});
</script>

<template>
  <Teleport to="body">
    <!-- v-if, never a hidden element: this floats over the viewport during a
         drag, and an element left in the DOM would take the pointerup that ends
         the very box it is describing. -->
    <div
      v-if="at"
      ref="el"
      class="areachip"
      :data-filter="filter"
      :style="{ left: `${at.x}px`, top: `${at.y}px` }"
      aria-hidden="true"
    >
      <Icon :name="areaFilterIcon(filter)" :size="16" />
      <span class="areachip-what">{{ label }}</span>
      <span class="areachip-how">{{ verdict }}</span>
      <kbd class="areachip-key">Tab</kbd>
    </div>
  </Teleport>
</template>
