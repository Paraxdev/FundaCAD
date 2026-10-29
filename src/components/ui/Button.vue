<script setup lang="ts">
import { computed, useSlots } from "vue";
import { ariaKeys } from "../../input/platform";
import Icon from "../shell/Icon.vue";
import { tipText } from "./tip";
import { useDisabled } from "./useDisabled";

const props = withDefaults(
  defineProps<{
    /** `tile` is a large card that lays its own content out in a column, as on Home; it takes no size. */
    variant?: "primary" | "secondary" | "ghost" | "danger" | "tile";
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
const title = computed(() => tipText(props.tip, props.keys));
// A visible label must stay the accessible name (WCAG 2.5.3), so the tip names only an icon only button.
const ariaLabel = computed(() => (slots.default ? undefined : props.tip));
</script>

<template>
  <button
    v-bind="d.bind.value"
    :type="type"
    class="btn"
    :class="[`btn-${variant}`, variant === 'tile' ? null : `btn-${size}`, { 'btn-block': block, 'is-on': pressed }]"
    :title="d.title(title)"
    :aria-label="ariaLabel"
    :aria-keyshortcuts="ariaKeys(keys)"
    :aria-pressed="pressed"
  >
    <slot name="icon"><Icon v-if="icon" :name="icon" :size="14" /></slot>
    <span v-if="$slots.default" class="btn-label"><slot /></span>
    <slot name="trailing" />
  </button>
</template>
