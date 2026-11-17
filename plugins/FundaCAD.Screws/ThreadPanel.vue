<script setup lang="ts">
import { computed } from "vue";
import { readAs, spellNumber } from "fundacad";
import { Button, FieldRow, FloatingPanel, NumberField, Select, Switch } from "fundacad/ui";
import { choicesFor, choiceOf, nearestIn, offByText, threadDraft, threadTool, type ThreadDraft } from "./threadTool";
import type { ThreadSystem } from "./threadSpec";

const readLength = readAs("length");

const SYSTEMS: { value: ThreadSystem; label: string }[] = [
  { value: "iso", label: "ISO metric" },
  { value: "unc", label: "UNC" },
  { value: "unf", label: "UNF" },
  { value: "tr", label: "Trapezoidal Tr" },
  { value: "acme", label: "ACME" },
];

const d = computed(() => threadDraft.value);
const choices = computed(() => (d.value ? choicesFor(d.value.system) : []));
const choice = computed(() => (d.value ? choiceOf(d.value) : null));
const offBy = computed(() => (d.value ? offByText(d.value) : ""));
const threadTitle = computed(() => `Standard Thread, ${d.value?.external ? "shaft" : "bore"}`);
const lead = computed(() => (choice.value && d.value ? +(choice.value.pitch * d.value.starts).toFixed(4) : 0));

function set(patch: Partial<ThreadDraft>) {
  if (!threadDraft.value) return;
  threadDraft.value = { ...threadDraft.value, ...patch };
  threadTool.value?.changed();
}

function setSystem(system: ThreadSystem) {
  const cur = threadDraft.value;
  if (!cur) return;
  const n = nearestIn(cur, system);
  const designation = n?.choice.designation ?? choicesFor(system)[0]?.designation ?? "";
  set({ system, designation, ...(n && !cur.external ? { faceIs: n.faceIs } : {}) });
}

const sizeOptions = computed(() => choices.value.map((c) => ({ value: c.designation, label: c.designation })));
const faceOptions = computed(() => [
  { value: "tap", label: `Tap drill${choice.value ? `, ${spellNumber(choice.value.tap)} mm` : ""}` },
  { value: "nominal", label: `Nominal${choice.value ? `, ${spellNumber(+choice.value.d.toFixed(3))} mm` : ""}` },
]);
const HANDS = [
  { value: "right", label: "Right" },
  { value: "left", label: "Left" },
];
const STARTS = [1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }));

// Inline because a downloaded plugin cannot ship a stylesheet (scripts/build-plugin-code.mjs).
const PANEL = { display: "flex", flexDirection: "column", gap: "6px", minWidth: "240px" } as const;
const FIELD = { minWidth: "120px" } as const;
const ACTIONS = { display: "flex", justifyContent: "flex-end", gap: "6px", marginTop: "4px" } as const;
</script>

<template>
  <FloatingPanel :open="!!d" :title="threadTitle" close-on-esc @close="threadTool?.cancel()">
    <div v-if="d" :style="PANEL" data-testid="thread-panel">
      <div class="measure-title" aria-hidden="true">{{ threadTitle }}</div>
      <FieldRow v-slot="{ id }" label="System">
        <Select
          :id="id"
          label="System"
          size="sm"
          testid="thread-system"
          :style="FIELD"
          :options="SYSTEMS"
          :model-value="d.system"
          @update:model-value="setSystem"
        />
      </FieldRow>
      <FieldRow v-slot="{ id }" label="Size">
        <Select
          :id="id"
          label="Size"
          size="sm"
          testid="thread-size"
          :style="FIELD"
          :options="sizeOptions"
          :model-value="d.designation"
          @update:model-value="set({ designation: $event })"
        />
      </FieldRow>
      <div v-if="offBy" class="measure-hint" data-testid="thread-offby">{{ offBy }}</div>
      <FieldRow
        v-if="!d.external"
        v-slot="{ id }"
        label="Bore drawn at"
        title="A bore drawn at tap drill size is cut, one drawn at the nominal size gets the thread joined into it"
      >
        <Select
          :id="id"
          label="Bore drawn at"
          size="sm"
          testid="thread-faceis"
          :style="FIELD"
          :options="faceOptions"
          :model-value="d.faceIs"
          @update:model-value="set({ faceIs: $event as 'tap' | 'nominal' })"
        />
      </FieldRow>
      <FieldRow v-slot="{ id }" label="Hand">
        <Select
          :id="id"
          label="Hand"
          size="sm"
          testid="thread-hand"
          :style="FIELD"
          :options="HANDS"
          :model-value="d.hand"
          @update:model-value="set({ hand: $event as 'right' | 'left' })"
        />
      </FieldRow>
      <FieldRow v-slot="{ id }" label="Starts">
        <Select
          :id="id"
          label="Starts"
          size="sm"
          testid="thread-starts"
          :style="FIELD"
          :options="STARTS"
          :model-value="String(d.starts)"
          @update:model-value="set({ starts: Number($event) })"
        />
      </FieldRow>
      <div v-if="choice" class="measure-hint"
        >Pitch {{ spellNumber(+choice.pitch.toFixed(4)) }} mm, lead {{ spellNumber(lead) }} mm</div
      >
      <FieldRow v-slot="{ id }" label="Print fit">
        <Switch
          :id="id"
          label="Print fit"
          data-testid="thread-printfit"
          :model-value="d.printFit"
          @update:model-value="set({ printFit: $event })"
        />
      </FieldRow>
      <FieldRow
        v-if="d.printFit"
        v-slot="{ id }"
        label="Clearance"
        title="Radial clearance, so a printed thread turns into its mate"
      >
        <NumberField
          :id="id"
          label="Clearance"
          unit="mm"
          size="sm"
          :style="FIELD"
          limits="arrows"
          nullable
          :parse="readLength"
          :min="0"
          :step="0.05"
          data-testid="thread-clearance"
          :model-value="d.clearance"
          @update:model-value="set({ clearance: Math.max(0, $event ?? 0) })"
        />
      </FieldRow>
      <div :style="ACTIONS">
        <Button data-testid="thread-cancel" @click="threadTool?.cancel()">Cancel</Button>
        <Button variant="primary" data-testid="thread-apply" :disabled="!choice" @click="threadTool?.apply()">{{
          d.editing ? "Update" : "Add"
        }}</Button>
      </div>
    </div>
  </FloatingPanel>
</template>
