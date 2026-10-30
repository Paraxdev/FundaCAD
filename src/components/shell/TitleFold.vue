<script setup lang="ts">
// The title bar's document name and workspace toggle at the top of the File menu, once the bar is too narrow for them.

import { onMounted, onUnmounted, ref } from "vue";
import MenuItem from "../ui/MenuItem.vue";
import MenuSeparator from "../ui/MenuSeparator.vue";
import { useUiStore } from "../../stores/ui";
import { onWorkspaceChange, setWorkspace, workspace, WORKSPACES } from "../../ui/workspace";

const ui = useUiStore();
const active = ref(workspace());
let off: () => void = () => {};
onMounted(() => {
  off = onWorkspaceChange((w) => {
    active.value = w;
  });
});
onUnmounted(() => off());
</script>

<template>
  <!-- For the eye: a caption row is never focused, and a screen reader has the name from the window title, which
       unsavedGuard.ts keeps as the document name and its unsaved state. -->
  <div class="tb-fold-doc" :class="{ dirty: ui.dirty }" aria-hidden="true">
    {{ ui.docName }}<span v-if="ui.dirty" class="dirty-mark">*</span>
  </div>
  <template v-if="!ui.sketchActive">
    <MenuItem
      v-for="w in WORKSPACES"
      :key="w.id"
      class="menu-item"
      :label="`${w.label} Workspace`"
      :checked="active === w.id"
      :data-fold-workspace="w.id"
      @select="setWorkspace(w.id)"
    />
  </template>
  <MenuSeparator />
</template>
