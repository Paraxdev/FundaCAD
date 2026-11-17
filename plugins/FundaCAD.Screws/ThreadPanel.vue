<script setup lang="ts">
import { computed } from "vue";
import { readAs, spellNumber } from "fundacad";
import { Button, FieldRow, FloatingPanel, NumberField, Select, Switch } from "fundacad/ui";
import { choicesFor, choiceOf, nearestIn, offByText, threadDraft, threadTool, type ThreadDraft } from "./threadTool";
import { t } from "./lines";
import type { ThreadSystem } from "./threadSpec";

const readLength = readAs("length");

const SYSTEMS = computed<{ value: ThreadSystem; label: string }[]>(() => [
  { value: "iso", label: t("thread.systemIso") },
  { value: "unc", label: "UNC" },
  { value: "unf", label: "UNF" },
  { value: "tr", label: t("thread.systemTr") },
  { value: "acme", label: "ACME" },
]);

const d = computed(() => threadDraft.value);
const choices = computed(() => (d.value ? choicesFor(d.value.system) : []));
const choice = computed(() => (d.value ? choiceOf(d.value) : null));
const offBy = computed(() => (d.value ? offByText(d.value) : ""));
const threadTitle = computed(() => (d.value?.external ? t("thread.titleShaft") : t("thread.titleBore")));
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
  {
    value: "tap",
    label: choice.value ? t("thread.faceTapMm", { mm: spellNumber(choice.value.tap) }) : t("thread.faceTap"),
  },
  {
    value: "nominal",
    label: choice.value
      ? t("thread.faceNominalMm", { mm: spellNumber(+choice.value.d.toFixed(3)) })
      : t("thread.faceNominal"),
  },
]);
const HANDS = computed(() => [
  { value: "right", label: t("option.right") },
  { value: "left", label: t("option.left") },
]);
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
      <FieldRow v-slot="{ id }" :label="t('field.system')">
        <Select
          :id="id"
          :label="t('field.system')"
          size="sm"
          testid="thread-system"
          :style="FIELD"
          :options="SYSTEMS"
          :model-value="d.system"
          @update:model-value="setSystem"
        />
      </FieldRow>
      <FieldRow v-slot="{ id }" :label="t('field.size')">
        <Select
          :id="id"
          :label="t('field.size')"
          size="sm"
          testid="thread-size"
          :style="FIELD"
          :options="sizeOptions"
          :model-value="d.designation"
          @update:model-value="set({ designation: $event })"
        />
      </FieldRow>
      <div v-if="offBy" class="measure-hint" data-testid="thread-offby">{{ offBy }}</div>
      <FieldRow v-if="!d.external" v-slot="{ id }" :label="t('field.boreDrawnAt')" :title="t('thread.boreTip')">
        <Select
          :id="id"
          :label="t('field.boreDrawnAt')"
          size="sm"
          testid="thread-faceis"
          :style="FIELD"
          :options="faceOptions"
          :model-value="d.faceIs"
          @update:model-value="set({ faceIs: $event as 'tap' | 'nominal' })"
        />
      </FieldRow>
      <FieldRow v-slot="{ id }" :label="t('field.hand')">
        <Select
          :id="id"
          :label="t('field.hand')"
          size="sm"
          testid="thread-hand"
          :style="FIELD"
          :options="HANDS"
          :model-value="d.hand"
          @update:model-value="set({ hand: $event as 'right' | 'left' })"
        />
      </FieldRow>
      <FieldRow v-slot="{ id }" :label="t('field.starts')">
        <Select
          :id="id"
          :label="t('field.starts')"
          size="sm"
          testid="thread-starts"
          :style="FIELD"
          :options="STARTS"
          :model-value="String(d.starts)"
          @update:model-value="set({ starts: Number($event) })"
        />
      </FieldRow>
      <div v-if="choice" class="measure-hint">{{
        t("thread.pitchLead", { pitch: spellNumber(+choice.pitch.toFixed(4)), lead: spellNumber(lead) })
      }}</div>
      <FieldRow v-slot="{ id }" :label="t('field.printFit')">
        <Switch
          :id="id"
          :label="t('field.printFit')"
          data-testid="thread-printfit"
          :model-value="d.printFit"
          @update:model-value="set({ printFit: $event })"
        />
      </FieldRow>
      <FieldRow v-if="d.printFit" v-slot="{ id }" :label="t('field.clearance')" :title="t('field.clearanceTip')">
        <NumberField
          :id="id"
          :label="t('field.clearance')"
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
        <Button data-testid="thread-cancel" @click="threadTool?.cancel()">{{ t("action.cancel") }}</Button>
        <Button variant="primary" data-testid="thread-apply" :disabled="!choice" @click="threadTool?.apply()">{{
          d.editing ? t("action.update") : t("action.add")
        }}</Button>
      </div>
    </div>
  </FloatingPanel>
</template>
