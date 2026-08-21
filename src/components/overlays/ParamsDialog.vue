<script setup lang="ts">
// Modify → Parameters: the Change Parameters dialog. User parameters (add /
// rename / re-express / comment / delete-with-named-blockers) and model
// parameters (dN — expression + target readout, renamable). Values are shown in
// display units for lengths; EXPRESSIONS are always canonical (mm / deg), the
// same rule as every other expression surface.

import { computed, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { useDocValue } from "../../app/useDoc";
import { usePanelsStore } from "../../stores/panels";
import { featureMeta } from "../../ui/featureMeta";
import { getUnit, toDisplay, round } from "../../ui/units";
import FloatingPanel from "./FloatingPanel.vue";
import ValidatedInput from "../shell/ValidatedInput.vue";
import type { CadDocument, ParamDef, ParamTarget, ParamUnit } from "../../types";

const engine = useEngine();
const store = engine.store;
const panels = usePanelsStore();

interface Row {
  name: string;
  def: ParamDef;
  value: string;
  drives: string | null;
  issue: string | undefined;
}

/** Both lists ride the document version, so an async commit landing, an undo or
 *  a load refreshes them — what the keystrokeGuard'd re-render used to do. The
 *  guard itself is per-input now (ValidatedRow / useDraft), so a refresh can no
 *  longer wipe an edit in progress. */
const rows = useDocValue((doc) => {
  const defs = doc.paramDefs ?? {};
  return Object.entries(defs).map(([name, def]) => ({
    name,
    def,
    value: formatValue(def),
    drives: def.target ? targetLabel(doc, def.target) : null,
    issue: store.paramIssues[name],
  })) as Row[];
});

const userRows = computed(() => rows.value.filter((r) => !r.def.target));
const modelRows = computed(() => rows.value.filter((r) => r.def.target));

function formatValue(def: ParamDef): string {
  if (def.unit === "mm") return `${round(toDisplay(def.value))} ${getUnit()}`;
  if (def.unit === "deg") return `${round(def.value)}°`;
  return String(round(def.value));
}

/** Human label for what a model parameter drives. */
function targetLabel(doc: CadDocument, t: ParamTarget): string {
  const featureName = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    return f ? `${featureMeta(f).label} ${id}` : id;
  };
  switch (t.kind) {
    case "feature":
      return `${featureName(t.feature)} · ${t.field}`;
    case "constraint":
      return `dimension in ${featureName(t.sketch)}`;
    case "entity":
      return `${t.field} in ${featureName(t.sketch)}`;
    case "pattern":
      return `pattern ${t.field} in ${featureName(t.sketch)}`;
  }
}

// --- delete (user params only; a dN dies with its target) ---
// deleteParam reports NAMED blockers rather than refusing silently, so the
// message belongs on the button that was pressed.
const delError = ref<Record<string, string>>({});
function del(name: string) {
  const err = store.deleteParam(name);
  if (err) delError.value = { ...delError.value, [name]: err };
}

// --- add row ---
const UNITS: ParamUnit[] = ["mm", "deg", "count"];
const newName = ref("");
const newExpr = ref("");
const newUnit = ref<ParamUnit>("mm");
const addError = ref("");

function add() {
  if (!newName.value.trim() || !newExpr.value.trim()) return;
  const err = store.addParam(newName.value.trim(), newExpr.value.trim(), newUnit.value);
  addError.value = err ?? "";
  if (err) return;
  newName.value = "";
  newExpr.value = "";
}
</script>

<template>
  <FloatingPanel
    :open="panels.params"
    close-on-esc
    panel-class="params-dialog"
    @close="panels.params = false"
  >
    <div class="measure-title">Parameters</div>
    <div class="params-body">
      <div class="params-section">User Parameters</div>
      <div class="params-row params-head">
        <span>Name</span><span>Expression</span><span>Value</span><span>Comment / drives</span><span></span>
      </div>
      <div
        v-for="r in userRows"
        :key="r.name"
        class="params-row"
        :class="{ 'param-stale': !!r.issue }"
        :title="r.issue"
      >
        <ValidatedInput
          :value="r.name"
          :commit="(raw) => (raw === r.name ? null : store.renameParam(r.name, raw))"
        />
        <ValidatedInput
          :value="r.def.expr"
          :commit="(raw) => store.setParamExpr(r.name, raw)"
        />
        <span class="params-value">{{ r.value }}</span>
        <ValidatedInput
          :value="r.def.comment ?? ''"
          :commit="(raw) => (store.setParamComment(r.name, raw), null)"
        />
        <button
          class="params-del"
          :class="{ 'input-error': !!delError[r.name] }"
          :title="delError[r.name] ?? `Delete ${r.name}`"
          @click="del(r.name)"
        >×</button>
      </div>

      <div class="params-row params-add">
        <input v-model="newName" type="text" placeholder="name" />
        <input v-model="newExpr" type="text" placeholder="expression" @keydown.enter="add()" />
        <select v-model="newUnit">
          <option v-for="u in UNITS" :key="u" :value="u">{{ u === "count" ? "unitless" : u }}</option>
        </select>
        <button :class="{ 'input-error': !!addError }" :title="addError" @click="add()">+ Add</button>
      </div>

      <template v-if="modelRows.length">
        <div class="params-section">Model Parameters</div>
        <div class="params-row params-head">
          <span>Name</span><span>Expression</span><span>Value</span><span>Comment / drives</span><span></span>
        </div>
        <div
          v-for="r in modelRows"
          :key="r.name"
          class="params-row"
          :class="{ 'param-stale': !!r.issue }"
          :title="r.issue"
        >
          <ValidatedInput
            :value="r.name"
            :commit="(raw) => (raw === r.name ? null : store.renameParam(r.name, raw))"
          />
          <ValidatedInput
            :value="r.def.expr"
            :commit="(raw) => store.setParamExpr(r.name, raw)"
          />
          <span class="params-value">{{ r.value }}</span>
          <!-- a dN has no comment and no delete: it dies with its target -->
          <span class="params-drives" :title="r.drives ?? ''">{{ r.drives }}</span>
          <span></span>
        </div>
      </template>

      <div class="measure-hint">
        Expressions are in mm / degrees; suffixes mm cm in deg rad allowed · Esc to close
      </div>
    </div>
  </FloatingPanel>
</template>
