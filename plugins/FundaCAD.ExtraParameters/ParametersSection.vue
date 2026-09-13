<script setup lang="ts">
// The knobs of the model, as a section of the browser: a configuration picker,
// the checks that do not hold, and every user parameter through the control it
// was given, in its group.
//
// A slider commits when it is let go, not on every step of the drag. Each commit
// is an undo step and a rebuild, and forty of them for one gesture would bury
// the change somebody wants to undo under the positions they dragged through.

import { computed, ref } from "vue";
import { checkResults, clampToControl, configurationDrift, toast, useBrowserStore, useDocValue, useEngine } from "fundacad";
import { Icon } from "fundacad/ui";
import { setupOpen } from "./state";
import { tuneGroups, type TuneRow } from "./view";

const store = useEngine().store;
const browser = useBrowserStore();

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

/** A slider's position while it is held, by parameter name. */
const dragging = ref<Record<string, number>>({});

function commit(row: TuneRow, value: number) {
  const v = clampToControl(row.control, value);
  const err = store.setParamExpr(row.name, String(v));
  if (err) toast(`${row.name}: ${err}`, { kind: "error" });
}

function release(row: TuneRow, value: number) {
  const { [row.name]: _held, ...rest } = dragging.value;
  dragging.value = rest;
  commit(row, value);
}

function pick(id: string) {
  const err = store.applyConfiguration(id);
  if (err) toast(err, { kind: "error" });
}

const num = (e: Event) => Number((e.target as HTMLInputElement).value);
const rowStyle = { display: "flex", alignItems: "center", gap: "6px", paddingRight: "8px" };
const nameStyle = { flex: "0 0 38%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const fieldStyle = { flex: "1", minWidth: "0", font: "inherit", color: "inherit" };
</script>

<template>
  <template v-if="shown">
    <div class="tree-folder" :aria-expanded="!collapsed" @click="browser.toggle('Parameters')">
      <span class="tree-caret"><Icon :name="collapsed ? 'caretRight' : 'caretDown'" :size="11" /></span>
      <span class="feature-icon"><Icon name="parameters" :size="14" /></span>
      <span>Parameters</span>
      <span style="flex: 1"></span>
      <Icon v-if="failing.length" name="warning" :size="13" style="margin-right: 4px; color: #d2a83b" />
      <button
        class="xp-setup"
        title="Parameter setup: controls, groups, configurations and checks"
        style="background: none; border: none; color: inherit; cursor: pointer; padding: 0 4px; margin-right: 6px"
        @click.stop="setupOpen = true"
      ><Icon name="properties" :size="14" /></button>
      <span class="tree-count">{{ count }}</span>
    </div>

    <template v-if="!collapsed">
      <div v-if="configs.length" class="feature-row tree-child" :style="rowStyle">
        <span style="flex: 0 0 auto">Configuration</span>
        <select
          class="xp-config"
          :style="fieldStyle"
          :value="activeId"
          @change="pick(($event.target as HTMLSelectElement).value)"
        >
          <option value="" disabled>Choose…</option>
          <option v-for="c in configs" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <span
          v-if="activeId && drift.length"
          style="opacity: 0.6; font-size: 11px"
          :title="`Changed since it was applied: ${drift.join(', ')}`"
        >modified</span>
      </div>

      <div
        v-for="r in failing"
        :key="r.check.id"
        class="feature-row tree-child xp-check"
        :style="{ ...rowStyle, color: r.check.level === 'error' ? '#e24a3b' : '#d2a83b' }"
        :title="r.error ? `${r.check.expr}: ${r.error}` : r.check.expr"
      >
        <Icon name="warning" :size="12" />
        <span style="white-space: normal">{{ r.check.message }}</span>
      </div>

      <template v-for="g in groups" :key="g.id ?? ''">
        <div
          v-if="g.id !== null"
          class="tree-folder tree-child"
          :aria-expanded="!browser.isCollapsed(`Parameters:${g.id}`)"
          @click="browser.toggle(`Parameters:${g.id}`)"
        >
          <span class="tree-caret">
            <Icon :name="browser.isCollapsed(`Parameters:${g.id}`) ? 'caretRight' : 'caretDown'" :size="11" />
          </span>
          <span>{{ g.name }}</span>
        </div>
        <template v-if="g.id === null || !browser.isCollapsed(`Parameters:${g.id}`)">
          <div
            v-for="row in g.rows"
            :key="row.name"
            class="feature-row tree-child xp-row"
            :data-param="row.name"
            :style="{ ...rowStyle, paddingLeft: g.id === null ? undefined : '34px' }"
            :title="row.problem ? `${row.name}: ${row.problem}` : row.def.comment ?? row.name"
          >
            <span :style="{ ...nameStyle, color: row.problem ? '#e24a3b' : undefined }">{{ row.name }}</span>

            <span v-if="!row.editable" :style="{ ...fieldStyle, opacity: 0.7 }" :title="`= ${row.def.expr}`">
              fx {{ Number(row.def.value.toFixed(4)) }} {{ row.unit }}
            </span>

            <input
              v-else-if="row.control.kind === 'toggle'"
              type="checkbox"
              :checked="row.def.value !== 0"
              @change="commit(row, ($event.target as HTMLInputElement).checked ? 1 : 0)"
            />

            <select
              v-else-if="row.control.kind === 'choice'"
              :style="fieldStyle"
              :value="String(row.def.value)"
              @change="commit(row, num($event))"
            >
              <option v-for="c in row.control.choices" :key="c.value" :value="String(c.value)">{{ c.label }}</option>
              <option
                v-if="!row.control.choices.some((c) => c.value === row.def.value)"
                :value="String(row.def.value)"
                disabled
              >{{ row.def.value }} (not listed)</option>
            </select>

            <template v-else-if="row.control.kind === 'slider'">
              <input
                type="range"
                :style="fieldStyle"
                :min="row.control.min"
                :max="row.control.max"
                :step="row.control.step ?? 'any'"
                :value="dragging[row.name] ?? row.def.value"
                @input="dragging = { ...dragging, [row.name]: num($event) }"
                @change="release(row, num($event))"
              />
              <span style="min-width: 3.5em; text-align: right">
                {{ Number((dragging[row.name] ?? row.def.value).toFixed(4)) }} {{ row.unit }}
              </span>
            </template>

            <template v-else>
              <input
                type="number"
                :style="fieldStyle"
                :min="row.control.min"
                :max="row.control.max"
                :step="row.control.step ?? 'any'"
                :value="row.def.value"
                @change="commit(row, num($event))"
              />
              <span>{{ row.unit }}</span>
            </template>
          </div>
        </template>
      </template>
    </template>
  </template>
</template>
