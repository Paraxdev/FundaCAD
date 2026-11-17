<script setup lang="ts">
// A dock, not a floating panel: it stays up with the workspace, and a window over the model would cover what every
// control here is judged against.

import { computed, onMounted, onUnmounted, ref, useId } from "vue";
import Icon from "./Icon.vue";
import Tabs from "../ui/Tabs.vue";
import { tabPanelAttrs } from "../ui/tabIds";
import RenderMaterials from "./RenderMaterials.vue";
import RenderEnvironment from "./RenderEnvironment.vue";
import RenderCamera from "./RenderCamera.vue";
import { onWorkspaceChange, workspace } from "../../ui/workspace";
import { useHomeStore } from "../../stores/home";
import { t } from "../../i18n";

type Tab = "material" | "environment" | "camera";

const TABS = computed<{ value: Tab; label: string; icon: string }[]>(() => [
  { value: "material", label: t("render.tab.material"), icon: "material" },
  { value: "environment", label: t("render.tab.environment"), icon: "sphere" },
  { value: "camera", label: t("render.tab.camera"), icon: "camera" },
]);

// Kept across a trip through Model and back: coming back to the tab you were on is what the workspace you left means.
const tab = ref<Tab>("material");
const panels = useId();

const rendering = ref(workspace() === "render");
// Home covers only #stage, and the dock has its own grid track beside it, so Home has to put the dock away itself.
const home = useHomeStore();
const open = computed(() => rendering.value && !home.shown);
let off: (() => void) | null = null;
onMounted(() => {
  off = onWorkspaceChange((w) => {
    rendering.value = w === "render";
  });
});
onUnmounted(() => off?.());
</script>

<template>
  <aside v-if="open" id="renderdock" :aria-label="t('render.dock.label')">
    <Tabs v-model="tab" class="rd-tabs" variant="bar" :tabs="TABS" :label="t('render.dock.label')" :panels="panels">
      <template #tab="{ tab: item }"
        ><Icon :name="item.icon!" :size="14" /><span>{{ item.label }}</span></template
      >
    </Tabs>
    <!-- v-show, not v-if: each tab keeps its scroll position, search box and selected row, so comparing finishes needs
    no re-navigation. -->
    <RenderMaterials v-show="tab === 'material'" v-bind="tabPanelAttrs(panels, 'material')" />
    <RenderEnvironment v-show="tab === 'environment'" v-bind="tabPanelAttrs(panels, 'environment')" />
    <RenderCamera v-show="tab === 'camera'" v-bind="tabPanelAttrs(panels, 'camera')" />
  </aside>
</template>
