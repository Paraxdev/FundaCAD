<script setup lang="ts">
// Snapshots come through the app's local-network request as JPEG data: URLs (CSP img-src allows data:), so this only
// ever sets img.src. The poller is tied to the component's lifetime, since onUnmounted cannot be missed.

import { ref, watch } from "vue";
import { t } from "./lines";
import { cameraPanel } from "./state";
import { Button, Panel } from "fundacad/ui";
import { printerCameraStart, printerCameraStop, onPrinterCameraFrame, onPrinterCameraOffline } from "./printerClient";

// Inline, because a plugin has nowhere to ship a stylesheet.
const S = {
  frame: {
    display: "block",
    width: "480px",
    maxWidth: "100%",
    minHeight: "180px",
    objectFit: "contain",
    background: "#111",
  },
  offline: { padding: "8px", color: "#e24a3b", display: "flex", alignItems: "center", gap: "var(--s-3)" },
} as const;

const frame = ref<string | null>(null);
const offline = ref(false);

let unlistenFrame: (() => void) | null = null;
let unlistenOffline: (() => void) | null = null;

async function start(id: string) {
  offline.value = false;
  try {
    await printerCameraStart(id);
  } catch {
    offline.value = true;
  }
}

function attach(id: string) {
  unlistenFrame = onPrinterCameraFrame((e) => {
    if (e.id !== id) return;
    offline.value = false;
    frame.value = e.data_url;
  });
  unlistenOffline = onPrinterCameraOffline((offlineId) => {
    if (offlineId === id) offline.value = true;
  });
  void start(id);
}

function detach(id: string) {
  printerCameraStop(id);
  unlistenFrame?.();
  unlistenOffline?.();
  unlistenFrame = null;
  unlistenOffline = null;
  frame.value = null;
  offline.value = false;
}

// One watcher covers open, close AND switching printers while open.
watch(
  () => cameraPanel.value,
  (id, prevId) => {
    if (prevId) detach(prevId);
    if (id) attach(id);
  },
  { immediate: true, flush: "sync" },
);
</script>

<template>
  <Panel
    :open="!!cameraPanel"
    :title="cameraPanel ? t('camera.title', { id: cameraPanel }) : t('camera.titleBare')"
    title-hidden
    close-on-esc
    @close="cameraPanel = null"
  >
    <div class="measure-title" aria-hidden="true">{{ t("camera.title", { id: cameraPanel ?? "" }) }}</div>
    <img
      class="camera-frame"
      :alt="frame ? t('camera.imageAlt') : t('camera.imageAltNone')"
      :src="frame ?? undefined"
      :style="S.frame"
    />
    <div v-if="offline" class="camera-offline" :style="S.offline">
      <span role="alert">{{ t("error.prefix", { message: t("camera.unavailable") }) }}</span>
      <Button class="camera-retry" size="sm" @click="cameraPanel && start(cameraPanel)">{{ t("camera.retry") }}</Button>
    </div>
    <div class="measure-hint">{{ t("camera.hint") }}</div>
  </Panel>
</template>
