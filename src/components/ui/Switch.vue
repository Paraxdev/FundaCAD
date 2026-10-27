<script setup lang="ts">
import { computed } from "vue";
import { fmtKeys } from "../../input/platform";
import { useDisabled } from "./useDisabled";

const props = defineProps<{
  modelValue: boolean;
  /** The accessible name when no tip names it. */
  label?: string | undefined;
  tip?: string | undefined;
  keys?: string | undefined;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}>();
const emit = defineEmits<{ "update:modelValue": [boolean] }>();

const d = useDisabled(props);
const tipText = computed(() => (props.tip && props.keys ? `${props.tip} (${fmtKeys(props.keys)})` : props.tip));
const flip = d.guard(() => emit("update:modelValue", !props.modelValue));

// Enter and Space are handled here and their native click refused, so every engine flips once on keydown.
function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  if (!e.repeat) flip();
}
function onKeyup(e: KeyboardEvent) {
  if (e.key === " ") e.preventDefault();
}
</script>

<template>
  <button
    type="button"
    role="switch"
    class="ui-switch ft-switch"
    :class="{ 'is-on': modelValue, on: modelValue }"
    v-bind="d.bind.value"
    :aria-checked="modelValue ? 'true' : 'false'"
    :aria-label="tipText || label"
    :title="d.title(tipText)"
    @click="flip"
    @keydown="onKeydown"
    @keyup="onKeyup"
    ><i class="ui-switch-knob"></i
  ></button>
</template>
