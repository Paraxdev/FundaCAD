<script setup lang="ts">
// The Render workspace's own column: material, environment, camera.
//
// A DOCK and not a floating panel, because it is not transient. It is up for as
// long as the workspace is, it is scrolled and worked in, and a floating window
// over the model would cover the one thing every control here is judged
// against. It takes its width from the viewport rather than from the browser
// tree, so the document's structure stays readable while a finish is chosen.
//
// Three tabs, in the order the work happens: what it is made of, what it is lit
// by, what it is seen through. Each is its own component; this file is the frame
// and the tab state and knows nothing about any of them.

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

// Kept across a trip through Model and back, because coming back to the tab you
// were on is what "the workspace I left" means; reset by nothing, since there is
// nothing a reset would fix.
const tab = ref<Tab>("material");

const open = ref(workspace() === "render");
let off: (() => void) | null = null;
onMounted(() => { off = onWorkspaceChange((w) => { open.value = w === "render"; }); });
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
    <!-- v-show and not v-if: each tab holds scroll position, a search box and a
         selected row, and a tab that forgot all three every time you looked at
         the lighting would make comparing two finishes a re-navigation. -->
    <RenderMaterials v-show="tab === 'material'" />
    <RenderEnvironment v-show="tab === 'environment'" />
    <RenderCamera v-show="tab === 'camera'" />
  </aside>
</template>
