<script setup lang="ts">
// The form for a fastener of your own. Which numbers it asks for follows the kind and the part
// types chosen, from catalogue/fields.json, the same list the geometry checks against.

import { computed, reactive, ref } from "vue";
import FastenerPreview from "./FastenerPreview.vue";
import { HANDS, KINDS, PARTS, getPath, setPath, specProblems, type FastenerSpec, type Kind, type PartName } from "./spec";

const props = defineProps<{ initial: FastenerSpec | null; editing: boolean }>();
const emit = defineEmits<{ save: [spec: FastenerSpec]; cancel: [] }>();

const DEFAULT_TYPES: Record<PartName, string> = {
  head: "socketCap", drive: "hex", point: "chamfer", shoulder: "plain", thread: "metric",
  nut: "hex", washer: "plain", insert: "knurled",
};

function blank(): Record<string, unknown> {
  return {
    kind: "screw", units: "mm", name: "", standard: "", notes: "",
    head: { type: "socketCap" }, drive: { type: "hex" }, point: { type: "chamfer" },
    thread: { type: "metric", hand: "right", modelled: false },
  };
}

const draft = reactive<Record<string, unknown>>(
  props.initial ? JSON.parse(JSON.stringify(props.initial)) as Record<string, unknown> : blank(),
);
if (!props.editing && props.initial) draft["name"] = `${String(props.initial.name)} (custom)`;
delete draft["info"];

const kind = computed(() => draft["kind"] as Kind);
const parts = computed(() => KINDS[kind.value].parts);
const inch = computed(() => draft["units"] === "in");

function ensureParts() {
  for (const p of KINDS[kind.value].parts) {
    const part = draft[p] as Record<string, unknown> | undefined;
    if (!part || typeof part["type"] !== "string") {
      draft[p] = { type: p === "thread" && inch.value ? "unified" : DEFAULT_TYPES[p], ...(p === "thread" ? { hand: "right", modelled: false } : {}) };
    }
  }
}
ensureParts();

function part(p: PartName): Record<string, unknown> {
  return draft[p] as Record<string, unknown>;
}

function num(v: string): number | undefined {
  const x = Number(v);
  return v.trim() === "" || !Number.isFinite(x) ? undefined : x;
}

function readPath(path: string): string {
  const v = getPath(draft, path);
  return typeof v === "number" ? String(v) : "";
}

function writePath(path: string, ev: Event) {
  setPath(draft, path, num((ev.target as HTMLInputElement).value));
}

function readField(p: PartName, field: string): string {
  const v = part(p)[field];
  return typeof v === "number" ? String(v) : "";
}

function writeField(p: PartName, field: string, ev: Event) {
  part(p)[field] = num((ev.target as HTMLInputElement).value);
}

const tpi = computed(() => {
  const pitch = part("thread")?.["pitch"];
  return typeof pitch === "number" && pitch > 0 ? String(+(1 / pitch).toFixed(3)) : "";
});

function writeTpi(ev: Event) {
  const v = num((ev.target as HTMLInputElement).value);
  part("thread")["pitch"] = v && v > 0 ? +(1 / v).toFixed(8) : undefined;
}

function onKind(ev: Event) {
  draft["kind"] = (ev.target as HTMLSelectElement).value;
  ensureParts();
}

function onUnits(ev: Event) {
  draft["units"] = (ev.target as HTMLSelectElement).value;
  const t = part("thread");
  if (t && (t["type"] === "metric" || t["type"] === "unified")) t["type"] = inch.value ? "unified" : "metric";
}

function designation(spec: FastenerSpec): string | undefined {
  const t = spec.thread;
  if (!t || !(t.diameter > 0) || !(t.pitch > 0)) return undefined;
  if (spec.units === "in") return `${t.diameter}-${Math.round(1 / t.pitch)}`;
  return `M${t.diameter}x${t.pitch}`;
}

const spec = computed<FastenerSpec>(() => {
  const out = JSON.parse(JSON.stringify(draft)) as Record<string, unknown>;
  const allowed = new Set<string>(["kind", "units", "name", "standard", "notes", "length", ...KINDS[kind.value].parts]);
  for (const k of Object.keys(out)) if (!allowed.has(k)) delete out[k];
  if (!out["standard"]) delete out["standard"];
  if (!out["notes"]) delete out["notes"];
  const s = out as unknown as FastenerSpec;
  if (s.thread) s.thread.designation = designation(s) ?? "";
  return s;
});

const problems = computed(() => specProblems(spec.value));
const previewProblem = ref<string | null>(null);
const previewSpec = computed(() => (problems.value.length ? null : spec.value));

const field = { width: "100%", boxSizing: "border-box" as const };
const label = { display: "grid", gridTemplateColumns: "150px 1fr", alignItems: "center", gap: "8px", margin: "3px 0" };
const heading = { margin: "10px 0 4px", fontWeight: 600, fontSize: "11px", textTransform: "uppercase" as const, letterSpacing: "0.05em", color: "var(--text-dim, #aaa1b5)" };
</script>

<template>
  <div class="scr-form" :style="{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '16px' }">
    <div :style="{ maxHeight: '62vh', overflow: 'auto', paddingRight: '6px' }">
      <label :style="label"><span>Name</span><input class="measure-number scr-name" :style="field" :value="draft['name']" placeholder="M4 thumb screw, long" @input="draft['name'] = ($event.target as HTMLInputElement).value" /></label>
      <label :style="label">
        <span>Kind</span>
        <select class="measure-select scr-kind" :style="field" :value="draft['kind']" @change="onKind">
          <option v-for="(k, id) in KINDS" :key="id" :value="id">{{ k.label }}</option>
        </select>
      </label>
      <label :style="label">
        <span>Units</span>
        <select class="measure-select scr-units" :style="field" :value="draft['units']" @change="onUnits">
          <option value="mm">Millimetres</option>
          <option value="in">Inches</option>
        </select>
      </label>
      <label :style="label"><span>Standard (optional)</span><input class="measure-number" :style="field" :value="draft['standard']" @input="draft['standard'] = ($event.target as HTMLInputElement).value" /></label>

      <template v-for="p in parts" :key="p">
        <div :style="heading">{{ p }}</div>
        <label :style="label">
          <span>Type</span>
          <select class="measure-select" :class="`scr-${p}-type`" :style="field" :value="part(p)['type']" @change="part(p)['type'] = ($event.target as HTMLSelectElement).value">
            <option v-for="(def, id) in PARTS[p]" :key="id" :value="id">{{ def.label }}</option>
          </select>
        </label>
        <template v-for="[f, text] in PARTS[p][String(part(p)['type'])]?.fields ?? []" :key="f">
          <label v-if="p === 'thread' && f === 'pitch' && inch" :style="label">
            <span>Threads per inch</span>
            <input class="measure-number scr-tpi" type="number" step="any" min="0" :style="field" :value="tpi" @input="writeTpi" />
          </label>
          <label v-else :style="label">
            <span>{{ text }} ({{ inch ? "in" : "mm" }})</span>
            <input class="measure-number" :class="`scr-${p}-${f}`" type="number" step="any" min="0" :style="field" :value="readField(p, f)" @input="writeField(p, f, $event)" />
          </label>
        </template>
        <label v-if="p === 'head' && part('head')['type'] === 'countersunk'" :style="label">
          <span>Countersink angle (deg)</span>
          <input class="measure-number" type="number" step="any" :style="field" :value="readField('head', 'angle') || '90'" @input="writeField('head', 'angle', $event)" />
        </label>
        <label v-if="p === 'drive' && ['phillips', 'pozidriv', 'torx'].includes(String(part('drive')['type']))" :style="label">
          <span>Driver number (optional)</span>
          <input class="measure-number" type="number" step="1" min="0" :style="field" :value="readField('drive', 'number')" @input="writeField('drive', 'number', $event)" />
        </label>
        <template v-if="p === 'thread'">
          <label :style="label">
            <span>Hand</span>
            <select class="measure-select" :style="field" :value="part('thread')['hand'] ?? 'right'" @change="part('thread')['hand'] = ($event.target as HTMLSelectElement).value">
              <option v-for="h in HANDS" :key="h" :value="h">{{ h === "right" ? "Right" : "Left" }}</option>
            </select>
          </label>
          <label :style="label">
            <span>Thread</span>
            <select class="measure-select" :style="field" :value="part('thread')['modelled'] ? 'modelled' : 'simple'" @change="part('thread')['modelled'] = ($event.target as HTMLSelectElement).value === 'modelled'">
              <option value="simple">Simplified</option>
              <option value="modelled">Modelled helix</option>
            </select>
          </label>
        </template>
      </template>

      <div v-if="KINDS[kind].fields.length" :style="heading">Lengths</div>
      <label v-for="[path, text] in KINDS[kind].fields" :key="path" :style="label">
        <span>{{ text }} ({{ inch ? "in" : "mm" }})</span>
        <input class="measure-number" :class="`scr-len-${path.replace('.', '-')}`" type="number" step="any" min="0" :style="field" :value="readPath(path)" @input="writePath(path, $event)" />
      </label>

      <div :style="heading">Notes</div>
      <textarea class="measure-number" :style="{ ...field, minHeight: '48px', textAlign: 'left' }" :value="String(draft['notes'] ?? '')" @input="draft['notes'] = ($event.target as HTMLTextAreaElement).value" />
    </div>

    <div>
      <FastenerPreview :spec="previewSpec" :width="300" :height="220" @problem="previewProblem = $event" />
      <ul v-if="problems.length || previewProblem" class="scr-problems" :style="{ margin: '8px 0', paddingLeft: '16px', color: 'var(--warn, #ffab2e)', fontSize: '11px' }">
        <li v-for="msg in problems" :key="msg">{{ msg }}</li>
        <li v-if="!problems.length && previewProblem">{{ previewProblem }}</li>
      </ul>
      <div v-else class="measure-hint">Everything needed to build it is there.</div>
      <div :style="{ display: 'flex', gap: '8px', marginTop: '10px' }">
        <button type="button" class="btn scr-save" :disabled="problems.length > 0 || !!previewProblem" @click="emit('save', spec)">
          {{ editing ? "Save changes" : "Add to my fasteners" }}
        </button>
        <button type="button" class="btn" @click="emit('cancel')">Cancel</button>
      </div>
    </div>
  </div>
</template>
