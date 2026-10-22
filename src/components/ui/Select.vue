<script setup lang="ts" generic="T extends string">
// A themed stand-in for <select>: the browser draws the open popup itself, out of reach of CSS, so this opens the
// shared Popover and ChoiceList instead.

import { ref, useTemplateRef } from "vue";
import Popover from "./Popover.vue";
import ChoiceList from "./ChoiceList.vue";

const props = withDefaults(
  defineProps<{
    modelValue: T;
    options: readonly { value: T; label: string; hint?: string }[];
    id?: string;
    testid?: string;
    disabled?: boolean;
  }>(),
  {
    disabled: false,
  },
);

const emit = defineEmits<{ "update:modelValue": [T] }>();

const open = ref(false);
const btn = useTemplateRef<HTMLButtonElement>("btn");
/** Measured on open: the list reads as this field's list when it is at least as
 *  wide as the field, and these fields stretch to fill their row. */
const width = ref(0);

function toggle() {
  if (props.disabled) return;
  width.value = btn.value?.offsetWidth ?? 0;
  open.value = !open.value;
}

function pick(v: T) {
  open.value = false;
  if (v !== props.modelValue) emit("update:modelValue", v);
}
</script>

<template>
  <button
    ref="btn"
    :id="id"
    type="button"
    class="sm-select select-trigger"
    :class="{ open }"
    :disabled="disabled"
    :data-testid="testid"
    :data-value="modelValue"
    :aria-haspopup="true"
    :aria-expanded="open"
    @click="toggle"
  >
    <span class="select-value">
      {{ options.find((o) => o.value === modelValue)?.label ?? modelValue }}
    </span>
  </button>

  <Popover
    v-if="open"
    :anchor="btn"
    side="bottom"
    align="start"
    kind="select-pop"
    :min-width="width"
    @close="open = false"
  >
    <ChoiceList :options="options" :model-value="modelValue" @update:model-value="pick" />
  </Popover>
</template>
