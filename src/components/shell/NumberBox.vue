<script setup lang="ts">
// Reads typed text through the shared measure grammar (units, fractions, arithmetic, decimal comma). Unparsed text
// keeps the last good value and turns the box red with the reason in its title, as ValidatedInput does.

import { computed, ref, watch } from "vue";
import { fieldError, fieldNumber } from "../../ui/measure";

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  modelValue: number | null | undefined;
  /** A blank box means null instead of "leave the model alone". */
  nullable?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: number | null] }>();

const text = ref(props.modelValue == null ? "" : String(props.modelValue));
const error = computed(() => fieldError(text.value));

let sent = props.modelValue;

// Resync only when the model moved for a reason other than this box's own emit.
watch(
  () => props.modelValue,
  (v) => {
    if (v === sent) return;
    sent = v;
    text.value = v == null ? "" : String(v);
  },
);

function send(v: number | null) {
  sent = v;
  emit("update:modelValue", v);
}

function onInput(e: Event) {
  text.value = (e.target as HTMLInputElement).value;
  if (text.value.trim() === "") {
    if (props.nullable) send(null);
    return;
  }
  const n = fieldNumber(text.value);
  if (Number.isFinite(n)) send(n);
}
</script>

<template>
  <input
    v-bind="$attrs"
    type="text"
    inputmode="decimal"
    :value="text"
    :class="{ 'input-error': !!error }"
    :title="error ?? ($attrs.title as string | undefined)"
    @input="onInput"
  />
</template>

<style>
input.input-error.measure-number,
input.input-error.sm-input {
  border-color: #ff6b6b;
  box-shadow: 0 0 0 3px rgba(255, 107, 107, 0.18);
}
</style>
