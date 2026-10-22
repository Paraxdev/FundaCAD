<script setup lang="ts">
import Icon from "../shell/Icon.vue";

withDefaults(
  defineProps<{
    icon: string;
    title: string;
    active?: boolean;
    size?: number;
    badge?: string | number | null;
    /** Greyed with the title kept live: some webviews show no tooltip on a native disabled button. The click still
     *  arrives, so the handler must refuse it. */
    disabled?: boolean;
  }>(),
  { active: false, size: 20, badge: null, disabled: false },
);
</script>

<template>
  <button
    type="button"
    class="icon-btn"
    :class="{ active, disabled }"
    :aria-disabled="disabled || undefined"
    :title="title"
    :aria-label="title"
    :aria-pressed="active"
  >
    <Icon :name="icon" :size="size" />
    <span v-if="badge !== null && badge !== ''" class="icon-btn-badge">{{ badge }}</span>
  </button>
</template>
