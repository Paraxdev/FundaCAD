<script setup lang="ts">
// Everything here edits the document (ParamDef.control/group/hidden and paramExtras), so it saves with the file,
// undoes like any edit, and survives the plugin being switched off.

import { computed, reactive, ref, useId } from "vue";
import { captureConfiguration, checkResults, evalExpr, toast, useDocValue, useEngine } from "fundacad";
import type { ParamCheck, ParamControl, ParamDef } from "fundacad";
import {
  Button,
  Checkbox,
  FloatingPanel,
  Icon,
  IconButton,
  NumberField,
  Select,
  TextField,
  announce,
} from "fundacad/ui";
import { setupOpen } from "./state";
import { convertControl, formatChoices, nextId, parseChoices } from "./view";

const store = useEngine().store;

/** Knobs first, hidden helpers after them, each in table order. */
const params = useDocValue((doc) =>
  Object.entries(doc.paramDefs ?? {})
    .filter(([, d]) => !d.target)
    .map(([name, def]) => ({ name, def }))
    .sort((a, b) => Number(!!a.def.hidden) - Number(!!b.def.hidden)),
);
const groups = useDocValue((doc) => doc.paramExtras?.groups ?? []);
const configs = useDocValue((doc) => doc.paramExtras?.configurations ?? []);
const checks = useDocValue((doc) => {
  const results = new Map(checkResults(doc).map((r) => [r.check.id, r]));
  return (doc.paramExtras?.checks ?? []).map((c) => ({ check: c, result: results.get(c.id) }));
});

const KINDS: { value: ParamControl["kind"]; label: string }[] = [
  { value: "number", label: "Number" },
  { value: "slider", label: "Slider" },
  { value: "toggle", label: "Toggle" },
  { value: "choice", label: "Choice" },
];
const LEVELS: { value: ParamCheck["level"]; label: string }[] = [
  { value: "warning", label: "Warning" },
  { value: "error", label: "Error" },
];
const BOUNDS = ["min", "max", "step"] as const;
type Bound = (typeof BOUNDS)[number];
const BOUND_WORDS: Record<Bound, string> = { min: "minimum", max: "maximum", step: "step" };

// What is wrong, as text on the panel: a refused edit used to be a toast, which a screen reader never reached. The
// panel's own refusals are spoken here, a field's own are spoken by the field and only shown here.
const problems = reactive<Record<string, string | null>>({});
const shownProblems = computed(() => Object.values(problems).filter((why): why is string => !!why));
function show(key: string, why: string | null) {
  problems[key] = why;
}
function fail(why: string) {
  show("panel", why);
  announce(why, "assertive", { key: "xp-setup-problem" });
}
const clear = () => show("panel", null);

const uid = useId();

function setKind(name: string, kind: ParamControl["kind"], value: number, current?: ParamControl) {
  clear();
  store.setParamMeta(name, { control: kind === "number" && !current ? null : convertControl(current, kind, value) });
}

/** A range field left empty removes that bound, except on a slider, which
 *  cannot be drawn without both ends. */
function setBound(name: string, control: ParamControl, key: Bound, v: number | null) {
  if (control.kind !== "number" && control.kind !== "slider") return;
  clear();
  const next = { ...control } as Record<string, unknown>;
  if (v === null) {
    if (control.kind === "slider" && key !== "step") return fail(`a slider needs a ${key}`);
    delete next[key];
  } else {
    next[key] = v;
  }
  const lo = next["min"] as number | undefined;
  const hi = next["max"] as number | undefined;
  if (lo !== undefined && hi !== undefined && lo >= hi) return fail("min must be below max");
  store.setParamMeta(name, { control: next as ParamControl });
}

const boundOf = (control: ParamControl, key: Bound): number | null =>
  control.kind === "number" || control.kind === "slider" ? (control[key] ?? null) : null;
const boundUnit = (def: ParamDef) => (def.unit === "mm" ? "mm" : def.unit === "deg" ? "deg" : null);
const stepProblem = (v: number) => (v <= 0 ? "step must be a positive number" : null);

function choicesProblem(key: string, raw: string): string | null {
  const parsed = parseChoices(raw);
  const why = typeof parsed === "string" ? parsed : null;
  show(key, why);
  return why;
}
function setChoices(name: string, raw: string) {
  const parsed = parseChoices(raw);
  if (typeof parsed === "string") return;
  clear();
  store.setParamMeta(name, { control: { kind: "choice", choices: parsed } });
}

const newGroup = ref("");
function addGroup() {
  const name = newGroup.value.trim();
  if (!name) return;
  clear();
  store.updateParamExtras((x) => {
    const list = (x.groups ??= []);
    list.push({
      id: nextId(
        "g",
        list.map((g) => g.id),
      ),
      name,
    });
  });
  newGroup.value = "";
}
function renameGroup(id: string, name: string) {
  if (!name.trim()) return;
  store.updateParamExtras((x) => {
    const g = x.groups?.find((y) => y.id === id);
    if (g) g.name = name.trim();
  });
}
function removeGroup(id: string) {
  store.updateParamExtras((x) => void (x.groups = (x.groups ?? []).filter((g) => g.id !== id)));
}

const newConfig = ref("");
function saveConfig() {
  const name = newConfig.value.trim();
  if (!name) return;
  const id = nextId(
    "c",
    configs.value.map((c) => c.id),
  );
  const cfg = captureConfiguration(store.document, id, name);
  store.updateParamExtras((x) => {
    (x.configurations ??= []).push(cfg);
    x.activeConfiguration = id;
  });
  newConfig.value = "";
}
function updateConfig(id: string, name: string) {
  const cfg = captureConfiguration(store.document, id, name);
  store.updateParamExtras((x) => {
    x.configurations = (x.configurations ?? []).map((c) => (c.id === id ? cfg : c));
    x.activeConfiguration = id;
  });
}
function renameConfig(id: string, name: string) {
  if (!name.trim()) return;
  store.updateParamExtras((x) => {
    const c = x.configurations?.find((y) => y.id === id);
    if (c) c.name = name.trim();
  });
}
function removeConfig(id: string) {
  store.updateParamExtras((x) => {
    x.configurations = (x.configurations ?? []).filter((c) => c.id !== id);
    if (x.activeConfiguration === id) delete x.activeConfiguration;
  });
}
function applyConfig(id: string) {
  const err = store.applyConfiguration(id);
  if (err) toast(err, { kind: "error" });
}

const newCheck = ref({ expr: "", message: "", level: "warning" as ParamCheck["level"] });

/** A rule that names a parameter that does not exist is refused when it is
 *  written, the one moment somebody is looking at it. */
function exprError(expr: string): string | null {
  const values = Object.fromEntries(Object.entries(store.document.paramDefs ?? {}).map(([n, d]) => [n, d.value]));
  try {
    evalExpr(expr, values);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function addCheck() {
  const { expr, message, level } = newCheck.value;
  if (!expr.trim() || !message.trim()) return fail("a check needs a rule and a message");
  const err = exprError(expr);
  if (err) return fail(`${expr}: ${err}`);
  clear();
  store.updateParamExtras((x) => {
    const list = (x.checks ??= []);
    list.push({
      id: nextId(
        "k",
        list.map((c) => c.id),
      ),
      expr: expr.trim(),
      message: message.trim(),
      level,
    });
  });
  newCheck.value = { expr: "", message: "", level: "warning" };
}
function exprProblem(key: string, expr: string): string | null {
  const err = exprError(expr.trim());
  const why = err && `${expr.trim()}: ${err}`;
  show(key, why);
  return why;
}
function editCheck(id: string, patch: Partial<ParamCheck>) {
  if (patch.expr !== undefined && exprError(patch.expr)) return;
  clear();
  store.updateParamExtras((x) => {
    const c = x.checks?.find((y) => y.id === id);
    if (c) Object.assign(c, patch);
  });
}
function removeCheck(id: string) {
  store.updateParamExtras((x) => void (x.checks = (x.checks ?? []).filter((c) => c.id !== id)));
}

const empty = computed(() => params.value.length === 0);
const groupOptions = computed(() => [
  { value: "", label: "none" },
  ...groups.value.map((g) => ({ value: g.id, label: g.name })),
]);
const configTitle = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([n, e]) => `${n} = ${e}`)
    .join("\n");
const hideLabel = (i: number) => `${uid}-hide-${i}`;
const checkTone = (c: { result?: { ok: boolean } | undefined; check: ParamCheck }) =>
  c.result?.ok ? "var(--ok)" : c.check.level === "error" ? "var(--error)" : "var(--warn)";

const section = { margin: "12px 0 4px", fontWeight: "600", opacity: "0.8" };
const grid = (cols: string) => ({ display: "grid", gridTemplateColumns: cols, gap: "4px 6px", alignItems: "center" });
const FILL = { width: "100%", minWidth: "0" };
const PROBLEM = { color: "var(--error)", fontSize: "var(--fs-small)", margin: "0 0 4px" };
</script>

<template>
  <FloatingPanel
    :open="setupOpen"
    title="Parameter Setup"
    close-on-esc
    panel-class="xp-setup-panel"
    @close="setupOpen = false"
  >
    <div class="measure-title" aria-hidden="true">Parameter Setup</div>
    <div v-for="why in shownProblems" :key="why" role="alert" :style="PROBLEM">{{ why }}</div>
    <div style="max-height: 70vh; overflow: auto; padding-right: 4px; width: 680px; max-width: 100%">
      <div v-if="empty" class="measure-hint">Add a user parameter first (Modify, Parameters).</div>

      <template v-else>
        <div :style="section">Controls</div>
        <div :style="grid('1fr 1.1fr 2.9fr 1fr auto')">
          <span aria-hidden="true" style="opacity: 0.6">Name</span>
          <span aria-hidden="true" style="opacity: 0.6">Control</span>
          <span aria-hidden="true" style="opacity: 0.6">Range or choices</span>
          <span aria-hidden="true" style="opacity: 0.6">Group</span>
          <span aria-hidden="true" style="opacity: 0.6" title="Hidden from the Parameters section">Hide</span>
          <template v-for="(p, i) in params" :key="p.name">
            <span :title="`${p.def.expr} = ${p.def.value}`" :style="{ opacity: p.def.hidden ? 0.5 : 1 }">{{
              p.name
            }}</span>
            <Select
              class="xp-kind"
              :data-param="p.name"
              :label="`${p.name} control`"
              size="sm"
              :style="FILL"
              :options="KINDS"
              :model-value="p.def.control?.kind ?? 'number'"
              @update:model-value="setKind(p.name, $event, p.def.value, p.def.control)"
            />
            <span v-if="p.def.control?.kind === 'choice'">
              <TextField
                :label="`${p.name} choices`"
                size="sm"
                commit="change"
                :style="FILL"
                placeholder="Small = 10, Large = 30"
                :validate="(raw) => choicesProblem(`${p.name}.choices`, raw)"
                :model-value="formatChoices(p.def.control.choices)"
                @update:model-value="setChoices(p.name, $event)"
              />
            </span>
            <span v-else-if="p.def.control && p.def.control.kind !== 'toggle'" :style="grid('1fr 1fr 1fr')">
              <NumberField
                v-for="key in BOUNDS"
                :key="key"
                :label="`${p.name} ${BOUND_WORDS[key]}`"
                :unit="boundUnit(p.def)"
                :unitless="!boundUnit(p.def)"
                size="sm"
                commit="change"
                nullable
                :style="FILL"
                :placeholder="key"
                :validate="key === 'step' ? stepProblem : undefined"
                :model-value="boundOf(p.def.control, key)"
                @update:model-value="setBound(p.name, p.def.control, key, $event)"
                @error="show(`${p.name}.${key}`, $event && `${p.name} ${BOUND_WORDS[key]}: ${$event}`)"
              />
            </span>
            <span v-else style="opacity: 0.5">{{ p.def.control?.kind === "toggle" ? "0 or 1" : "any value" }}</span>
            <Select
              :label="`${p.name} group`"
              size="sm"
              :style="FILL"
              :options="groupOptions"
              :model-value="p.def.group ?? ''"
              @update:model-value="store.setParamMeta(p.name, { group: $event || null })"
            />
            <span :id="hideLabel(i)" class="sr-only">{{ p.name }} Hide</span>
            <Checkbox
              :labelledby="hideLabel(i)"
              :model-value="!!p.def.hidden"
              @update:model-value="store.setParamMeta(p.name, { hidden: $event })"
            />
          </template>
        </div>

        <div :style="section">Groups</div>
        <div :style="grid('1fr auto')">
          <template v-for="g in groups" :key="g.id">
            <TextField
              :label="`Name of group ${g.name}`"
              size="sm"
              commit="change"
              :style="FILL"
              :model-value="g.name"
              @update:model-value="renameGroup(g.id, $event)"
            />
            <IconButton
              icon="close"
              :icon-size="13"
              size="sm"
              variant="plain"
              :tip="`Delete group ${g.name}, its parameters become ungrouped`"
              @click="removeGroup(g.id)"
            />
          </template>
          <TextField
            v-model="newGroup"
            label="New group name"
            size="sm"
            :style="FILL"
            placeholder="new group"
            @keydown.enter="addGroup()"
          />
          <IconButton icon="plus" :icon-size="13" size="sm" variant="plain" tip="Add group" @click="addGroup()" />
        </div>

        <div :style="section">Configurations</div>
        <div :style="grid('1fr auto auto auto')">
          <template v-for="c in configs" :key="c.id">
            <TextField
              :label="`Name of configuration ${c.name}`"
              size="sm"
              commit="change"
              :style="FILL"
              :title="configTitle(c.values)"
              :model-value="c.name"
              @update:model-value="renameConfig(c.id, $event)"
            />
            <Button class="xp-apply" size="sm" :aria-label="`Apply ${c.name}`" @click="applyConfig(c.id)">Apply</Button>
            <Button
              size="sm"
              tip="Overwrite with the values the parameters have now"
              :aria-label="`Update ${c.name}`"
              @click="updateConfig(c.id, c.name)"
              >Update</Button
            >
            <IconButton
              icon="close"
              :icon-size="13"
              size="sm"
              variant="plain"
              :tip="`Delete ${c.name}`"
              @click="removeConfig(c.id)"
            />
          </template>
          <TextField
            v-model="newConfig"
            label="New configuration name"
            size="sm"
            :style="FILL"
            placeholder="save the current values as…"
            @keydown.enter="saveConfig()"
          />
          <Button size="sm" style="grid-column: span 3; justify-self: start" @click="saveConfig()">Save</Button>
        </div>

        <div :style="section">Checks</div>
        <div class="measure-hint" style="margin-bottom: 4px"
          >A rule that must hold, like gap &gt;= 0.3. When it does not, the Parameters section shows its message.</div
        >
        <div :style="grid('auto 1.2fr 1.6fr 0.8fr auto')">
          <template v-for="(c, i) in checks" :key="c.check.id">
            <Icon
              :name="c.result?.ok ? 'check' : 'warning'"
              :size="13"
              :style="{ color: checkTone(c) }"
              :title="c.result?.error ?? (c.result?.ok ? 'holds' : 'does not hold')"
              :label="c.result?.error ?? (c.result?.ok ? 'holds' : 'does not hold')"
            />
            <TextField
              :label="`Check ${i + 1} rule`"
              size="sm"
              commit="change"
              :style="FILL"
              :validate="(raw) => exprProblem(`check.${c.check.id}`, raw)"
              :model-value="c.check.expr"
              @update:model-value="editCheck(c.check.id, { expr: $event.trim() })"
            />
            <TextField
              :label="`Check ${i + 1} message`"
              size="sm"
              commit="change"
              :style="FILL"
              :model-value="c.check.message"
              @update:model-value="editCheck(c.check.id, { message: $event.trim() })"
            />
            <Select
              :label="`Check ${i + 1} level`"
              size="sm"
              :style="FILL"
              :options="LEVELS"
              :model-value="c.check.level"
              @update:model-value="editCheck(c.check.id, { level: $event })"
            />
            <IconButton
              icon="close"
              :icon-size="13"
              size="sm"
              variant="plain"
              :tip="`Delete check ${i + 1}`"
              @click="removeCheck(c.check.id)"
            />
          </template>
          <span></span>
          <TextField
            v-model="newCheck.expr"
            class="xp-new-check-expr"
            label="New check rule"
            size="sm"
            :style="FILL"
            placeholder="gap >= 0.3"
          />
          <TextField
            v-model="newCheck.message"
            label="New check message"
            size="sm"
            :style="FILL"
            placeholder="gap below 0.3 mm fuses"
            @keydown.enter="addCheck()"
          />
          <Select v-model="newCheck.level" label="New check level" size="sm" :style="FILL" :options="LEVELS" />
          <IconButton icon="plus" :icon-size="13" size="sm" variant="plain" tip="Add check" @click="addCheck()" />
        </div>
      </template>
      <div class="measure-hint" style="margin-top: 10px"
        >Saved with the document · Ctrl Z undoes any change here · Esc to close</div
      >
    </div>
  </FloatingPanel>
</template>
