<script setup lang="ts">
import Icon from "../shell/Icon.vue";

withDefaults(
  defineProps<{
    icon: string;
    title: string;
    active?: boolean;
    size?: number;
    badge?: string | number | null;
  }>(),
  { active: false, size: 20, badge: null },
);
</script>

<template>
  <button
    type="button"
    class="icon-btn"
    :class="{ active }"
    :title="title"
    :aria-label="title"
    :aria-pressed="active"
  >
    <Icon :name="icon" :size="size" />
    <span v-if="badge !== null && badge !== ''" class="icon-btn-badge">{{ badge }}</span>
  </button>
</template>
