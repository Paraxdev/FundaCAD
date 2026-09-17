<script setup lang="ts">
// Mounted for the life of the capability; the dialog itself is only parsed
// once there is a question to answer, same split as FilamentMappingHost.

import { defineAsyncComponent } from "vue";
import { customBedReq } from "./customBedDialog";

const CustomBedDialog = defineAsyncComponent(() => import("./CustomBedDialog.vue"));
</script>

<template>
  <CustomBedDialog v-if="customBedReq" :req="customBedReq" />
</template>
