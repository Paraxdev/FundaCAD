<script setup lang="ts">
// No Esc-dismiss: Esc clears the body selection, which widens the check back to every body, and must not close the
// results with it. Inline styles on host tokens, as a plugin .vue may not carry a <style> block.

import { computed, ref, useId, watch, type CSSProperties } from "vue";
import { readAs, useBrowserStore } from "fundacad";
import { Button, Checkbox, FloatingPanel, ListRow, NumberField, Select } from "fundacad/ui";
import type { PrintabilityKind } from "fundacad";
import { KIND_COLORS, checkChoices, cssHex, kindLabel, upChoices } from "./printability";
import { printabilityPanel } from "./printabilityPanel";
import { t } from "./lines";

const browser = useBrowserStore();
const uid = useId();
const fieldId = (key: string) => `${uid}-${key}`;

const ctl = printabilityPanel;
const d = computed(() => ctl.value?.data.value ?? null);
const setup = computed(() => d.value?.setup ?? null);

/** What Check will cover, as the controller decides it: the selected bodies,
 *  or every body when none is selected. */
const scope = computed(() => {
  const bodies = ctl.value?.bodies.value ?? [];
  const picked = bodies.filter((b) => browser.selectedBodyIds.includes(b.id));
  if (picked.length === 1) return picked[0]!.name || picked[0]!.id;
  if (picked.length) return t("panel.scopeSelected", { n: picked.length });
  const n = bodies.length;
  return n === 1 ? t("panel.scopeOne") : t("panel.scopeAll", { n });
});

const readLength = readAs("length");
type NumberKey = "nozzle" | "layer" | "overhang" | "minGap" | "maxBridge";
const NUMBERS = computed<
  {
    key: NumberKey;
    label: string;
    cls: string;
    unit: "mm" | "deg";
    min: number;
    max?: number;
    step: number;
    parse?: (raw: string) => number;
  }[]
>(() => [
  {
    key: "nozzle",
    label: t("panel.nozzle"),
    cls: "printability-nozzle",
    unit: "mm",
    min: 0,
    step: 0.05,
    parse: readLength,
  },
  {
    key: "layer",
    label: t("panel.layer"),
    cls: "printability-layer",
    unit: "mm",
    min: 0,
    step: 0.05,
    parse: readLength,
  },
  {
    key: "overhang",
    label: t("panel.overhangAngle"),
    cls: "printability-overhang",
    unit: "deg",
    min: 1,
    max: 89,
    step: 1,
    parse: readAs("angle"),
  },
  {
    key: "minGap",
    label: t("panel.minGap"),
    cls: "printability-gap",
    unit: "mm",
    min: 0,
    step: 0.05,
    parse: readLength,
  },
  {
    key: "maxBridge",
    label: t("panel.maxBridge"),
    cls: "printability-bridge",
    unit: "mm",
    min: 0,
    step: 1,
    parse: readLength,
  },
]);
const upOptions = computed(upChoices);
const checkOptions = computed(checkChoices);

// Pointer and keyboard focus each light a face; leaving one falls back to the other.
const pointerOn = ref<number | null>(null);
const focusOn = ref<number | null>(null);
function light(pointer: number | null, focus: number | null) {
  pointerOn.value = pointer;
  focusOn.value = focus;
  ctl.value?.hover(pointer ?? focus);
}
watch(
  () => d.value?.result,
  () => {
    pointerOn.value = null;
    focusOn.value = null;
  },
);

const swatch = (k: PrintabilityKind) => ({ "--key": cssHex(KIND_COLORS[k] ?? 0x888888) });

// A long check lists a row per finding; it scrolls rather than running off
// the bottom of the window, as the app's Stress panel does.
const BODY: CSSProperties = {
  width: "380px",
  maxWidth: "100%",
  maxHeight: "calc(100vh - 180px)",
  overflowY: "auto",
};
const CHECK_ROW: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "var(--s-1) var(--s-4)" };
const ACTIONS: CSSProperties = { justifyContent: "flex-start", gap: "var(--s-2)", marginTop: "var(--s-2)" };
const BODY_NAME: CSSProperties = { marginTop: "var(--s-2)", fontWeight: 600 };
const LEGEND: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--s-1) var(--s-3)",
  marginTop: "var(--s-2)",
};
const WARN: CSSProperties = { color: "var(--warn)" };
const ERROR: CSSProperties = { color: "var(--error)" };
const LIST: CSSProperties = { margin: 0, padding: 0, listStyle: "none" };
const checksId = `${uid}-checks`;
</script>

<template>
  <FloatingPanel :open="!!d" :title="t('tool.printability')" panel-class="printability-panel" @close="ctl?.close()">
    <div v-if="ctl && d && setup" :style="BODY">
      <div class="measure-title" aria-hidden="true">{{ t("tool.printability") }}</div>

      <div class="measure-row">
        <span class="measure-k">{{ t("panel.bodies") }}</span>
        <span class="measure-v printability-scope">{{ scope }}</span>
      </div>

      <div class="measure-divider" />
      <div v-for="n in NUMBERS" :key="n.key" class="measure-row">
        <label class="measure-k" :for="fieldId(n.key)">{{ n.label }}</label>
        <span class="measure-v"
          ><NumberField
            :id="fieldId(n.key)"
            :class="n.cls"
            :label="n.label"
            :unit="n.unit"
            size="sm"
            :width-ch="6"
            commit="live"
            limits="arrows"
            nullable
            :min="n.min"
            :max="n.max"
            :step="n.step"
            :parse="n.parse"
            :model-value="setup[n.key]"
            @update:model-value="setup[n.key] = $event"
            @error="$event && (setup[n.key] = null)"
        /></span>
      </div>
      <div class="measure-row">
        <label class="measure-k" :for="fieldId('up')">{{ t("panel.up") }}</label>
        <Select
          :id="fieldId('up')"
          v-model="setup.up"
          class="printability-up"
          :label="t('panel.up')"
          size="sm"
          :options="upOptions"
          :disabled="setup.layFlat"
          :disabled-reason="t('panel.upDisabled')"
        />
      </div>
      <div class="measure-row">
        <Checkbox v-model="setup.layFlat" class="printability-layflat">{{ t("panel.layFlat") }}</Checkbox>
      </div>

      <div class="measure-divider" />
      <div role="group" :aria-labelledby="checksId" :style="CHECK_ROW">
        <span :id="checksId" class="sr-only">{{ t("panel.checksToRun") }}</span>
        <Checkbox
          v-for="c in checkOptions"
          :key="c.value"
          v-model="setup.checks[c.value]"
          :class="'printability-check-' + c.value"
          >{{ c.label }}</Checkbox
        >
      </div>

      <div class="measure-row" :style="ACTIONS">
        <Button
          variant="primary"
          class="printability-run"
          :disabled="d.running"
          :disabled-reason="t('panel.running')"
          @click="ctl.run()"
          >{{ d.running ? t("action.checking") : t("action.check") }}</Button
        >
        <Button v-if="d.running" class="printability-cancel" @click="ctl.cancel()">{{ t("action.cancel") }}</Button>
        <Button v-else class="printability-close" @click="ctl.close()">{{ t("action.close") }}</Button>
      </div>
      <div v-if="d.error" class="measure-hint printability-error" :style="ERROR">{{
        t("panel.error", { message: d.error })
      }}</div>

      <template v-if="d.result">
        <div class="measure-divider" />
        <div v-if="d.result.header" class="measure-hint printability-header">{{ d.result.header }}</div>
        <div
          v-for="g in d.result.groups"
          :key="g.body"
          class="printability-group"
          role="group"
          :aria-labelledby="fieldId('body-' + g.body)"
        >
          <div class="measure-row printability-body" :style="BODY_NAME"
            ><span :id="fieldId('body-' + g.body)" class="measure-v">{{ g.name }}</span></div
          >
          <div v-for="(n, i) in g.notes" :key="'n' + i" class="measure-row printability-note" :style="WARN">
            <span class="measure-v">{{ t("panel.warning", { message: n }) }}</span>
          </div>
          <ul v-if="g.rows.length" :style="LIST" :aria-label="t('panel.findingsOf', { name: g.name })">
            <li v-for="r in g.rows" :key="r.index">
              <ListRow
                class="printability-finding"
                :label="r.text"
                :hint="r.hint"
                :aria-label="r.spoken"
                :selected="d.picked === r.index"
                @click="ctl.pick(r.index)"
                @focus="light(pointerOn, r.index)"
                @blur="light(pointerOn, null)"
                @pointerenter="light(r.index, focusOn)"
                @pointerleave="light(null, focusOn)"
              >
                <template #leading><span class="print-swatch" :style="swatch(r.kind)" aria-hidden="true" /></template>
              </ListRow>
            </li>
          </ul>
          <div v-if="!g.notes.length && !g.rows.length" class="measure-row printability-clean">
            <span class="measure-k">{{ t("panel.nothingFound") }}</span>
          </div>
        </div>
        <div v-if="!d.result.groups.length && !d.result.errors.length" class="measure-row printability-clean">
          <span class="measure-k">{{ t("panel.nothingFound") }}</span>
        </div>
        <div v-if="d.result.kinds.length" role="list" :aria-label="t('panel.legend')" :style="LEGEND">
          <span v-for="k in d.result.kinds" :key="k" role="listitem" class="measure-k printability-legend-item">
            <span class="print-swatch" :style="swatch(k)" aria-hidden="true" />{{ kindLabel(k) }}
          </span>
        </div>
        <div v-for="(w, i) in d.result.errors" :key="'e' + i" class="measure-hint printability-warning" :style="WARN">{{
          t("panel.warning", { message: w })
        }}</div>
        <div v-if="d.stale" class="measure-hint printability-stale" role="status">{{ t("panel.stale") }}</div>
      </template>

      <div class="measure-hint">{{ t("panel.hint") }}</div>
    </div>
  </FloatingPanel>
</template>
