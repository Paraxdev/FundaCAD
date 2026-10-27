<script setup lang="ts">
import { computed } from "vue";
import Icon from "../shell/Icon.vue";
import { tipText } from "./tip";
import { useDisabled } from "./useDisabled";

const props = withDefaults(
  defineProps<{
    icon: string;
    /** Required: an icon has no text, so this is its only name. */
    tip: string;
    keys?: string | undefined;
    /** sm 24px, md 28px (a card close), lg 40px (a viewport tile). */
    size?: "sm" | "md" | "lg";
    variant?: "plain" | "tile" | "danger";
    /** A toggle: sets `aria-pressed` and `.is-on`. Leave it out for a plain action. */
    active?: boolean | undefined;
    iconSize?: number | undefined;
    badge?: string | number | null;
    disabled?: boolean;
    disabledReason?: string | undefined;
    clickable?: boolean;
  }>(),
  {
    keys: undefined,
    size: "lg",
    variant: "tile",
    active: undefined,
    iconSize: undefined,
    badge: null,
    disabled: false,
    disabledReason: undefined,
    clickable: false,
  },
);

const d = useDisabled(props);
const label = computed(() => tipText(props.tip, props.keys));
const hasBadge = computed(() => props.badge !== null && props.badge !== "");
</script>

<template>
  <button
    v-bind="d.bind.value"
    type="button"
    class="icon-btn"
    :class="[`icon-btn-${variant}`, `icon-btn-${size}`, { active, 'is-on': active }]"
    :title="d.title(label)"
    :aria-label="hasBadge ? `${label}, ${badge}` : label"
    :aria-pressed="active"
  >
    <Icon :name="icon" :size="iconSize ?? (size === 'lg' ? 20 : 14)" />
    <span v-if="hasBadge" class="chip chip-error chip-xs icon-btn-badge" aria-hidden="true">{{ badge }}</span>
  </button>
</template>
