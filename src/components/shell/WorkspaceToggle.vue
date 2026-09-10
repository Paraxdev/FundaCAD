<script setup lang="ts">
// [ Model | Render ]: which job the window is set up for.
//
// A SEGMENTED control rather than two buttons or a dropdown, and the difference
// matters here. Two buttons would not say that picking one un-picks the other; a
// dropdown hides the alternative behind a click and gives no clue that a second
// arrangement of the app exists at all. A segment shows both states at once and
// which one you are in, which is the whole message.
//
// In the title bar, not the ribbon. The ribbon is the CONTENTS of a workspace
// (its tools change with the context), so a control that switches workspaces
// cannot live inside the thing it switches. The title bar is also the one strip
// that never scrolls, and this must never be reachable only by scrolling.

import { onMounted, onUnmounted, ref } from "vue";
import Icon from "./Icon.vue";
import { onWorkspaceChange, setWorkspace, workspace, WORKSPACES } from "../../ui/workspace";
import { useUiStore } from "../../stores/ui";

const ui = useUiStore();
const active = ref(workspace());
let off: (() => void) | null = null;
onMounted(() => { off = onWorkspaceChange((w) => { active.value = w; }); });
onUnmounted(() => off?.());
</script>

<template>
  <!-- Hidden outright while a sketch is open, rather than disabled. A sketch is
       a mode of its own with its own ribbon and its own escape, and offering a
       third arrangement of the window from inside it is offering a door that
       has to be explained. Leaving the sketch puts it back. -->
  <div v-if="!ui.sketchActive" id="workspace-toggle" class="segmented" role="group" aria-label="Workspace">
    <button
      v-for="w in WORKSPACES"
      :key="w.id"
      type="button"
      class="seg-btn"
      :class="{ active: active === w.id }"
      :data-workspace="w.id"
      :aria-pressed="active === w.id"
      :title="w.id === 'render'
        ? 'Render: materials, environment and camera'
        : 'Model: the full width, every tool'"
      @click="setWorkspace(w.id)"
    >
      <Icon :name="w.icon" :size="14" /><span>{{ w.label }}</span>
    </button>
  </div>
</template>
