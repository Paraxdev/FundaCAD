<script setup lang="ts">
// The node body panel: the nodes, the picked node's numbers, the chains, the
// blend and the operation. Mounted for the life of the plugin and drawn only
// while the tool runs. Inline styles on host tokens, as a plugin .vue may not
// carry a <style> block.

import { computed, ref, type CSSProperties } from "vue";
import * as panel from "./panel";
import { NODE_FIELDS, numOf, type NodeValues, type Operation } from "./nodeForm";

type NodeField = keyof NodeValues & string;
const GROUPS: { label: string; title: string; fields: NodeField[] }[] = [
  { label: "Centre", title: "Where the node sits, mm", fields: ["x", "y", "z"] },
  { label: "Radius", title: "Half the node's size along each of its own axes, mm", fields: ["sx", "sy", "sz"] },
  { label: "Turn", title: "Degrees about X, then Y, then Z", fields: ["rx", "ry", "rz"] },
];

function fieldTitle(f: string): string {
  return NODE_FIELDS.find(([k]) => k === f)?.[1] ?? f;
}

const v = computed(() => panel.view.value);
const picked = computed<NodeValues | null>(() => {
  const s = v.value;
  return (s && s.selected && s.feature.nodes.find((n) => n.id === s.selected)) || null;
});
const fieldError = ref<string | null>(null);

function shown(x: unknown): string {
  if (typeof x === "number") return String(Math.round(x * 1000) / 1000);
  return x == null ? "" : String(x);
}

function commitValue(field: keyof NodeValues & string, ev: Event) {
  const n = picked.value;
  if (!n) return;
  const raw = (ev.target as HTMLInputElement).value;
  fieldError.value = panel.act()?.setValue(n.id, field, raw) ?? null;
}

function setBlend(ev: Event) {
  const raw = (ev.target as HTMLInputElement).value.trim();
  const b = Number(raw);
  if (raw === "" || !Number.isFinite(b) || b < 0) {
    fieldError.value = "The blend is a radius of 0 or more";
    return;
  }
  fieldError.value = null;
  panel.act()?.setFeature({ blend: b });
}

function setOperation(ev: Event) {
  panel.act()?.setFeature({ operation: (ev.target as HTMLSelectElement).value as Operation });
}

function isBound(field: string): boolean {
  const n = picked.value;
  return !!n && !!v.value?.bound.has(`${n.id}.${field}`);
}

function describe(n: NodeValues): string {
  const d = [n.sx, n.sy, n.sz].map((s) => 2 * numOf(s, 5));
  return d[0] === d[1] && d[1] === d[2] ? `⌀ ${d[0]}` : d.join(" × ");
}

const root: CSSProperties = {
  position: "fixed", top: "60px", right: "16px", zIndex: "50",
  padding: "8px",
  background: "var(--panel, #20242c)",
  border: "1px solid var(--line-strong, #3a4150)",
  borderRadius: "var(--r-md, 6px)",
  boxShadow: "var(--shadow-2, 0 6px 20px rgba(0,0,0,0.4))",
  font: "12px system-ui, sans-serif",
  color: "var(--text, #dce3ee)",
  width: "280px", maxWidth: "calc(100vw - 24px)", boxSizing: "border-box",
  maxHeight: "calc(100vh - 80px)", overflowY: "auto",
};
const title: CSSProperties = { fontWeight: "600", marginBottom: "6px" };
const muted: CSSProperties = { color: "var(--text-mute, #8b93a3)", marginBottom: "6px" };
const errorStyle: CSSProperties = { color: "var(--error, #ff5c5c)", marginBottom: "6px" };
const section: CSSProperties = { color: "var(--text-mute, #8b93a3)", margin: "8px 0 4px", textTransform: "uppercase", fontSize: "10px", letterSpacing: "0.06em" };
const row: CSSProperties = { display: "flex", gap: "6px", alignItems: "center", marginBottom: "4px" };
const grid: CSSProperties = { display: "grid", gridTemplateColumns: "56px 1fr 1fr 1fr", gap: "4px 6px", alignItems: "center" };
const axisHead: CSSProperties = { color: "var(--text-mute, #8b93a3)", textAlign: "center", fontSize: "10px" };
const field: CSSProperties = {
  background: "var(--panel-2, #161a20)", color: "var(--text, #dce3ee)",
  border: "1px solid var(--line-strong, #3a4150)", borderRadius: "var(--r-sm, 3px)",
  padding: "3px 4px", font: "inherit", width: "100%", boxSizing: "border-box", minWidth: "0",
};
const lockedField: CSSProperties = { ...field, color: "var(--accent, #3fb6a8)", fontStyle: "italic" };
const listItem: CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "center",
  padding: "2px 6px", borderRadius: "var(--r-sm, 3px)", cursor: "pointer",
};
const listPicked: CSSProperties = { ...listItem, background: "var(--accent-dim, rgba(63,182,168,0.25))" };
const x: CSSProperties = {
  border: "none", background: "transparent", color: "var(--text-mute, #8b93a3)",
  cursor: "pointer", font: "inherit", padding: "0 4px",
};
const btn: CSSProperties = { border: "none", borderRadius: "var(--r-sm, 4px)", padding: "4px 10px", cursor: "pointer", font: "inherit" };
const okBtn: CSSProperties = { ...btn, background: "var(--accent, #2b6)", color: "var(--on-accent, #fff)" };
const noBtn: CSSProperties = { ...btn, background: "var(--raised, #555)", color: "var(--text, #fff)" };
const tag: CSSProperties = {
  position: "fixed", zIndex: "40", pointerEvents: "none", transform: "translate(14px, -50%)",
  padding: "1px 6px", borderRadius: "var(--r-sm, 3px)",
  background: "var(--panel, #20242c)", color: "var(--text, #dce3ee)",
  border: "1px solid var(--line-strong, #3a4150)", font: "11px system-ui, sans-serif", whiteSpace: "nowrap",
};
</script>

<template>
  <Teleport v-if="v" to="body">
    <div data-panel="node-body" :style="root">
      <div :style="title">{{ v.editing ? "Edit node body" : "Node body" }}</div>
      <div v-if="v.error" :style="errorStyle">{{ v.error }}</div>
      <div v-else-if="!v.feature.nodes.length" :style="muted">Click in the view to place the first node.</div>

      <div v-if="v.feature.nodes.length" :style="section">Nodes</div>
      <div
        v-for="n in v.feature.nodes"
        :key="n.id"
        :data-node="n.id"
        :style="n.id === v.selected ? listPicked : listItem"
        @click="panel.act()?.select(n.id)"
      >
        <span>{{ n.id }}</span>
        <span :style="muted">{{ describe(n) }}</span>
        <button :style="x" title="Remove this node" @click.stop="panel.act()?.removeNode(n.id)">&times;</button>
      </div>

      <template v-if="picked">
        <div :style="section">{{ picked.id }}</div>
        <div :style="grid">
          <span />
          <span v-for="axis in ['X', 'Y', 'Z']" :key="axis" :style="axisHead">{{ axis }}</span>
          <template v-for="group in GROUPS" :key="group.label">
            <label :title="group.title">{{ group.label }}</label>
            <input
              v-for="f in group.fields"
              :key="f"
              :data-field="f"
              :style="isBound(f) ? lockedField : field"
              :value="shown(picked[f])"
              :readonly="isBound(f)"
              :title="isBound(f) ? 'A parameter drives this value' : fieldTitle(f)"
              @change="commitValue(f, $event)"
            />
          </template>
        </div>
        <div v-if="fieldError" :style="errorStyle">{{ fieldError }}</div>
      </template>

      <div v-if="v.feature.chains.length" :style="section">Chains</div>
      <div v-for="(c, i) in v.feature.chains" :key="i" :style="listItem">
        <span>{{ c.join(" → ") }}</span>
        <button :style="x" title="Remove this chain" @click="panel.act()?.removeChain(i)">&times;</button>
      </div>

      <div :style="section">Body</div>
      <div :style="row">
        <label style="width: 70px">Blend</label>
        <input data-field="blend" :style="field" :value="shown(v.feature.blend ?? 0)" @change="setBlend" />
      </div>
      <div :style="row">
        <label style="width: 70px">Operation</label>
        <select data-field="operation" :style="field" :value="v.feature.operation ?? 'new'" @change="setOperation">
          <option value="new">New body</option>
          <option value="join">Join</option>
          <option value="cut">Cut</option>
          <option value="intersect">Intersect</option>
        </select>
      </div>
      <label :style="row">
        <input type="checkbox" :checked="v.linkNew" @change="panel.act()?.setLinkNew(($event.target as HTMLInputElement).checked)" />
        Link new nodes to the picked one
      </label>
      <div :style="[row, { justifyContent: 'flex-end', marginTop: '6px' }]">
        <button :style="noBtn" @click="panel.act()?.cancel()">Cancel</button>
        <button :style="okBtn" data-action="commit" @click="panel.act()?.commit()">{{ v.editing ? "Update" : "Add" }}</button>
      </div>
    </div>
    <div v-if="panel.label.value" data-node-size :style="[tag, { left: `${panel.label.value.x}px`, top: `${panel.label.value.y}px` }]">
      {{ panel.label.value.text }}
    </div>
  </Teleport>
</template>
