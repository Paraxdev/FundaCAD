<script setup lang="ts">
// The fields asked for follow the kind and part types, from catalogue/fields.json, the list the geometry checks against.

import { computed, reactive, ref, watch } from "vue";
import { Button, FieldRow, NumberField, Select, TextField, announce } from "fundacad/ui";
import { plainNumber, typedExprProblem } from "fundacad";
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

const props = defineProps<{ initial: FastenerSpec | null; editing: boolean; stacked?: boolean }>();
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
function readNumber(raw: string): number {
  const x = plainNumber(raw);
  if (x === null) throw new Error(typedExprProblem(raw) ?? "Not a number");
  return x;
}

const numberOr = (v: unknown) => (typeof v === "number" ? v : null);

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

function onKind(value: string) {
  draft["kind"] = value;
  ensureParts();
}

function onUnits(value: string) {
  draft["units"] = value;
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

const kindOptions = Object.entries(KINDS).map(([value, k]) => ({ value, label: k.label }));
const unitOptions = [
  { value: "mm", label: "Millimetres" },
  { value: "in", label: "Inches" },
];
const handOptions = HANDS.map((h) => ({ value: h, label: h === "right" ? "Right" : "Left" }));
const threadOptions = [
  { value: "simple", label: "Simplified" },
  { value: "modelled", label: "Modelled helix" },
];
const titled = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);
const typeOptions = (p: PartName) => Object.entries(PARTS[p]).map(([value, def]) => ({ value, label: def.label }));

// A plugin ships no stylesheet, so the layout is written here.
const LABEL_WIDTH = "150px";
const FILL = { width: "100%" };
const heading = {
  margin: "10px 0 4px",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
  color: "var(--text-dim)",
};

const allProblems = computed(() =>
  problems.value.length ? problems.value : previewProblem.value ? [previewProblem.value] : [],
);

// Spoken once per change and only after the person has used the form, never for what it opens with.
let touched = false;
const touch = () => {
  touched = true;
};
watch(
  () => allProblems.value.join("|"),
  () => {
    if (!touched) return;
    const [first, ...more] = allProblems.value;
    const line = first
      ? `${first}${more.length ? `, and ${more.length} more` : ""}`
      : "Everything needed to build it is there";
    announce(line, first ? "assertive" : "polite", { key: "screws-form-problems", delay: 500 });
  },
);
</script>

<template>
  <div
    class="scr-form"
    :style="{
      display: 'grid',
      gridTemplateColumns: stacked ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) 300px',
      gridTemplateRows: stacked ? 'minmax(140px, 1fr) auto' : 'minmax(0, 1fr)',
      gap: '16px',
      minHeight: 0,
    }"
    @pointerdown.capture="touch"
    @input.capture="touch"
    @keydown.capture="touch"
  >
    <div :style="{ minHeight: '140px', overflow: 'auto', paddingRight: '6px' }">
      <FieldRow v-slot="{ id }" layout="param" label="Name" :label-width="LABEL_WIDTH">
        <TextField
          :id="id"
          class="scr-name"
          size="sm"
          label="Name"
          placeholder="M4 thumb screw, long"
          :model-value="String(draft['name'] ?? '')"
          @update:model-value="draft['name'] = $event"
        />
      </FieldRow>
      <FieldRow v-slot="{ id }" layout="param" label="Kind" :label-width="LABEL_WIDTH">
        <Select
          :id="id"
          class="scr-kind"
          size="sm"
          label="Kind"
          :options="kindOptions"
          :model-value="String(draft['kind'])"
          @update:model-value="onKind"
        />
      </FieldRow>
      <FieldRow v-slot="{ id }" layout="param" label="Units" :label-width="LABEL_WIDTH">
        <Select
          :id="id"
          class="scr-units"
          size="sm"
          label="Units"
          :options="unitOptions"
          :model-value="String(draft['units'])"
          @update:model-value="onUnits"
        />
      </FieldRow>
      <FieldRow v-slot="{ id }" layout="param" label="Standard (optional)" :label-width="LABEL_WIDTH">
        <TextField
          :id="id"
          size="sm"
          label="Standard (optional)"
          :model-value="String(draft['standard'] ?? '')"
          @update:model-value="draft['standard'] = $event"
        />
      </FieldRow>

      <template v-for="p in parts" :key="p">
        <h3 :style="heading">{{ p }}</h3>
        <FieldRow v-slot="{ id }" layout="param" label="Type" :label-width="LABEL_WIDTH">
          <Select
            :id="id"
            :class="`scr-${p}-type`"
            size="sm"
            :label="`${titled(p)} type`"
            :options="typeOptions(p)"
            :model-value="String(part(p)['type'])"
            @update:model-value="part(p)['type'] = $event"
          />
        </FieldRow>
        <template v-for="[f, text] in PARTS[p][String(part(p)['type'])]?.fields ?? []" :key="f">
          <FieldRow
            v-if="p === 'thread' && f === 'pitch' && inch"
            v-slot="{ id }"
            layout="param"
            label="Threads per inch"
            :label-width="LABEL_WIDTH"
          >
            <NumberField
              :id="id"
              class="scr-tpi"
              label="Threads per inch"
              caption="TPI"
              size="sm"
              commit="live"
              limits="arrows"
              nullable
              :parse="readNumber"
              :min="0"
              :model-value="tpi"
              @update:model-value="writeTpi"
              @error="$event && writeTpi(null)"
            />
          </FieldRow>
          <FieldRow v-else v-slot="{ id }" layout="param" :label="text" :label-width="LABEL_WIDTH">
            <NumberField
              :id="id"
              :class="`scr-${p}-${f}`"
              :label="text"
              :unit="inch ? undefined : 'mm'"
              :caption="inch ? 'in' : undefined"
              size="sm"
              commit="live"
              limits="arrows"
              nullable
              :parse="readNumber"
              :min="0"
              :model-value="numberOr(part(p)[f])"
              @update:model-value="writeField(p, f, $event)"
              @error="$event && writeField(p, f, null)"
            />
          </FieldRow>
        </template>
        <FieldRow
          v-if="p === 'head' && part('head')['type'] === 'countersunk'"
          v-slot="{ id }"
          layout="param"
          label="Countersink angle"
          :label-width="LABEL_WIDTH"
        >
          <NumberField
            :id="id"
            label="Countersink angle"
            unit="deg"
            size="sm"
            commit="live"
            nullable
            :parse="readNumber"
            :min="1"
            :max="179"
            :step-from="90"
            placeholder="90"
            :model-value="numberOr(part('head')['angle'])"
            @update:model-value="writeField('head', 'angle', $event)"
            @error="refuse('head', 'angle', 'Countersink angle', $event)"
            @vue:unmounted="refused['angle'] = null"
          />
        </FieldRow>
        <FieldRow
          v-if="p === 'drive' && ['phillips', 'pozidriv', 'torx'].includes(String(part('drive')['type']))"
          v-slot="{ id }"
          layout="param"
          label="Driver number (optional)"
          :label-width="LABEL_WIDTH"
        >
          <NumberField
            :id="id"
            label="Driver number (optional)"
            unitless
            size="sm"
            commit="live"
            nullable
            :parse="readNumber"
            :min="0"
            :step="1"
            :model-value="numberOr(part('drive')['number'])"
            @update:model-value="writeField('drive', 'number', $event)"
            @error="refuse('drive', 'number', 'Driver number', $event)"
            @vue:unmounted="refused['number'] = null"
          />
        </FieldRow>
        <template v-if="p === 'thread'">
          <FieldRow v-slot="{ id }" layout="param" label="Hand" :label-width="LABEL_WIDTH">
            <Select
              :id="id"
              size="sm"
              label="Hand"
              :options="handOptions"
              :model-value="String(part('thread')['hand'] ?? 'right')"
              @update:model-value="part('thread')['hand'] = $event"
            />
          </FieldRow>
          <FieldRow v-slot="{ id }" layout="param" label="Thread" :label-width="LABEL_WIDTH">
            <Select
              :id="id"
              size="sm"
              label="Thread"
              :options="threadOptions"
              :model-value="part('thread')['modelled'] ? 'modelled' : 'simple'"
              @update:model-value="part('thread')['modelled'] = $event === 'modelled'"
            />
          </FieldRow>
        </template>
      </template>

      <h3 v-if="KINDS[kind].fields.length" :style="heading">Lengths</h3>
      <FieldRow
        v-for="[path, text] in KINDS[kind].fields"
        :key="path"
        v-slot="{ id }"
        layout="param"
        :label="text"
        :label-width="LABEL_WIDTH"
      >
        <NumberField
          :id="id"
          :class="`scr-len-${path.replace('.', '-')}`"
          :label="text"
          :unit="inch ? undefined : 'mm'"
          :caption="inch ? 'in' : undefined"
          size="sm"
          commit="live"
          limits="arrows"
          nullable
          :parse="readNumber"
          :min="0"
          :model-value="numberOr(getPath(draft, path))"
          @update:model-value="writePath(path, $event)"
          @error="$event && writePath(path, null)"
        />
      </FieldRow>

      <FieldRow v-slot="{ id }" layout="stacked" label="Notes">
        <TextField
          :id="id"
          multiline
          rows="3"
          label="Notes"
          :style="FILL"
          :model-value="String(draft['notes'] ?? '')"
          @update:model-value="draft['notes'] = $event"
        />
      </FieldRow>
    </div>

    <div
      :style="{
        display: 'flex',
        flexWrap: 'wrap',
        alignContent: 'flex-start',
        alignItems: 'flex-start',
        columnGap: '16px',
        minWidth: 0,
        paddingBottom: stacked ? 'var(--prompt-clear, 0px)' : 0,
      }"
    >
      <FastenerPreview
        :spec="previewSpec"
        :width="stacked ? 88 : 300"
        :height="stacked ? 64 : 220"
        @problem="previewProblem = $event"
      />
      <div :style="{ flex: '1 1 100%', minWidth: 0, order: stacked ? -1 : 0, marginBottom: stacked ? '8px' : 0 }">
        <div
          v-if="allProblems.length"
          class="scr-problems"
          :style="{ margin: stacked ? 0 : '8px 0 0', color: 'var(--warn)', fontSize: 'var(--fs-small)' }"
        >
          <ul :style="{ margin: 0, paddingLeft: '16px' }">
            <li v-for="msg in allProblems" :key="msg">{{ msg }}</li>
          </ul>
        </div>
        <div v-else class="measure-hint">Everything needed to build it is there.</div>
      </div>
      <div
        :style="{
          display: 'flex',
          flexWrap: 'wrap',
          flex: stacked ? '1 1 140px' : '1 1 100%',
          gap: '8px',
          marginTop: stacked ? 0 : '10px',
          minWidth: 0,
        }"
      >
        <Button
          variant="primary"
          class="scr-save"
          :disabled="allProblems.length > 0"
          disabled-reason="Fix what is listed first"
          @click="emit('save', spec)"
        >
          {{ editing ? "Save changes" : "Add to my fasteners" }}
        </Button>
        <Button class="scr-cancel" @click="emit('cancel')">Cancel</Button>
      </div>
    </div>
  </div>
</template>
