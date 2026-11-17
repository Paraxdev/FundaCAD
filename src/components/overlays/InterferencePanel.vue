<script setup lang="ts">
// The overlap solids and clearance lines are drawn by the viewport (ui/panels.ts showInterference).

import { ref, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { t } from "../../i18n";
import { spellNumber } from "../../ui/measure";
import { usePanelsStore } from "../../stores/panels";
import Panel from "../ui/Panel.vue";
import Checkbox from "../ui/Checkbox.vue";
import ListRow from "../ui/ListRow.vue";
import NumberField from "../ui/NumberField.vue";
import type { ClashRow, ClearanceRow } from "../../stores/panels";

const engine = useEngine();
const panels = usePanelsStore();

// Typical print-in-place clearance; not persisted, this is a per-check value.
const clearanceOn = ref(false);
const threshold = ref(0.2);

// Hover and focus both preview a pair; leaving one falls back to the other, then to the kept pair.
const hovered = ref<ClashRow | null>(null);
const focused = ref<ClashRow | null>(null);

// A press owns the tint, so a focused row stops previewing until it is focused again.
function highlight(c: ClashRow | ClearanceRow) {
  focused.value = null;
  engine.ui.panels.highlightInterference(c.a, c.b);
}

watch(
  () => panels.interference,
  () => {
    hovered.value = null;
    focused.value = null;
  },
);

function show(hover: ClashRow | null, focus: ClashRow | null) {
  hovered.value = hover;
  focused.value = focus;
  const r = hover ?? focus;
  engine.ui.panels.previewInterference(r ? r.a : null, r?.b);
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
      <ul class="clash-list" :aria-label="t('interference.clashes')">
        <li v-for="c in panels.interference.clashes" :key="c.key">
          <ListRow
            class="clash-row"
            :label="c.label"
            :hint="c.v"
            :aria-label="c.spoken"
            :selected="panels.interferenceLit === c.key"
            @click="highlight(c)"
            @focus="show(hovered, c)"
            @blur="show(hovered, null)"
            @pointerenter="show(c, focused)"
            @pointerleave="show(null, focused)"
          />
        </li>
      </ul>
      <div v-if="!panels.interference.clashes.length" class="measure-row">
        <span class="measure-v">{{
          panels.interference.unchecked.length ? t("interference.noneChecked") : t("interference.none")
        }}</span>
      </div>
      <div
        v-for="(u, i) in panels.interference.unchecked"
        :key="'unchecked' + i"
        class="measure-hint"
        style="color: var(--accent-hot)"
      >
        {{ t("interference.notChecked", { what: u }) }}
      </div>

      <div class="measure-divider" />
      <div class="measure-row">
        <Checkbox
          v-model="clearanceOn"
          class="measure-k"
          :label="t('interference.clearanceMode')"
          @update:model-value="recheck"
        />
        <NumberField
          v-if="clearanceOn"
          class="measure-v"
          size="sm"
          unit="mm"
          :width-ch="6"
          :min="0.01"
          :max="50"
          :step="0.01"
          :label="t('interference.clearance')"
          :tip="t('interference.clearance')"
          :model-value="threshold"
          @update:model-value="setThreshold"
        />
      </div>

      <template v-if="clearanceOn">
        <ul class="clash-list" :aria-label="t('interference.closePairs')">
          <li v-for="c in panels.interference.clearances" :key="c.key">
            <ListRow
              class="clash-row"
              :label="c.label"
              :hint="c.v"
              :aria-label="c.spoken"
              :selected="panels.interferenceLit === c.key"
              @click="highlight(c)"
              @focus="show(hovered, c)"
              @blur="show(hovered, null)"
              @pointerenter="show(c, focused)"
              @pointerleave="show(null, focused)"
            />
          </li>
        </ul>
        <div v-if="!panels.interference.clearances.length" class="measure-row">
          <span class="measure-v">{{ t("interference.noneCloser", { amount: spellNumber(threshold) }) }}</span>
        </div>
      </template>

      <div v-if="panels.interference.truncatedMessage" class="measure-hint" style="color: var(--accent-hot)">
        {{ panels.interference.truncatedMessage }}
      </div>
      <div class="measure-hint">
        {{
          panels.interference.clashes.length || panels.interference.clearances.length
            ? t("interference.hintRows")
            : t("interference.hintClose")
        }}
      </div>
    </template>
  </Panel>
</template>
