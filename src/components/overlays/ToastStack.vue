<script setup lang="ts">
import Icon from "../shell/Icon.vue";
import { useToastStore } from "../../stores/toasts";

const toasts = useToastStore();
</script>

<template>
  <!-- Teleported: the stack is position:fixed and must not inherit a stacking context from #app's grid. -->
  <Teleport to="body">
    <div v-if="toasts.items.length" class="toast-stack">
      <div v-for="t in toasts.items" :key="t.id" class="toast" :class="[`toast-${t.kind}`, { 'toast-out': t.leaving }]">
        <!-- Messages carry engine error text and document-sourced names, {{ }} escapes them. -->
        <span class="toast-msg">{{ t.message }}</span>
        <button
          v-if="t.action"
          class="toast-action"
          @click="
            t.action.onClick();
            toasts.dismiss(t.id);
          "
          >{{ t.action.label }}</button
        >
        <button class="toast-close" aria-label="Dismiss" @click="toasts.dismiss(t.id)">
          <Icon name="close" :size="12" />
        </button>
      </div>
    </div>
  </Teleport>
</template>
