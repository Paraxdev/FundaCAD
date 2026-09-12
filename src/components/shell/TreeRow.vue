<script setup lang="ts">
// One leaf row of the Browser: glyph, optional colour chip, label, eye, plus
// the structured right-click menu ([extra…] · Edit · Rename · Delete).
//
// Labels are document-sourced (STEP product names, user renames), so they go
// through an interpolation in InlineLabel. The innerHTML version needed an
// esc() on every one of them; putting esc() back would double-escape and show
// "Bracket & Plate" as "Bracket &amp; Plate".

import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
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
  /** Eye state. Omit both `toggleVis` and `eyeDown` to render no eye at all. */
  visible?: boolean | undefined;
  title?: string | undefined;
  activate?: ((e: MouseEvent) => void) | undefined;
  toggleVis?: (() => void) | undefined;
  /** A press on the eye. When given it replaces the click toggle: the press
   *  itself shows or hides the row and starts a drag that paints the same state
   *  across the rows it crosses (see ui/visibilityPaint.ts). */
  eyeDown?: ((e: PointerEvent) => void) | undefined;
  /** The pointer entered this row, which is how a paint drag reaches it. */
  eyeOver?: (() => void) | undefined;
  /** "Edit" action (sketches), also double-click. */
  edit?: (() => void) | undefined;
  /** "Rename", also double-click when there is no `edit`. */
  rename?: ((name: string) => void) | undefined;
  /** "Delete" action. */
  remove?: (() => void) | undefined;
  /** Menu items prepended to the row's own (Cut all bodies, Color). */
  extraMenu?: CtxItem[] | undefined;
  /** Begin dragging this row (a body being filed into an element). Omit and the
   *  row is not draggable at all, which is what every non-body row stays. */
  dragStart?: (() => void) | undefined;
  /** Can what is being dragged land on THIS row? Read off the store, not the
   *  event, for the same reason as TreeFolder: dataTransfer is unreadable until
   *  the drop. Dropping a body onto another body groups them into an element. */
  acceptDrop?: (() => boolean) | undefined;
  /** Take the drop. */
  dropHere?: (() => void) | undefined;
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

// --- the eye ---------------------------------------------------------------
function onEyeDown(e: PointerEvent) {
  if (!props.eyeDown || e.button !== 0) return;
  // No text selection and no body drag out of a press that is about to paint.
  e.preventDefault();
  // A pen or a finger captures its pointer to the element it pressed, and a
  // captured pointer never enters the rows below, so the paint could not reach
  // them. Hand the capture back.
  const el = e.currentTarget as Element | null;
  if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  props.eyeDown(e);
}
/** A pointer's click on the eye was already handled by its press (onEyeDown).
 *  A click with no pointer behind it (detail 0: the keyboard, assistive tech,
 *  element.click()) still has to toggle, or the eye works for a mouse only. */
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

/** A Shift-click takes a run of rows, and the browser's own reading of the same
 *  gesture is to extend a TEXT selection across every label between, which then
 *  sits highlighted over the rows that were just picked. Not inside a label being
 *  renamed, where Shift-click extending the selection is exactly right. */
function onMouseDown(e: MouseEvent) {
  if (e.shiftKey && !(e.target as HTMLElement | null)?.closest?.("[contenteditable='true']")) e.preventDefault();
}

// --- drop target (a body dropped onto this body groups them) --------------
// Same counter-not-flag and read-the-store-not-the-event reasoning as
// TreeFolder; see there.
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
    <span
      v-if="toggleVis || eyeDown"
      class="tree-eye"
      title="Show/hide · drag across eyes to show or hide many · Alt+click to show only this"
      @pointerdown.stop="onEyeDown"
      @click.stop="onEyeClick"
      @dblclick.stop
    >
      <Icon :name="visible === false ? 'hidden' : 'visible'" :size="13" />
    </span>
  </div>
</template>
