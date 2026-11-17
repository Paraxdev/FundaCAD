<script setup lang="ts">
// Everything here edits the document (ParamDef.control/group/hidden and paramExtras), so it saves with the file,
// undoes like any edit, and survives the plugin being switched off.

import { computed, onBeforeUnmount, reactive, ref, useId, watch } from "vue";
import {
  captureConfiguration,
  checkResults,
  evalExpr,
  shownExpr,
  spellNumber,
  storedExpr,
  toast,
  useDocValue,
  useEngine,
} from "fundacad";
import type { ParamCheck, ParamControl, ParamDef } from "fundacad";
import { Button, Checkbox, FloatingPanel, Icon, IconButton, NumberField, Select, TextField } from "fundacad/ui";
import { setupOpen } from "./state";
import { t } from "./lines";
import { choiceSeparator, convertControl, formatChoices, nextId, parseChoices, uniqueGroups } from "./view";

const store = useEngine().store;

/** Knobs first, hidden helpers after them, each in table order. */
const params = useDocValue((doc) =>
  Object.entries(doc.paramDefs ?? {})
    .filter(([, d]) => !d.target)
    .map(([name, def]) => ({ name, def }))
    .sort((a, b) => Number(!!a.def.hidden) - Number(!!b.def.hidden)),
);
const groups = useDocValue((doc) => uniqueGroups(doc.paramExtras?.groups));
const configs = useDocValue((doc) => doc.paramExtras?.configurations ?? []);
const checks = useDocValue((doc) => {
  const results = new Map(checkResults(doc).map((r) => [r.check.id, r]));
  return (doc.paramExtras?.checks ?? []).map((c) => ({ check: c, result: results.get(c.id) }));
});

const kinds = computed<{ value: ParamControl["kind"]; label: string }[]>(() => [
  { value: "number", label: t("setup.kindNumber") },
  { value: "slider", label: t("setup.kindSlider") },
  { value: "toggle", label: t("setup.kindToggle") },
  { value: "choice", label: t("setup.kindChoice") },
]);
const levels = computed<{ value: ParamCheck["level"]; label: string }[]>(() => [
  { value: "warning", label: t("setup.levelWarning") },
  { value: "error", label: t("setup.levelError") },
]);
const BOUNDS = ["min", "max", "step"] as const;
type Bound = (typeof BOUNDS)[number];
const boundLabel = (name: string, key: Bound) =>
  key === "min" ? t("setup.minOf", { name }) : key === "max" ? t("setup.maxOf", { name }) : t("setup.stepOf", { name });
const boundWord = (key: Bound) => (key === "min" ? t("setup.min") : key === "max" ? t("setup.max") : t("setup.step"));

// What is wrong, as alerts on the panel: a refused edit used to be a toast, which a screen reader never reached. A
// field's own refusal is spoken by the field as well, so it is only shown here.
const problems = reactive<Record<string, string | null>>({});
const shownProblems = computed(() => Object.values(problems).filter((why): why is string => !!why));
function show(key: string, why: string | null) {
  problems[key] = why;
}
function fail(why: string) {
  show("panel", why);
}
const clear = () => show("panel", null);

const uid = useId();

// The panel is capped to the span between the rail and the right cards, which a plugin has no stylesheet to query, so
// below this width the table rows fold onto several lines.
const STACK_BELOW = 560;
const scroller = ref<HTMLElement | null>(null);
const stacked = ref(false);
let widthWatch: ResizeObserver | null = null;
let restack = 0;
const stopWatching = () => {
  widthWatch?.disconnect();
  widthWatch = null;
  cancelAnimationFrame(restack);
  restack = 0;
};
watch(scroller, (el) => {
  stopWatching();
  if (!el) return;
  stacked.value = el.offsetWidth < STACK_BELOW;
  // Restacking changes the layout, so doing it inside the callback makes WebKit report a ResizeObserver loop error.
  widthWatch = new ResizeObserver(() => {
    if (restack) return;
    restack = requestAnimationFrame(() => {
      restack = 0;
      stacked.value = el.offsetWidth < STACK_BELOW;
    });
  });
  widthWatch.observe(el);
});
onBeforeUnmount(stopWatching);

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
    if (control.kind === "slider" && key !== "step") {
      return fail(key === "min" ? t("setup.sliderNeedsMin") : t("setup.sliderNeedsMax"));
    }
    delete next[key];
  } else {
    next[key] = v;
  }
  const lo = next["min"] as number | undefined;
  const hi = next["max"] as number | undefined;
  if (lo !== undefined && hi !== undefined && lo >= hi) return fail(t("setup.minBelowMax"));
  store.setParamMeta(name, { control: next as ParamControl });
}

const boundOf = (control: ParamControl, key: Bound): number | null =>
  control.kind === "number" || control.kind === "slider" ? (control[key] ?? null) : null;
const boundUnit = (def: ParamDef) => (def.unit === "mm" ? "mm" : def.unit === "deg" ? "deg" : null);
const stepProblem = (v: number) => (v <= 0 ? t("setup.stepPositive") : null);

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
    evalExpr(storedExpr(expr), values);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function addCheck() {
  const { expr, message, level } = newCheck.value;
  if (!expr.trim() || !message.trim()) return fail(t("setup.checkNeeds"));
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
      expr: storedExpr(expr.trim()),
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
  const stored = patch.expr === undefined ? patch : { ...patch, expr: storedExpr(patch.expr) };
  store.updateParamExtras((x) => {
    const c = x.checks?.find((y) => y.id === id);
    if (c) Object.assign(c, stored);
  });
}
function removeCheck(id: string) {
  store.updateParamExtras((x) => void (x.checks = (x.checks ?? []).filter((c) => c.id !== id)));
}

const empty = computed(() => params.value.length === 0);
const groupOptions = computed(() => [
  { value: "", label: stacked.value ? t("setup.noGroup") : t("setup.noGroupShort") },
  ...groups.value.map((g) => ({ value: g.id, label: g.name })),
]);
const configTitle = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([n, e]) => `${n} = ${shownExpr(e)}`)
    .join("\n");
const hideLabel = (i: number) => `${uid}-hide-${i}`;
const checkTone = (c: { result?: { ok: boolean } | undefined; check: ParamCheck }) =>
  c.result?.ok ? "var(--ok)" : c.check.level === "error" ? "var(--error)" : "var(--warn)";

const section = { margin: "12px 0 4px", fontWeight: "600", opacity: "0.8" };
const grid = (cols: string) => ({ display: "grid", gridTemplateColumns: cols, gap: "4px 6px", alignItems: "center" });
const FILL = { width: "100%", minWidth: "0" };
const ROW = { display: "contents" };
const BLOCKS = { display: "grid", gap: "6px" };
const block = (cols: string) => ({
  ...grid(cols),
  padding: "6px 8px",
  background: "var(--float-tile-bg)",
  borderRadius: "var(--float-chip-radius)",
  cornerShape: "squircle",
});
const PARAM_BLOCK = block("minmax(0, 1fr) minmax(0, 1fr)");
const CHECK_BLOCK = block("13px minmax(0, 1fr) auto");
const lineFrom = (col: number) => (stacked.value ? { gridColumn: `${col} / -1` } : {});
const PROBLEM = { color: "var(--error)", fontSize: "var(--fs-small)", margin: "0 0 4px" };
</script>

<template>
  <FloatingPanel
    :open="setupOpen"
    :title="t('setup.title')"
    close-on-esc
    panel-class="xp-setup-panel"
    @close="setupOpen = false"
  >
    <div class="measure-title" aria-hidden="true">{{ t("setup.title") }}</div>
    <div v-for="why in shownProblems" :key="why" role="alert" :style="PROBLEM">{{ why }}</div>
    <div ref="scroller" style="max-height: 70vh; overflow: auto; padding-right: 4px; width: 680px; max-width: 100%">
      <div v-if="empty" class="measure-hint">{{ t("setup.empty") }}</div>

      <template v-else>
        <div :style="section">{{ t("setup.controls") }}</div>
        <div :style="stacked ? BLOCKS : grid('1fr 1.1fr 2.9fr 1fr auto')">
          <template v-if="!stacked">
            <span aria-hidden="true" style="opacity: 0.6">{{ t("setup.colName") }}</span>
            <span aria-hidden="true" style="opacity: 0.6">{{ t("setup.colControl") }}</span>
            <span aria-hidden="true" style="opacity: 0.6">{{ t("setup.colRange") }}</span>
            <span aria-hidden="true" style="opacity: 0.6">{{ t("setup.colGroup") }}</span>
            <span aria-hidden="true" style="opacity: 0.6" :title="t('setup.colHideTip')">{{ t("setup.colHide") }}</span>
          </template>
          <div v-for="(p, i) in params" :key="p.name" class="xp-param" :style="stacked ? PARAM_BLOCK : ROW">
            <span
              :title="`${shownExpr(p.def.expr)} = ${spellNumber(p.def.value)}`"
              :style="{
                opacity: p.def.hidden ? 0.5 : 1,
                overflowWrap: stacked ? 'anywhere' : undefined,
                fontWeight: stacked ? 600 : undefined,
              }"
              >{{ p.name }}</span
            >
            <Select
              class="xp-kind"
              :data-param="p.name"
              :label="t('setup.controlOf', { name: p.name })"
              size="sm"
              :style="FILL"
              :options="kinds"
              :model-value="p.def.control?.kind ?? 'number'"
              @update:model-value="setKind(p.name, $event, p.def.value, p.def.control)"
            />
            <div class="xp-range" :style="{ minWidth: 0, ...lineFrom(1) }">
              <TextField
                v-if="p.def.control?.kind === 'choice'"
                :label="t('setup.choicesOf', { name: p.name })"
                size="sm"
                commit="change"
                :style="FILL"
                :placeholder="t('choices.placeholder', { sep: choiceSeparator() })"
                :validate="(raw) => choicesProblem(`${p.name}.choices`, raw)"
                :model-value="formatChoices(p.def.control.choices)"
                @update:model-value="setChoices(p.name, $event)"
              />
              <div v-else-if="p.def.control && p.def.control.kind !== 'toggle'" :style="grid('1fr 1fr 1fr')">
                <NumberField
                  v-for="key in BOUNDS"
                  :key="key"
                  :label="boundLabel(p.name, key)"
                  :unit="boundUnit(p.def)"
                  :unitless="!boundUnit(p.def)"
                  size="sm"
                  commit="change"
                  nullable
                  :style="FILL"
                  :placeholder="boundWord(key)"
                  :validate="key === 'step' ? stepProblem : undefined"
                  :model-value="boundOf(p.def.control, key)"
                  @update:model-value="setBound(p.name, p.def.control, key, $event)"
                  @error="
                    show(
                      `${p.name}.${key}`,
                      $event && t('setup.problemOf', { what: boundLabel(p.name, key), why: $event }),
                    )
                  "
                />
              </div>
              <span v-else style="opacity: 0.5">{{
                p.def.control?.kind === "toggle" ? t("setup.zeroOrOne") : t("setup.anyValue")
              }}</span>
            </div>
            <Select
              :label="t('setup.groupOf', { name: p.name })"
              size="sm"
              :style="FILL"
              :options="groupOptions"
              :model-value="p.def.group ?? ''"
              @update:model-value="store.setParamMeta(p.name, { group: $event || null })"
            />
            <span :id="hideLabel(i)" class="sr-only">{{ t("setup.hideOf", { name: p.name }) }}</span>
            <Checkbox
              :labelledby="hideLabel(i)"
              :model-value="!!p.def.hidden"
              @update:model-value="store.setParamMeta(p.name, { hidden: $event })"
            >
              <template v-if="stacked" #default>{{ t("setup.colHide") }}</template>
            </Checkbox>
          </div>
        </div>

        <div :style="section">{{ t("setup.groups") }}</div>
        <div :style="grid('1fr auto')">
          <template v-for="g in groups" :key="g.id">
            <TextField
              :label="t('setup.groupName', { name: g.name })"
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
              :tip="t('setup.groupDelete', { name: g.name })"
              @click="removeGroup(g.id)"
            />
          </template>
          <TextField
            v-model="newGroup"
            :label="t('setup.groupNew')"
            size="sm"
            :style="FILL"
            :placeholder="t('setup.groupNewPlaceholder')"
            @keydown.enter="addGroup()"
          />
          <IconButton
            icon="plus"
            :icon-size="13"
            size="sm"
            variant="plain"
            :tip="t('setup.groupAdd')"
            @click="addGroup()"
          />
        </div>

        <div :style="section">{{ t("setup.configs") }}</div>
        <div :style="grid(stacked ? 'auto auto minmax(0, 1fr) auto' : '1fr auto auto auto')">
          <template v-for="c in configs" :key="c.id">
            <TextField
              :label="t('setup.configName', { name: c.name })"
              size="sm"
              commit="change"
              :style="{ ...FILL, ...lineFrom(1) }"
              :title="configTitle(c.values)"
              :model-value="c.name"
              @update:model-value="renameConfig(c.id, $event)"
            />
            <Button
              class="xp-apply"
              size="sm"
              :aria-label="t('setup.applyOf', { name: c.name })"
              @click="applyConfig(c.id)"
              >{{ t("setup.apply") }}</Button
            >
            <Button
              size="sm"
              :tip="t('setup.updateTip')"
              :aria-label="t('setup.updateOf', { name: c.name })"
              @click="updateConfig(c.id, c.name)"
              >{{ t("setup.update") }}</Button
            >
            <IconButton
              icon="close"
              :icon-size="13"
              size="sm"
              variant="plain"
              :tip="t('setup.configDelete', { name: c.name })"
              @click="removeConfig(c.id)"
            />
          </template>
          <TextField
            v-model="newConfig"
            :label="t('setup.configNew')"
            size="sm"
            :style="{ ...FILL, ...lineFrom(1) }"
            :placeholder="t('setup.configNewPlaceholder')"
            @keydown.enter="saveConfig()"
          />
          <Button size="sm" style="grid-column: span 3; justify-self: start" @click="saveConfig()">{{
            t("setup.save")
          }}</Button>
        </div>

        <div :style="section">{{ t("setup.checks") }}</div>
        <div class="measure-hint" style="margin-bottom: 4px">{{ t("setup.checkHint") }}</div>
        <div :style="stacked ? BLOCKS : grid('auto 1.2fr 1.6fr 0.8fr auto')">
          <div v-for="(c, i) in checks" :key="c.check.id" :style="stacked ? CHECK_BLOCK : ROW">
            <Icon
              :name="c.result?.ok ? 'check' : 'warning'"
              :size="13"
              :style="{ color: checkTone(c) }"
              :title="c.result?.error ?? (c.result?.ok ? t('check.holds') : t('check.fails'))"
              :label="c.result?.error ?? (c.result?.ok ? t('check.holds') : t('check.fails'))"
            />
            <TextField
              :label="t('setup.checkRule', { n: i + 1 })"
              size="sm"
              commit="change"
              :style="{ ...FILL, ...lineFrom(2) }"
              :validate="(raw) => exprProblem(`check.${c.check.id}`, raw)"
              :model-value="shownExpr(c.check.expr)"
              @update:model-value="editCheck(c.check.id, { expr: $event.trim() })"
            />
            <TextField
              :label="t('setup.checkMessage', { n: i + 1 })"
              size="sm"
              commit="change"
              :style="{ ...FILL, ...lineFrom(2) }"
              :model-value="c.check.message"
              @update:model-value="editCheck(c.check.id, { message: $event.trim() })"
            />
            <Select
              :label="t('setup.checkLevel', { n: i + 1 })"
              size="sm"
              :style="{ ...FILL, gridColumn: stacked ? 2 : undefined }"
              :options="levels"
              :model-value="c.check.level"
              @update:model-value="editCheck(c.check.id, { level: $event })"
            />
            <IconButton
              icon="close"
              :icon-size="13"
              size="sm"
              variant="plain"
              :tip="t('setup.checkDelete', { n: i + 1 })"
              @click="removeCheck(c.check.id)"
            />
          </div>
          <div :style="stacked ? CHECK_BLOCK : ROW">
            <span></span>
            <TextField
              v-model="newCheck.expr"
              class="xp-new-check-expr"
              :label="t('setup.checkNewRule')"
              size="sm"
              :style="{ ...FILL, ...lineFrom(2) }"
              :placeholder="t('setup.checkRulePlaceholder')"
            />
            <TextField
              v-model="newCheck.message"
              :label="t('setup.checkNewMessage')"
              size="sm"
              :style="{ ...FILL, ...lineFrom(2) }"
              :placeholder="t('setup.checkMessagePlaceholder')"
              @keydown.enter="addCheck()"
            />
            <Select
              v-model="newCheck.level"
              :label="t('setup.checkNewLevel')"
              size="sm"
              :style="{ ...FILL, gridColumn: stacked ? 2 : undefined }"
              :options="levels"
            />
            <IconButton
              icon="plus"
              :icon-size="13"
              size="sm"
              variant="plain"
              :tip="t('setup.checkAdd')"
              @click="addCheck()"
            />
          </div>
        </div>
      </template>
      <div class="measure-hint" style="margin-top: 10px">{{ t("setup.footer") }}</div>
    </div>
  </FloatingPanel>
</template>
