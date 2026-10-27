<script setup lang="ts">
import Icon from "../shell/Icon.vue";
import { useDisabled } from "./useDisabled";

const props = withDefaults(
  defineProps<{
    label: string;
    hint?: string | undefined;
    icon?: string | undefined;
    selected?: boolean;
    /** "option" inside a listbox, whose owner moves focus; "button" standalone. */
    as?: "button" | "option";
    tip?: string | undefined;
    disabled?: boolean;
    disabledReason?: string | undefined;
  }>(),
  { hint: undefined, icon: undefined, selected: false, as: "button", tip: undefined, disabledReason: undefined },
);
const d = useDisabled(props);
</script>

<template>
  <component
    :is="as === 'option' ? 'div' : 'button'"
    v-bind="d.bind.value"
    :type="as === 'option' ? undefined : 'button'"
    :role="as === 'option' ? 'option' : undefined"
    :aria-selected="as === 'option' ? selected : undefined"
    :aria-current="as === 'button' && selected ? 'true' : undefined"
    :tabindex="as === 'option' ? -1 : undefined"
    class="ui-list-row"
    :class="{ 'is-selected': selected }"
    :title="d.title(tip)"
  >
    <slot name="leading" />
    <Icon v-if="icon" class="ui-list-row-icon" :name="icon" :size="16" />
    <span class="ui-list-row-text">
      <span class="ui-list-row-label">{{ label }}</span>
      <span v-if="hint" class="ui-list-row-hint">{{ hint }}</span>
    </span>
    <slot name="trailing" />
  </component>
</template>
