<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import { linkReq } from "./dialog";

const LinkDialog = defineAsyncComponent(() => import("./LinkDialog.vue"));
</script>

<template>
  <LinkDialog v-if="linkReq" :req="linkReq" />
</template>
