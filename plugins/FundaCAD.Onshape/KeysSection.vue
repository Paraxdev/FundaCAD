<script setup lang="ts">
import { onMounted, ref } from "vue";
import { forgetKeys, loadKeys } from "./native";

const state = ref<"loading" | "stored" | "none" | "error">("loading");
const message = ref("");

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
  <div class="pref-card">
    <div class="pref-head">
      <span class="pref-title">API keys</span>
      <button v-if="state === 'stored'" type="button" class="btn" @click="forget()">Forget keys</button>
    </div>
    <div class="sm-hint">
      <template v-if="state === 'stored'"
        >Keys are stored in the system's credential store. File, Import from Onshape link uses them.</template
      >
      <template v-else-if="state === 'none'"
        >No keys are stored. File, Import from Onshape link asks for them.</template
      >
      <template v-else-if="state === 'error'">{{ message }}</template>
    </div>
  </div>
</template>
