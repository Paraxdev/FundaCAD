<script setup lang="ts">
// A small node editor for a material's procedural surface graph. Nodes are cards
// on a canvas; wire an output port to an input port (click one then the other),
// drag cards to arrange, tune params inline. Every change writes the graph to the
// material, and the viewport recompiles it (viewport/proceduralSurface.ts), so
// the part updates live.
//
// The graph is held locally and synced to the store on each change: this is the
// only editor of it open at a time, so a local copy is the source of truth and
// avoids a round trip through the document on every keystroke.
import { computed, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import type { MaterialDef, SurfaceGraph, SurfaceNode } from "../../document/materials";

const props = defineProps<{ materialId: string }>();
const emit = defineEmits<{ close: [] }>();
const store = useEngine().store;

type NodeType = SurfaceNode["type"];
const LABEL: Record<NodeType, string> = {
  noise: "Noise", scratches: "Scratches", brushed: "Brushed", voronoi: "Wear",
  ramp: "Ramp", mix: "Mix", output: "Output",
};
const ADDABLE: NodeType[] = ["noise", "scratches", "brushed", "voronoi", "ramp", "mix"];
// input ports per type, and the output type each node produces (for wiring rules)
const INPUTS: Record<NodeType, string[]> = {
  noise: [], scratches: [], brushed: [], voronoi: [],
  ramp: ["t"], mix: ["a", "b", "t"], output: ["roughness", "bump", "color"],
};
const OUT_TYPE: Record<NodeType, "float" | "vec3" | "none"> = {
  noise: "float", scratches: "float", brushed: "float", voronoi: "float",
  ramp: "vec3", mix: "float", output: "none",
};
// what each INPUT port expects, so a float cannot be wired into a colour port
// (which would be a shader type error)
const PORT_TYPE: Record<string, "float" | "vec3"> = {
  t: "float", a: "float", b: "float", roughness: "float", bump: "float", color: "vec3",
};

const NODE_W = 150;
const clone = (g: SurfaceGraph): SurfaceGraph => JSON.parse(JSON.stringify(g));
let seq = 0;
const uid = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

function defaultGraph(): SurfaceGraph {
  return { output: "out", nodes: [{ id: "out", type: "output", x: 420, y: 120, params: { roughAmount: 0.5, bumpAmount: 0.4, colorAmount: 0.4 } }] };
}
function defaults(type: NodeType): Record<string, number | string> {
  if (type === "ramp") return { colorA: "#201810", colorB: "#e0a060" };
  if (type === "mix") return { t: 0.5 };
  if (type === "scratches" || type === "brushed") return { scale: 6, angle: 0 };
  return { scale: 6 };
}

const material = computed<MaterialDef | undefined>(() => store.materialLibrary.find((m) => m.id === props.materialId));
const g = ref<SurfaceGraph>(clone(material.value?.surfaceGraph ?? defaultGraph()));

function sync() {
  store.updateMaterial(props.materialId, { surfaceGraph: clone(g.value) });
}
function node(id: string): SurfaceNode | undefined { return g.value.nodes.find((n) => n.id === id); }

function addNode(type: NodeType) {
  g.value.nodes.push({ id: uid(), type, x: 60, y: 60 + g.value.nodes.length * 30, params: defaults(type) });
  sync();
}
function removeNode(id: string) {
  if (id === g.value.output) return; // the output stays
  g.value.nodes = g.value.nodes.filter((n) => n.id !== id);
  for (const n of g.value.nodes) {
    if (!n.in) continue;
    for (const [port, src] of Object.entries(n.in)) if (src === id) delete n.in[port];
  }
  sync();
}
function clearGraph() { g.value = defaultGraph(); sync(); }

// --- wiring: click an output, then an input --------------------------------
const armed = ref<string | null>(null);
function clickOutput(id: string) { armed.value = armed.value === id ? null : id; }
function clickInput(nodeId: string, port: string) {
  const src = armed.value;
  if (!src) return;
  const s = node(src);
  if (!s || src === nodeId || OUT_TYPE[s.type] !== PORT_TYPE[port]) { armed.value = null; return; }
  const n = node(nodeId);
  if (n) { (n.in ??= {})[port] = src; sync(); }
  armed.value = null;
}
function disconnect(nodeId: string, port: string) {
  const n = node(nodeId);
  if (n?.in && n.in[port]) { delete n.in[port]; sync(); }
}

// --- params ----------------------------------------------------------------
function setParam(id: string, key: string, raw: string, numeric: boolean) {
  const n = node(id);
  if (!n) return;
  const v = numeric ? Number.parseFloat(raw) : raw;
  if (numeric && !Number.isFinite(v as number)) return;
  (n.params ??= {})[key] = v;
  sync();
}
const NUM_PARAMS: Record<NodeType, { key: string; label: string; min: number; max: number; step: number }[]> = {
  noise: [{ key: "scale", label: "Scale", min: 0.5, max: 30, step: 0.5 }],
  voronoi: [{ key: "scale", label: "Scale", min: 0.5, max: 30, step: 0.5 }],
  scratches: [{ key: "scale", label: "Scale", min: 0.5, max: 30, step: 0.5 }, { key: "angle", label: "Angle", min: 0, max: 3.14, step: 0.01 }],
  brushed: [{ key: "scale", label: "Scale", min: 0.5, max: 30, step: 0.5 }, { key: "angle", label: "Angle", min: 0, max: 3.14, step: 0.01 }],
  mix: [{ key: "t", label: "Mix", min: 0, max: 1, step: 0.01 }],
  ramp: [],
  output: [
    { key: "roughAmount", label: "Rough", min: 0, max: 1, step: 0.01 },
    { key: "bumpAmount", label: "Bump", min: 0, max: 1, step: 0.01 },
    { key: "colorAmount", label: "Colour", min: 0, max: 1, step: 0.01 },
  ],
};
const pnum = (n: SurfaceNode, key: string, d = 0) => (typeof n.params?.[key] === "number" ? (n.params[key] as number) : d);
const pcol = (n: SurfaceNode, key: string, d: string) => (typeof n.params?.[key] === "string" ? (n.params[key] as string) : d);

// --- drag ------------------------------------------------------------------
const drag = ref<{ id: string; ox: number; oy: number } | null>(null);
function startDrag(n: SurfaceNode, e: PointerEvent) {
  drag.value = { id: n.id, ox: e.clientX - (n.x ?? 0), oy: e.clientY - (n.y ?? 0) };
}
const cursor = ref({ x: 0, y: 0 });
function onMove(e: PointerEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  cursor.value = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const d = drag.value;
  if (!d) return;
  const n = node(d.id);
  if (n) { n.x = e.clientX - d.ox; n.y = e.clientY - d.oy; }
}
function onUp() {
  if (drag.value) { drag.value = null; sync(); }
}

// --- wire geometry (from node x/y + fixed port offsets) --------------------
const outPos = (n: SurfaceNode) => ({ x: (n.x ?? 0) + NODE_W, y: (n.y ?? 0) + 16 });
const inPos = (n: SurfaceNode, i: number) => ({ x: n.x ?? 0, y: (n.y ?? 0) + 37 + i * 20 });
function bez(x1: number, y1: number, x2: number, y2: number) {
  return `M ${x1} ${y1} C ${x1 + 44} ${y1}, ${x2 - 44} ${y2}, ${x2} ${y2}`;
}
const wires = computed(() => {
  const out: { d: string }[] = [];
  for (const n of g.value.nodes) {
    INPUTS[n.type].forEach((port, i) => {
      const src = n.in?.[port];
      const s = src ? node(src) : undefined;
      if (s) { const a = outPos(s), b = inPos(n, i); out.push({ d: bez(a.x, a.y, b.x, b.y) }); }
    });
  }
  return out;
});
const pending = computed(() => {
  const s = armed.value ? node(armed.value) : undefined;
  if (!s) return null;
  const a = outPos(s);
  return bez(a.x, a.y, cursor.value.x, cursor.value.y);
});
</script>

<template>
  <div class="ne-overlay">
    <div class="ne-bar">
      <span class="ne-title-main">Surface graph · {{ material?.name }}</span>
      <button v-for="t in ADDABLE" :key="t" class="rd-chip" :data-add="t" @click="addNode(t)">+ {{ LABEL[t] }}</button>
      <span class="ne-spacer"></span>
      <button class="rd-chip" @click="clearGraph">Clear</button>
      <button class="btn btn-primary" @click="emit('close')">Done</button>
    </div>
    <div class="ne-canvas" @pointermove="onMove" @pointerup="onUp" @pointerleave="onUp">
      <svg class="ne-wires">
        <path v-for="(w, i) in wires" :key="i" :d="w.d" class="ne-wire" />
        <path v-if="pending" :d="pending" class="ne-wire ne-wire-pending" />
      </svg>
      <div
        v-for="n in g.nodes"
        :key="n.id"
        class="ne-node"
        :class="{ 'ne-output': n.type === 'output' }"
        :style="{ left: (n.x ?? 0) + 'px', top: (n.y ?? 0) + 'px', width: NODE_W + 'px' }"
        :data-node-type="n.type"
      >
        <div class="ne-node-head" @pointerdown="startDrag(n, $event)">
          {{ LABEL[n.type] }}
          <button v-if="n.type !== 'output'" class="ne-x" @pointerdown.stop @click="removeNode(n.id)">×</button>
        </div>
        <!-- input ports -->
        <div
          v-for="(port, i) in INPUTS[n.type]"
          :key="port"
          class="ne-port ne-in"
          :style="{ top: (30 + i * 20) + 'px' }"
          :data-in="n.id + ':' + port"
          @click="n.in?.[port] ? disconnect(n.id, port) : clickInput(n.id, port)"
        ><span class="ne-dot"></span>{{ port }}</div>
        <!-- output port -->
        <div
          v-if="OUT_TYPE[n.type] !== 'none'"
          class="ne-port ne-out"
          :class="{ armed: armed === n.id }"
          :data-out="n.id"
          @click="clickOutput(n.id)"
        >out<span class="ne-dot"></span></div>
        <!-- params -->
        <div class="ne-params" :style="{ paddingTop: (INPUTS[n.type].length ? INPUTS[n.type].length * 20 + 8 : 6) + 'px' }">
          <label v-for="p in NUM_PARAMS[n.type]" :key="p.key" class="ne-prow">
            <span>{{ p.label }}</span>
            <input class="sm-slider" type="range" :min="p.min" :max="p.max" :step="p.step"
              :value="pnum(n, p.key, p.key === 'roughAmount' ? 0.5 : 0)"
              @input="setParam(n.id, p.key, ($event.target as HTMLInputElement).value, true)" />
          </label>
          <template v-if="n.type === 'ramp'">
            <label class="ne-prow"><span>A</span>
              <input class="mats-color" type="color" :value="pcol(n, 'colorA', '#201810')"
                @input="setParam(n.id, 'colorA', ($event.target as HTMLInputElement).value, false)" /></label>
            <label class="ne-prow"><span>B</span>
              <input class="mats-color" type="color" :value="pcol(n, 'colorB', '#e0a060')"
                @input="setParam(n.id, 'colorB', ($event.target as HTMLInputElement).value, false)" /></label>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ne-overlay { position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column; background: var(--bg); }
.ne-bar { display: flex; gap: 6px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.ne-title-main { font-weight: 600; margin-right: 8px; }
.ne-spacer { flex: 1; }
.ne-canvas { position: relative; flex: 1; overflow: hidden; background:
  radial-gradient(circle, var(--line) 1px, transparent 1px) 0 0 / 22px 22px; touch-action: none; }
.ne-wires { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.ne-wire { fill: none; stroke: var(--accent); stroke-width: 2; opacity: 0.85; }
.ne-wire-pending { stroke-dasharray: 4 3; opacity: 0.6; }
.ne-node { position: absolute; background: var(--panel-2); border: 1px solid var(--line-strong);
  border-radius: var(--r-md); box-shadow: var(--shadow-2); font-size: 12px; user-select: none; }
.ne-node.ne-output { border-color: var(--accent); }
.ne-node-head { padding: 4px 8px; font-weight: 600; cursor: grab; border-bottom: 1px solid var(--line);
  display: flex; justify-content: space-between; align-items: center; }
.ne-x { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px; }
.ne-params { padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
.ne-prow { display: flex; align-items: center; gap: 6px; }
.ne-prow > span { width: 46px; color: var(--text-dim); }
.ne-port { position: absolute; display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-dim); cursor: pointer; }
.ne-in { left: -6px; }
.ne-out { right: -6px; flex-direction: row-reverse; top: 14px; }
.ne-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--line-strong); border: 1px solid var(--accent); }
.ne-out.armed .ne-dot { background: var(--accent); }
</style>
