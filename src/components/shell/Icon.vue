<script setup lang="ts">
// The one sanctioned v-html: every value is an SVG bundled from src/assets/icons, never document, file or network data.
// Tests and e2e scripts assert on data-icon, an svg has no text content.

import { computed, onUnmounted, ref } from "vue";
import { iconPaths, onIconPackChange } from "../../ui/icons";

const props = withDefaults(
  defineProps<{
    name: string;
    size?: number | string;
    /** Only for an icon that says something no text beside it does: it then reads as an image of this name. */
    label?: string | undefined;
  }>(),
  { size: 16, label: undefined },
);

// The active pack is plain module state, so a per-icon counter re-resolves it. icons.ts stays Vue-free for the headless
// suite.
const tick = ref(0);
const stop = onIconPackChange(() => tick.value++);
onUnmounted(stop);

const paths = computed(() => {
  tick.value; // dependency: re-resolve when the user switches packs
  return iconPaths(props.name);
});
</script>

<template>
  <!-- The svg is the root, the layout CSS selects `.ribbon-btn svg`. Size goes on as attributes so a stylesheet rule wins. -->
  <svg
    class="icon"
    :data-icon="name"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
    focusable="false"
    viewBox="0 0 24 24"
    :width="size"
    :height="size"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    v-html="paths"
  />
</template>
