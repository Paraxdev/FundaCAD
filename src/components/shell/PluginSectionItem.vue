<script setup lang="ts">
import { onMounted, onUnmounted, ref, type Component } from "vue";
import TreeItem from "../ui/TreeItem.vue";

defineProps<{ itemKey: string; label: string; component: Component }>();
const emit = defineEmits<{ empty: [empty: boolean] }>();

// A section decides its own visibility, so whether it draws anything is only known from what it put in the page.
const item = ref<{ $el: Element | null } | null>(null);
const empty = ref(false);
let watcher: MutationObserver | null = null;

function check(always = false) {
  const el = item.value?.$el;
  const now = !!el && el.childElementCount === 0 && !el.textContent?.trim();
  if (now === empty.value && !always) return;
  empty.value = now;
  emit("empty", now);
}
onMounted(() => {
  check(true);
  const el = item.value?.$el;
  if (!el) return;
  watcher = new MutationObserver(() => check());
  watcher.observe(el, { childList: true, subtree: true, characterData: true });
});
onUnmounted(() => {
  watcher?.disconnect();
  if (empty.value) emit("empty", false);
});
</script>

<template>
  <TreeItem ref="item" :item-key="itemKey" :label="label" :selectable="false" :absent="empty"
    ><component :is="component"
  /></TreeItem>
</template>
