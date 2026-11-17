<script setup lang="ts">
// In the title bar, not the ribbon: the ribbon is a workspace's contents, and the title bar never scrolls.

import { computed, onMounted, onUnmounted, ref } from "vue";
import Segmented from "../ui/Segmented.vue";
import { onWorkspaceChange, setWorkspace, workspace, WORKSPACES } from "../../ui/workspace";
import { useUiStore } from "../../stores/ui";
import { t } from "../../i18n";

const ui = useUiStore();
const active = ref(workspace());
let off: (() => void) | null = null;
onMounted(() => {
  off = onWorkspaceChange((w) => {
    active.value = w;
  });
});
onUnmounted(() => off?.());

const options = computed(() =>
  WORKSPACES.map((w) => ({
    value: w.id,
    label: t("shell.workspace.name", { workspace: w.id }),
    icon: w.icon,
    tip: t("shell.workspace.tip", { workspace: w.id }),
    attrs: { "data-workspace": w.id },
  })),
);
</script>

<template>
  <!-- Hidden, not disabled, while a sketch is open: a sketch is its own mode with its own escape. -->
  <Segmented
    v-if="!ui.sketchActive"
    id="workspace-toggle"
    :model-value="active"
    :options="options"
    :label="t('shell.workspace')"
    size="sm"
    activation="manual"
    @update:model-value="setWorkspace"
  />
</template>
