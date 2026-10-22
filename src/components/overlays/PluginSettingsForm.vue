<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch, type Component } from "vue";
import { settingMatches, type NumberSetting, type PluginSettings, type SettingProp } from "../../plugins/settings";
import { fmtKeys } from "../../input/platform";
import { keyCombo, numberText, parseNumberField, stepNumber, unitLabel } from "../../plugins/settingsInput";
import { getUnit, onUnitChange } from "../../ui/units";
import Icon from "../shell/Icon.vue";

const props = defineProps<{
  settings?: PluginSettings | undefined;
  component?: Component | undefined;
  title?: string | undefined;
  query?: string;
}>();

const values = shallowRef<Record<string, unknown>>(props.settings?.all() ?? {});
const unit = ref(getUnit());
/** typed text not yet stored, and why, per key */
const drafts = ref<Record<string, string>>({});
const errors = ref<Record<string, string>>({});
const capturing = ref("");

let off: (() => void) | null = null;
watch(
  () => props.settings,
  (s) => {
    off?.();
    off =
      s?.onChange(() => {
        values.value = s.all();
      }) ?? null;
    values.value = s?.all() ?? {};
  },
  { immediate: true },
);
const offUnit = onUnitChange(() => {
  unit.value = getUnit();
});
onUnmounted(() => {
  off?.();
  offUnit();
});

const visible = computed(() =>
  (props.settings?.schema.props ?? []).filter(
    (p) => p.type !== "data" && settingMatches(p, props.query ?? "") && (p.visibleWhen?.(values.value) ?? true),
  ),
);

const groups = computed(() => {
  const out = new Map<string, SettingProp[]>();
  for (const p of visible.value) {
    const g = out.get(p.group ?? "") ?? [];
    g.push(p);
    out.set(p.group ?? "", g);
  }
  return [...out.entries()];
});

const id = (p: SettingProp) => `plugset-${props.settings?.pluginId}-${p.key}`;

function store(p: SettingProp, v: unknown) {
  const problem = props.settings!.set(p.key, v);
  const next = { ...errors.value };
  if (problem) next[p.key] = problem;
  else delete next[p.key];
  errors.value = next;
}

const shownNumber = (p: NumberSetting) =>
  drafts.value[p.key] ?? numberText(p, values.value[p.key] as number, unit.value);

function typeNumber(p: NumberSetting, raw: string) {
  drafts.value = { ...drafts.value, [p.key]: raw };
  const r = parseNumberField(p, raw, unit.value);
  errors.value = "error" in r ? { ...errors.value, [p.key]: r.error } : withoutKey(errors.value, p.key);
}

function commitNumber(p: NumberSetting) {
  const raw = drafts.value[p.key];
  if (raw === undefined) return;
  const r = parseNumberField(p, raw, unit.value);
  if ("error" in r) return;
  drafts.value = withoutKey(drafts.value, p.key);
  store(p, r.value);
}

function arrowNumber(p: NumberSetting, ev: KeyboardEvent) {
  const draft = drafts.value[p.key];
  const typed = draft === undefined ? null : parseNumberField(p, draft, unit.value);
  const from = typed && "value" in typed ? typed.value : (values.value[p.key] as number);
  const next = stepNumber(p, from, (ev.key === "ArrowUp" ? 1 : -1) * (ev.shiftKey ? 10 : 1));
  if (next === null) return;
  ev.preventDefault();
  drafts.value = withoutKey(drafts.value, p.key);
  store(p, next);
}

function withoutKey<T>(o: Record<string, T>, k: string): Record<string, T> {
  const next = { ...o };
  delete next[k];
  return next;
}

function onKey(p: SettingProp, ev: KeyboardEvent) {
  if (ev.key === "Tab") return;
  ev.preventDefault();
  ev.stopPropagation();
  if (ev.key === "Escape") {
    capturing.value = "";
    (ev.target as HTMLElement).blur();
    return;
  }
  if (ev.key === "Backspace" || ev.key === "Delete") {
    store(p, "");
    return;
  }
  const combo = keyCombo(ev);
  if (combo) {
    store(p, combo);
    capturing.value = "";
    (ev.target as HTMLElement).blur();
  }
}

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function pickFile(p: SettingProp & { extensions?: readonly string[] }) {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const exts = p.extensions ? [...p.extensions] : undefined;
  const picked = await open({
    multiple: false,
    ...(exts ? { filters: [{ name: p.label ?? p.key, extensions: exts }] } : {}),
  });
  if (typeof picked === "string") store(p, picked);
}

function reset(p: SettingProp) {
  drafts.value = withoutKey(drafts.value, p.key);
  errors.value = withoutKey(errors.value, p.key);
  props.settings!.reset(p.key);
}

const isDefault = (p: SettingProp) => {
  void values.value;
  return props.settings!.isDefault(p.key);
};
</script>

<template>
  <div class="plugset" :data-plugin-settings-form="settings?.pluginId">
    <div v-if="title" class="plugset-title">{{ title }}</div>
    <template v-for="[group, list] in groups" :key="group">
      <div v-if="group" class="plugset-group">{{ group }}</div>
      <div v-for="p in list" :key="p.key" class="pref-card plugset-row" :data-setting="p.key">
        <div class="pref-head">
          <label class="pref-title" :for="id(p)">{{ p.label }}</label>
          <div class="plugset-control">
            <span v-if="p.type === 'boolean'" class="param-switch">
              <input
                :id="id(p)"
                type="checkbox"
                :checked="values[p.key] === true"
                @change="store(p, ($event.target as HTMLInputElement).checked)"
              />
              <span class="track"><span class="knob"></span></span>
            </span>

            <template v-else-if="p.type === 'number'">
              <input
                :id="id(p)"
                class="plugset-num"
                :class="{ invalid: errors[p.key] }"
                type="text"
                inputmode="decimal"
                spellcheck="false"
                :value="shownNumber(p)"
                :aria-invalid="!!errors[p.key]"
                @input="typeNumber(p, ($event.target as HTMLInputElement).value)"
                @change="commitNumber(p)"
                @keydown.enter="commitNumber(p)"
                @keydown.up="arrowNumber(p, $event)"
                @keydown.down="arrowNumber(p, $event)"
              />
              <span v-if="unitLabel(p, unit)" class="plugset-unit">{{ unitLabel(p, unit) }}</span>
            </template>

            <select
              v-else-if="p.type === 'enum'"
              :id="id(p)"
              class="plugset-select"
              :value="values[p.key]"
              @change="store(p, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="o in p.options" :key="o.id" :value="o.id">{{ o.label }}</option>
            </select>

            <input
              v-else-if="p.type === 'string'"
              :id="id(p)"
              class="plugset-text"
              type="text"
              spellcheck="false"
              :maxlength="p.maxLength"
              :placeholder="p.placeholder"
              :value="values[p.key]"
              @change="store(p, ($event.target as HTMLInputElement).value)"
            />

            <input
              v-else-if="p.type === 'colour'"
              :id="id(p)"
              type="color"
              :value="values[p.key]"
              @change="store(p, ($event.target as HTMLInputElement).value)"
            />

            <button
              v-else-if="p.type === 'key'"
              :id="id(p)"
              type="button"
              class="btn plugset-key"
              @focus="capturing = p.key"
              @blur="capturing = ''"
              @keydown="onKey(p, $event)"
            >
              {{ capturing === p.key ? "Press a key…" : fmtKeys((values[p.key] as string) || "None") }}
            </button>

            <template v-else-if="p.type === 'file'">
              <input
                :id="id(p)"
                class="plugset-text"
                type="text"
                spellcheck="false"
                :value="values[p.key]"
                @change="store(p, ($event.target as HTMLInputElement).value)"
              />
              <button v-if="isTauri()" type="button" class="btn" @click="pickFile(p)">Choose</button>
            </template>

            <button
              type="button"
              class="plugset-reset"
              :class="{ hidden: isDefault(p) }"
              :disabled="isDefault(p)"
              :title="`Reset ${p.label} to its default`"
              :aria-label="`Reset ${p.label}`"
              data-setting-reset
              @click="reset(p)"
            >
              <Icon name="undo" :size="14" />
            </button>
          </div>
        </div>
        <p v-if="errors[p.key]" class="plugset-error" role="alert">{{ errors[p.key] }}</p>
        <p v-if="p.description" class="pref-hint">{{ p.description }}</p>
      </div>
    </template>
    <component :is="component" v-if="component && !query" />
  </div>
</template>

<style scoped>
.plugset {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.plugset-title,
.plugset-group {
  font-weight: 600;
  margin-top: 6px;
}
.plugset-control {
  display: flex;
  align-items: center;
  gap: 6px;
}
.plugset-num {
  width: 7em;
  text-align: right;
}
.plugset-num.invalid {
  outline: 1px solid var(--danger, #d33);
}
.plugset-text {
  width: 14em;
}
.plugset-unit {
  opacity: 0.7;
  min-width: 2em;
}
.plugset-reset {
  border: none;
  background: none;
  cursor: pointer;
  color: inherit;
  opacity: 0.8;
  width: 1.6em;
}
.plugset-reset.hidden {
  visibility: hidden;
}
.plugset-error {
  color: var(--danger, #d33);
  margin: 2px 0 0;
  font-size: 0.9em;
}
</style>
