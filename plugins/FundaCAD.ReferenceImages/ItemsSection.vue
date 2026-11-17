<script setup lang="ts">
// The reference images as a folder of the browser, a click opens the image's panel.

import { computed, onUnmounted, ref, useId } from "vue";
import { useBrowserStore, useEngine } from "fundacad";
import { Icon, IconButton, InlineLabel } from "fundacad/ui";
import { patched, readRefImage, type RefImage } from "./refImage";
import { missingTick, selected, tool } from "./state";

const engine = useEngine();
const uid = useId();
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
</script>

<template>
  <template v-if="list.length">
    <div
      class="tree-folder"
      data-section="reference-images"
      style="cursor: pointer"
      @click="browser.toggle('Reference images')"
    >
      <IconButton
        class="tree-caret"
        variant="plain"
        size="sm"
        :icon="collapsed ? 'caretRight' : 'caretDown'"
        :icon-size="11"
        :tip="`${collapsed ? 'Expand' : 'Collapse'} Reference images`"
        :aria-expanded="!collapsed"
        :aria-controls="`${uid}-body`"
        @click.stop="browser.toggle('Reference images')"
      />
      <span class="feature-icon"><Icon name="ref-image" :size="14" /></span>
      <span :id="`${uid}-head`">Reference images</span>
      <span style="flex: 1"></span>
      <span class="tree-count">{{ list.length }}</span>
    </div>
    <div v-if="!collapsed" :id="`${uid}-body`" role="list" :aria-labelledby="`${uid}-head`" style="display: contents">
      <div
        v-for="r in list"
        :key="r.id"
        role="listitem"
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
          :rename="
            (name: string) => {
              if (name.trim()) set(r.id, { name: name.trim() });
            }
          "
        />
        <span v-if="missing(r.id)" style="margin-left: 6px; opacity: 0.6; font-size: var(--fs-micro, 11px)"
          >image not found</span
        >
        <span style="flex: 1"></span>
        <!-- .stop: a button sits inside the row, and a bare click would also open or close the image's panel. -->
        <IconButton
          class="ref-row-btn"
          icon="properties"
          variant="plain"
          size="sm"
          :icon-size="13"
          :tip="`Settings of ${r.name}`"
          :active="selected === r.id"
          @click.stop="selected = selected === r.id ? null : r.id"
        />
        <IconButton
          class="ref-row-btn"
          :icon="r.locked ? 'ref-locked' : 'ref-unlocked'"
          variant="plain"
          size="sm"
          :icon-size="13"
          :tip="`Lock ${r.name} against moving and calibrating`"
          :active="r.locked"
          data-action="lock"
          @click.stop="set(r.id, { locked: !r.locked })"
        />
        <IconButton
          class="ref-row-btn"
          icon="close"
          variant="plain"
          size="sm"
          :icon-size="13"
          :tip="`Delete ${r.name}`"
          data-action="delete"
          @click.stop="tool?.remove(r.id)"
        />
        <IconButton
          class="tree-eye ref-row-btn"
          :icon="r.hidden ? 'hidden' : 'visible'"
          variant="plain"
          size="sm"
          :icon-size="13"
          :tip="`${r.hidden ? 'Show' : 'Hide'} ${r.name}`"
          data-action="eye"
          @click.stop="set(r.id, { hidden: !r.hidden })"
        />
      </div>
    </div>
  </template>
</template>
