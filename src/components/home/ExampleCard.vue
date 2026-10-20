<script setup lang="ts">
import Icon from "../shell/Icon.vue";
import type { TemplateInfo } from "../../templates";

defineProps<{ example: TemplateInfo }>();
const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <div class="home-cell">
    <button class="home-example" :title="example.hint" @click="emit('open')">
      <span class="home-card-pic"><Icon name="body" :size="36" /></span>
      <span class="home-example-name">{{ example.name }}</span>
      <span class="home-example-line">Example</span>
    </button>
  </div>
</template>
