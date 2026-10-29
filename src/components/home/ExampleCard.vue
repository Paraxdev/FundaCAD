<script setup lang="ts">
import Icon from "../shell/Icon.vue";
import Button from "../ui/Button.vue";
import type { TemplateInfo } from "../../templates";

defineProps<{ example: TemplateInfo }>();
const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <div class="home-cell">
    <Button variant="tile" class="home-example" :title="example.hint" @click="emit('open')">
      <span class="home-card-pic"><Icon :name="example.icon" :size="36" /></span>
      <span class="home-example-name">{{ example.name }}</span>
      <span class="home-example-line">{{ example.caption }}</span>
    </Button>
  </div>
</template>
