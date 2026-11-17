<script setup lang="ts">
// Lengths show in display units, but expressions are always canonical (mm, deg), as on every expression surface.

import { computed, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { t } from "../../i18n";
import { useDocValue } from "../../app/useDoc";
import { usePanelsStore } from "../../stores/panels";
import { featureMeta } from "../../ui/featureMeta";
import { getUnit, toDisplay } from "../../ui/units";
import { shownExpr, spellRounded, storedExpr, typedExprProblem } from "../../ui/measure";
import Panel from "../ui/Panel.vue";
import TextField from "../ui/TextField.vue";
import Select from "../ui/Select.vue";
import Button from "../ui/Button.vue";
import IconButton from "../ui/IconButton.vue";
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

/** Rides the document version, so an async commit, an undo or a load refreshes both lists. An edit in progress is
 *  guarded per field (useCommitField). */
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
  if (def.unit === "mm") return `${spellRounded(toDisplay(def.value))} ${getUnit()}`;
  if (def.unit === "deg") return `${spellRounded(def.value)}°`;
  return spellRounded(def.value);
}

function targetLabel(doc: CadDocument, target: ParamTarget): string {
  const featureName = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    return f ? `${featureMeta(f).label} ${id}` : id;
  };
  switch (target.kind) {
    case "feature":
      return `${featureName(target.feature)} · ${target.field}`;
    case "constraint":
      return t("params.drives.dimension", { feature: featureName(target.sketch) });
    case "entity":
      return t("params.drives.field", { field: target.field, feature: featureName(target.sketch) });
    case "pattern":
      return t("params.drives.pattern", { field: target.field, feature: featureName(target.sketch) });
  }
}

// User params only, a dN dies with its target. deleteParam names its blockers, so the message sits on the pressed
// button.
const delError = ref<Record<string, string>>({});
function del(name: string) {
  const err = store.deleteParam(name);
  if (err) delError.value = { ...delError.value, [name]: err };
}

const UNITS = computed<{ value: ParamUnit; label: string }[]>(() => [
  { value: "mm", label: "mm" },
  { value: "deg", label: "deg" },
  { value: "count", label: t("params.unitless") },
]);
const newName = ref("");
const newExpr = ref("");
const newUnit = ref<ParamUnit>("mm");
const addError = ref("");

/** The store's own check is the commit, so it runs as TextField's validate, which runs once per commit and keeps the
 *  refused text. */
const commitWith = (fn: (raw: string) => string | null) => (raw: string) => fn(raw.trim());
const commitExpr = (fn: (expr: string) => string | null) =>
  commitWith((raw) => typedExprProblem(raw) ?? fn(storedExpr(raw)));

function add() {
  if (!newName.value.trim() || !newExpr.value.trim()) return;
  const expr = newExpr.value.trim();
  const err = typedExprProblem(expr) ?? store.addParam(newName.value.trim(), storedExpr(expr), newUnit.value);
  addError.value = err ?? "";
  if (err) return;
  newName.value = "";
  newExpr.value = "";
}
</script>

<template>
  <Panel
    :open="panels.params"
    :title="t('tool.parameters')"
    close-on-esc
    panel-class="params-dialog"
    @close="panels.params = false"
  >
    <div class="params-body">
      <div class="params-section">{{ t("params.user") }}</div>
      <div class="params-row params-head">
        <span>{{ t("params.column.name") }}</span
        ><span>{{ t("params.column.expression") }}</span
        ><span>{{ t("params.column.value") }}</span
        ><span>{{ t("params.column.comment") }}</span
        ><span></span>
      </div>
      <div
        v-for="r in userRows"
        :key="r.name"
        class="params-row"
        :class="{ 'param-stale': !!r.issue }"
        :title="r.issue"
      >
        <TextField
          commit="change"
          :label="t('params.nameOf', { name: r.name })"
          :model-value="r.name"
          :validate="commitWith((raw) => (raw === r.name ? null : store.renameParam(r.name, raw)))"
        />
        <TextField
          commit="change"
          :label="t('params.expressionOf', { name: r.name })"
          :model-value="shownExpr(r.def.expr)"
          :validate="commitExpr((expr) => store.setParamExpr(r.name, expr))"
        />
        <span class="params-value">{{ r.value }}</span>
        <TextField
          commit="change"
          :label="t('params.commentOn', { name: r.name })"
          :model-value="r.def.comment ?? ''"
          :validate="commitWith((raw) => (store.setParamComment(r.name, raw), null))"
        />
        <IconButton
          class="params-del"
          :class="{ 'is-error': !!delError[r.name] }"
          icon="close"
          :tip="delError[r.name] ?? t('params.delete', { name: r.name })"
          size="sm"
          variant="danger"
          @click="del(r.name)"
        />
      </div>

      <div class="params-row params-add">
        <TextField v-model="newName" :placeholder="t('params.new.namePlaceholder')" :label="t('params.new.name')" />
        <TextField
          v-model="newExpr"
          :placeholder="t('params.new.expressionPlaceholder')"
          :label="t('params.new.expression')"
          @keydown.enter="add()"
        />
        <Select v-model="newUnit" :options="UNITS" :label="t('params.new.unit')" />
        <Button :variant="addError ? 'danger' : 'secondary'" :tip="addError || undefined" @click="add()">{{
          t("params.add")
        }}</Button>
      </div>

      <template v-if="modelRows.length">
        <div class="params-section">{{ t("params.model") }}</div>
        <div class="params-row params-head">
          <span>{{ t("params.column.name") }}</span
          ><span>{{ t("params.column.expression") }}</span
          ><span>{{ t("params.column.value") }}</span
          ><span>{{ t("params.column.comment") }}</span
          ><span></span>
        </div>
        <div
          v-for="r in modelRows"
          :key="r.name"
          class="params-row"
          :class="{ 'param-stale': !!r.issue }"
          :title="r.issue"
        >
          <TextField
            commit="change"
            :label="t('params.nameOf', { name: r.name })"
            :model-value="r.name"
            :validate="commitWith((raw) => (raw === r.name ? null : store.renameParam(r.name, raw)))"
          />
          <TextField
            commit="change"
            :label="t('params.expressionOf', { name: r.name })"
            :model-value="shownExpr(r.def.expr)"
            :validate="commitExpr((expr) => store.setParamExpr(r.name, expr))"
          />
          <span class="params-value">{{ r.value }}</span>
          <!-- a dN has no comment and no delete: it dies with its target -->
          <span class="params-drives" :title="r.drives ?? ''">{{ r.drives }}</span>
          <span></span>
        </div>
      </template>

      <div class="measure-hint">{{ t("params.hint") }}</div>
    </div>
  </Panel>
</template>
