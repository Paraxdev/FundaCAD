<script setup lang="ts">
// The editing label is a separate v-if branch from the display label, so a prop change mid-edit never patches its text
// node and moves the caret. start() writes the text by hand for the same reason.

import { nextTick, ref, useTemplateRef } from "vue";

const props = defineProps<{
  text: string;
  /** Omit to make the label read-only. */
  rename?: ((name: string) => void) | undefined;
  /** Inline style for the DISPLAY label only (dimming a hidden row, margins). */
  labelStyle?: Record<string, string> | undefined;
  /** Start editing on a double-click of the label. Off by default, a tree row owns that gesture (Edit on a sketch). */
  renameOnDblclick?: boolean | undefined;
}>();

const renaming = ref(false);
const editEl = useTemplateRef<HTMLElement>("editEl");

function start() {
  if (!props.rename || renaming.value) return;
  renaming.value = true;
  void nextTick(() => {
    const el = editEl.value;
    if (!el) return;
    el.textContent = props.text;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
}

/** Clearing `renaming` first makes this idempotent: Enter unmounts the editor, whose blur then arrives and falls out. */
function finish(save: boolean) {
  if (!renaming.value) return;
  const name = (editEl.value?.textContent ?? "").trim();
  renaming.value = false;
  if (save && name && name !== props.text) props.rename?.(name);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    finish(true);
  } else if (e.key === "Escape") {
    e.preventDefault();
    finish(false);
  }
}

defineExpose({ start });
</script>

<template>
  <!-- @keydown.stop keeps every keystroke out of the global keymap while
       editing, without it, typing a name made of tool shortcuts starts tools. -->
  <span
    v-if="renaming"
    ref="editEl"
    class="tree-label renaming"
    contenteditable="true"
    @keydown.stop="onKeydown"
    @blur="finish(true)"
  ></span>
  <span v-else class="tree-label" :style="labelStyle" @dblclick="renameOnDblclick ? start() : undefined">{{
    text
  }}</span>
</template>
