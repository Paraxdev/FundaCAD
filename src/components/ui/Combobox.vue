<script setup lang="ts" generic="T extends string">
// A text field that filters a list under it. Focus stays in the input and the list follows by aria-activedescendant,
// on the ChoiceList driven mode Select uses. Attributes, the class and other listeners land on the TextField.

import { computed, mergeProps, nextTick, useAttrs, useId, useTemplateRef, watch } from "vue";
import TextField from "./TextField.vue";
import ChoiceList from "./ChoiceList.vue";
import { rovingIndex } from "./useRovingFocus";
import type { Named } from "./useName";

defineOptions({ inheritAttrs: false });

interface Option {
  value: T;
  label: string;
  hint?: string | undefined;
  disabled?: boolean | undefined;
  title?: string | undefined;
  keyshortcuts?: string | undefined;
}

const props = defineProps<
  {
    /** The typed query. */
    modelValue: string;
    options: readonly Option[];
    /** The highlighted option, -1 for none. */
    active: number;
    /** On the element around the list, which scrolls it and holds the empty slot. */
    listClass?: string | undefined;
  } & Named
>();
const emit = defineEmits<{ "update:modelValue": [string]; "update:active": [number]; pick: [T] }>();
defineSlots<{
  default?(p: { option: Option; index: number; selected: boolean; active: boolean }): unknown;
  empty?(): unknown;
}>();

const attrs = useAttrs();
const field = useTemplateRef<InstanceType<typeof TextField>>("field");
const listId = `${useId()}-list`;
const expanded = computed(() => props.options.length > 0);
const current = computed(() => (props.active >= 0 && props.active < props.options.length ? props.active : -1));
const name = computed<Named>(() =>
  props.labelledby ? { labelledby: props.labelledby } : { label: props.label ?? "" },
);

function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !expanded.value) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const flags = props.options.map((o) => !!o.disabled);
    const next = rovingIndex(e.key, current.value, flags, { orientation: "vertical", wrap: false });
    if (next !== null && next !== current.value) emit("update:active", next);
  } else if (e.key === "Enter") {
    const o = props.options[current.value];
    if (!o) return;
    e.preventDefault();
    if (!o.disabled) emit("pick", o.value);
  }
}

// Ours first, so a caller's keydown sees the arrows and Enter already handled.
function fieldAttrs() {
  return mergeProps({ onKeydown }, attrs, name.value) as Record<string, unknown> & Named;
}

watch(current, async (i) => {
  if (i < 0) return;
  await nextTick();
  document.getElementById(`${listId}-${i}`)?.scrollIntoView?.({ block: "nearest" });
});

defineExpose({ focus: () => field.value?.focus() });
</script>

<template>
  <TextField
    ref="field"
    v-bind="fieldAttrs()"
    :model-value="modelValue"
    role="combobox"
    aria-autocomplete="list"
    :aria-expanded="expanded"
    :aria-controls="expanded ? listId : undefined"
    :aria-activedescendant="current >= 0 ? `${listId}-${current}` : undefined"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <div class="ui-combobox-list" :class="listClass">
    <ChoiceList
      v-if="expanded"
      v-bind="name"
      :id="listId"
      :options="options"
      :model-value="options[current]?.value ?? null"
      :active="current"
      @update:model-value="emit('pick', $event)"
      @update:active="emit('update:active', $event)"
    >
      <template v-if="$slots.default" #default="s"><slot v-bind="s" /></template>
    </ChoiceList>
    <slot v-else name="empty" />
  </div>
</template>
