<script setup lang="ts">
// The fields asked for follow the kind and part types, from catalogue/fields.json, the list the geometry checks against.

import { computed, reactive, ref } from "vue";
import { NumberField } from "fundacad/ui";
import FastenerPreview from "./FastenerPreview.vue";
import {
  HANDS,
  KINDS,
  PARTS,
  getPath,
  setPath,
  specProblems,
  type FastenerSpec,
  type Kind,
  type PartName,
} from "./spec";

const props = defineProps<{ initial: FastenerSpec | null; editing: boolean }>();
const emit = defineEmits<{ save: [spec: FastenerSpec]; cancel: [] }>();

const DEFAULT_TYPES: Record<PartName, string> = {
  head: "socketCap",
  drive: "hex",
  point: "chamfer",
  shoulder: "plain",
  thread: "metric",
  nut: "hex",
  washer: "plain",
  insert: "knurled",
};

function blank(): Record<string, unknown> {
  return {
    kind: "screw",
    units: "mm",
    name: "",
    standard: "",
    notes: "",
    head: { type: "socketCap" },
    drive: { type: "hex" },
    point: { type: "chamfer" },
    thread: { type: "metric", hand: "right", modelled: false },
  };
}

const draft = reactive<Record<string, unknown>>(
  props.initial ? (JSON.parse(JSON.stringify(props.initial)) as Record<string, unknown>) : blank(),
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
      draft[p] = {
        type: p === "thread" && inch.value ? "unified" : DEFAULT_TYPES[p],
        ...(p === "thread" ? { hand: "right", modelled: false } : {}),
      };
    }
  }
}
ensureParts();

function part(p: PartName): Record<string, unknown> {
  return draft[p] as Record<string, unknown>;
}

// The form's numbers are in its own units, and a written unit would fold to mm whatever those are, so a plain number
// is all that reads.
function plainNumber(raw: string): number {
  const x = Number(raw.trim().replace(",", "."));
  if (!Number.isFinite(x)) throw new Error("Not a number");
  return x;
}

const numberOr = (v: unknown, blank: number | null = null) => (typeof v === "number" ? v : blank);

function writePath(path: string, v: number | null) {
  setPath(draft, path, v ?? undefined);
}

function writeField(p: PartName, field: string, v: number | null) {
  part(p)[field] = v ?? undefined;
}

// A refused optional field leaves nothing in the spec to object to, so its refusal holds Save itself.
const refused = reactive<Record<string, string | null>>({});

function refuse(p: PartName, f: string, label: string, why: string | null) {
  refused[f] = why && `${label}: ${why}`;
  if (why) writeField(p, f, null);
}

const tpi = computed(() => {
  const pitch = part("thread")?.["pitch"];
  return typeof pitch === "number" && pitch > 0 ? +(1 / pitch).toFixed(3) : null;
});

function writeTpi(v: number | null) {
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

const problems = computed(() => [
  ...specProblems(spec.value),
  ...Object.values(refused).filter((why): why is string => !!why),
]);
const previewProblem = ref<string | null>(null);
const previewSpec = computed(() => (problems.value.length ? null : spec.value));

const field = { width: "100%", boxSizing: "border-box" as const };
const label = { display: "grid", gridTemplateColumns: "150px 1fr", alignItems: "center", gap: "8px", margin: "3px 0" };
const heading = {
  margin: "10px 0 4px",
  fontWeight: 600,
  fontSize: "var(--fs-micro, 11px)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
  color: "var(--text-dim, #aaa1b5)",
};
</script>

<template>
  <div class="scr-form" :style="{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '16px' }">
    <div :style="{ maxHeight: '62vh', overflow: 'auto', paddingRight: '6px' }">
      <label :style="label"
        ><span>Name</span
        ><input
          class="measure-number scr-name"
          :style="field"
          :value="draft['name']"
          placeholder="M4 thumb screw, long"
          @input="draft['name'] = ($event.target as HTMLInputElement).value"
      /></label>
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
      <label :style="label"
        ><span>Standard (optional)</span
        ><input
          class="measure-number"
          :style="field"
          :value="draft['standard']"
          @input="draft['standard'] = ($event.target as HTMLInputElement).value"
      /></label>

      <template v-for="p in parts" :key="p">
        <div :style="heading">{{ p }}</div>
        <label :style="label">
          <span>Type</span>
          <select
            class="measure-select"
            :class="`scr-${p}-type`"
            :style="field"
            :value="part(p)['type']"
            @change="part(p)['type'] = ($event.target as HTMLSelectElement).value"
          >
            <option v-for="(def, id) in PARTS[p]" :key="id" :value="id">{{ def.label }}</option>
          </select>
        </label>
        <template v-for="[f, text] in PARTS[p][String(part(p)['type'])]?.fields ?? []" :key="f">
          <label v-if="p === 'thread' && f === 'pitch' && inch" :style="label">
            <span>Threads per inch</span>
            <NumberField
              class="scr-tpi"
              label="Threads per inch"
              size="sm"
              commit="live"
              limits="arrows"
              nullable
              :parse="plainNumber"
              :min="0"
              :style="field"
              :model-value="tpi"
              @update:model-value="writeTpi"
              @error="$event && writeTpi(null)"
            />
          </label>
          <label v-else :style="label">
            <span>{{ text }} ({{ inch ? "in" : "mm" }})</span>
            <NumberField
              :class="`scr-${p}-${f}`"
              :label="`${text} (${inch ? 'in' : 'mm'})`"
              size="sm"
              commit="live"
              limits="arrows"
              nullable
              :parse="plainNumber"
              :min="0"
              :style="field"
              :model-value="numberOr(part(p)[f])"
              @update:model-value="writeField(p, f, $event)"
              @error="$event && writeField(p, f, null)"
            />
          </label>
        </template>
        <label v-if="p === 'head' && part('head')['type'] === 'countersunk'" :style="label">
          <span>Countersink angle (deg)</span>
          <NumberField
            label="Countersink angle (deg)"
            size="sm"
            commit="live"
            nullable
            :parse="plainNumber"
            :min="1"
            :max="179"
            :style="field"
            :model-value="numberOr(part('head')['angle'], 90)"
            @update:model-value="writeField('head', 'angle', $event)"
            @error="refuse('head', 'angle', 'Countersink angle', $event)"
            @vue:unmounted="refused['angle'] = null"
          />
        </label>
        <label
          v-if="p === 'drive' && ['phillips', 'pozidriv', 'torx'].includes(String(part('drive')['type']))"
          :style="label"
        >
          <span>Driver number (optional)</span>
          <NumberField
            label="Driver number (optional)"
            size="sm"
            commit="live"
            nullable
            :parse="plainNumber"
            :min="0"
            :step="1"
            :style="field"
            :model-value="numberOr(part('drive')['number'])"
            @update:model-value="writeField('drive', 'number', $event)"
            @error="refuse('drive', 'number', 'Driver number', $event)"
            @vue:unmounted="refused['number'] = null"
          />
        </label>
        <template v-if="p === 'thread'">
          <label :style="label">
            <span>Hand</span>
            <select
              class="measure-select"
              :style="field"
              :value="part('thread')['hand'] ?? 'right'"
              @change="part('thread')['hand'] = ($event.target as HTMLSelectElement).value"
            >
              <option v-for="h in HANDS" :key="h" :value="h">{{ h === "right" ? "Right" : "Left" }}</option>
            </select>
          </label>
          <label :style="label">
            <span>Thread</span>
            <select
              class="measure-select"
              :style="field"
              :value="part('thread')['modelled'] ? 'modelled' : 'simple'"
              @change="part('thread')['modelled'] = ($event.target as HTMLSelectElement).value === 'modelled'"
            >
              <option value="simple">Simplified</option>
              <option value="modelled">Modelled helix</option>
            </select>
          </label>
        </template>
      </template>

      <div v-if="KINDS[kind].fields.length" :style="heading">Lengths</div>
      <label v-for="[path, text] in KINDS[kind].fields" :key="path" :style="label">
        <span>{{ text }} ({{ inch ? "in" : "mm" }})</span>
        <NumberField
          :class="`scr-len-${path.replace('.', '-')}`"
          :label="`${text} (${inch ? 'in' : 'mm'})`"
          size="sm"
          commit="live"
          limits="arrows"
          nullable
          :parse="plainNumber"
          :min="0"
          :style="field"
          :model-value="numberOr(getPath(draft, path))"
          @update:model-value="writePath(path, $event)"
          @error="$event && writePath(path, null)"
        />
      </label>

      <div :style="heading">Notes</div>
      <textarea
        class="measure-number"
        :style="{ ...field, minHeight: '48px', textAlign: 'left' }"
        :value="String(draft['notes'] ?? '')"
        @input="draft['notes'] = ($event.target as HTMLTextAreaElement).value"
      />
    </div>

    <div>
      <FastenerPreview :spec="previewSpec" :width="300" :height="220" @problem="previewProblem = $event" />
      <ul
        v-if="problems.length || previewProblem"
        class="scr-problems"
        :style="{
          margin: '8px 0',
          paddingLeft: '16px',
          color: 'var(--warn, #ffab2e)',
          fontSize: 'var(--fs-small, 12px)',
        }"
      >
        <li v-for="msg in problems" :key="msg">{{ msg }}</li>
        <li v-if="!problems.length && previewProblem">{{ previewProblem }}</li>
      </ul>
      <div v-else class="measure-hint">Everything needed to build it is there.</div>
      <div :style="{ display: 'flex', gap: '8px', marginTop: '10px' }">
        <button
          type="button"
          class="btn scr-save"
          :disabled="problems.length > 0 || !!previewProblem"
          @click="emit('save', spec)"
        >
          {{ editing ? "Save changes" : "Add to my fasteners" }}
        </button>
        <button type="button" class="btn" @click="emit('cancel')">Cancel</button>
      </div>
    </div>
  </div>
</template>
