<script setup lang="ts">
// The label comes from untrusted STEP names, so it is interpolated, never markup, and esc() would double-escape.
// Rename, menu and drop are opt-in by prop, without them the head is a read-only heading.

import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import Icon from "./Icon.vue";
import IconButton from "../ui/IconButton.vue";
import { fmtKeys } from "../../input/platform";
import InlineLabel from "./InlineLabel.vue";
import { folderIndent } from "../../ui/browserTree";
import { contextMenu, type CtxItem } from "../../ui/menu";
import { useBrowserStore } from "../../stores/browser";

const props = defineProps<{
  label: string;
  /** An icon NAME from ui/icons.ts, not a character, see featureMeta.ts. */
  icon: string;
  count: number;
  depth: number;
  collapsed: boolean;
  /** Eye state. Omit both `toggleVis` and `eyeDown` to render no eye at all. */
  visible?: boolean | undefined;
  toggleVis?: (() => void) | undefined;
  /** A press on the eye, which replaces the click toggle when given; see TreeRow. */
  eyeDown?: ((e: PointerEvent) => void) | undefined;
  /** The pointer entered this head, which is how a paint drag reaches it. */
  eyeOver?: (() => void) | undefined;
  /** Stable id (an element's), so a head can be renamed programmatically the
   *  way a row can, through the store's pendingRenameId. */
  id?: string | undefined;
  /** Omit to leave the head read-only. */
  rename?: ((name: string) => void) | undefined;
  /** Extra right-click rows, above Rename/Delete. */
  extraMenu?: CtxItem[] | undefined;
  /** "Delete" row on the right-click menu. */
  remove?: (() => void) | undefined;
  /** Begin dragging whatever this head stands for. */
  dragStart?: (() => void) | undefined;
  /** Asked on every dragover, so it reads the drag off the store: dataTransfer is unreadable until the drop. */
  acceptDrop?: (() => boolean) | undefined;
  dropHere?: (() => void) | undefined;
  /** Given, a click on the head selects what the folder holds and only the caret
   *  (or a double-click) opens and closes it. */
  activate?: ((e: MouseEvent) => void) | undefined;
  selected?: boolean | undefined;
}>();

const emit = defineEmits<{ toggle: [] }>();

const browser = useBrowserStore();
const labelEl = useTemplateRef<InstanceType<typeof InlineLabel>>("labelEl");

// Only nested heads carry an inline padding, so a top-level folder keeps
// whatever the stylesheet gives it.
const style = computed(() => (props.depth > 0 ? { paddingLeft: `${folderIndent(props.depth)}px` } : undefined));

function onClick(e: MouseEvent) {
  if (props.activate && !(e.target as HTMLElement | null)?.closest?.(".tree-caret")) props.activate(e);
  else emit("toggle");
}

// A caret left focused by a mouse click would fold the folder again on a later Enter or Space.
function onCaretClick(e: MouseEvent) {
  if (e.detail > 0) (e.currentTarget as HTMLElement | null)?.blur();
}

function onDblClick(e: MouseEvent) {
  if (!props.activate || (e.target as HTMLElement | null)?.closest?.(".tree-caret, .tree-label.renaming")) return;
  emit("toggle");
}

/** Same reason as TreeRow: Shift-click takes a run, not a text selection. */
function onMouseDown(e: MouseEvent) {
  if (e.shiftKey && !(e.target as HTMLElement | null)?.closest?.(".tree-label.renaming")) e.preventDefault();
}

function startRename() {
  void nextTick(() => labelEl.value?.start());
}

// A freshly made element starts its own rename, so naming it is typing. Same field and immediate watch as TreeRow.
watch(
  () => browser.pendingRenameId,
  (id) => {
    if (!id || id !== props.id) return;
    browser.pendingRenameId = null;
    startRename();
  },
  { immediate: true },
);

function openMenu(e: MouseEvent) {
  const items: CtxItem[] = [...(props.extraMenu ?? [])];
  if (props.rename) items.push({ label: "Rename", onClick: startRename });
  if (props.remove) items.push({ label: "Delete", danger: true, onClick: props.remove });
  if (!items.length) return;
  e.preventDefault();
  e.stopPropagation();
  contextMenu(e.clientX, e.clientY, items);
}

// The eye, handled as in TreeRow.
function onEyeDown(e: PointerEvent) {
  if (!props.eyeDown || e.button !== 0) return;
  e.preventDefault();
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

// A counter, not a flag: dragenter and dragleave also fire across the head's child spans, and a flag would flicker.
const inside = ref(0);
const canTake = computed(() => !!props.dropHere && props.acceptDrop?.() !== false);

function onOver(e: DragEvent) {
  if (!canTake.value) return;
  e.preventDefault(); // the only way to say "a drop is allowed here"
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
  <!-- The head carries aria-expanded as well as the caret, since a click on the head itself may toggle it. -->
  <div
    class="tree-folder"
    :data-id="id"
    :class="{ 'drop-into': inside > 0, selected: selected }"
    :style="style"
    :aria-expanded="!collapsed"
    :draggable="!!dragStart"
    @mousedown="onMouseDown"
    @click="onClick"
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
    <IconButton
      class="tree-caret"
      variant="plain"
      size="sm"
      :icon="collapsed ? 'caretRight' : 'caretDown'"
      :icon-size="11"
      :tip="collapsed ? 'Expand' : 'Collapse'"
      :aria-expanded="!collapsed"
      @click="onCaretClick"
    />
    <span class="feature-icon"><Icon :name="icon" :size="14" /></span>
    <InlineLabel ref="labelEl" :text="label" :rename="rename" />
    <span style="flex: 1"></span>
    <span class="tree-count">{{ count || "" }}</span>
    <!-- .stop: the eye sits inside the head, and a bare click would also
         collapse the section it is trying to hide. -->
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
    />
  </div>
</template>
