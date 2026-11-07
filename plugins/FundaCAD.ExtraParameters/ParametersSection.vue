<script setup lang="ts">
import { computed, useId, watch } from "vue";
import {
  checkResults,
  clampToControl,
  configurationDrift,
  readAs,
  toast,
  useBrowserStore,
  useDocValue,
  useEngine,
} from "fundacad";
import { Checkbox, FieldRow, Icon, IconButton, NumberField, Select, Slider, announce } from "fundacad/ui";
import { setupOpen } from "./state";
import { nameColumnChars, rowTooltip, tuneGroups, type TuneRow } from "./view";

const store = useEngine().store;
const browser = useBrowserStore();
const uid = useId();

const groups = useDocValue((doc) => tuneGroups(doc));
const failing = useDocValue((doc) => checkResults(doc).filter((r) => !r.ok));
const configs = useDocValue((doc) => doc.paramExtras?.configurations ?? []);
const activeId = useDocValue((doc) => doc.paramExtras?.activeConfiguration ?? "");
const drift = useDocValue((doc) => {
  const cfg = doc.paramExtras?.configurations?.find((c) => c.id === doc.paramExtras?.activeConfiguration);
  return cfg ? configurationDrift(doc, cfg) : [];
});

const count = computed(() => groups.value.reduce((n, g) => n + g.rows.length, 0));
const shown = computed(() => count.value > 0 || configs.value.length > 0);
const collapsed = computed(() => browser.isCollapsed("Parameters"));
const configOptions = computed(() => configs.value.map((c) => ({ value: c.id, label: c.name })));

// A drawn check row is an alert and speaks itself; folded away nothing is drawn, so the announcer says it instead.
let seen = new Set<string>();
watch(failing, (now) => {
  const fresh = now.filter((r) => !seen.has(r.check.id));
  seen = new Set(now.map((r) => r.check.id));
  if (!collapsed.value) return;
  for (const r of fresh) {
    const level = r.check.level === "error" ? "error" : "warning";
    announce(`Check failed, ${level}: ${r.check.message}`, level === "error" ? "assertive" : "polite");
  }
});
seen = new Set(failing.value.map((r) => r.check.id));

function commit(row: TuneRow, value: number) {
  const v = clampToControl(row.control, value);
  const err = store.setParamExpr(row.name, String(v));
  if (err) toast(`${row.name}: ${err}`, { kind: "error" });
}

function pick(id: string) {
  const err = store.applyConfiguration(id);
  if (err) toast(err, { kind: "error" });
}

const readAngle = readAs("angle");
const readLength = readAs("length");
const readPlain = readAs(null);
const rowParse = (row: TuneRow) => (row.unit === "mm" ? readLength : row.unit === "°" ? readAngle : readPlain);
const fieldUnit = (row: TuneRow) => (row.unit === "mm" ? "mm" : row.unit === "°" ? "deg" : undefined);
const spokenUnit = (row: TuneRow) => (row.unit === "°" ? "degrees" : row.unit);
const sliderText = (row: TuneRow) => (v: number) => [String(v), spokenUnit(row)].filter(Boolean).join(" ");
const sliderStep = (row: TuneRow) =>
  row.control.kind === "slider" ? (row.control.step ?? (row.control.max - row.control.min) / 100) : 1;
function choiceOptions(row: TuneRow) {
  if (row.control.kind !== "choice") return [];
  const out: { value: string; label: string; disabled?: boolean }[] = row.control.choices.map((c) => ({
    value: String(c.value),
    label: c.label,
  }));
  if (!row.control.choices.some((c) => c.value === row.def.value)) {
    out.push({ value: String(row.def.value), label: `${row.def.value} (not listed)`, disabled: true });
  }
  return out;
}
const shortValue = (v: number) => Number(v.toFixed(4));
const groupKey = (id: string) => `Parameters:${id}`;
const groupId = (id: string) => `${uid}-group-${id}`;
// Only a field or a select is a labelable element, the rest are named by the label's id.
const labelFor = (row: TuneRow) =>
  row.editable && (row.control.kind === "number" || row.control.kind === "choice") ? undefined : null;

const rowStyle = { paddingRight: "8px", marginBottom: "0", display: "grid" };
// The name takes its longest name's width up to 62% of the row, but it is the one that gives way: the slider and the
// number field keep their minimum widths and the name ellipsizes in what is left.
const nameWidth = computed(() => `${nameColumnChars(groups.value.flatMap((g) => g.rows)) + 1}ch`);
const rowLayout = (g: { id: string | null }) => ({
  ...rowStyle,
  gridTemplateColumns: `minmax(0, min(${nameWidth.value}, 62%)) minmax(0, 1fr)`,
  paddingLeft: g.id === null ? undefined : "34px",
});
</script>

<template>
  <template v-if="shown">
    <div class="tree-folder xp-head" style="cursor: pointer" @click="browser.toggle('Parameters')">
      <IconButton
        class="tree-caret"
        variant="plain"
        size="sm"
        :icon="collapsed ? 'caretRight' : 'caretDown'"
        :icon-size="11"
        :tip="`${collapsed ? 'Expand' : 'Collapse'} Parameters`"
        :aria-expanded="!collapsed"
        :aria-controls="`${uid}-body`"
        @click.stop="browser.toggle('Parameters')"
      />
      <span class="feature-icon"><Icon name="parameters" :size="14" /></span>
      <span :id="`${uid}-head`">Parameters</span>
      <span style="flex: 1"></span>
      <Icon v-if="failing.length" name="warning" :size="13" style="margin-right: 4px; color: var(--warn)" />
      <IconButton
        class="xp-setup"
        variant="plain"
        size="sm"
        icon="properties"
        :icon-size="14"
        tip="Parameter setup"
        @click.stop="setupOpen = true"
      />
      <span class="tree-count">{{ count }}</span>
    </div>

    <div v-show="!collapsed" :id="`${uid}-body`" role="group" :aria-labelledby="`${uid}-head`">
      <FieldRow
        v-if="configs.length"
        v-slot="{ id }"
        layout="param"
        label="Configuration"
        class="feature-row tree-child"
        :style="rowStyle"
      >
        <Select
          :id="id"
          class="xp-config"
          label="Configuration"
          size="sm"
          placeholder="Choose…"
          :options="configOptions"
          :model-value="activeId"
          @update:model-value="pick"
        />
        <span
          v-if="activeId && drift.length"
          style="opacity: 0.6; font-size: var(--fs-micro, 11px)"
          :title="`Changed since it was applied: ${drift.join(', ')}`"
          >modified<span class="sr-only">, changed since it was applied: {{ drift.join(", ") }}</span></span
        >
      </FieldRow>

      <div
        v-for="r in failing"
        :key="r.check.id"
        role="alert"
        class="feature-row tree-child xp-check"
        :style="{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          paddingRight: '8px',
          color: r.check.level === 'error' ? 'var(--error)' : 'var(--warn)',
        }"
        :title="r.error ? `${r.check.expr}: ${r.error}` : r.check.expr"
      >
        <Icon name="warning" :size="12" />
        <span style="white-space: normal"
          >{{ r.check.level === "error" ? "Error" : "Warning" }}: {{ r.check.message }}</span
        >
      </div>

      <template v-for="g in groups" :key="g.id ?? ''">
        <div
          v-if="g.id !== null"
          class="tree-folder tree-child"
          style="cursor: pointer"
          @click="browser.toggle(groupKey(g.id))"
        >
          <IconButton
            class="tree-caret"
            variant="plain"
            size="sm"
            :icon="browser.isCollapsed(groupKey(g.id)) ? 'caretRight' : 'caretDown'"
            :icon-size="11"
            :tip="`${browser.isCollapsed(groupKey(g.id)) ? 'Expand' : 'Collapse'} ${g.name}`"
            :aria-expanded="!browser.isCollapsed(groupKey(g.id))"
            :aria-controls="groupId(g.id)"
            @click.stop="browser.toggle(groupKey(g.id))"
          />
          <span :id="`${groupId(g.id)}-name`">{{ g.name }}</span>
        </div>
        <div
          v-show="g.id === null || !browser.isCollapsed(groupKey(g.id))"
          :id="g.id === null ? undefined : groupId(g.id)"
          :role="g.id === null ? undefined : 'group'"
          :aria-labelledby="g.id === null ? undefined : `${groupId(g.id)}-name`"
        >
          <FieldRow
            v-for="row in g.rows"
            :key="row.name"
            v-slot="{ id, labelId, errorId }"
            layout="param"
            :label="row.name"
            :for="labelFor(row)"
            :error="row.problem ?? undefined"
            class="feature-row tree-child xp-row"
            :data-param="row.name"
            :style="rowLayout(g)"
            :title="rowTooltip(row)"
          >
            <span v-if="!row.editable" style="opacity: 0.7" :title="`= ${row.def.expr}`"
              ><span aria-hidden="true">fx </span>{{ shortValue(row.def.value) }} {{ row.unit
              }}<span class="sr-only">, calculated from {{ row.def.expr }}</span></span
            >

            <Checkbox
              v-else-if="row.control.kind === 'toggle'"
              :labelledby="labelId"
              :aria-describedby="errorId"
              :model-value="row.def.value !== 0"
              @update:model-value="commit(row, $event ? 1 : 0)"
            />

            <Select
              v-else-if="row.control.kind === 'choice'"
              :id="id"
              :label="row.name"
              size="sm"
              :aria-describedby="errorId"
              :options="choiceOptions(row)"
              :model-value="String(row.def.value)"
              @update:model-value="commit(row, Number($event))"
            />

            <Slider
              v-else-if="row.control.kind === 'slider'"
              :labelledby="labelId"
              :aria-describedby="errorId"
              style="flex: 1 1 auto; min-width: 60px"
              :min="row.control.min"
              :max="row.control.max"
              :step="sliderStep(row)"
              :unit="row.unit || undefined"
              :value-text="sliderText(row)"
              show-value
              commit="end"
              :model-value="row.def.value"
              @update:model-value="commit(row, $event)"
            />

            <NumberField
              v-else
              :id="id"
              :label="row.name"
              size="sm"
              style="flex: 1 0 76px; min-width: 76px"
              limits="arrows"
              :unit="fieldUnit(row)"
              :unitless="!fieldUnit(row)"
              :parse="rowParse(row)"
              :min="row.control.min"
              :max="row.control.max"
              :step="row.control.step ?? 1"
              :model-value="row.def.value"
              @update:model-value="$event !== null && commit(row, $event)"
            />
          </FieldRow>
        </div>
      </template>
    </div>
  </template>
</template>
