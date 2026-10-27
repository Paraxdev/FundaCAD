<script setup lang="ts">
import { computed } from "vue";
import { fmtKeys } from "../../input/platform";
import { useDisabled } from "./useDisabled";

const props = defineProps<{
  modelValue: boolean;
  label?: string | undefined;
  indeterminate?: boolean | undefined;
  tip?: string | undefined;
  keys?: string | undefined;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}>();
const emit = defineEmits<{ "update:modelValue": [boolean] }>();

const d = useDisabled(props);
const tipText = computed(() => (props.tip && props.keys ? `${props.tip} (${fmtKeys(props.keys)})` : props.tip));

// The box is controlled: the native toggle is put back until the parent hands the new value down.
function onChange(e: Event) {
  const el = e.target as HTMLInputElement;
  const next = el.checked;
  el.checked = props.modelValue;
  el.indeterminate = !!props.indeterminate;
  if (!d.isDisabled.value) emit("update:modelValue", next);
}

// Space is handled here and its native toggle refused, so every engine flips once on keydown.
function onKeydown(e: KeyboardEvent) {
  if (e.key !== " ") return;
  e.preventDefault();
  if (!e.repeat && !d.isDisabled.value) emit("update:modelValue", props.indeterminate ? true : !props.modelValue);
}
function onKeyup(e: KeyboardEvent) {
  if (e.key === " ") e.preventDefault();
}
</script>

<template>
  <label
    class="ui-checkbox"
    :class="{ 'is-on': modelValue, 'is-mixed': indeterminate }"
    v-bind="d.bind.value"
    :title="d.title(tipText)"
  >
    <span class="ui-checkbox-box">
      <input
        type="checkbox"
        class="ui-checkbox-input"
        :checked="modelValue"
        :indeterminate="!!indeterminate"
        :aria-disabled="disabled ? 'true' : undefined"
        :aria-label="label || $slots.default ? undefined : tipText"
        @change="onChange"
        @keydown="onKeydown"
        @keyup="onKeyup"
      />
      <span class="ui-checkbox-mark" aria-hidden="true"></span>
    </span>
    <span v-if="label || $slots.default" class="ui-checkbox-label"
      ><slot>{{ label }}</slot></span
    >
  </label>
</template>
