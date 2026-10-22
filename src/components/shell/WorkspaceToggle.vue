<script setup lang="ts">
// In the title bar, not the ribbon: the ribbon is a workspace's contents, and the title bar never scrolls.

import { onMounted, onUnmounted, ref } from "vue";
import Icon from "./Icon.vue";
import { onWorkspaceChange, setWorkspace, workspace, WORKSPACES } from "../../ui/workspace";
import { useUiStore } from "../../stores/ui";

const ui = useUiStore();
const active = ref(workspace());
let off: (() => void) | null = null;
onMounted(() => {
  off = onWorkspaceChange((w) => {
    active.value = w;
  });
});
onUnmounted(() => off?.());
</script>

<template>
  <!-- Hidden, not disabled, while a sketch is open: a sketch is its own mode with its own escape. -->
  <div v-if="!ui.sketchActive" id="workspace-toggle" class="segmented" role="group" aria-label="Workspace">
    <button
      v-for="w in WORKSPACES"
      :key="w.id"
      type="button"
      class="seg-btn"
      :class="{ active: active === w.id }"
      :data-workspace="w.id"
      :aria-pressed="active === w.id"
      :title="w.id === 'render' ? 'Render: materials, environment and camera' : 'Model: the full width, every tool'"
      @click="setWorkspace(w.id)"
    >
      <Icon :name="w.icon" :size="14" /><span>{{ w.label }}</span>
    </button>
  </div>
</template>
