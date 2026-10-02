<script setup lang="ts">
// PRINT, Printability: what would go wrong making the selected bodies, or
// every body, layer by layer. The user sets the nozzle, layer and limits and
// which way is up, and Check lists the findings by body while the view tints
// the faces they are on, one colour per kind (see printabilityPanel.ts).
//
// Mounted for the life of the plugin and drawn only while the panel is open.
// Inline styles on host tokens, as a plugin .vue may not carry a <style> block.
//
// No Esc-dismiss: Esc clears the body selection, which is how the user widens
// the check back to every body, and it must not close the results with it.

import { computed, type CSSProperties } from "vue";
import { useBrowserStore } from "fundacad";
import { FloatingPanel } from "fundacad/ui";
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

const focus = computed(() => d.value?.hovered ?? d.value?.picked ?? null);

function swatch(k: PrintabilityKind): CSSProperties {
  return {
    display: "inline-block", width: "8px", height: "8px", marginRight: "6px", borderRadius: "2px",
    verticalAlign: "middle", background: cssHex(KIND_COLORS[k] ?? 0x888888),
  };
}

// A long check lists a row per finding; it scrolls rather than running off
// the bottom of the window, as the app's Stress panel does.
const BODY: CSSProperties = { minWidth: "300px", maxWidth: "380px", maxHeight: "calc(100vh - 180px)", overflowY: "auto" };
const TOGGLE: CSSProperties = { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" };
const CHECK_ROW: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "var(--s-1) var(--s-4)" };
const ACTIONS: CSSProperties = { justifyContent: "flex-start", gap: "var(--s-2)", marginTop: "var(--s-2)" };
const BODY_NAME: CSSProperties = { marginTop: "var(--s-2)", fontWeight: 600 };
const LEGEND: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "var(--s-1) var(--s-3)", marginTop: "var(--s-2)" };
const WARN: CSSProperties = { color: "var(--accent-hot, #ff9a5c)" };

function findingStyle(index: number): CSSProperties {
  return {
    cursor: "pointer", borderRadius: "2px",
    ...(focus.value === index ? { background: "var(--accent-tint, rgba(255, 122, 60, 0.14))" } : {}),
  };
}
</script>

<template>
  <FloatingPanel :open="!!d" panel-class="printability-panel" @close="ctl?.close()">
    <div v-if="ctl && d && setup" :style="BODY">
      <div class="measure-title">Printability</div>

      <div class="measure-row">
        <span class="measure-k">Bodies</span>
        <span class="measure-v printability-scope">{{ scope }}</span>
      </div>

      <div class="measure-divider" />
      <div class="measure-row">
        <span class="measure-k">Nozzle</span>
        <span class="measure-v"><input v-model.number="setup.nozzle" class="measure-number printability-nozzle" type="number" min="0" step="0.05" /> mm</span>
      </div>
      <div class="measure-row">
        <span class="measure-k">Layer</span>
        <span class="measure-v"><input v-model.number="setup.layer" class="measure-number printability-layer" type="number" min="0" step="0.05" /> mm</span>
      </div>
      <div class="measure-row">
        <span class="measure-k">Overhang angle</span>
        <span class="measure-v"><input v-model.number="setup.overhang" class="measure-number printability-overhang" type="number" min="1" max="89" step="1" /> °</span>
      </div>
      <div class="measure-row">
        <span class="measure-k">Smallest gap</span>
        <span class="measure-v"><input v-model.number="setup.minGap" class="measure-number printability-gap" type="number" min="0" step="0.05" /> mm</span>
      </div>
      <div class="measure-row">
        <span class="measure-k">Longest bridge</span>
        <span class="measure-v"><input v-model.number="setup.maxBridge" class="measure-number printability-bridge" type="number" min="0" step="1" /> mm</span>
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
        <button
          type="button" class="btn btn-primary printability-run" :disabled="d.running"
          @click="ctl.run()"
        >{{ d.running ? "Checking…" : "Check" }}</button>
        <button
          type="button" class="btn printability-cancel" :disabled="!d.running"
          @click="ctl.cancel()"
        >Cancel</button>
        <button type="button" class="btn printability-close" @click="ctl.close()">Close</button>
      </div>
      <div v-if="d.error" class="measure-hint printability-error" :style="WARN">{{ d.error }}</div>

      <template v-if="d.result">
        <div class="measure-divider" />
        <div v-if="d.result.header" class="measure-hint printability-header">{{ d.result.header }}</div>
        <div v-for="g in d.result.groups" :key="g.body" class="printability-group">
          <div class="measure-row printability-body" :style="BODY_NAME"><span class="measure-v">{{ g.name }}</span></div>
          <div v-for="(n, i) in g.notes" :key="'n' + i" class="measure-row printability-note" :style="WARN">
            <span class="measure-v">{{ n }}</span>
          </div>
          <div
            v-for="r in g.rows" :key="r.index"
            class="measure-row printability-finding" :class="{ 'is-focus': focus === r.index }"
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
        <div v-for="(w, i) in d.result.errors" :key="'e' + i" class="measure-hint printability-warning" :style="WARN">{{ w }}</div>
        <div v-if="d.stale" class="measure-hint printability-stale">The model changed since this check, check again to see the faces</div>
      </template>

      <div class="measure-hint">
        Checks the selected bodies, or every body when none is selected · hover a finding to pick out its face, click to look at it
      </div>
    </div>
  </FloatingPanel>
</template>
