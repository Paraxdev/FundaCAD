<script setup lang="ts">
import { computed } from "vue";
import Icon from "../shell/Icon.vue";
import Button from "../ui/Button.vue";
import { exampleCard, type TemplateInfo } from "../../templates";

const props = defineProps<{ example: TemplateInfo }>();
const emit = defineEmits<{ open: [] }>();
const card = computed(() => exampleCard(props.example));
</script>

<template>
  <div class="home-cell">
    <Button variant="tile" class="home-example" :title="card.hint" @click="emit('open')">
      <span class="home-card-pic"><Icon :name="example.icon" :size="36" /></span>
      <span class="home-example-name">{{ card.name }}</span>
      <span class="home-example-line">{{ card.caption }}</span>
    </Button>
  </div>
</template>
