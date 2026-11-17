<script setup lang="ts">
import { onMounted, ref, useId } from "vue";
import { Button } from "fundacad/ui";
import { t } from "./lines";
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
      <span :id="titleId" class="pref-title">{{ t("keys.title") }}</span>
      <Button v-if="state === 'stored'" size="sm" @click="forget()">{{ t("keys.forget") }}</Button>
    </div>
    <div v-if="state === 'error'" class="sm-hint" role="alert">{{ t("error.prefix", { message }) }}</div>
    <div v-else class="sm-hint" role="status">
      <template v-if="state === 'stored'">{{ t("keys.stored") }}</template>
      <template v-else-if="state === 'none'">{{ t("keys.none") }}</template>
    </div>
  </div>
</template>
