<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { lastRoundTripMs, onRoundTrip, type RoundTrip } from "../../diagnostics/rebuildTiming";
import { t } from "../../i18n";

const ms = ref(lastRoundTripMs());
const text = computed(() =>
  ms.value == null ? t("shell.roundTrip.waiting") : t("shell.roundTrip", { ms: ms.value.toFixed(0) }),
);
let unsub: (() => void) | null = null;

onMounted(() => {
  unsub = onRoundTrip((rt: RoundTrip) => {
    ms.value = rt.drawnAt - rt.sentAt;
  });
});
onUnmounted(() => unsub?.());
</script>

<template>
  <div class="roundtrip" :title="t('shell.roundTrip.tip')">{{ text }}</div>
</template>

<style scoped>
.roundtrip {
  position: absolute;
  right: var(--s-4);
  bottom: calc(var(--s-4) + 26px);
  padding: var(--s-0) var(--s-3);
  font:
    var(--fs-micro)/1.4 ui-monospace,
    "SF Mono",
    Menlo,
    Consolas,
    monospace;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  cursor: default;
  user-select: none;
  z-index: 15;
}
</style>
