<script setup lang="ts">
import Icon from "../shell/Icon.vue";

const emit = defineEmits<{ blank: []; open: [] }>();
// A browser tab's Open reads documents only, model files come in there by a drop.
const takes = "__TAURI_INTERNALS__" in window ? "Documents, STEP, STL, 3MF" : "FundaCAD documents";
</script>

<template>
  <div class="home-new">
    <button class="home-new-card home-new-blank" @click="emit('blank')">
      <span class="home-new-pic"><Icon name="plus" :size="24" /></span>
      <span class="home-new-name">Blank</span>
    </button>
    <button class="home-new-card home-open" @click="emit('open')">
      <span class="home-new-pic"><Icon name="open" :size="24" /></span>
      <span class="home-new-name">Open…</span>
      <span class="home-new-line">{{ takes }}</span>
    </button>
  </div>
</template>
