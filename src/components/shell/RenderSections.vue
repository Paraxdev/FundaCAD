<script setup lang="ts">
// The sections plugins add to the end of one Render dock tab.
import { onUnmounted, shallowRef } from "vue";
import { contributedRenderSections, onContribChange, type RenderTab } from "../../plugins/contrib";

const props = defineProps<{ tab: RenderTab }>();
const sections = shallowRef(contributedRenderSections(props.tab));
const stop = onContribChange(() => { sections.value = contributedRenderSections(props.tab); });
onUnmounted(stop);
</script>

<template>
  <component :is="s.section.component" v-for="s in sections" :key="s.key" :data-render-section="s.key" />
</template>
