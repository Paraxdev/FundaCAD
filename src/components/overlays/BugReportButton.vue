<script setup lang="ts">
// The floating bug button, bottom-right. Chrome rather than a dialog, so it
// lives for the whole session, but only once app/engine.ts's mountUi() has
// handed the reporter its engine handles, because a report with nothing to
// report on is worse than no button.

import Icon from "../shell/Icon.vue";
import { useDialogStore } from "../../stores/dialogs";

const dialogs = useDialogStore();
</script>

<template>
  <Teleport to="body">
    <button
      v-if="dialogs.bugDeps"
      class="bug-report-btn"
      title="Report a bug"
      aria-label="Report a bug"
      @click="dialogs.bugReport = true"
    ><Icon name="bug" :size="18" /></button>
  </Teleport>
</template>
