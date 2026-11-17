<script setup lang="ts">
// One row per colored slot the sliced job uses, choosing which physical U1 toolhead holds that filament, plus the
// three U1 start flags.

import { ref } from "vue";
import { Button, Checkbox, ModalFrame, Select } from "fundacad/ui";
import type { FilamentReq } from "./state";
import { autoMatch, toolheadLabel } from "./printDialog";

const props = defineProps<{ req: FilamentReq }>();

// ModalFrame, not Dialog: this dialog never counted itself in the modal-depth gate, and it opens from a flow that is
// already several native dialogs deep.

/** Physical toolhead chosen per logical slot, keyed by the slot's index (which
 *  is the logical gcode tool Tn). Seeded from autoMatch. */
const picked = ref(new Map<number, number>(props.req.slots.map((s) => [s.index, autoMatch(s, props.req.toolheads)])));

const opts = ref({ bedLevel: false, flowCalibrate: false, timeLapseCamera: false });
const OPTS = [
  { key: "bedLevel", label: "Auto bed leveling" },
  { key: "flowCalibrate", label: "Flow calibrate" },
  { key: "timeLapseCamera", label: "Timelapse" },
] as const;

// Inline, because a plugin has nowhere to ship a stylesheet.
const S = {
  card: { minWidth: "360px" },
  rows: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--s-1)",
    margin: "0 0 var(--s-4)",
    padding: 0,
    listStyle: "none",
  },
  row: { display: "flex", alignItems: "center", gap: "var(--s-3)", padding: "var(--s-1) var(--s-0)" },
  slot: {
    display: "flex",
    alignItems: "center",
    gap: "var(--s-2)",
    minWidth: "130px",
    fontSize: "var(--fs-small, 12px)",
    color: "var(--text, #e6e8ec)",
  },
  swatch: {
    width: "14px",
    height: "14px",
    borderRadius: "var(--r-xs)",
    border: "1px solid var(--line-strong, #323843)",
    display: "inline-block",
    flex: "none",
  },
  arrow: { color: "var(--text-mute, #6b7280)" },
  opts: { display: "flex", flexWrap: "wrap", gap: "var(--s-3)" },
  select: { flex: 1, minWidth: 0 },
} as const;

function confirm() {
  props.req.resolve({
    // Source order, not Map order, the two agree, but the wire format is
    // positional enough that it is worth not depending on that.
    mapTable: props.req.slots.map((s) => [s.index, picked.value.get(s.index) ?? s.index]),
    opts: { ...opts.value },
  });
}

const nameOf = (slot: FilamentReq["slots"][number]) => slot.name || `Filament ${slot.index + 1}`;
const toolheadOptions = props.req.toolheads.map((t) => ({ value: String(t.index), label: toolheadLabel(t) }));
</script>

<template>
  <ModalFrame panel-class="print-map-card" @close="req.resolve(null)">
    <template #title>Send to printer, filament mapping</template>

    <div class="modal-body">
      <div :style="S.card">
        <ul class="print-map-rows" aria-label="Filament slots" :style="S.rows">
          <li v-for="slot in req.slots" :key="slot.index" class="print-map-row" :style="S.row">
            <span class="print-map-slot" :style="S.slot">
              <span class="print-swatch" aria-hidden="true" :style="[S.swatch, { background: slot.color }]"></span>
              <span>{{ nameOf(slot) }}</span>
            </span>
            <span class="print-map-arrow" aria-hidden="true" :style="S.arrow">→</span>
            <Select
              class="print-map-select"
              size="sm"
              :style="S.select"
              :label="`Toolhead for ${nameOf(slot)}`"
              :options="toolheadOptions"
              :model-value="String(picked.get(slot.index))"
              @update:model-value="picked.set(slot.index, Number($event))"
            />
          </li>
        </ul>

        <div class="print-map-opts" role="group" aria-label="Start options" :style="S.opts">
          <Checkbox v-for="o in OPTS" :key="o.key" v-model="opts[o.key]">{{ o.label }}</Checkbox>
        </div>
      </div>
    </div>

    <div class="modal-foot">
      <Button @click="req.resolve(null)">Cancel</Button>
      <Button variant="primary" @click="confirm()">Upload &amp; Print</Button>
    </div>
  </ModalFrame>
</template>
