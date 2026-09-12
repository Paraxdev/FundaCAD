<script setup lang="ts">
// A small node editor for a material's procedural surface graph. Nodes are cards
// on a pannable, zoomable canvas; wire an output port to an input port (drag from
// one dot to the other, or click one then the other), drag cards to arrange, tune
// params inline. Every change writes the graph to the material, and the viewport
// recompiles it (viewport/proceduralSurface.ts), so the part updates live.
//
// The editor is a bottom sheet, not a full-screen cover: the real viewport stays
// visible above it and IS the live preview, showing the actual body under the
// document's own lighting rather than a second little sphere that has to be kept
// in step. Drag the top edge to trade graph room for preview room.
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
  ramp: "Ramp", mix: "Mix", math: "Math", output: "Output",
};
const ADDABLE: NodeType[] = ["noise", "scratches", "brushed", "voronoi", "ramp", "mix", "math"];
const MATH_OPS = ["multiply", "add", "subtract", "min", "max", "pow"];
// input ports per type, and the output type each node produces (for wiring rules)
const INPUTS: Record<NodeType, string[]> = {
  noise: [], scratches: [], brushed: [], voronoi: [],
  ramp: ["t"], mix: ["a", "b", "t"], math: ["a", "b"], output: ["roughness", "bump", "color"],
};
const OUT_TYPE: Record<NodeType, "float" | "vec3" | "none"> = {
  noise: "float", scratches: "float", brushed: "float", voronoi: "float",
  ramp: "vec3", mix: "float", math: "float", output: "none",
};
// what each INPUT port expects, so a float cannot be wired into a colour port
// (which would be a shader type error)
const PORT_TYPE: Record<string, "float" | "vec3"> = {
  t: "float", a: "float", b: "float", roughness: "float", bump: "float", color: "vec3",
};

const NODE_W = 150;
const clone = (g: SurfaceGraph): SurfaceGraph => JSON.parse(JSON.stringify(g));
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
let seq = 0;
const uid = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

function defaultGraph(): SurfaceGraph {
  return { output: "out", nodes: [{ id: "out", type: "output", x: 420, y: 120, params: { roughAmount: 0.5, bumpAmount: 0.4, colorAmount: 0.4 } }] };
}
function defaults(type: NodeType): Record<string, number | string> {
  if (type === "ramp") return { colorA: "#201810", colorB: "#e0a060" };
  if (type === "mix") return { t: 0.5 };
  if (type === "math") return { op: "multiply", a: 0.5, b: 0.5 };
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
  // drop it into the middle of the current view, in world coordinates. The view
  // centre is element-relative (half the canvas), so unproject it directly rather
  // than through toWorld, which expects page coordinates.
  const cw = canvasEl.value?.clientWidth ?? 600, ch = canvasEl.value?.clientHeight ?? 300;
  const wx = (cw / 2 - pan.value.x) / zoom.value, wy = (ch / 2 - pan.value.y) / zoom.value;
  // cascade each new node off the centre so successive adds do not stack exactly
  // on top of one another (which would bury the lower ones' ports).
  const off = (g.value.nodes.length % 6) * 26;
  g.value.nodes.push({ id: uid(), type, x: Math.round(wx - NODE_W / 2 + off), y: Math.round(wy - 20 + off), params: defaults(type) });
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

// --- wiring: drag a dot to a dot, or click one then the other ---------------
const armed = ref<string | null>(null);
const wire = ref<{ from: string; moved: boolean } | null>(null);
function startWire(id: string, e: PointerEvent) {
  canvasEl.value?.setPointerCapture(e.pointerId);
  armed.value = id;
  wire.value = { from: id, moved: false };
}
function tryWire(nodeId: string, port: string, src: string): boolean {
  const s = node(src);
  if (!s || src === nodeId || OUT_TYPE[s.type] !== PORT_TYPE[port]) return false;
  const n = node(nodeId);
  if (!n) return false;
  (n.in ??= {})[port] = src;
  sync();
  return true;
}
// click-click path: a dot was armed, now an input dot was clicked
function clickInput(nodeId: string, port: string) {
  if (!armed.value) return;
  tryWire(nodeId, port, armed.value);
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
  // a/b sliders show only for the ports left unwired; the op is a select below
  math: [{ key: "a", label: "A", min: 0, max: 1, step: 0.01 }, { key: "b", label: "B", min: 0, max: 1, step: 0.01 }],
  ramp: [],
  output: [
    { key: "roughAmount", label: "Rough", min: 0, max: 1, step: 0.01 },
    { key: "bumpAmount", label: "Bump", min: 0, max: 1, step: 0.01 },
    { key: "colorAmount", label: "Colour", min: 0, max: 1, step: 0.01 },
  ],
};
const pnum = (n: SurfaceNode, key: string, d = 0) => (typeof n.params?.[key] === "number" ? (n.params[key] as number) : d);
const pcol = (n: SurfaceNode, key: string, d: string) => (typeof n.params?.[key] === "string" ? (n.params[key] as string) : d);

// --- pan / zoom ------------------------------------------------------------
const canvasEl = ref<HTMLElement | null>(null);
const pan = ref({ x: 20, y: 20 });
const zoom = ref(1);
const worldStyle = computed(() => ({
  transform: `translate(${pan.value.x}px, ${pan.value.y}px) scale(${zoom.value})`,
  transformOrigin: "0 0",
}));
function toWorld(clientX: number, clientY: number) {
  const r = canvasEl.value?.getBoundingClientRect();
  const lx = clientX - (r?.left ?? 0), ly = clientY - (r?.top ?? 0);
  return { x: (lx - pan.value.x) / zoom.value, y: (ly - pan.value.y) / zoom.value };
}
function onWheel(e: WheelEvent) {
  e.preventDefault();
  const r = canvasEl.value?.getBoundingClientRect();
  const cx = e.clientX - (r?.left ?? 0), cy = e.clientY - (r?.top ?? 0);
  const old = zoom.value;
  const next = clamp(old * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.35, 2.5);
  pan.value.x = cx - (cx - pan.value.x) * (next / old);
  pan.value.y = cy - (cy - pan.value.y) * (next / old);
  zoom.value = next;
}
function fit() {
  const ns = g.value.nodes;
  const el = canvasEl.value;
  if (!ns.length || !el) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of ns) {
    const x = n.x ?? 0, y = n.y ?? 0;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + NODE_W); maxY = Math.max(maxY, y + 120);
  }
  const pad = 40, cw = el.clientWidth, ch = el.clientHeight;
  const z = clamp(Math.min(cw / (maxX - minX + pad * 2), ch / (maxY - minY + pad * 2)), 0.35, 1.4);
  zoom.value = z;
  pan.value = { x: cw / 2 - ((minX + maxX) / 2) * z, y: ch / 2 - ((minY + maxY) / 2) * z };
}

// --- drag nodes / pan background -------------------------------------------
const drag = ref<{ id: string; ox: number; oy: number } | null>(null);
const panning = ref<{ sx: number; sy: number; px: number; py: number } | null>(null);
function startDrag(n: SurfaceNode, e: PointerEvent) {
  canvasEl.value?.setPointerCapture(e.pointerId);
  const w = toWorld(e.clientX, e.clientY);
  drag.value = { id: n.id, ox: w.x - (n.x ?? 0), oy: w.y - (n.y ?? 0) };
}
function onCanvasDown(e: PointerEvent) {
  // only the empty background pans; nodes and ports are children with other jobs
  const t = e.target as HTMLElement;
  if (t !== canvasEl.value && !t.classList.contains("ne-world")) return;
  armed.value = null;
  canvasEl.value?.setPointerCapture(e.pointerId);
  panning.value = { sx: e.clientX, sy: e.clientY, px: pan.value.x, py: pan.value.y };
}
const cursor = ref({ x: 0, y: 0 });
function onMove(e: PointerEvent) {
  cursor.value = toWorld(e.clientX, e.clientY);
  if (wire.value) wire.value.moved = true;
  if (panning.value) {
    pan.value = { x: panning.value.px + (e.clientX - panning.value.sx), y: panning.value.py + (e.clientY - panning.value.sy) };
    return;
  }
  const d = drag.value;
  if (!d) return;
  const n = node(d.id);
  if (n) { n.x = Math.round(cursor.value.x - d.ox); n.y = Math.round(cursor.value.y - d.oy); }
}
function onUp(e: PointerEvent) {
  if (drag.value) { drag.value = null; sync(); }
  panning.value = null;
  if (wire.value) {
    const w = wire.value;
    wire.value = null;
    if (w.moved) {
      // a real drag: drop it on whatever input dot is under the pointer
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-in]");
      const din = el?.getAttribute("data-in");
      if (din) { const i = din.indexOf(":"); tryWire(din.slice(0, i), din.slice(i + 1), w.from); }
      armed.value = null;
    }
    // a press without a drag leaves the dot armed, so click-then-click still works
  }
}

// --- resize the sheet ------------------------------------------------------
const panelH = ref(Math.round(Math.min(Math.max(window.innerHeight * 0.5, 260), window.innerHeight * 0.85)));
const resizing = ref<{ y: number; h: number } | null>(null);
function startResize(e: PointerEvent) {
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  resizing.value = { y: e.clientY, h: panelH.value };
}
function onResizeMove(e: PointerEvent) {
  if (!resizing.value) return;
  panelH.value = clamp(resizing.value.h + (resizing.value.y - e.clientY), 220, window.innerHeight * 0.9);
}
function onResizeUp() { resizing.value = null; }

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
  <div class="ne-overlay" :style="{ height: panelH + 'px' }">
    <div class="ne-resize" @pointerdown="startResize" @pointermove="onResizeMove" @pointerup="onResizeUp"></div>
    <div class="ne-bar">
      <span class="ne-title-main">Surface graph · {{ material?.name }}</span>
      <button v-for="t in ADDABLE" :key="t" class="rd-chip" :data-add="t" @click="addNode(t)">+ {{ LABEL[t] }}</button>
      <span class="ne-spacer"></span>
      <button class="rd-chip" @click="fit">Fit</button>
      <button class="rd-chip" @click="clearGraph">Clear</button>
      <button class="btn btn-primary" @click="emit('close')">Done</button>
    </div>
    <div
      class="ne-canvas"
      ref="canvasEl"
      @pointerdown="onCanvasDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @wheel="onWheel"
    >
      <div class="ne-world" :style="worldStyle">
        <svg class="ne-wires" width="4000" height="3000">
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
            @pointerup.stop="wire && wire.moved ? tryWire(n.id, port, wire.from) : null"
            @click="n.in?.[port] ? disconnect(n.id, port) : clickInput(n.id, port)"
          ><span class="ne-dot"></span>{{ port }}</div>
          <!-- output port -->
          <div
            v-if="OUT_TYPE[n.type] !== 'none'"
            class="ne-port ne-out"
            :class="{ armed: armed === n.id }"
            :data-out="n.id"
            @pointerdown.stop="startWire(n.id, $event)"
            @click="armed = armed === n.id ? null : n.id"
          >out<span class="ne-dot"></span></div>
          <!-- params -->
          <div class="ne-params" :style="{ paddingTop: (INPUTS[n.type].length ? INPUTS[n.type].length * 20 + 8 : 6) + 'px' }">
            <label v-if="n.type === 'math'" class="ne-prow">
              <span>Op</span>
              <select class="ne-select" :value="pcol(n, 'op', 'multiply')"
                @change="setParam(n.id, 'op', ($event.target as HTMLSelectElement).value, false)">
                <option v-for="o in MATH_OPS" :key="o" :value="o">{{ o }}</option>
              </select>
            </label>
            <!-- a/b constant only matters while that port is unwired -->
            <label v-for="p in NUM_PARAMS[n.type]" v-show="!(n.type === 'math' && n.in?.[p.key])" :key="p.key" class="ne-prow">
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
      <div class="ne-zoom">{{ Math.round(zoom * 100) }}%</div>
    </div>
  </div>
</template>

<style scoped>
.ne-overlay { position: fixed; left: 0; right: 0; bottom: 0; z-index: 60; display: flex; flex-direction: column;
  background: var(--bg); border-top: 1px solid var(--line-strong); box-shadow: 0 -12px 32px rgba(0, 0, 0, 0.35); }
.ne-resize { height: 7px; margin-top: -3px; cursor: ns-resize; flex: none; }
.ne-resize::after { content: ""; display: block; width: 46px; height: 3px; margin: 2px auto 0;
  border-radius: 2px; background: var(--line-strong); }
.ne-bar { display: flex; gap: 6px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.ne-title-main { font-weight: 600; margin-right: 8px; }
.ne-spacer { flex: 1; }
.ne-canvas { position: relative; flex: 1; overflow: hidden; background:
  radial-gradient(circle, var(--line) 1px, transparent 1px) 0 0 / 22px 22px; touch-action: none; cursor: grab; }
.ne-world { position: absolute; inset: 0; }
.ne-wires { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
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
.ne-select { flex: 1; background: var(--panel); color: var(--text); border: 1px solid var(--line);
  border-radius: var(--r-sm); font-size: 11px; padding: 1px 4px; }
.ne-port { position: absolute; display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-dim); cursor: pointer; }
.ne-in { left: -6px; }
.ne-out { right: -6px; flex-direction: row-reverse; top: 14px; }
.ne-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--line-strong); border: 1px solid var(--accent); }
.ne-dot:hover { background: var(--accent); }
.ne-out.armed .ne-dot { background: var(--accent); }
.ne-zoom { position: absolute; right: 8px; bottom: 6px; font-size: 11px; color: var(--text-dim);
  background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 1px 6px; pointer-events: none; }
</style>
