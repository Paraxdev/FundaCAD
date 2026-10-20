<script setup lang="ts">
import Icon from "../shell/Icon.vue";
import { TEMPLATES } from "../../templates";

const emit = defineEmits<{ blank: []; open: []; template: [id: string] }>();
</script>

<template>
  <div class="home-new">
    <button class="home-new-card home-new-blank" @click="emit('blank')">
      <span class="home-new-pic"><Icon name="plus" :size="28" /></span>
      <span class="home-new-name">Blank</span>
    </button>
    <button
      v-for="t in TEMPLATES"
      :key="t.id"
      class="home-new-card home-new-template"
      :title="t.hint"
      @click="emit('template', t.id)"
    >
      <span class="home-new-pic"><Icon :name="t.icon" :size="28" /></span>
      <span class="home-new-name">{{ t.name }}</span>
    </button>
    <button class="home-new-card home-open" @click="emit('open')">
      <span class="home-new-pic"><Icon name="open" :size="28" /></span>
      <span class="home-new-name">Open…</span>
    </button>
  </div>
</template>
