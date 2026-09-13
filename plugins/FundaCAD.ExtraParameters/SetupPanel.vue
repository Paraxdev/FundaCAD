<script setup lang="ts">
// Parameter setup: how each parameter is edited, the groups it is filed in, the
// named configurations, and the checks. Everything here edits the DOCUMENT
// (ParamDef.control/group/hidden and paramExtras), so it saves with the file,
// undoes like any edit, and survives the plugin being switched off.

import { computed, ref } from "vue";
import {
  captureConfiguration, checkResults, evalExpr, toast, useDocValue, useEngine,
} from "fundacad";
import type { ParamCheck, ParamControl } from "fundacad";
import { FloatingPanel, Icon } from "fundacad/ui";
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

const KINDS: { kind: ParamControl["kind"]; label: string }[] = [
  { kind: "number", label: "Number" },
  { kind: "slider", label: "Slider" },
  { kind: "toggle", label: "Toggle" },
  { kind: "choice", label: "Choice" },
];

// --- controls ------------------------------------------------------------------

function setKind(name: string, kind: ParamControl["kind"], value: number, current?: ParamControl) {
  store.setParamMeta(name, { control: kind === "number" && !current ? null : convertControl(current, kind, value) });
}

/** A range field left empty removes that bound, except on a slider, which
 *  cannot be drawn without both ends. */
function setBound(name: string, control: ParamControl, key: "min" | "max" | "step", raw: string) {
  if (control.kind !== "number" && control.kind !== "slider") return;
  const next = { ...control } as Record<string, unknown>;
  if (raw.trim() === "") {
    if (control.kind === "slider" && key !== "step") return toast(`a slider needs a ${key}`, { kind: "warning" });
    delete next[key];
  } else {
    const v = Number(raw);
    if (!Number.isFinite(v) || (key === "step" && v <= 0)) return toast(`${key} must be a ${key === "step" ? "positive " : ""}number`, { kind: "warning" });
    next[key] = v;
  }
  const lo = next["min"] as number | undefined;
  const hi = next["max"] as number | undefined;
  if (lo !== undefined && hi !== undefined && lo >= hi) return toast("min must be below max", { kind: "warning" });
  store.setParamMeta(name, { control: next as ParamControl });
}

function setChoices(name: string, raw: string) {
  const parsed = parseChoices(raw);
  if (typeof parsed === "string") return toast(parsed, { kind: "warning" });
  store.setParamMeta(name, { control: { kind: "choice", choices: parsed } });
}

// --- groups --------------------------------------------------------------------

const newGroup = ref("");
function addGroup() {
  const name = newGroup.value.trim();
  if (!name) return;
  store.updateParamExtras((x) => {
    const list = (x.groups ??= []);
    list.push({ id: nextId("g", list.map((g) => g.id)), name });
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

// --- configurations --------------------------------------------------------------

const newConfig = ref("");
function saveConfig() {
  const name = newConfig.value.trim();
  if (!name) return;
  const id = nextId("c", configs.value.map((c) => c.id));
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

// --- checks ----------------------------------------------------------------------

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
  if (!expr.trim() || !message.trim()) return toast("a check needs a rule and a message", { kind: "warning" });
  const err = exprError(expr);
  if (err) return toast(`${expr}: ${err}`, { kind: "warning" });
  store.updateParamExtras((x) => {
    const list = (x.checks ??= []);
    list.push({ id: nextId("k", list.map((c) => c.id)), expr: expr.trim(), message: message.trim(), level });
  });
  newCheck.value = { expr: "", message: "", level: "warning" };
}
function editCheck(id: string, patch: Partial<ParamCheck>) {
  if (patch.expr !== undefined) {
    const err = exprError(patch.expr);
    if (err) return toast(`${patch.expr}: ${err}`, { kind: "warning" });
  }
  store.updateParamExtras((x) => {
    const c = x.checks?.find((y) => y.id === id);
    if (c) Object.assign(c, patch);
  });
}
function removeCheck(id: string) {
  store.updateParamExtras((x) => void (x.checks = (x.checks ?? []).filter((c) => c.id !== id)));
}

const val = (e: Event) => (e.target as HTMLInputElement).value;
const empty = computed(() => params.value.length === 0);

const section = { margin: "12px 0 4px", fontWeight: "600", opacity: "0.8" };
const grid = (cols: string) => ({ display: "grid", gridTemplateColumns: cols, gap: "4px 6px", alignItems: "center" });
const input = { minWidth: "0", font: "inherit" };
const iconBtn = { background: "none", border: "none", color: "inherit", cursor: "pointer", padding: "0 2px" };
</script>

<template>
  <FloatingPanel :open="setupOpen" close-on-esc panel-class="xp-setup-panel" @close="setupOpen = false">
    <div class="measure-title">Parameter Setup</div>
    <div style="max-height: 70vh; overflow: auto; padding-right: 4px; min-width: 560px">
      <div v-if="empty" class="measure-hint">Add a user parameter first (Modify, Parameters).</div>

      <template v-else>
        <div :style="section">Controls</div>
        <div :style="grid('1.2fr 0.9fr 2.4fr 1fr auto')">
          <span style="opacity: 0.6">Name</span><span style="opacity: 0.6">Control</span>
          <span style="opacity: 0.6">Range or choices</span><span style="opacity: 0.6">Group</span>
          <span style="opacity: 0.6" title="Hidden from the Parameters section">Hide</span>
          <template v-for="p in params" :key="p.name">
            <span :title="`${p.def.expr} = ${p.def.value}`" :style="{ opacity: p.def.hidden ? 0.5 : 1 }">{{ p.name }}</span>
            <select
              class="xp-kind"
              :data-param="p.name"
              :style="input"
              :value="p.def.control?.kind ?? 'number'"
              @change="setKind(p.name, val($event) as ParamControl['kind'], p.def.value, p.def.control)"
            >
              <option v-for="k in KINDS" :key="k.kind" :value="k.kind">{{ k.label }}</option>
            </select>
            <span v-if="p.def.control?.kind === 'choice'">
              <input
                :style="{ ...input, width: '100%' }"
                :value="formatChoices(p.def.control.choices)"
                placeholder="Small = 10, Large = 30"
                @change="setChoices(p.name, val($event))"
              />
            </span>
            <span v-else-if="p.def.control && p.def.control.kind !== 'toggle'" :style="grid('1fr 1fr 1fr')">
              <input :style="input" :value="p.def.control.min ?? ''" placeholder="min" @change="setBound(p.name, p.def.control, 'min', val($event))" />
              <input :style="input" :value="p.def.control.max ?? ''" placeholder="max" @change="setBound(p.name, p.def.control, 'max', val($event))" />
              <input :style="input" :value="p.def.control.step ?? ''" placeholder="step" @change="setBound(p.name, p.def.control, 'step', val($event))" />
            </span>
            <span v-else style="opacity: 0.5">{{ p.def.control?.kind === "toggle" ? "0 or 1" : "any value" }}</span>
            <select
              :style="input"
              :value="p.def.group ?? ''"
              @change="store.setParamMeta(p.name, { group: val($event) || null })"
            >
              <option value="">none</option>
              <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
            <input
              type="checkbox"
              :checked="!!p.def.hidden"
              @change="store.setParamMeta(p.name, { hidden: ($event.target as HTMLInputElement).checked })"
            />
          </template>
        </div>

        <div :style="section">Groups</div>
        <div :style="grid('1fr auto')">
          <template v-for="g in groups" :key="g.id">
            <input :style="input" :value="g.name" @change="renameGroup(g.id, val($event))" />
            <button :style="iconBtn" :title="`Delete ${g.name}, its parameters become ungrouped`" @click="removeGroup(g.id)">
              <Icon name="close" :size="13" />
            </button>
          </template>
          <input v-model="newGroup" :style="input" placeholder="new group" @keydown.enter="addGroup()" />
          <button :style="iconBtn" title="Add group" @click="addGroup()"><Icon name="plus" :size="13" /></button>
        </div>

        <div :style="section">Configurations</div>
        <div :style="grid('1fr auto auto auto')">
          <template v-for="c in configs" :key="c.id">
            <input
              :style="input"
              :value="c.name"
              :title="Object.entries(c.values).map(([n, e]) => `${n} = ${e}`).join('\n')"
              @change="renameConfig(c.id, val($event))"
            />
            <button class="xp-apply" @click="applyConfig(c.id)">Apply</button>
            <button title="Overwrite with the values the parameters have now" @click="updateConfig(c.id, c.name)">Update</button>
            <button :style="iconBtn" :title="`Delete ${c.name}`" @click="removeConfig(c.id)"><Icon name="close" :size="13" /></button>
          </template>
          <input v-model="newConfig" :style="input" placeholder="save the current values as…" @keydown.enter="saveConfig()" />
          <button style="grid-column: span 3; justify-self: start" @click="saveConfig()">Save</button>
        </div>

        <div :style="section">Checks</div>
        <div class="measure-hint" style="margin-bottom: 4px">A rule that must hold, like gap &gt;= 0.3. When it does not, the Parameters section shows its message.</div>
        <div :style="grid('auto 1.2fr 1.6fr 0.8fr auto')">
          <template v-for="c in checks" :key="c.check.id">
            <Icon
              :name="c.result?.ok ? 'check' : 'warning'"
              :size="13"
              :style="{ color: c.result?.ok ? '#3ba55d' : c.check.level === 'error' ? '#e24a3b' : '#d2a83b' }"
              :title="c.result?.error ?? (c.result?.ok ? 'holds' : 'does not hold')"
            />
            <input :style="input" :value="c.check.expr" @change="editCheck(c.check.id, { expr: val($event).trim() })" />
            <input :style="input" :value="c.check.message" @change="editCheck(c.check.id, { message: val($event).trim() })" />
            <select :style="input" :value="c.check.level" @change="editCheck(c.check.id, { level: val($event) as ParamCheck['level'] })">
              <option value="warning">Warning</option>
              <option value="error">Error</option>
            </select>
            <button :style="iconBtn" title="Delete check" @click="removeCheck(c.check.id)"><Icon name="close" :size="13" /></button>
          </template>
          <span></span>
          <input v-model="newCheck.expr" class="xp-new-check-expr" :style="input" placeholder="gap >= 0.3" />
          <input v-model="newCheck.message" :style="input" placeholder="gap below 0.3 mm fuses" @keydown.enter="addCheck()" />
          <select v-model="newCheck.level" :style="input">
            <option value="warning">Warning</option>
            <option value="error">Error</option>
          </select>
          <button :style="iconBtn" title="Add check" @click="addCheck()"><Icon name="plus" :size="13" /></button>
        </div>
      </template>
      <div class="measure-hint" style="margin-top: 10px">Saved with the document · Ctrl Z undoes any change here · Esc to close</div>
    </div>
  </FloatingPanel>
</template>
