<script setup lang="ts">
// The one sanctioned v-html in the app.
//
// It is safe for a reason that has to hold for it to stay safe: every value in
// icons.ts's pack tables is a compile-time string constant in that file. No
// document data, no file name, no network payload ever reaches it. Nothing else
// may use v-html — see the CI grep.
//
// Renders the <svg> element ITSELF rather than wrapping one, because the layout
// rules select `.ribbon-btn svg` / `.ctx-item svg` directly and a wrapper span
// would sit between them and break the flex sizing.
//
// `size` goes on as width/height ATTRIBUTES, never as an inline style. That is
// what lets a stylesheet keep the last word: `.ribbon-btn svg { width: 24px }`
// beats a presentation attribute, so the ribbon stays sized by CSS while the
// dozens of call sites with no rule of their own get the size they asked for.
// An inline style would silently invert that and shrink the ribbon.
//
// `data-icon` is the only thing a test or an e2e script can assert on now that
// these marks are paths rather than characters: `.tree-eye` used to be read
// through textContent, and an <svg> has no text content at all.

import { computed, onUnmounted, ref } from "vue";
import { iconPaths, onIconPackChange } from "../../ui/icons";

const props = withDefaults(defineProps<{ name: string; size?: number | string }>(), {
  size: 16,
});

// The active pack is module state in a plain .ts, not a store, so nothing
// tracks it. One counter per mounted icon is cheap — an icon is a leaf with no
// children to re-render — and it keeps icons.ts free of a Vue import, which
// matters because the headless *.test.ts suite imports it.
const tick = ref(0);
const stop = onIconPackChange(() => tick.value++);
onUnmounted(stop);

const paths = computed(() => {
  tick.value; // dependency: re-resolve when the user switches packs
  return iconPaths(props.name);
});
</script>

<template>
  <svg
    class="icon"
    :data-icon="name"
    viewBox="0 0 24 24"
    :width="size"
    :height="size"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    v-html="paths"
  />
</template>
