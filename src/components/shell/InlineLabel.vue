<script setup lang="ts">
// The editing field is a separate v-if branch from the display label, so a prop change mid-edit never touches its draft.

import { nextTick, ref, useTemplateRef } from "vue";
import TextField from "../ui/TextField.vue";

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
const field = useTemplateRef<InstanceType<typeof TextField>>("field");
// One save per edit: a blur that arrives as the closed field unmounts commits again and falls out here.
let open = false;

function start() {
  if (!props.rename || renaming.value) return;
  renaming.value = true;
  open = true;
  void nextTick(() => field.value?.focus());
}

// The field itself commits on Enter and blur and reverts on Escape, these handlers only close it.
function save(name: string) {
  const n = name.trim();
  if (!open) return;
  open = false;
  if (n && n !== props.text) props.rename?.(n);
}
function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Enter" && e.key !== "Escape") return;
  e.preventDefault();
  if (e.key === "Escape") open = false;
  renaming.value = false;
}

defineExpose({ start });
</script>

<template>
  <!-- @keydown.stop keeps every keystroke out of the tree and the global keymap while editing, without it, typing a
       name made of tool shortcuts starts tools. -->
  <TextField
    v-if="renaming"
    ref="field"
    class="tree-label renaming"
    size="sm"
    commit="change"
    select-on-focus
    :model-value="text"
    @update:model-value="save"
    @keydown.stop="onKeydown"
    @blur="renaming = false"
  />
  <span v-else class="tree-label" :style="labelStyle" @dblclick="renameOnDblclick ? start() : undefined">{{
    text
  }}</span>
</template>
