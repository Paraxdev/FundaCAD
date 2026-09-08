<script setup lang="ts">
// The mapping dialog, mounted only while there is a question to answer.
//
// A host and not the dialog itself, because a contributed overlay is mounted for
// as long as the capability runs while a modal's mount IS its opening — the rule
// every dialog in this app follows, and what lets the ones that gate global
// shortcuts push and pop the modal depth in onMounted/onUnmounted without ever
// leaking a count.
//
// Async, so a machine that never sends a multi-filament job never parses the
// dialog. It used to be async from App.vue for exactly this reason; the
// difference is that App.vue no longer has to know it exists.

import { defineAsyncComponent } from "vue";
import { filamentReq } from "./state";

const FilamentMappingDialog = defineAsyncComponent(() => import("./FilamentMappingDialog.vue"));
</script>

<template>
  <FilamentMappingDialog v-if="filamentReq" :req="filamentReq" />
</template>
