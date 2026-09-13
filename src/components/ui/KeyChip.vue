<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ keys: string }>();
const parts = computed(() => props.keys.split(/[\s+]+/).filter(Boolean));
</script>

<template>
  <span class="key-chip">
    <kbd v-for="(k, i) in parts" :key="i">{{ k }}</kbd>
  </span>
</template>
