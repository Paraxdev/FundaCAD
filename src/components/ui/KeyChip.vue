<script setup lang="ts">
import { computed } from "vue";
import { fmtKeys } from "../../input/platform";

const props = defineProps<{
  keys: string;
  /** The owner's title or aria-label already says these keys, so a screen reader would hear them twice. */
  inTitle?: boolean;
}>();
const parts = computed(() =>
  fmtKeys(props.keys)
    .split(/[\s+]+/)
    .filter(Boolean),
);
</script>

<template>
  <span class="key-chip" :aria-hidden="inTitle ? 'true' : undefined">
    <kbd v-for="(k, i) in parts" :key="i">{{ k }}</kbd>
  </span>
</template>
