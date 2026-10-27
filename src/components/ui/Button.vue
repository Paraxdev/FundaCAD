<script setup lang="ts">
import { computed, useSlots } from "vue";
import Icon from "../shell/Icon.vue";
import { tipText } from "./tip";
import { useDisabled } from "./useDisabled";

const props = withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "ghost" | "danger";
    size?: "sm" | "md";
    /** Spans the width of its container. */
    block?: boolean;
    /** A toggle: sets `aria-pressed` and `.is-on`. Leave it out for a plain action. */
    pressed?: boolean | undefined;
    icon?: string | undefined;
    type?: "button" | "submit" | "reset";
    tip?: string | undefined;
    keys?: string | undefined;
    disabled?: boolean;
    disabledReason?: string | undefined;
  }>(),
  {
    variant: "secondary",
    size: "md",
    block: false,
    pressed: undefined,
    icon: undefined,
    type: "button",
    tip: undefined,
    keys: undefined,
    disabled: false,
    disabledReason: undefined,
  },
);

const d = useDisabled(props);
const slots = useSlots();
const label = computed(() => tipText(props.tip, props.keys));
// A visible label must stay the accessible name (WCAG 2.5.3), so the tip names only an icon only button.
const ariaLabel = computed(() => (slots.default ? undefined : label.value));
</script>

<template>
  <button
    v-bind="d.bind.value"
    :type="type"
    class="btn"
    :class="[`btn-${variant}`, `btn-${size}`, { 'btn-block': block, 'is-on': pressed }]"
    :title="d.title(label)"
    :aria-label="ariaLabel"
    :aria-pressed="pressed"
  >
    <slot name="icon"><Icon v-if="icon" :name="icon" :size="14" /></slot>
    <span v-if="$slots.default" class="btn-label"><slot /></span>
    <slot name="trailing" />
  </button>
</template>
