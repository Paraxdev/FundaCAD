<script setup lang="ts">
import { ref } from "vue";
import { leaveSafeMode, safeMode, safeModeLeaveNote, safeModeWhy } from "../../ui/safeMode";

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
      <strong>FundaCAD started in safe mode</strong> because {{ safeModeWhy(info) }}.
      Plugins, saved preferences and work recovery are off for this session, and nothing saved was changed.
      Preferences changed now are forgotten when it closes.
      <template v-if="safeModeLeaveNote(info)"> {{ safeModeLeaveNote(info) }}</template>
      <span v-if="failed" class="failed">{{ failed }}</span>
    </div>
    <button type="button" class="btn" :disabled="leaving" @click="restart">Restart normally</button>
  </div>
</template>

<style scoped>
#safe-mode-banner {
  position: fixed;
  top: 44px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 900;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: min(760px, calc(100vw - 32px));
  padding: 10px 14px;
  border: 1px solid var(--warn);
  border-radius: var(--r-md);
  background: var(--panel);
  color: var(--text);
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.25);
  font-size: 12.5px;
  line-height: 1.45;
}
.text { flex: 1 1 auto; min-width: 0; }
.failed { display: block; color: var(--warn); margin-top: 4px; }
button { flex: 0 0 auto; white-space: nowrap; }
</style>
