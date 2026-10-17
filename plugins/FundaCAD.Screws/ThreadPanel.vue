<script setup lang="ts">
import { computed } from "vue";
import { FloatingPanel } from "fundacad/ui";
import { choicesFor, choiceOf, nearestIn, offByText, threadDraft, threadTool, type ThreadDraft } from "./threadTool";
import type { ThreadSystem } from "./threadSpec";

const SYSTEMS: { value: ThreadSystem; label: string }[] = [
  { value: "iso", label: "ISO metric" },
  { value: "unc", label: "UNC" },
  { value: "unf", label: "UNF" },
  { value: "tr", label: "Trapezoidal Tr" },
  { value: "acme", label: "ACME" },
];

const d = computed(() => threadDraft.value);
const choices = computed(() => (d.value ? choicesFor(d.value.system) : []));
const choice = computed(() => (d.value ? choiceOf(d.value) : null));
const offBy = computed(() => (d.value ? offByText(d.value) : ""));
const lead = computed(() => (choice.value && d.value ? +(choice.value.pitch * d.value.starts).toFixed(4) : 0));

function set(patch: Partial<ThreadDraft>) {
  if (!threadDraft.value) return;
  threadDraft.value = { ...threadDraft.value, ...patch };
  threadTool.value?.changed();
}

function setSystem(system: ThreadSystem) {
  const cur = threadDraft.value;
  if (!cur) return;
  const n = nearestIn(cur, system);
  const designation = n?.choice.designation ?? choicesFor(system)[0]?.designation ?? "";
  set({ system, designation, ...(n && !cur.external ? { faceIs: n.faceIs } : {}) });
}

// Inline because a downloaded plugin cannot ship a stylesheet (scripts/build-plugin-code.mjs).
const PANEL = { display: "flex", flexDirection: "column", gap: "6px", minWidth: "240px" } as const;
const ROW = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" } as const;
const FIELD = { minWidth: "120px" } as const;
const ACTIONS = { display: "flex", justifyContent: "flex-end", gap: "6px", marginTop: "4px" } as const;

function num(ev: Event): number {
  return Number((ev.target as HTMLInputElement).value);
}
</script>

<template>
  <FloatingPanel :open="!!d" close-on-esc @close="threadTool?.cancel()">
    <div v-if="d" :style="PANEL" data-testid="thread-panel">
      <div class="measure-title">Standard Thread, {{ d.external ? "shaft" : "bore" }}</div>
      <label :style="ROW">System
        <select :style="FIELD" data-testid="thread-system" :value="d.system" @change="setSystem(($event.target as HTMLSelectElement).value as ThreadSystem)">
          <option v-for="s in SYSTEMS" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
      </label>
      <label :style="ROW">Size
        <select :style="FIELD" data-testid="thread-size" :value="d.designation" @change="set({ designation: ($event.target as HTMLSelectElement).value })">
          <option v-for="c in choices" :key="c.designation" :value="c.designation">{{ c.designation }}</option>
        </select>
      </label>
      <div v-if="offBy" class="measure-hint" data-testid="thread-offby">{{ offBy }}</div>
      <label v-if="!d.external" :style="ROW" title="A bore drawn at tap drill size is cut, one drawn at the nominal size gets the thread joined into it">Bore drawn at
        <select :style="FIELD" data-testid="thread-faceis" :value="d.faceIs" @change="set({ faceIs: ($event.target as HTMLSelectElement).value as 'tap' | 'nominal' })">
          <option value="tap">Tap drill{{ choice ? `, ${choice.tap} mm` : "" }}</option>
          <option value="nominal">Nominal{{ choice ? `, ${+choice.d.toFixed(3)} mm` : "" }}</option>
        </select>
      </label>
      <label :style="ROW">Hand
        <select :style="FIELD" data-testid="thread-hand" :value="d.hand" @change="set({ hand: ($event.target as HTMLSelectElement).value as 'right' | 'left' })">
          <option value="right">Right</option>
          <option value="left">Left</option>
        </select>
      </label>
      <label :style="ROW">Starts
        <select :style="FIELD" data-testid="thread-starts" :value="d.starts" @change="set({ starts: num($event) })">
          <option v-for="n in 4" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
      <div v-if="choice" class="measure-hint">Pitch {{ +choice.pitch.toFixed(4) }} mm, lead {{ lead }} mm</div>
      <label :style="ROW">Print fit
        <input type="checkbox" data-testid="thread-printfit" :checked="d.printFit" @change="set({ printFit: ($event.target as HTMLInputElement).checked })" />
      </label>
      <label v-if="d.printFit" :style="ROW" title="Radial clearance, so a printed thread turns into its mate">Clearance, mm
        <input type="number" :style="FIELD" min="0" step="0.05" data-testid="thread-clearance" :value="d.clearance" @change="set({ clearance: Math.max(0, num($event)) })" />
      </label>
      <div :style="ACTIONS">
        <button data-testid="thread-cancel" @click="threadTool?.cancel()">Cancel</button>
        <button data-testid="thread-apply" :disabled="!choice" @click="threadTool?.apply()">{{ d.editing ? "Update" : "Add" }}</button>
      </div>
    </div>
  </FloatingPanel>
</template>

