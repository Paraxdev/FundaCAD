<script setup lang="ts">
import { useId } from "vue";
import Icon from "../shell/Icon.vue";

withDefaults(defineProps<{ title: string; collapsible?: boolean }>(), { collapsible: false });
const collapsed = defineModel<boolean>("collapsed", { default: false });
const titleId = useId();
const bodyId = useId();
</script>

<template>
  <section class="float-card ui-card" :class="{ 'is-collapsed': collapsed }" :aria-labelledby="titleId">
    <div class="float-card-head">
      <button
        v-if="collapsible"
        :id="titleId"
        type="button"
        class="float-card-title ui-card-toggle"
        :aria-expanded="!collapsed"
        :aria-controls="bodyId"
        @click="collapsed = !collapsed"
      >
        <Icon class="ui-card-caret" name="caretRight" :size="10" />
        {{ title }}
      </button>
      <span v-else :id="titleId" class="float-card-title">{{ title }}</span>
      <slot name="head-actions" />
    </div>
    <div v-show="!collapsed" :id="bodyId" class="float-card-body"><slot /></div>
    <div v-if="$slots.foot" v-show="!collapsed" class="float-card-foot"><slot name="foot" /></div>
  </section>
</template>
