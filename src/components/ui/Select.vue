<script setup lang="ts" generic="T extends string">
// A themed stand-in for a native <select>: the browser draws that control's
// OPEN popup itself (a separate OS-level surface on some platforms), so no
// amount of CSS reaches the option list or its selected-row highlight, only
// the closed box. This opens the same Popover/ChoiceList every other picker in
// the app uses, so the list is themed like everything else that floats.

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
  { id: undefined, testid: undefined, disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [T] }>();

const open = ref(false);
const btn = useTemplateRef<HTMLButtonElement>("btn");

function toggle() {
  if (!props.disabled) open.value = !open.value;
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
    :aria-haspopup="true"
    :aria-expanded="open"
    @click="toggle"
  >
    <span class="select-value">{{ options.find((o) => o.value === modelValue)?.label ?? modelValue }}</span>
  </button>
  <Popover v-if="open" :anchor="btn" side="bottom" align="start" kind="select-pop" @close="open = false" :style="{ zIndex: 99999 }">
    <ChoiceList  :options="options" :model-value="modelValue" @update:model-value="pick" />
  </Popover>
</template>
