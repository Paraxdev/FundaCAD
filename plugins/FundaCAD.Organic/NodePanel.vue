<script setup lang="ts">
// Mounted for the life of the plugin and drawn only while the tool runs. Inline styles on host tokens, as a plugin
// .vue may not carry a <style> block.

import { computed, reactive, useId, watch, type CSSProperties } from "vue";
import { Button, Checkbox, Chip, FieldRow, IconButton, ListRow, NumberField, Panel, Select } from "fundacad/ui";
import * as panel from "./panel";
import { numOf, type NodeValues, type Operation } from "./nodeForm";

type NodeField = keyof NodeValues & string;
const GROUPS: { label: string; title: string; unit: "mm" | "deg"; fields: NodeField[] }[] = [
  { label: "Centre", title: "Where the node sits", unit: "mm", fields: ["x", "y", "z"] },
  { label: "Radius", title: "Half the node's size along each of its own axes", unit: "mm", fields: ["sx", "sy", "sz"] },
  { label: "Turn", title: "About X, then Y, then Z", unit: "deg", fields: ["rx", "ry", "rz"] },
];
const OPERATIONS: { value: Operation; label: string }[] = [
  { value: "new", label: "New body" },
  { value: "join", label: "Join" },
  { value: "cut", label: "Cut" },
  { value: "intersect", label: "Intersect" },
];

const uid = useId();
const v = computed(() => panel.view.value);
const picked = computed<NodeValues | null>(() => {
  const s = v.value;
  return (s && s.selected && s.feature.nodes.find((n) => n.id === s.selected)) || null;
});

// A refusal stays until that field is committed or the node changes, and every one is listed as an alert.
const refused = reactive<Record<string, string | null>>({});
const problems = computed(() => Object.values(refused).filter((why): why is string => !!why));
watch(
  () => picked.value?.id,
  () => {
    for (const k of Object.keys(refused)) delete refused[k];
  },
);

function refuse(key: string, label: string, why: string | null) {
  refused[key] = why && `${label}: ${why}`;
}

function shown(x: unknown): string {
  if (typeof x === "number") return String(Math.round(x * 1000) / 1000);
  return x == null ? "" : String(x);
}

function numeric(x: unknown): number | null {
  const n = numOf(x as number | string | undefined, Number.NaN);
  return Number.isNaN(n) ? null : n;
}

const axisOf = (f: string) => f.slice(-1).toUpperCase();
const labelOf = (group: { label: string }, f: string) => `${group.label} ${axisOf(f)}`;
const isRadius = (f: string) => f === "sx" || f === "sy" || f === "sz";
const radiusRule = (f: string) =>
  isRadius(f) ? (x: number) => (x > 0 ? null : "A radius must be greater than 0") : undefined;

function commitValue(f: NodeField, label: string, value: number | null) {
  const n = picked.value;
  if (!n || value === null) return;
  refuse(f, label, panel.act()?.setValue(n.id, f, String(value)) ?? null);
}

function setBlend(value: number | null) {
  if (value === null) return;
  panel.act()?.setFeature({ blend: value });
}

const blendRule = (x: number) => (x < 0 ? "The blend is a radius of 0 or more" : null);

function isBound(field: string): boolean {
  const n = picked.value;
  return !!n && !!v.value?.bound.has(`${n.id}.${field}`);
}

function diameters(n: NodeValues): number[] {
  return [n.sx, n.sy, n.sz].map((s) => 2 * numOf(s, 5));
}

function describe(n: NodeValues): string {
  const d = diameters(n);
  return d[0] === d[1] && d[1] === d[2] ? `⌀ ${d[0]}` : d.join(" × ");
}

function spoken(n: NodeValues): string {
  const d = diameters(n);
  return `${n.id}, ${d[0] === d[1] && d[1] === d[2] ? `diameter ${d[0]}` : `size ${d.join(" by ")}`} mm`;
}

const WIDTH: CSSProperties = { width: "300px", maxWidth: "100%", maxHeight: "calc(100vh - 180px)", overflowY: "auto" };
const ROW: CSSProperties = { gridTemplateColumns: "84px minmax(0, 1fr)" };
const SECTION: CSSProperties = {
  color: "var(--text-mute)",
  margin: "8px 0 4px",
  textTransform: "uppercase",
  fontSize: "var(--fs-micro)",
  fontWeight: 600,
  letterSpacing: "0.06em",
};
const MUTED: CSSProperties = { color: "var(--text-mute)" };
const PROBLEM: CSSProperties = { color: "var(--error)", fontSize: "var(--fs-small)", marginBottom: "4px" };
const ITEM: CSSProperties = { display: "flex", alignItems: "center", gap: "4px" };
const GROW: CSSProperties = { flex: "1 1 auto", minWidth: 0 };
const GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "56px repeat(3, minmax(0, 1fr))",
  gap: "4px 6px",
  alignItems: "center",
  marginBottom: "4px",
};
const AXIS: CSSProperties = { color: "var(--text-mute)", textAlign: "center", fontSize: "var(--fs-micro)" };
const LOCKED: CSSProperties = { fontStyle: "italic" };
const ACTIONS: CSSProperties = { display: "flex", gap: "6px", justifyContent: "flex-end", marginTop: "8px" };
const TAG: CSSProperties = {
  position: "fixed",
  zIndex: "40",
  pointerEvents: "none",
  transform: "translate(14px, -50%)",
  boxShadow: "var(--shadow-2)",
  whiteSpace: "nowrap",
};
</script>

<template>
  <Panel :open="!!v" :title="v?.editing ? 'Edit node body' : 'Node body'">
    <div v-if="v" data-panel="node-body" :style="WIDTH">
      <div v-if="v.error" role="alert" :style="PROBLEM">Error: {{ v.error }}</div>
      <div v-else-if="!v.feature.nodes.length" :style="MUTED">Click in the view to place the first node.</div>

      <template v-if="v.feature.nodes.length">
        <h3 :style="SECTION">Nodes</h3>
        <div role="list" aria-label="Nodes">
          <div v-for="n in v.feature.nodes" :key="n.id" role="listitem" :style="ITEM">
            <ListRow
              :data-node="n.id"
              :style="GROW"
              :label="n.id"
              :hint="describe(n)"
              :aria-label="spoken(n)"
              :selected="n.id === v.selected"
              @click="panel.act()?.select(n.id)"
            />
            <IconButton
              icon="close"
              :tip="`Remove node ${n.id}`"
              size="sm"
              variant="plain"
              @click="panel.act()?.removeNode(n.id)"
            />
          </div>
        </div>
      </template>

      <template v-if="picked">
        <h3 :style="SECTION">{{ picked.id }}</h3>
        <div :style="GRID" aria-hidden="true">
          <span />
          <span v-for="axis in ['X', 'Y', 'Z']" :key="axis" :style="AXIS">{{ axis }}</span>
        </div>
        <div
          v-for="group in GROUPS"
          :key="group.label"
          role="group"
          :aria-labelledby="`${uid}-${group.label}`"
          :style="GRID"
        >
          <span :id="`${uid}-${group.label}`" :title="group.title">{{ group.label }}</span>
          <NumberField
            v-for="f in group.fields"
            :key="f"
            :data-field="f"
            :label="labelOf(group, f)"
            :unit="group.unit"
            size="sm"
            :tip="group.title"
            :style="isBound(f) ? LOCKED : undefined"
            :model-value="numeric(picked[f])"
            :text="isBound(f) ? shown(picked[f]) : undefined"
            :disabled="isBound(f)"
            disabled-reason="A parameter drives this value"
            :validate="radiusRule(f)"
            @update:model-value="commitValue(f, labelOf(group, f), $event)"
            @error="refuse(f, labelOf(group, f), $event)"
          />
        </div>
      </template>

      <template v-if="v.feature.chains.length">
        <h3 :style="SECTION">Chains</h3>
        <div role="list" aria-label="Chains">
          <div v-for="(c, i) in v.feature.chains" :key="i" role="listitem" :style="ITEM">
            <span :style="GROW">{{ c.join(" → ") }}</span>
            <IconButton
              icon="close"
              :tip="`Remove chain ${c.join(' to ')}`"
              size="sm"
              variant="plain"
              @click="panel.act()?.removeChain(i)"
            />
          </div>
        </div>
      </template>

      <h3 :id="`${uid}-body`" :style="SECTION">Body</h3>
      <div role="group" :aria-labelledby="`${uid}-body`">
        <FieldRow v-slot="{ id }" layout="param" label="Blend" :style="ROW">
          <NumberField
            :id="id"
            data-field="blend"
            label="Blend"
            unit="mm"
            size="sm"
            :model-value="numeric(v.feature.blend ?? 0)"
            :validate="blendRule"
            @update:model-value="setBlend"
            @error="refuse('blend', 'Blend', $event)"
          />
        </FieldRow>
        <FieldRow v-slot="{ id }" layout="param" label="Operation" :style="ROW">
          <Select
            :id="id"
            data-field="operation"
            label="Operation"
            size="sm"
            :options="OPERATIONS"
            :model-value="v.feature.operation ?? 'new'"
            @update:model-value="panel.act()?.setFeature({ operation: $event })"
          />
        </FieldRow>
        <Checkbox :model-value="v.linkNew" @update:model-value="panel.act()?.setLinkNew($event)"
          >Link new nodes to the picked one</Checkbox
        >
      </div>

      <div v-for="msg in problems" :key="msg" role="alert" :style="PROBLEM">Error: {{ msg }}</div>

      <div :style="ACTIONS">
        <Button data-action="cancel" @click="panel.act()?.cancel()">Cancel</Button>
        <Button variant="primary" data-action="commit" @click="panel.act()?.commit()">{{
          v.editing ? "Update" : "Add"
        }}</Button>
      </div>
    </div>
  </Panel>

  <Teleport v-if="v && panel.label.value" to="body">
    <Chip
      data-node-size
      aria-hidden="true"
      :style="[TAG, { left: `${panel.label.value.x}px`, top: `${panel.label.value.y}px` }]"
      :label="panel.label.value.text"
    />
  </Teleport>
</template>
