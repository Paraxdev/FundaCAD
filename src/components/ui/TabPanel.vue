<script setup lang="ts">
import { tabPanelAttrs } from "./tabIds";

defineProps<{
  /** The id base the Tabs above were given as `panels`. */
  panels: string;
  value: string;
}>();
</script>

<template>
  <div class="ui-tabpanel" v-bind="tabPanelAttrs(panels, value)">
    <slot />
  </div>
</template>
