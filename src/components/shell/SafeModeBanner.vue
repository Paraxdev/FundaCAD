<script setup lang="ts">
import { ref } from "vue";
import { leaveSafeMode, safeMode, safeModeLeaveNote, safeModeWhy } from "../../ui/safeMode";
import { openReportDialog } from "../../ui/bugReporter";
import Button from "../ui/Button.vue";

const info = safeMode();
const leaving = ref(false);
const failed = ref<string | null>(null);

async function restart() {
  leaving.value = true;
  failed.value = null;
  try {
    await leaveSafeMode();
  } catch (e) {
    leaving.value = false;
    failed.value = `Could not restart: ${String(e)}`;
  }
}
</script>

<template>
  <div v-if="info" id="safe-mode-banner" role="alert">
    <div class="text">
      <strong>FundaCAD started in safe mode</strong> because {{ safeModeWhy(info) }}. Plugins, saved preferences and
      work recovery are off for this session, and nothing saved was changed. Preferences changed now are forgotten when
      it closes.
      <template v-if="safeModeLeaveNote(info)"> {{ safeModeLeaveNote(info) }}</template>
      <span v-if="failed" class="failed">{{ failed }}</span>
    </div>
    <Button :disabled="leaving" @click="restart">Restart normally</Button>
    <Button class="safe-report" @click="openReportDialog()">Report a problem</Button>
  </div>
</template>

<style scoped>
#safe-mode-banner {
  position: fixed;
  top: calc(36px + var(--float-gap));
  left: 50%;
  transform: translateX(-50%);
  z-index: 900;
  display: flex;
  align-items: center;
  gap: var(--s-3);
  max-width: min(760px, calc(100vw - 32px));
  padding: var(--s-3) var(--s-4);
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.45;
}
.text {
  flex: 1 1 auto;
  min-width: 0;
}
.failed {
  display: block;
  color: var(--warn);
  margin-top: 4px;
}
.btn {
  flex: 0 0 auto;
}
</style>
