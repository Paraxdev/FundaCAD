<script setup lang="ts">
import { computed } from "vue";
import Icon from "../shell/Icon.vue";
import Switch from "./Switch.vue";
import { fmtKeys } from "../../input/platform";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    label: string;
    icon?: string;
    layout?: "float" | "param";
    tip?: string | undefined;
    keys?: string | undefined;
    disabled?: boolean;
    disabledReason?: string | undefined;
  }>(),
  { icon: "", layout: "float", disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [boolean] }>();

// The row is a label holding the switch, so a click anywhere on it reaches the switch once.
const tipText = computed(() => (props.tip && props.keys ? `${props.tip} (${fmtKeys(props.keys)})` : props.tip));
const title = computed(() => (props.disabled && props.disabledReason ? props.disabledReason : tipText.value));
</script>

<template>
  <label
    class="ui-switch-row"
    :class="[
      `ui-switch-row-${layout}`,
      { 'float-toggle': layout === 'float', 'is-disabled': disabled, disabled: disabled && layout === 'float' },
    ]"
    :title="title"
  >
    <span class="ui-switch-row-label ft-label">
      <Icon v-if="icon" :name="icon" :size="16" />
      {{ label }}
    </span>
    <span v-if="$slots.hint" class="ui-switch-row-hint"><slot name="hint" /></span>
    <span v-if="layout === 'float'" class="ui-switch-row-state ft-state" aria-hidden="true">{{
      modelValue ? "On" : "Off"
    }}</span>
    <Switch
      :model-value="modelValue"
      :label="label"
      :disabled="disabled"
      :disabled-reason="disabledReason"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </label>
</template>
