<script setup lang="ts">
import Icon from "../shell/Icon.vue";
import { useToastStore } from "../../stores/toasts";

const toasts = useToastStore();
</script>

<template>
  <!-- Teleported to body rather than rendered in place: the stack is
       position:fixed and must not inherit a stacking context from #app's grid,
       which is what document.body.appendChild bought the imperative version. -->
  <Teleport to="body">
    <div v-if="toasts.items.length" class="toast-stack">
      <div
        v-for="t in toasts.items"
        :key="t.id"
        class="toast"
        :class="[`toast-${t.kind}`, { 'toast-out': t.leaving }]"
      >
        <!-- {{ }} escapes; the old code used textContent for the same reason.
             Messages carry engine error text and document-sourced names. -->
        <span class="toast-msg">{{ t.message }}</span>
        <button
          v-if="t.action"
          class="toast-action"
          @click="t.action.onClick(); toasts.dismiss(t.id)"
        >{{ t.action.label }}</button>
        <button class="toast-close" aria-label="Dismiss" @click="toasts.dismiss(t.id)">
          <Icon name="close" :size="12" />
        </button>
      </div>
    </div>
  </Teleport>
</template>
