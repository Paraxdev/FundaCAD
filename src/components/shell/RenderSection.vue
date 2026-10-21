<script setup lang="ts">
// One titled block of the Render dock, with an optional hint under it.
defineProps<{ title: string; hint?: string }>();
</script>

<template>
  <section class="rd-section">
    <h3 class="rd-head">{{ title }}</h3>
    <slot />
    <p v-if="hint" class="sm-hint">{{ hint }}</p>
  </section>
</template>
