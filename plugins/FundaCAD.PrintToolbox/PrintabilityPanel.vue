<script setup lang="ts">
// No Esc-dismiss: Esc clears the body selection, which widens the check back to every body, and must not close the
// results with it. Inline styles on host tokens, as a plugin .vue may not carry a <style> block.

import { computed, type CSSProperties } from "vue";
import { readAs, useBrowserStore } from "fundacad";
import { FloatingPanel, NumberField } from "fundacad/ui";
import type { PrintabilityKind } from "fundacad";
import { CHECKS, KIND_COLORS, KIND_LABELS, UP_CHOICES, cssHex } from "./printability";
import { printabilityPanel } from "./printabilityPanel";

const browser = useBrowserStore();

const ctl = printabilityPanel;
const d = computed(() => ctl.value?.data.value ?? null);
const setup = computed(() => d.value?.setup ?? null);

/** What Check will cover, as the controller decides it: the selected bodies,
 *  or every body when none is selected. */
const scope = computed(() => {
  const bodies = ctl.value?.bodies.value ?? [];
  const picked = bodies.filter((b) => browser.selectedBodyIds.includes(b.id));
  if (picked.length === 1) return picked[0]!.name || picked[0]!.id;
  if (picked.length) return `${picked.length} selected`;
  const n = bodies.length;
  return n === 1 ? "The one body" : `All ${n}`;
});

const readLength = readAs("length");
type NumberKey = "nozzle" | "layer" | "overhang" | "minGap" | "maxBridge";
const NUMBERS: {
  key: NumberKey;
  label: string;
  cls: string;
  unit: string;
  min: number;
  max?: number;
  step: number;
  parse?: (raw: string) => number;
}[] = [
  { key: "nozzle", label: "Nozzle", cls: "printability-nozzle", unit: "mm", min: 0, step: 0.05, parse: readLength },
  { key: "layer", label: "Layer", cls: "printability-layer", unit: "mm", min: 0, step: 0.05, parse: readLength },
  {
    key: "overhang",
    label: "Overhang angle",
    cls: "printability-overhang",
    unit: "°",
    min: 1,
    max: 89,
    step: 1,
    parse: readAs("angle"),
  },
  { key: "minGap", label: "Smallest gap", cls: "printability-gap", unit: "mm", min: 0, step: 0.05, parse: readLength },
  {
    key: "maxBridge",
    label: "Longest bridge",
    cls: "printability-bridge",
    unit: "mm",
    min: 0,
    step: 1,
    parse: readLength,
  },
];

const focus = computed(() => d.value?.hovered ?? d.value?.picked ?? null);

function swatch(k: PrintabilityKind): CSSProperties {
  return {
    display: "inline-block",
    width: "8px",
    height: "8px",
    marginRight: "6px",
    borderRadius: "2px",
    verticalAlign: "middle",
    background: cssHex(KIND_COLORS[k] ?? 0x888888),
  };
}

// A long check lists a row per finding; it scrolls rather than running off
// the bottom of the window, as the app's Stress panel does.
const BODY: CSSProperties = {
  minWidth: "300px",
  maxWidth: "380px",
  maxHeight: "calc(100vh - 180px)",
  overflowY: "auto",
};
const TOGGLE: CSSProperties = { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" };
const CHECK_ROW: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "var(--s-1) var(--s-4)" };
const ACTIONS: CSSProperties = { justifyContent: "flex-start", gap: "var(--s-2)", marginTop: "var(--s-2)" };
const BODY_NAME: CSSProperties = { marginTop: "var(--s-2)", fontWeight: 600 };
const LEGEND: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--s-1) var(--s-3)",
  marginTop: "var(--s-2)",
};
const WARN: CSSProperties = { color: "var(--accent-hot, #ff9a5c)" };

function findingStyle(index: number): CSSProperties {
  return {
    cursor: "pointer",
    borderRadius: "2px",
    ...(focus.value === index ? { background: "var(--accent-tint, rgba(255, 122, 60, 0.14))" } : {}),
  };
}
</script>

<template>
  <FloatingPanel :open="!!d" title="Printability" panel-class="printability-panel" @close="ctl?.close()">
    <div v-if="ctl && d && setup" :style="BODY">
      <div class="measure-title" aria-hidden="true">Printability</div>

      <div class="measure-row">
        <span class="measure-k">Bodies</span>
        <span class="measure-v printability-scope">{{ scope }}</span>
      </div>

      <div class="measure-divider" />
      <div v-for="n in NUMBERS" :key="n.key" class="measure-row">
        <span class="measure-k">{{ n.label }}</span>
        <span class="measure-v"
          ><NumberField
            :class="n.cls"
            :label="n.label"
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
          />
          {{ n.unit }}</span
        >
      </div>
      <div class="measure-row">
        <span class="measure-k">Up</span>
        <select v-model="setup.up" class="measure-select printability-up" :disabled="setup.layFlat">
          <option v-for="u in UP_CHOICES" :key="u.value" :value="u.value">{{ u.label }}</option>
        </select>
      </div>
      <div class="measure-row">
        <label class="measure-k" :style="TOGGLE">
          <input v-model="setup.layFlat" class="printability-layflat" type="checkbox" />
          Lay flat on the largest flat face
        </label>
      </div>

      <div class="measure-divider" />
      <div :style="CHECK_ROW">
        <label v-for="c in CHECKS" :key="c.value" class="measure-k" :style="TOGGLE">
          <input v-model="setup.checks[c.value]" :class="'printability-check-' + c.value" type="checkbox" />
          {{ c.label }}
        </label>
      </div>

      <div class="measure-row" :style="ACTIONS">
        <button type="button" class="btn btn-primary printability-run" :disabled="d.running" @click="ctl.run()">{{
          d.running ? "Checking…" : "Check"
        }}</button>
        <button v-if="d.running" type="button" class="btn printability-cancel" @click="ctl.cancel()">Cancel</button>
        <button v-else type="button" class="btn printability-close" @click="ctl.close()">Close</button>
      </div>
      <div v-if="d.error" class="measure-hint printability-error" :style="WARN">{{ d.error }}</div>

      <template v-if="d.result">
        <div class="measure-divider" />
        <div v-if="d.result.header" class="measure-hint printability-header">{{ d.result.header }}</div>
        <div v-for="g in d.result.groups" :key="g.body" class="printability-group">
          <div class="measure-row printability-body" :style="BODY_NAME"
            ><span class="measure-v">{{ g.name }}</span></div
          >
          <div v-for="(n, i) in g.notes" :key="'n' + i" class="measure-row printability-note" :style="WARN">
            <span class="measure-v">{{ n }}</span>
          </div>
          <div
            v-for="r in g.rows"
            :key="r.index"
            class="measure-row printability-finding"
            :class="{ 'is-focus': focus === r.index }"
            :style="findingStyle(r.index)"
            @mouseenter="ctl.hover(r.index)"
            @mouseleave="ctl.hover(null)"
            @click="ctl.pick(r.index)"
          >
            <span class="measure-v"><span :style="swatch(r.kind)" />{{ r.text }}</span>
          </div>
          <div v-if="!g.notes.length && !g.rows.length" class="measure-row printability-clean">
            <span class="measure-k">Nothing found</span>
          </div>
        </div>
        <div v-if="!d.result.groups.length && !d.result.errors.length" class="measure-row printability-clean">
          <span class="measure-k">Nothing found</span>
        </div>
        <div v-if="d.result.kinds.length" :style="LEGEND">
          <span v-for="k in d.result.kinds" :key="k" class="measure-k printability-legend-item">
            <span :style="swatch(k)" />{{ KIND_LABELS[k] }}
          </span>
        </div>
        <div v-for="(w, i) in d.result.errors" :key="'e' + i" class="measure-hint printability-warning" :style="WARN">{{
          w
        }}</div>
        <div v-if="d.stale" class="measure-hint printability-stale"
          >The model changed since this check, check again to see the faces</div
        >
      </template>

      <div class="measure-hint">
        Checks the selected bodies, or every body when none is selected · hover a finding to pick out its face, click to
        look at it
      </div>
    </div>
  </FloatingPanel>
</template>
