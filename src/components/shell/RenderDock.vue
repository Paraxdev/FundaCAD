<script setup lang="ts">
// A dock, not a floating panel: it stays up with the workspace, and a window over the model would cover what every
// control here is judged against.

import { onMounted, onUnmounted, ref } from "vue";
import Icon from "./Icon.vue";
import RenderMaterials from "./RenderMaterials.vue";
import RenderEnvironment from "./RenderEnvironment.vue";
import RenderCamera from "./RenderCamera.vue";
import { onWorkspaceChange, workspace } from "../../ui/workspace";

type Tab = "material" | "environment" | "camera";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "material", label: "Material", icon: "material" },
  { id: "environment", label: "Environment", icon: "sphere" },
  { id: "camera", label: "Camera", icon: "camera" },
];

// Kept across a trip through Model and back: coming back to the tab you were on is what the workspace you left means.
const tab = ref<Tab>("material");

const open = ref(workspace() === "render");
let off: (() => void) | null = null;
onMounted(() => {
  off = onWorkspaceChange((w) => {
    open.value = w === "render";
  });
});
onUnmounted(() => off?.());
</script>

<template>
  <aside v-if="open" id="renderdock" aria-label="Render">
    <div class="rd-tabs" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="rd-tab"
        :class="{ active: tab === t.id }"
        role="tab"
        :aria-selected="tab === t.id"
        :data-tab="t.id"
        @click="tab = t.id"
      >
        <Icon :name="t.icon" :size="14" /><span>{{ t.label }}</span>
      </button>
    </div>
    <!-- v-show, not v-if: each tab keeps its scroll position, search box and selected row, so comparing finishes needs
    no re-navigation. -->
    <RenderMaterials v-show="tab === 'material'" />
    <RenderEnvironment v-show="tab === 'environment'" />
    <RenderCamera v-show="tab === 'camera'" />
  </aside>
</template>
