<script setup lang="ts">
import Button from "../ui/Button.vue";
import IconButton from "../ui/IconButton.vue";
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
        <Button
          v-if="t.action"
          size="sm"
          class="toast-action"
          @click="
            t.action.onClick();
            toasts.dismiss(t.id);
          "
          >{{ t.action.label }}</Button
        >
        <IconButton
          icon="close"
          tip="Dismiss"
          size="sm"
          variant="plain"
          :icon-size="12"
          class="toast-close"
          @click="toasts.dismiss(t.id)"
        />
      </div>
    </div>
  </Teleport>
</template>
