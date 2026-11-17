<script setup lang="ts">
import { onMounted, ref, useId } from "vue";
import { Button } from "fundacad/ui";
import { forgetKeys, loadKeys } from "./native";

const state = ref<"loading" | "stored" | "none" | "error">("loading");
const message = ref("");
const titleId = useId();

async function refresh() {
  try {
    state.value = (await loadKeys()) ? "stored" : "none";
  } catch (e) {
    state.value = "error";
    message.value = String(e);
  }
}

async function forget() {
  try {
    await forgetKeys();
  } catch (e) {
    message.value = String(e);
  }
  await refresh();
}

onMounted(refresh);
</script>

<template>
  <div class="pref-card" role="group" :aria-labelledby="titleId">
    <div class="pref-head">
      <span :id="titleId" class="pref-title">API keys</span>
      <Button v-if="state === 'stored'" size="sm" @click="forget()">Forget keys</Button>
    </div>
    <div v-if="state === 'error'" class="sm-hint" role="alert">Error: {{ message }}</div>
    <div v-else class="sm-hint" role="status">
      <template v-if="state === 'stored'"
        >Keys are stored in the system's credential store. File, Import from Onshape link uses them.</template
      >
      <template v-else-if="state === 'none'"
        >No keys are stored. File, Import from Onshape link asks for them.</template
      >
    </div>
  </div>
</template>
