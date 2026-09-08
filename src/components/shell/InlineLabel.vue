<script setup lang="ts">
// A tree label that can be edited in place: contentEditable, select-all on
// entry, commit on Enter/blur, cancel on Escape.
//
// The editing label is a SEPARATE vnode from the display label, not one element
// with a toggled contenteditable attribute. That is load-bearing rather than
// tidy: with a single element, any prop change arriving mid-edit, a rebuild
// finishing, a sibling being renamed, an eye toggled, patches the label's text
// node, and the caret jumps to the start or disappears outright. As two
// branches of a v-if, Vue owns no binding inside the editing node at all, so it
// never touches it.
//
// The text is written by hand in start() for the same reason.

import { nextTick, ref, useTemplateRef } from "vue";

const props = defineProps<{
  /** The committed value. Shown when not editing; seeded into the editor. */
  text: string;
  /** Omit to make the label read-only. */
  rename?: ((name: string) => void) | undefined;
  /** Inline style for the DISPLAY label only (dimming a hidden row, margins). */
  labelStyle?: Record<string, string> | undefined;
  /** Start editing on a double-click of the label itself. Off by default: a tree
   *  row owns that gesture (double-click means Edit on a sketch), and only the
   *  palette slots, whose row has no other double-click meaning, want it. */
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

/** Clearing `renaming` before committing is what makes this idempotent: Enter
 *  finishes and unmounts the editor, whose blur then arrives second and falls
 *  straight back out. */
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
  <span
    v-else
    class="tree-label"
    :style="labelStyle"
    @dblclick="renameOnDblclick ? start() : undefined"
  >{{ text }}</span>
</template>
