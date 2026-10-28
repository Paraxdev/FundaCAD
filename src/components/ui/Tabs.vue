<script setup lang="ts" generic="T extends string">
import { computed, ref } from "vue";
import Icon from "../shell/Icon.vue";
import { fmtKeys } from "../../input/platform";
import { useRovingFocus } from "./useRovingFocus";
import { useName, type Named } from "./useName";

export interface TabItem<V> {
  value: V;
  label: string;
  icon?: string | undefined;
  disabled?: boolean | undefined;
  /** The tooltip, say why a disabled tab cannot be chosen yet. */
  title?: string | undefined;
  tip?: string | undefined;
  keys?: string | undefined;
}

const props = withDefaults(
  defineProps<
    {
      tabs: readonly TabItem<T>[];
      modelValue: T;
      /** `underline` for a card, `bar` for a dock, `nav` for a settings page list (aria-current, not tabs). */
      variant?: "underline" | "bar" | "nav";
      /** Defaults to vertical for `nav`, else horizontal. */
      orientation?: "horizontal" | "vertical" | undefined;
    } & Named
  >(),
  { variant: "underline", orientation: undefined },
);
const emit = defineEmits<{ "update:modelValue": [T] }>();
defineSlots<{ tab?(p: { tab: TabItem<T>; selected: boolean }): unknown }>();

const name = useName(props, "Tabs");
const root = ref<HTMLElement | null>(null);
const nav = computed(() => props.variant === "nav");
const vertical = computed(() => (props.orientation ?? (nav.value ? "vertical" : "horizontal")) === "vertical");
const selected = computed(() => props.tabs.findIndex((t) => t.value === props.modelValue));

function pick(i: number) {
  const t = props.tabs[i];
  if (t && !t.disabled) emit("update:modelValue", t.value);
}

const r = useRovingFocus({
  items: () => props.tabs,
  active: selected,
  container: root,
  orientation: () => (vertical.value ? "vertical" : "horizontal"),
  onMove: pick,
});

const tipOf = (t: TabItem<T>) => {
  if (t.disabled && t.title) return t.title;
  if (t.tip) return t.keys ? `${t.tip} (${fmtKeys(t.keys)})` : t.tip;
  return t.title;
};
</script>

<template>
  <component
    :is="nav ? 'nav' : 'div'"
    ref="root"
    class="ui-tabs"
    :class="[`ui-tabs-${variant}`, { 'float-tabs': variant === 'underline', 'ui-tabs-vertical': vertical }]"
    :role="nav ? undefined : 'tablist'"
    :aria-orientation="!nav && vertical ? 'vertical' : undefined"
    v-bind="name"
    @keydown="r.onKeydown"
  >
    <button
      v-for="(t, i) in tabs"
      :key="t.value"
      type="button"
      :role="nav ? undefined : 'tab'"
      data-roving
      :data-tab="t.value"
      class="ui-tab"
      :class="{
        'float-tab': variant === 'underline',
        active: variant === 'underline' && i === selected,
        'is-selected': i === selected,
        'is-disabled': t.disabled,
      }"
      :aria-selected="nav ? undefined : i === selected"
      :aria-current="nav && i === selected ? 'page' : undefined"
      :aria-disabled="t.disabled ? 'true' : undefined"
      :title="tipOf(t)"
      :tabindex="r.tabindex(i)"
      @focus="r.onFocus(i)"
      @click="pick(i)"
    >
      <slot name="tab" :tab="t" :selected="i === selected">
        <Icon v-if="t.icon" :name="t.icon" :size="16" />
        {{ t.label }}
      </slot>
    </button>
  </component>
</template>
