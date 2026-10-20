<script setup lang="ts">
// The document's reference images as a folder of the browser: show or hide,
// rename, lock, delete, and a click opens the image's panel.

import { computed, onUnmounted, ref } from "vue";
import { useBrowserStore, useEngine } from "fundacad";
import { Icon, InlineLabel } from "fundacad/ui";
import { patched, readRefImage, type RefImage } from "./refImage";
import { missingTick, selected, tool } from "./state";

const engine = useEngine();
const browser = useBrowserStore();
const list = ref<RefImage[]>([]);
const off = engine.store.onReferenceImagesChange((l) => {
  list.value = l.map(readRefImage).filter((r): r is RefImage => r !== null);
});
onUnmounted(off);

const collapsed = computed(() => browser.isCollapsed("Reference images"));
const missing = (id: string) => {
  missingTick.value;
  return tool.value?.missing(id) ?? false;
};

function set(id: string, change: Partial<RefImage>) {
  engine.store.setReferenceImages(patched(engine.store.referenceImages(), id, change));
}

const iconBtn = "background: none; border: none; color: inherit; cursor: pointer; padding: 0 3px; opacity: 0.75";
</script>

<template>
  <template v-if="list.length">
    <div class="tree-folder" data-section="reference-images" :aria-expanded="!collapsed" @click="browser.toggle('Reference images')">
      <span class="tree-caret"><Icon :name="collapsed ? 'caretRight' : 'caretDown'" :size="11" /></span>
      <span class="feature-icon"><Icon name="ref-image" :size="14" /></span>
      <span>Reference images</span>
      <span style="flex: 1"></span>
      <span class="tree-count">{{ list.length }}</span>
    </div>
    <template v-if="!collapsed">
      <div
        v-for="r in list"
        :key="r.id"
        class="feature-row tree-child"
        :class="{ selected: selected === r.id }"
        :data-ref-image="r.id"
        :title="missing(r.id) ? 'The image file is not in this document or the engine store' : r.name"
        @click="selected = selected === r.id ? null : r.id"
      >
        <span class="feature-icon"><Icon name="ref-image" :size="14" /></span>
        <InlineLabel
          :text="r.name"
          :label-style="{ marginLeft: '4px', opacity: r.hidden ? '0.5' : '1' }"
          rename-on-dblclick
          :rename="(name: string) => { if (name.trim()) set(r.id, { name: name.trim() }); }"
        />
        <span v-if="missing(r.id)" style="margin-left: 6px; opacity: 0.6; font-size: 11px">image not found</span>
        <span style="flex: 1"></span>
        <button
          :style="iconBtn"
          :title="r.locked ? 'Locked, click to unlock' : 'Lock against moving and calibrating'"
          data-action="lock"
          @click.stop="set(r.id, { locked: !r.locked })"
        ><Icon :name="r.locked ? 'ref-locked' : 'ref-unlocked'" :size="13" /></button>
        <button :style="iconBtn" title="Delete the reference image" data-action="delete" @click.stop="tool?.remove(r.id)">
          <Icon name="close" :size="13" />
        </button>
        <span class="tree-eye" title="Show/hide" data-action="eye" @click.stop="set(r.id, { hidden: !r.hidden })">
          <Icon :name="r.hidden ? 'hidden' : 'visible'" :size="13" />
        </span>
      </div>
    </template>
  </template>
</template>
