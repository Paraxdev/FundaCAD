<script setup lang="ts">
import { computed } from "vue";
import Icon from "../shell/Icon.vue";
import IconButton from "./IconButton.vue";
import { tipText } from "./tip";
import { useDisabled } from "./useDisabled";

const props = withDefaults(
  defineProps<{
    variant?: "neutral" | "accent" | "warn" | "error";
    /** xs is a count badge, sm a tag, md a chip on the model. */
    size?: "xs" | "sm" | "md";
    icon?: string | undefined;
    /** The text when there is no default slot, and the X of the remove button's "Remove X". */
    label?: string | undefined;
    removable?: boolean;
    as?: "span" | "button";
    tip?: string | undefined;
    keys?: string | undefined;
    disabled?: boolean;
    disabledReason?: string | undefined;
  }>(),
  {
    variant: "neutral",
    size: "sm",
    icon: undefined,
    label: undefined,
    removable: false,
    as: "span",
    tip: undefined,
    keys: undefined,
    disabled: false,
    disabledReason: undefined,
  },
);
const emit = defineEmits<{ remove: [] }>();

const d = useDisabled(props);
const text = computed(() => tipText(props.tip, props.keys));
// A remove button cannot sit inside a button, so a removable button chip wraps a body button and the remove beside it.
const split = computed(() => props.as === "button" && props.removable);
const rootTag = computed(() => (split.value ? "span" : props.as));
const rootIsButton = computed(() => rootTag.value === "button");
const removeTip = computed(() => (props.label ? `Remove ${props.label}` : "Remove"));
</script>

<template>
  <component
    :is="rootTag"
    v-bind="d.bind.value"
    class="chip"
    :class="[`chip-${variant}`, `chip-${size}`]"
    :type="rootIsButton ? 'button' : undefined"
    :title="split ? undefined : d.title(text)"
    :aria-label="rootIsButton ? text : undefined"
  >
    <button
      v-if="split"
      type="button"
      class="chip-body"
      :title="d.title(text)"
      :aria-label="text"
      :aria-disabled="disabled ? 'true' : undefined"
    >
      <Icon v-if="icon" :name="icon" :size="12" />
      <slot>{{ label }}</slot>
    </button>
    <template v-else>
      <Icon v-if="icon" :name="icon" :size="12" />
      <slot>{{ label }}</slot>
    </template>
    <IconButton
      v-if="removable"
      class="chip-remove"
      icon="close"
      :tip="removeTip"
      size="sm"
      variant="plain"
      :icon-size="10"
      :disabled="disabled"
      @click.stop="emit('remove')"
    />
  </component>
</template>
