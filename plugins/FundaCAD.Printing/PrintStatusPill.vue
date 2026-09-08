<script setup lang="ts">
import { usePrintStatusStore } from "./printStatus";

const print = usePrintStatusStore();
</script>

<template>
  <Teleport to="body">
    <div
      v-if="print.text != null"
      class="print-status-pill"
      :style="print.onClick ? { cursor: 'pointer' } : undefined"
      :title="print.onClick ? 'Show camera' : undefined"
      @click="print.onClick?.()"
    >{{ print.text }}</div>
  </Teleport>
</template>
