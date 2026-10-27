<script setup lang="ts" generic="T extends string | number">
import { computed, ref } from "vue";
import Icon from "../shell/Icon.vue";
import { fmtKeys } from "../../input/platform";
import { useDisabled } from "./useDisabled";
import { useRovingFocus } from "./useRovingFocus";

export interface SegmentedOption<V> {
  value: V;
  label?: string | undefined;
  icon?: string | undefined;
  tip?: string | undefined;
  keys?: string | undefined;
  disabled?: boolean | undefined;
}

const props = withDefaults(
  defineProps<{
    modelValue: T;
    options: readonly SegmentedOption<T>[];
    /** The group's accessible name. */
    label?: string | undefined;
    size?: "sm" | "md";
    /** `chips` is the Render dock look: separate chips instead of one joined bar. */
    variant?: "bar" | "chips";
    iconOnly?: boolean;
    disabled?: boolean;
    disabledReason?: string | undefined;
  }>(),
  { size: "md", variant: "bar", iconOnly: false, disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [T] }>();
defineSlots<{ option?(p: { option: SegmentedOption<T>; selected: boolean }): unknown }>();

const d = useDisabled(props);
const root = ref<HTMLElement | null>(null);
const selected = computed(() => props.options.findIndex((o) => o.value === props.modelValue));

function pick(i: number) {
  const o = props.options[i];
  if (!o || o.disabled || props.disabled || o.value === props.modelValue) return;
  emit("update:modelValue", o.value);
}

const r = useRovingFocus({ items: () => props.options, active: selected, container: root, onMove: pick });
const onKeydown = (e: KeyboardEvent) => {
  if (!props.disabled) r.onKeydown(e);
};

const tipOf = (o: SegmentedOption<T>) => {
  const name = o.tip ?? (props.iconOnly ? o.label : undefined);
  return name && o.keys ? `${name} (${fmtKeys(o.keys)})` : name;
};
</script>

<template>
  <div
    ref="root"
    role="radiogroup"
    class="ui-segmented"
    :class="[`ui-segmented-${size}`, `ui-segmented-${variant}`, { 'ui-segmented-icon': iconOnly }]"
    v-bind="d.bind.value"
    :aria-label="label"
    :title="d.title(undefined)"
    @keydown="onKeydown"
  >
    <button
      v-for="(o, i) in options"
      :key="String(o.value)"
      type="button"
      role="radio"
      data-roving
      class="ui-segment"
      :class="{ 'is-selected': i === selected, 'is-disabled': o.disabled }"
      :aria-checked="i === selected ? 'true' : 'false'"
      :aria-disabled="o.disabled ? 'true' : undefined"
      :aria-label="iconOnly ? tipOf(o) : undefined"
      :title="tipOf(o)"
      :tabindex="r.tabindex(i)"
      @focus="r.onFocus(i)"
      @click="pick(i)"
    >
      <slot name="option" :option="o" :selected="i === selected">
        <Icon v-if="o.icon" :name="o.icon" :size="size === 'sm' ? 14 : 16" />
        <span v-if="o.label && !iconOnly" class="ui-segment-label">{{ o.label }}</span>
      </slot>
    </button>
  </div>
</template>
