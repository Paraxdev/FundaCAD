<script setup lang="ts">
// A host rather than the dialog, since a contributed overlay is mounted while the capability runs and a modal's mount
// IS its opening. Async, so a machine that never sends a multi-filament job never parses the dialog.

import { defineAsyncComponent } from "vue";
import { filamentReq } from "./state";

const FilamentMappingDialog = defineAsyncComponent(() => import("./FilamentMappingDialog.vue"));
</script>

<template>
  <FilamentMappingDialog v-if="filamentReq" :req="filamentReq" />
</template>
