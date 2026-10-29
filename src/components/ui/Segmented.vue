<script setup lang="ts" generic="T extends string | number">
import { computed, ref } from "vue";
import Icon from "../shell/Icon.vue";
import { fmtKeys } from "../../input/platform";
import { useDisabled } from "./useDisabled";
import { useName, type Named } from "./useName";
import { rovingIndex, useRovingFocus, type RovingOrientation } from "./useRovingFocus";

export interface SegmentedOption<V> {
  value: V;
  label?: string | undefined;
  icon?: string | undefined;
  tip?: string | undefined;
  keys?: string | undefined;
  disabled?: boolean | undefined;
  /** Greyed but still answers a click or a key, a soft block the pick lifts, as IconButton's clickable. */
  clickable?: boolean | undefined;
  /** Extra attributes on the option's button, such as a data hook for e2e. */
  attrs?: Record<string, string> | undefined;
}

const props = withDefaults(
  defineProps<
    {
      modelValue: T;
      options: readonly SegmentedOption<T>[];
      /** lg is a 40px viewport tile. */
      size?: "sm" | "md" | "lg";
      /** `chips` is the Render dock look: separate chips instead of one joined bar. `tile` is the viewport icon tiles. */
      variant?: "bar" | "chips" | "tile";
      iconOnly?: boolean;
      disabled?: boolean;
      disabledReason?: string | undefined;
      orientation?: RovingOrientation;
      /** `manual`: the arrows only move focus and Space, Enter or a click picks, for a switch that loads something heavy. */
      activation?: "auto" | "manual";
      /** false: an arrow at either end is left to the parent, so a Toolbar around the group moves on. */
      wrap?: boolean;
    } & Named
  >(),
  {
    size: "md",
    variant: "bar",
    iconOnly: false,
    disabled: false,
    orientation: "horizontal",
    activation: "auto",
    wrap: true,
  },
);
const emit = defineEmits<{ "update:modelValue": [T] }>();
defineSlots<{ option?(p: { option: SegmentedOption<T>; selected: boolean }): unknown }>();

const name = useName(props, "Segmented");
const d = useDisabled(props);
const root = ref<HTMLElement | null>(null);
const selected = computed(() => props.options.findIndex((o) => o.value === props.modelValue));

const blocked = (o: SegmentedOption<T>) => !!o.disabled && !o.clickable;

function pick(i: number) {
  const o = props.options[i];
  if (!o || blocked(o) || props.disabled || o.value === props.modelValue) return;
  emit("update:modelValue", o.value);
}

const r = useRovingFocus({
  items: () => props.options.map((o) => ({ disabled: blocked(o) })),
  active: selected,
  container: root,
  orientation: () => props.orientation,
  wrap: () => props.wrap,
  onMove: (i) => {
    if (props.activation === "auto") pick(i);
  },
});
const ARROWS = /^Arrow(Up|Down|Left|Right)$/;
function atEnd(e: KeyboardEvent): boolean {
  if (props.wrap || !ARROWS.test(e.key)) return false;
  const els = [...(root.value?.querySelectorAll("[data-roving]") ?? [])];
  const from = els.findIndex((el) => el.contains(e.target as Node));
  const off = props.options.map(blocked);
  return from >= 0 && rovingIndex(e.key, from, off, { orientation: props.orientation, wrap: false }) === from;
}
const onKeydown = (e: KeyboardEvent) => {
  if (!props.disabled && !atEnd(e)) r.onKeydown(e);
};
// Tab back into a manual group lands on the checked option, not on one the arrows left focus on.
const onFocusout = (e: FocusEvent) => {
  if (props.activation === "manual" && !root.value?.contains(e.relatedTarget as Node | null)) r.onFocus(-1);
};

const ICON_SIZE = { sm: 14, md: 16, lg: 20 } as const;

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
    :class="[
      `ui-segmented-${size}`,
      `ui-segmented-${variant}`,
      { 'ui-segmented-icon': iconOnly, 'ui-segmented-vertical': orientation === 'vertical' },
    ]"
    v-bind="{ ...d.bind.value, ...name }"
    :title="d.title(undefined)"
    @keydown="onKeydown"
    @focusout="onFocusout"
  >
    <button
      v-for="(o, i) in options"
      :key="String(o.value)"
      v-bind="o.attrs"
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
        <Icon v-if="o.icon" :name="o.icon" :size="ICON_SIZE[size]" />
        <span v-if="o.label && !iconOnly" class="ui-segment-label">{{ o.label }}</span>
      </slot>
    </button>
  </div>
</template>
