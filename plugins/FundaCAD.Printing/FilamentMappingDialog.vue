<script setup lang="ts">
// "Send to printer, filament mapping": one row per colored slot the sliced job
// uses, each choosing which physical U1 toolhead is loaded with that filament,
// plus the three U1 start flags. Pre-matched by printDialog.ts's autoMatch
// (material first, then nearest color).

import { onMounted, onUnmounted, ref } from "vue";
import type { FilamentReq } from "./state";
import { autoMatch, toolheadLabel } from "./printDialog";

const props = defineProps<{ req: FilamentReq }>();

// NOTE: no useModalGate(). This dialog never counted itself in the modal-depth
// gate, and it opens from a flow that is already several native dialogs deep.
// Changing that is behaviour, not layout, left as it was.

/** Physical toolhead chosen per logical slot, keyed by the slot's index (which
 *  is the logical gcode tool Tn). Seeded from autoMatch. */
const picked = ref(new Map<number, number>(
  props.req.slots.map((s) => [s.index, autoMatch(s, props.req.toolheads)]),
));

const opts = ref({ bedLevel: false, flowCalibrate: false, timeLapseCamera: false });
const OPTS = [
  { key: "bedLevel", label: "Auto bed leveling" },
  { key: "flowCalibrate", label: "Flow calibrate" },
  { key: "timeLapseCamera", label: "Timelapse" },
] as const;

// Inline, because a plugin has nowhere to ship a stylesheet.
const S = {
  card: { minWidth: "360px" },
  rows: { display: "flex", flexDirection: "column", gap: "var(--s-1)", marginBottom: "var(--s-4)" },
  row: { display: "flex", alignItems: "center", gap: "var(--s-3)", padding: "var(--s-1) var(--s-0)" },
  slot: {
    display: "flex", alignItems: "center", gap: "var(--s-2)", minWidth: "130px",
    fontSize: "12px", color: "var(--text, #e6e8ec)",
  },
  swatch: {
    width: "14px", height: "14px", borderRadius: "var(--r-xs)",
    border: "1px solid var(--line-strong, #323843)", display: "inline-block", flex: "none",
  },
  arrow: { color: "var(--text-mute, #6b7280)" },
  select: {
    flex: 1, background: "var(--raised, #22262e)", border: "1px solid var(--line, #262a31)",
    borderRadius: "var(--r-md, 8px)", color: "var(--text, #e6e8ec)", fontSize: "12px",
    padding: "var(--s-2) var(--s-3)", cursor: "pointer",
  },
  opts: { display: "flex", flexWrap: "wrap", gap: "var(--s-3)", marginBottom: "var(--s-4)" },
  // One rung tighter than a full-width .choice-check: wrapping chips, not rows.
  opt: { padding: "var(--s-1) var(--s-3)" },
} as const;

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
      <div class="choice-card print-map-card" :style="S.card">
        <div class="choice-title">Send to printer, filament mapping</div>

        <div class="print-map-rows" :style="S.rows">
          <div v-for="slot in req.slots" :key="slot.index" class="print-map-row" :style="S.row">
            <span class="print-map-slot" :style="S.slot">
              <span class="print-swatch" :style="[S.swatch, { background: slot.color }]"></span>
              <span>{{ slot.name || `Filament ${slot.index + 1}` }}</span>
            </span>
            <span class="print-map-arrow" :style="S.arrow">→</span>
            <select
              class="print-map-select"
              :style="S.select"
              :value="picked.get(slot.index)"
              @change="picked.set(slot.index, Number(($event.target as HTMLSelectElement).value))"
            >
              <option v-for="t in req.toolheads" :key="t.index" :value="t.index">
                {{ toolheadLabel(t) }}
              </option>
            </select>
          </div>
        </div>

        <div class="print-map-opts" :style="S.opts">
          <label v-for="o in OPTS" :key="o.key" class="choice-check" :style="S.opt">
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
