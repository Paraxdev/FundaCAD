<script setup lang="ts">
import { panelId, tabId } from "./tabIds";

defineProps<{
  /** The id base the Tabs above were given as `panels`. */
  panels: string;
  value: string;
}>();
</script>

<template>
  <div :id="panelId(panels, value)" class="ui-tabpanel" role="tabpanel" :aria-labelledby="tabId(panels, value)">
    <slot />
  </div>
</template>
