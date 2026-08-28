<script setup lang="ts">
// A collapsible section head in the Browser: caret, glyph, label, count badge
// and (for assembly nodes and anything else that can be hidden wholesale) an eye.
//
// The label is document-sourced — assembly node names come straight out of an
// untrusted STEP file — so it is an interpolation, never markup. That is what
// replaced the esc() calls the innerHTML version needed; adding esc() back here
// would double-escape and render a product called "Bracket & Plate" as
// "Bracket &amp; Plate".

import { computed } from "vue";
import Icon from "./Icon.vue";
import { indent } from "../../ui/browserTree";

const props = defineProps<{
  label: string;
  /** An icon NAME from ui/icons.ts, not a character — see featureMeta.ts. */
  icon: string;
  count: number;
  depth: number;
  collapsed: boolean;
  /** Eye state. Omit `toggleVis` to render no eye at all. */
  visible?: boolean | undefined;
  toggleVis?: (() => void) | undefined;
}>();

defineEmits<{ toggle: [] }>();

// Only nested heads carry an inline padding, so a top-level folder keeps
// whatever the stylesheet gives it.
const style = computed(() =>
  props.depth > 0 ? { paddingLeft: `${indent(props.depth, 8)}px` } : undefined,
);
</script>

<template>
  <!-- aria-expanded is the disclosure state a screen reader announces, and it is
       also the only place that state is legible from outside: the caret is an
       icon, so its element carries no text to read it off. -->
  <div class="tree-folder" :style="style" :aria-expanded="!collapsed" @click="$emit('toggle')">
    <span class="tree-caret"><Icon :name="collapsed ? 'caretRight' : 'caretDown'" :size="11" /></span>
    <span class="feature-icon"><Icon :name="icon" :size="14" /></span>
    <span class="tree-label">{{ label }}</span>
    <span style="flex: 1"></span>
    <span class="tree-count">{{ count || "" }}</span>
    <!-- .stop: the eye sits inside the head, and a bare click would also
         collapse the section it is trying to hide. -->
    <span v-if="toggleVis" class="tree-eye" title="Show/hide" @click.stop="toggleVis()">
      <Icon :name="visible === false ? 'hidden' : 'visible'" :size="13" />
    </span>
  </div>
</template>
