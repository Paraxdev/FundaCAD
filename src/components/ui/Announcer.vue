<script setup lang="ts">
// Mounted once, in App.vue. A region has to exist before its text changes or no screen reader speaks it, and it sits
// on body, outside #app, so a modal making the page inert never silences it.
import { onMounted, onUnmounted, useTemplateRef } from "vue";
import { attachAnnouncer } from "../../ui/announce";

const polite = useTemplateRef<HTMLDivElement>("polite");
const assertive = useTemplateRef<HTMLDivElement>("assertive");
let detach: (() => void) | null = null;

onMounted(() => {
  if (polite.value && assertive.value) detach = attachAnnouncer({ polite: polite.value, assertive: assertive.value });
});
onUnmounted(() => detach?.());
</script>

<template>
  <Teleport to="body">
    <div id="a11y-announcer" class="sr-only" data-testid="announcer">
      <div id="a11y-polite" ref="polite" role="status" aria-live="polite" aria-atomic="true"></div>
      <div id="a11y-assertive" ref="assertive" role="alert" aria-live="assertive" aria-atomic="true"></div>
    </div>
  </Teleport>
</template>
