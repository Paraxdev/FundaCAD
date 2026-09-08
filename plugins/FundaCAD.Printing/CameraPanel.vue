<script setup lang="ts">
// Live printer camera. The webview never dials the LAN — Rust polls the
// printer's webcam and pushes JPEG data: URLs (CSP img-src already allows
// data:), so this only ever sets img.src.
//
// The subscriptions and the poller are tied to the component's lifetime.
// Previously they hung off FloatingPanel's onClose hook precisely because every
// dismissal path had to stop the poll; onUnmounted cannot be missed.

import { ref, watch } from "vue";
import { cameraPanel } from "./state";
import {
  printerCameraStart, printerCameraStop, onPrinterCameraFrame, onPrinterCameraOffline,
} from "./printerClient";
import FloatingPanel from "../../src/components/overlays/FloatingPanel.vue";

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

async function attach(id: string) {
  unlistenFrame = await onPrinterCameraFrame((e) => {
    if (e.id !== id) return;
    offline.value = false;
    frame.value = e.data_url;
  });
  unlistenOffline = await onPrinterCameraOffline((offlineId) => {
    if (offlineId === id) offline.value = true;
  });
  await start(id);
}

function detach(id: string) {
  void printerCameraStop(id).catch(() => {});
  unlistenFrame?.();
  unlistenOffline?.();
  unlistenFrame = null;
  unlistenOffline = null;
  frame.value = null;
  offline.value = false;
}

// One watcher covers open, close AND switching printers while open — the old
// code could only handle the first two because open() built the DOM.
watch(
  () => cameraPanel.value,
  (id, prevId) => {
    if (prevId) detach(prevId);
    if (id) void attach(id);
  },
  { immediate: true, flush: "sync" },
);
</script>

<template>
  <FloatingPanel :open="!!cameraPanel" close-on-esc @close="cameraPanel = null">
    <div class="measure-title">Camera, {{ cameraPanel }}</div>
    <img
      class="camera-frame"
      alt="printer camera"
      :src="frame ?? undefined"
      style="display: block; max-width: 480px; min-width: 320px; min-height: 180px; background: #111"
    />
    <div v-if="offline" class="camera-offline" style="padding: 8px; color: #e24a3b">
      camera unavailable
      <button class="camera-retry" @click="cameraPanel && start(cameraPanel)">Retry</button>
    </div>
    <div class="measure-hint">~1 frame/s · Esc to close</div>
  </FloatingPanel>
</template>
