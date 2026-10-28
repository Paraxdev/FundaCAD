<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch, type Component } from "vue";
import { settingMatches, type PluginSettings, type SettingProp } from "../../plugins/settings";
import { fmtKeys } from "../../input/platform";
import { keyCombo, numberField } from "../../plugins/settingsInput";
import { getUnit, onUnitChange } from "../../ui/units";
import Button from "../ui/Button.vue";
import Checkbox from "../ui/Checkbox.vue";
import IconButton from "../ui/IconButton.vue";
import NumberField from "../ui/NumberField.vue";
import Select from "../ui/Select.vue";
import TextField from "../ui/TextField.vue";
import UnitChip from "../ui/UnitChip.vue";

const props = defineProps<{
  settings?: PluginSettings | undefined;
  component?: Component | undefined;
  title?: string | undefined;
  query?: string;
}>();

const values = shallowRef<Record<string, unknown>>(props.settings?.all() ?? {});
const unit = ref(getUnit());
/** why typed text was not stored, per key */
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

const numbers = computed(
  () =>
    new Map(visible.value.flatMap((p) => (p.type === "number" ? [[p.key, numberField(p, unit.value)] as const] : []))),
);
const numberOf = (p: SettingProp) => numbers.value.get(p.key)!;

function store(p: SettingProp, v: unknown) {
  const problem = props.settings!.set(p.key, v);
  const next = { ...errors.value };
  if (problem) next[p.key] = problem;
  else delete next[p.key];
  errors.value = next;
}

function setError(p: SettingProp, e: string | null) {
  errors.value = e ? { ...errors.value, [p.key]: e } : withoutKey(errors.value, p.key);
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
          <label
            class="pref-title"
            :for="p.type === 'boolean' ? undefined : id(p)"
            @click="p.type === 'boolean' && store(p, values[p.key] !== true)"
            >{{ p.label }}</label
          >
          <div class="plugset-control">
            <Checkbox
              v-if="p.type === 'boolean'"
              :id="id(p)"
              :model-value="values[p.key] === true"
              :tip="p.label"
              @update:model-value="store(p, $event)"
            />

            <NumberField
              v-else-if="p.type === 'number'"
              :id="id(p)"
              class="plugset-num"
              :model-value="values[p.key] as number"
              :unit="numberOf(p).unit"
              :step="numberOf(p).step"
              :min="p.min"
              :max="p.max"
              :validate="numberOf(p).validate"
              @update:model-value="store(p, $event)"
              @error="setError(p, $event)"
            >
              <template v-if="numberOf(p).caption" #trailing>
                <UnitChip :unit="numberOf(p).caption!" />
              </template>
            </NumberField>

            <Select
              v-else-if="p.type === 'enum'"
              :id="id(p)"
              class="plugset-select"
              :model-value="String(values[p.key])"
              :options="p.options.map((o) => ({ value: o.id, label: o.label }))"
              @update:model-value="store(p, $event)"
            />

            <TextField
              v-else-if="p.type === 'string'"
              :id="id(p)"
              class="plugset-text"
              commit="change"
              spellcheck="false"
              :model-value="String(values[p.key] ?? '')"
              :maxlength="p.maxLength"
              :placeholder="p.placeholder"
              @update:model-value="store(p, $event)"
            />

            <input
              v-else-if="p.type === 'colour'"
              :id="id(p)"
              type="color"
              :value="values[p.key]"
              @change="store(p, ($event.target as HTMLInputElement).value)"
            />

            <Button
              v-else-if="p.type === 'key'"
              :id="id(p)"
              class="plugset-key"
              @focus="capturing = p.key"
              @blur="capturing = ''"
              @keydown="onKey(p, $event)"
            >
              {{ capturing === p.key ? "Press a key…" : fmtKeys((values[p.key] as string) || "None") }}
            </Button>

            <template v-else-if="p.type === 'file'">
              <TextField
                :id="id(p)"
                class="plugset-text"
                commit="change"
                spellcheck="false"
                :model-value="String(values[p.key] ?? '')"
                @update:model-value="store(p, $event)"
              />
              <Button v-if="isTauri()" @click="pickFile(p)">Choose</Button>
            </template>

            <IconButton
              class="plugset-reset"
              :class="{ hidden: isDefault(p) }"
              icon="undo"
              variant="plain"
              size="sm"
              :icon-size="14"
              :disabled="isDefault(p)"
              :tip="`Reset ${p.label} to its default`"
              :aria-label="`Reset ${p.label}`"
              data-setting-reset
              @click="reset(p)"
            />
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
  width: 9em;
}
.plugset :deep(.plugset-select) {
  width: 18em;
  max-width: none;
}
.plugset-text {
  width: 14em;
}
.plugset-reset.hidden {
  visibility: hidden;
}
.plugset-error {
  color: var(--error);
  margin: 2px 0 0;
  font-size: 0.9em;
}
</style>
