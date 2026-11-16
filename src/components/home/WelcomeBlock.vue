<script setup lang="ts">
import { MANUAL_URL, closeWelcome, openExternal } from "../../ui/welcome";
import { t } from "../../i18n";
import Button from "../ui/Button.vue";

const emit = defineEmits<{ close: [] }>();
function hide() {
  closeWelcome();
  emit("close");
}
</script>

<template>
  <section class="home-welcome" aria-labelledby="home-welcome-title">
    <h2 id="home-welcome-title" class="home-welcome-title">{{ t("home.welcome.title") }}</h2>
    <p class="home-welcome-text">{{ t("home.welcome.text") }}</p>
    <div class="home-welcome-acts">
      <Button class="home-welcome-manual" @click="void openExternal(MANUAL_URL)">{{ t("home.welcome.manual") }}</Button>
      <Button class="home-welcome-hide" @click="hide">{{ t("home.welcome.hide") }}</Button>
    </div>
  </section>
</template>
