<script setup lang="ts">
import { computed, mergeProps, useAttrs, useSlots } from "vue";
import { fmtKeys } from "../../input/platform";
import { useDisabled } from "./useDisabled";
import { useName, type Named } from "./useName";

defineOptions({ inheritAttrs: false });

/** Slot text names the box as a label does; a type cannot see a slot, so only the dev warning holds it to one. */
type Slotted = { label?: undefined; labelledby?: undefined };

const props = defineProps<
  {
    modelValue: boolean;
    indeterminate?: boolean | undefined;
    tip?: string | undefined;
    keys?: string | undefined;
    disabled?: boolean | undefined;
    disabledReason?: string | undefined;
  } & (Named | Slotted)
>();
const emit = defineEmits<{ "update:modelValue": [boolean] }>();

const attrs = useAttrs();
const slots = useSlots();
const d = useDisabled(props);
const name = useName(props, "Checkbox", () => !!slots.default);
const tipText = computed(() => (props.tip && props.keys ? `${props.tip} (${fmtKeys(props.keys)})` : props.tip));
const rootAttrs = computed(() => {
  const { "aria-label": _l, "aria-labelledby": _b, ...rest } = attrs;
  return mergeProps(d.bind.value, { title: d.title(tipText.value) }, rest);
});
// Drawn text names the box through the wrapping label; otherwise labelledby or a plugin's aria attribute does.
const inputName = computed(() => (props.label || slots.default ? {} : name.value));

const next = () => (props.indeterminate ? true : !props.modelValue);

// The box is controlled: the native toggle is put back until the parent hands the new value down.
function onChange(e: Event) {
  const el = e.target as HTMLInputElement;
  el.checked = props.modelValue;
  el.indeterminate = !!props.indeterminate;
  if (!d.isDisabled.value) emit("update:modelValue", next());
}

// Space is handled here and its native toggle refused, so every engine flips once on keydown.
function onKeydown(e: KeyboardEvent) {
  if (e.key !== " ") return;
  e.preventDefault();
  if (!e.repeat && !d.isDisabled.value) emit("update:modelValue", next());
}
function onKeyup(e: KeyboardEvent) {
  if (e.key === " ") e.preventDefault();
}
</script>

<template>
  <label class="ui-checkbox" :class="{ 'is-on': modelValue, 'is-mixed': indeterminate }" v-bind="rootAttrs">
    <span class="ui-checkbox-box">
      <input
        type="checkbox"
        class="ui-checkbox-input"
        :checked="modelValue"
        :indeterminate="!!indeterminate"
        :aria-disabled="disabled ? 'true' : undefined"
        v-bind="inputName"
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
