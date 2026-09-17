<script setup lang="ts">
// Typing a bed size for the "Custom" preset. Same shortcuts as the app's own
// small dialogs: Enter accepts, Escape (or the backdrop) cancels, and a bad
// number gets a message beside the fields instead of a silently-kept default.

import { onMounted, onUnmounted, ref } from "vue";
import { ModalFrame } from "fundacad/ui";
import { parseCustomBedSize } from "./bedFit";
import type { CustomBedRequest } from "./customBedDialog";

const props = defineProps<{ req: CustomBedRequest }>();

const width = ref(String(props.req.initial[0]));
const depth = ref(String(props.req.initial[1]));
const height = ref(String(props.req.initial[2]));
const error = ref("");

function confirm() {
  const result = parseCustomBedSize(
    Number.parseFloat(width.value),
    Number.parseFloat(depth.value),
    Number.parseFloat(height.value),
  );
  if (!result.ok) {
    error.value = result.message;
    return;
  }
  props.req.resolve(result.size);
}
const cancel = () => props.req.resolve(null);

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  } else if (e.key === "Enter") {
    e.preventDefault();
    e.stopImmediatePropagation();
    confirm();
  }
}
onMounted(() => window.addEventListener("keydown", onKey, true));
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <ModalFrame panel-class="bed-custom-dialog" @close="cancel()">
    <template #title>Custom bed size</template>

    <div class="modal-body prefs">
      <label class="prefs-row">
        <span class="prefs-label">Width</span>
        <span class="export-num">
          <input
            v-model="width" class="sm-input" type="number" min="0" step="1"
            data-testid="bed-custom-width" autofocus
          />
          <span class="export-unit">mm</span>
        </span>
      </label>
      <label class="prefs-row">
        <span class="prefs-label">Depth</span>
        <span class="export-num">
          <input v-model="depth" class="sm-input" type="number" min="0" step="1" data-testid="bed-custom-depth" />
          <span class="export-unit">mm</span>
        </span>
      </label>
      <label class="prefs-row">
        <span class="prefs-label">Height</span>
        <span class="export-num">
          <input v-model="height" class="sm-input" type="number" min="0" step="1" data-testid="bed-custom-height" />
          <span class="export-unit">mm</span>
        </span>
      </label>
      <div v-if="error" class="sm-hint bed-custom-error" data-testid="bed-custom-error">{{ error }}</div>
    </div>

    <div class="modal-foot">
      <button type="button" class="btn" data-testid="bed-custom-cancel" @click="cancel()">Cancel</button>
      <button type="button" class="btn btn-primary" data-testid="bed-custom-confirm" @click="confirm()">OK</button>
    </div>
  </ModalFrame>
</template>

<style scoped>
.bed-custom-dialog .prefs-row {
  grid-template-columns: 70px 1fr;
}
.export-num {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.export-num input {
  flex: 1;
  min-width: 0;
}
.export-unit {
  width: 22px;
  font-size: 12px;
  color: var(--text-dim);
}
.bed-custom-error {
  color: var(--error, #f0564a);
}
</style>
