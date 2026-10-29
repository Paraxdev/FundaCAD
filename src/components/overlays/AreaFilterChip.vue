<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import Icon from "../shell/Icon.vue";
import { useEngine } from "../../app/engineKey";
import { areaFilterIcon, type AreaFilter, type AreaMode } from "../../viewport/areaSelect";

const engine = useEngine();

/** Kept clear of the cursor, and of the box. */
const GAP_PX = 18;
/** Assumed width for the first frame only, before layout (happy-dom and a drag's first frame have none). Later frames
 *  measure, since the width changes with the word and a guessed clamp hangs off the screen edge. */
const WIDTH_PX = 190;
const HEIGHT_PX = 30;

const el = ref<HTMLElement | null>(null);
const at = ref<{ x: number; y: number } | null>(null);
const filter = shallowRef<AreaFilter>("all");
const mode = shallowRef<AreaMode>("window");

const label = computed(() => {
  const f = filter.value;
  return { all: "Everything", faces: "Faces", profiles: "Sketch profiles", edges: "Edges", bodies: "Bodies" }[f];
});

const verdict = computed(() => (mode.value === "window" ? "fully inside" : "touched"));

function refresh(): boolean {
  const drag = engine.viewport.areaDragState;
  if (!drag) {
    at.value = null;
    return false;
  }
  filter.value = engine.viewport.areaTakes;
  mode.value = drag.mode;
  // On the far side of the cursor from the box, so it never covers the geometry being boxed.
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
let held = false;

// Polled, because onAreaDrag is a single-slot callback owned by app/viewportWiring.ts. The loop outlives the press: a
// drag starts frames after the button goes down, so stopping on the first empty frame would never show it.
function tick() {
  raf = 0;
  if (refresh() || held) raf = requestAnimationFrame(tick);
}

function wake() {
  if (!raf) raf = requestAnimationFrame(tick);
}

// Only a primary press can start a box. Capture phase because the viewport may stop propagation, passive since it
// never prevents the event.
const onDown = (e: PointerEvent) => {
  if (e.button !== 0) return;
  held = true;
  wake();
};
const onUp = () => {
  held = false;
};

const OPTS = { capture: true, passive: true } as const;
onMounted(() => {
  window.addEventListener("pointerdown", onDown, OPTS);
  window.addEventListener("pointerup", onUp, OPTS);
  window.addEventListener("pointercancel", onUp, OPTS);
});
onUnmounted(() => {
  window.removeEventListener("pointerdown", onDown, OPTS);
  window.removeEventListener("pointerup", onUp, OPTS);
  window.removeEventListener("pointercancel", onUp, OPTS);
  if (raf) cancelAnimationFrame(raf);
});
</script>

<template>
  <Teleport to="body">
    <!-- v-if, never hidden: an element left in the DOM would take the pointerup that ends the box. -->
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
