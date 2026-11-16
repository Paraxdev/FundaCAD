<script setup lang="ts">
import { computed } from "vue";
import Icon from "../shell/Icon.vue";
import Button from "../ui/Button.vue";
import { t } from "../../i18n";

const emit = defineEmits<{ blank: []; open: [] }>();
// A browser tab's Open reads documents only, model files come in there by a drop.
const desktop = "__TAURI_INTERNALS__" in window;
const takes = computed(() => (desktop ? t("home.new.takesDesktop") : t("home.new.takesBrowser")));
</script>

<template>
  <div class="home-new">
    <Button variant="tile" class="home-new-card home-new-blank" @click="emit('blank')">
      <span class="home-new-pic"><Icon name="plus" :size="24" /></span>
      <span class="home-new-name">{{ t("home.new.blank") }}</span>
    </Button>
    <Button variant="tile" class="home-new-card home-open" @click="emit('open')">
      <span class="home-new-pic"><Icon name="open" :size="24" /></span>
      <span class="home-new-name">{{ t("home.new.open") }}</span>
      <span class="home-new-line">{{ takes }}</span>
    </Button>
  </div>
</template>
