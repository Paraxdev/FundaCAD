<script setup lang="ts">
// "Send to printer, filament mapping": one row per colored slot the sliced job
// uses, each choosing which physical U1 toolhead is loaded with that filament,
// plus the three U1 start flags. Pre-matched by print/printDialog.ts's
// autoMatch (material first, then nearest color).

import { onMounted, onUnmounted, ref } from "vue";
import type { FilamentReq } from "./state";
import { autoMatch, toolheadLabel } from "./printDialog";

const props = defineProps<{ req: FilamentReq }>();

// NOTE: no useModalGate(). This dialog never counted itself in the modal-depth
// gate, and it opens from a flow that is already several native dialogs deep.
// Changing that is behaviour, not layout, left as it was.

/** Physical toolhead chosen per logical slot, keyed by the slot's index (which
 *  is the logical gcode tool Tn). Seeded from autoMatch, exactly as the
 *  `selected` attribute on the pre-rendered <option> used to be. */
const picked = ref(new Map<number, number>(
  props.req.slots.map((s) => [s.index, autoMatch(s, props.req.toolheads)]),
));

const opts = ref({ bedLevel: false, flowCalibrate: false, timeLapseCamera: false });
const OPTS = [
  { key: "bedLevel", label: "Auto bed leveling" },
  { key: "flowCalibrate", label: "Flow calibrate" },
  { key: "timeLapseCamera", label: "Timelapse" },
] as const;

function confirm() {
  props.req.resolve({
    // Source order, not Map order, the two agree, but the wire format is
    // positional enough that it is worth not depending on that.
    mapTable: props.req.slots.map((s) => [s.index, picked.value.get(s.index) ?? s.index]),
    opts: { ...opts.value },
  });
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") props.req.resolve(null);
}
onMounted(() => window.addEventListener("keydown", onKey, true));
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <Teleport to="body">
    <div class="choice-backdrop" @pointerdown.self="req.resolve(null)">
      <div class="choice-card print-map-card">
        <div class="choice-title">Send to printer, filament mapping</div>

        <div class="print-map-rows">
          <div v-for="slot in req.slots" :key="slot.index" class="print-map-row">
            <span class="print-map-slot">
              <!-- :style, not an interpolated style="" string: the binding is
                   escaped by Vue, which is what esc() was doing by hand. -->
              <span class="print-swatch" :style="{ background: slot.color }"></span>
              <span>{{ slot.name || `Filament ${slot.index + 1}` }}</span>
            </span>
            <span class="print-map-arrow">→</span>
            <select
              class="print-map-select"
              :value="picked.get(slot.index)"
              @change="picked.set(slot.index, Number(($event.target as HTMLSelectElement).value))"
            >
              <option v-for="t in req.toolheads" :key="t.index" :value="t.index">
                {{ toolheadLabel(t) }}
              </option>
            </select>
          </div>
        </div>

        <div class="print-map-opts">
          <label v-for="o in OPTS" :key="o.key" class="choice-check">
            <input v-model="opts[o.key]" type="checkbox" />
            <span>{{ o.label }}</span>
          </label>
        </div>

        <div class="choice-row">
          <button class="choice-btn" @click="req.resolve(null)"><span>Cancel</span></button>
          <button class="choice-btn choice-primary" @click="confirm()">
            <span>Upload &amp; Print</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
