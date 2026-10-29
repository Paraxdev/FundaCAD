<script setup lang="ts">
// Labels come from STEP names and user renames, InlineLabel interpolates them, and esc() would double-escape.

import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import Icon from "./Icon.vue";
import IconButton from "../ui/IconButton.vue";
import { fmtKeys } from "../../input/platform";
import InlineLabel from "./InlineLabel.vue";
import { rowIndent } from "../../ui/browserTree";
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
  /** Eye state. Omit both `toggleVis` and `eyeDown` to render no eye at all. */
  visible?: boolean | undefined;
  title?: string | undefined;
  activate?: ((e: MouseEvent) => void) | undefined;
  toggleVis?: (() => void) | undefined;
  /** A press on the eye. When given it replaces the click toggle and starts a drag that paints the same state across
   *  the rows it crosses (ui/visibilityPaint.ts). */
  eyeDown?: ((e: PointerEvent) => void) | undefined;
  /** The pointer entered this row, which is how a paint drag reaches it. */
  eyeOver?: (() => void) | undefined;
  /** "Edit" action (sketches), also double-click. */
  edit?: (() => void) | undefined;
  /** "Rename", also double-click when there is no `edit`. */
  rename?: ((name: string) => void) | undefined;
  remove?: (() => void) | undefined;
  /** Menu items prepended to the row's own (Cut all bodies, Color). */
  extraMenu?: CtxItem[] | undefined;
  /** Begin dragging this row (a body being filed into an element). Omit and the
   *  row is not draggable at all, which is what every non-body row stays. */
  dragStart?: (() => void) | undefined;
  /** Read off the store like TreeFolder's, dataTransfer is unreadable until the drop. A body on a body groups them. */
  acceptDrop?: (() => boolean) | undefined;
  dropHere?: (() => void) | undefined;
}>();

const browser = useBrowserStore();
const labelEl = useTemplateRef<InstanceType<typeof InlineLabel>>("labelEl");

const style = computed(() => ({
  ...(props.depth > 1 ? { paddingLeft: `${rowIndent(props.depth)}px` } : {}),
  // A dimmed or hidden row steps down a text colour rather than fading, so it keeps its contrast on a light card.
  ...(props.dim ? { color: "var(--text-dim)" } : {}),
}));

const labelStyle = computed(() =>
  props.toggleVis && props.visible === false ? { color: "var(--text-mute)" } : undefined,
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

// `immediate` matters: BrowserPane expands the folders when the id is set, so the matching row is usually mounted by
// that same update. Whichever row matches clears the field, so exactly one edit starts.
watch(
  () => browser.pendingRenameId,
  (id) => {
    if (!id || id !== props.id) return;
    browser.pendingRenameId = null;
    startRename();
  },
  { immediate: true },
);

function onDblClick(e: MouseEvent) {
  if (inRenameField(e)) return;
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

function onEyeDown(e: PointerEvent) {
  if (!props.eyeDown || e.button !== 0) return;
  // No text selection and no body drag out of a press that is about to paint.
  e.preventDefault();
  // A pen or finger captures its pointer to the pressed element, and a captured pointer never enters the rows below,
  // so hand the capture back.
  const el = e.currentTarget as Element | null;
  if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  props.eyeDown(e);
}
/** A pointer click was handled by its press. A click with no pointer (detail 0: keyboard, assistive tech, click())
 *  still toggles, or the eye works for a mouse only. */
function onEyeClick(e: MouseEvent) {
  if (props.eyeDown && e.detail > 0) return;
  props.toggleVis?.();
}
function onDragStart(e: DragEvent) {
  if (browser.painting) {
    e.preventDefault();
    return;
  }
  props.dragStart?.();
}

/** Shift-click takes a run of rows, so the browser's text selection across the labels is suppressed, except inside a
 *  label being renamed. A double click in that field selects a word and must not edit the row. */
function onMouseDown(e: MouseEvent) {
  if (e.shiftKey && !inRenameField(e)) e.preventDefault();
}
function inRenameField(e: Event) {
  return !!(e.target as HTMLElement | null)?.closest?.(".tree-label.renaming");
}

// Drop target: a body dropped onto this body groups them. Counter and store reasoning as in TreeFolder.
const inside = ref(0);
const canTake = computed(() => !!props.dropHere && props.acceptDrop?.() !== false);

function onOver(e: DragEvent) {
  if (!canTake.value) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
}
function onEnter() {
  if (canTake.value) inside.value++;
}
function onLeave() {
  if (inside.value > 0) inside.value--;
}
function onDrop(e: DragEvent) {
  inside.value = 0;
  if (!canTake.value) return;
  e.preventDefault();
  e.stopPropagation();
  props.dropHere?.();
}
</script>

<template>
  <div
    class="feature-row tree-child"
    :data-id="id"
    :class="{ selected: selected, error: error, 'drop-into': inside > 0 }"
    :style="style"
    :title="title"
    :draggable="!!dragStart"
    @mousedown="onMouseDown"
    @click="activate?.($event)"
    @dblclick="onDblClick"
    @contextmenu="openMenu"
    @dragstart="onDragStart"
    @dragend="browser.endDrag()"
    @dragenter="onEnter"
    @dragleave="onLeave"
    @dragover="onOver"
    @drop="onDrop"
    @pointerenter="eyeOver?.()"
  >
    <span class="feature-icon"><Icon :name="icon" :size="14" /></span>
    <span v-if="swatch" class="tree-swatch" :style="{ ...swatchStyle, background: swatch }"></span>
    <InlineLabel ref="labelEl" :text="label" :rename="rename" :label-style="labelStyle" />
    <span style="flex: 1"></span>
    <!-- .stop so the eye neither selects nor edits the row it sits in -->
    <IconButton
      v-if="toggleVis || eyeDown"
      class="tree-eye"
      variant="plain"
      size="sm"
      :icon="visible === false ? 'hidden' : 'visible'"
      :icon-size="13"
      :tip="fmtKeys('Show/hide · drag across eyes to show or hide many · Alt+click to show only this')"
      :data-visible="visible !== false"
      @pointerdown.stop="onEyeDown"
      @click.stop="onEyeClick"
      @dblclick.stop
    />
  </div>
</template>
