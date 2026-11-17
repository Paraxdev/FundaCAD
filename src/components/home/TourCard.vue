<script setup lang="ts">
import Icon from "../shell/Icon.vue";
import Button from "../ui/Button.vue";
import { t } from "../../i18n";

const emit = defineEmits<{ start: [] }>();
</script>

<template>
  <div class="home-cell home-tour">
    <!-- An example card in all but what it opens, so it wears the same tile. -->
    <Button
      variant="tile"
      class="home-example"
      data-action="first-bracket"
      :title="t('home.firstBracket.hint')"
      @click="emit('start')"
    >
      <span class="home-card-pic"><Icon name="play" :size="36" /></span>
      <span class="home-example-name">{{ t("home.firstBracket.name") }}</span>
      <span class="home-example-line">{{ t("home.firstBracket.caption") }}</span>
    </Button>
  </div>
</template>
