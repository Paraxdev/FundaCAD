<script setup lang="ts">
// The overlap solids and clearance lines are drawn by the viewport (ui/panels.ts showInterference).

import { ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import Panel from "../ui/Panel.vue";
import Checkbox from "../ui/Checkbox.vue";
import NumberField from "../ui/NumberField.vue";
import type { ClashRow, ClearanceRow } from "../../stores/panels";

const engine = useEngine();
const panels = usePanelsStore();

// Typical print-in-place clearance; not persisted, this is a per-check value.
const clearanceOn = ref(false);
const threshold = ref(0.2);

function highlight(c: ClashRow | ClearanceRow) {
  engine.ui.panels.highlightInterference(c.a, c.b);
}

function setThreshold(v: number | null) {
  if (v === null) return;
  threshold.value = v;
  recheck();
}

function recheck() {
  void engine.ui.panels.showInterference(clearanceOn.value ? threshold.value : undefined);
}

function close() {
  engine.ui.panels.closeInterference();
}
</script>

<template>
  <Panel :open="!!panels.interference" :title="panels.interference?.title" close-on-esc @close="close">
    <template v-if="panels.interference">
      <div
        v-for="(c, i) in panels.interference.clashes"
        :key="'clash' + i"
        class="measure-row clash-row"
        style="cursor: pointer"
        @click="highlight(c)"
      >
        <span class="measure-k">{{ c.k }}</span>
        <span class="measure-v">{{ c.v }}</span>
      </div>
      <div v-if="!panels.interference.clashes.length" class="measure-row">
        <span class="measure-v">{{
          panels.interference.unchecked.length
            ? "No overlap among the pairs that were checked"
            : "No overlapping bodies"
        }}</span>
      </div>
      <div
        v-for="(u, i) in panels.interference.unchecked"
        :key="'unchecked' + i"
        class="measure-hint"
        style="color: var(--accent-hot)"
      >
        Not checked: {{ u }}
      </div>

      <div class="measure-divider" />
      <div class="measure-row">
        <Checkbox v-model="clearanceOn" class="measure-k" label="Clearance mode" @update:model-value="recheck" />
        <NumberField
          v-if="clearanceOn"
          class="measure-v"
          size="sm"
          unit="mm"
          :width-ch="6"
          :min="0.01"
          :max="50"
          :step="0.01"
          tip="Clearance"
          :model-value="threshold"
          @update:model-value="setThreshold"
        />
      </div>

      <template v-if="clearanceOn">
        <div
          v-for="(c, i) in panels.interference.clearances"
          :key="'clear' + i"
          class="measure-row clash-row"
          style="cursor: pointer"
          @click="highlight(c)"
        >
          <span class="measure-k">{{ c.k }}</span>
          <span class="measure-v">{{ c.v }}</span>
        </div>
        <div v-if="!panels.interference.clearances.length" class="measure-row">
          <span class="measure-v">No pairs closer than {{ threshold }} mm</span>
        </div>
      </template>

      <div v-if="panels.interference.truncatedMessage" class="measure-hint" style="color: var(--accent-hot)">
        {{ panels.interference.truncatedMessage }}
      </div>
      <div class="measure-hint">
        {{
          panels.interference.clashes.length || panels.interference.clearances.length
            ? "Click a row to highlight the pair · Esc to close"
            : "Esc to close"
        }}
      </div>
    </template>
  </Panel>
</template>
