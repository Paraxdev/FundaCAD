<script setup lang="ts">
// One leaf row of the Browser: glyph, optional colour chip, label, eye, plus
// the structured right-click menu ([extra…] · Edit · Rename · Delete).
//
// Labels are document-sourced (STEP product names, user renames), so they go
// through an interpolation in InlineLabel. The innerHTML version needed an
// esc() on every one of them; putting esc() back would double-escape and show
// "Bracket & Plate" as "Bracket &amp; Plate".

import { computed, nextTick, useTemplateRef, watch } from "vue";
import Icon from "./Icon.vue";
import InlineLabel from "./InlineLabel.vue";
import { indent } from "../../ui/browserTree";
import { contextMenu, type CtxItem } from "../../ui/menu";
import { useBrowserStore } from "../../stores/browser";

const props = defineProps<{
  label: string;
  /** An icon NAME from ui/icons.ts, not a character, see featureMeta.ts. */
  icon: string;
  depth: number;
  /** Stable id, a row with one can be renamed programmatically (the viewport's
   *  body menu → Rename…), by way of the store's pendingRenameId. */
  id?: string | undefined;
  /** A small colored chip before the label (the body's assigned palette slot). */
  swatch?: string | undefined;
  dim?: boolean | undefined;
  selected?: boolean | undefined;
  error?: boolean | undefined;
  /** Eye state. Omit `toggleVis` to render no eye at all. */
  visible?: boolean | undefined;
  title?: string | undefined;
  activate?: ((e: MouseEvent) => void) | undefined;
  toggleVis?: (() => void) | undefined;
  /** "Edit" action (sketches), also double-click. */
  edit?: (() => void) | undefined;
  /** "Rename", also double-click when there is no `edit`. */
  rename?: ((name: string) => void) | undefined;
  /** "Delete" action. */
  remove?: (() => void) | undefined;
  /** Menu items prepended to the row's own (Cut all bodies, Color). */
  extraMenu?: CtxItem[] | undefined;
}>();

const browser = useBrowserStore();
const labelEl = useTemplateRef<InstanceType<typeof InlineLabel>>("labelEl");

const style = computed(() => ({
  ...(props.depth > 0 ? { paddingLeft: `${indent(props.depth, 26)}px` } : {}),
  ...(props.dim ? { opacity: "0.7" } : {}),
}));

const labelStyle = computed(() =>
  props.toggleVis && props.visible === false ? { opacity: ".45" } : undefined,
);

const swatchStyle = {
  display: "inline-block",
  width: "10px",
  height: "10px",
  borderRadius: "2px",
  border: "1px solid #0007",
  marginRight: "5px",
  verticalAlign: "middle",
};

function startRename() {
  // one tick: on a row that is being mounted BY this very update the template
  // ref is not assigned yet.
  void nextTick(() => labelEl.value?.start());
}

// Programmatic rename (viewport body menu → Rename…). `immediate` matters:
// BrowserPane expands the enclosing folders when the id is set, so the row that
// should start editing usually does not exist yet and is mounted by that same
// update, its watcher then fires as it is created. Whichever row matches
// clears the field, so exactly one edit starts however the row got on screen.
watch(
  () => browser.pendingRenameId,
  (id) => {
    if (!id || id !== props.id) return;
    browser.pendingRenameId = null;
    startRename();
  },
  { immediate: true },
);

function onDblClick() {
  if (props.edit) props.edit();
  else startRename();
}

function openMenu(e: MouseEvent) {
  const items: CtxItem[] = [...(props.extraMenu ?? [])];
  if (props.edit) items.push({ label: "Edit", onClick: props.edit });
  if (props.rename) items.push({ label: "Rename", onClick: startRename });
  if (props.remove) items.push({ label: "Delete", onClick: props.remove });
  if (!items.length) return;
  e.preventDefault();
  contextMenu(e.clientX, e.clientY, items);
}
</script>

<template>
  <div
    class="feature-row tree-child"
    :class="{ selected: selected, error: error }"
    :style="style"
    :title="title"
    @click="activate?.($event)"
    @dblclick="onDblClick"
    @contextmenu="openMenu"
  >
    <span class="feature-icon"><Icon :name="icon" :size="14" /></span>
    <span v-if="swatch" class="tree-swatch" :style="{ ...swatchStyle, background: swatch }"></span>
    <InlineLabel ref="labelEl" :text="label" :rename="rename" :label-style="labelStyle" />
    <span style="flex: 1"></span>
    <!-- .stop so the eye neither selects nor edits the row it sits in -->
    <span v-if="toggleVis" class="tree-eye" title="Show/hide" @click.stop="toggleVis()">
      <Icon :name="visible === false ? 'hidden' : 'visible'" :size="13" />
    </span>
  </div>
</template>
