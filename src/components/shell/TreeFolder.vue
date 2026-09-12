<script setup lang="ts">
// A collapsible section head in the Browser: caret, glyph, label, count badge
// and (for assembly nodes and anything else that can be hidden wholesale) an eye.
//
// The label is document-sourced, assembly node names come straight out of an
// untrusted STEP file, so it is an interpolation, never markup. That is what
// replaced the esc() calls the innerHTML version needed; adding esc() back here
// would double-escape and render a product called "Bracket & Plate" as
// "Bracket &amp; Plate".
//
// A head is also renameable, right-clickable and a drop target now, because an
// ELEMENT is a folder the user owns rather than a fact about a file (see
// document/elements.ts). Every one of those is opt-in by prop: pass no `rename`,
// no menu and no `dropHere` and the head is exactly the read-only heading it
// always was, which is what "Origin", "Sketches" and an assembly node stay.

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
  /** Can what is being dragged land here? Asked on every dragover, which is why
   *  it reads the drag off the store rather than the event: dataTransfer cannot
   *  be read until the drop, i.e. never at the moment a target has to decide. */
  acceptDrop?: (() => boolean) | undefined;
  /** Take the drop. */
  dropHere?: (() => void) | undefined;
}>();

defineEmits<{ toggle: [] }>();

const browser = useBrowserStore();
const labelEl = useTemplateRef<InstanceType<typeof InlineLabel>>("labelEl");

// Only nested heads carry an inline padding, so a top-level folder keeps
// whatever the stylesheet gives it.
const style = computed(() =>
  props.depth > 0 ? { paddingLeft: `${indent(props.depth, 8)}px` } : undefined,
);

function startRename() {
  void nextTick(() => labelEl.value?.start());
}

// A freshly made element starts its own rename: the folder appears with its
// name selected, so naming it is typing rather than a second gesture. Same
// field and the same immediate-watch reasoning as TreeRow, see there.
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

// --- the eye, same handling as TreeRow's -----------------------------------
function onEyeDown(e: PointerEvent) {
  if (!props.eyeDown || e.button !== 0) return;
  e.preventDefault();
  const el = e.currentTarget as Element | null;
  if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  props.eyeDown(e);
}
function onEyeClick() {
  if (!props.eyeDown) props.toggleVis?.();
}
function onDragStart(e: DragEvent) {
  if (browser.painting) {
    e.preventDefault();
    return;
  }
  props.dragStart?.();
}

// --- drag and drop -------------------------------------------------------
//
// A COUNTER rather than a flag: dragenter/dragleave also fire as the pointer
// crosses the head's own child spans, and a boolean flickers off halfway
// through the row it is supposed to be highlighting.
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
  <!-- aria-expanded is the disclosure state a screen reader announces, and it is
       also the only place that state is legible from outside: the caret is an
       icon, so its element carries no text to read it off. -->
  <div
    class="tree-folder"
    :class="{ 'drop-into': inside > 0 }"
    :style="style"
    :aria-expanded="!collapsed"
    :draggable="!!dragStart"
    @click="$emit('toggle')"
    @contextmenu="openMenu"
    @dragstart="onDragStart"
    @dragend="browser.endDrag()"
    @dragenter="onEnter"
    @dragleave="onLeave"
    @dragover="onOver"
    @drop="onDrop"
    @pointerenter="eyeOver?.()"
  >
    <span class="tree-caret"><Icon :name="collapsed ? 'caretRight' : 'caretDown'" :size="11" /></span>
    <span class="feature-icon"><Icon :name="icon" :size="14" /></span>
    <InlineLabel ref="labelEl" :text="label" :rename="rename" />
    <span style="flex: 1"></span>
    <span class="tree-count">{{ count || "" }}</span>
    <!-- .stop: the eye sits inside the head, and a bare click would also
         collapse the section it is trying to hide. -->
    <span
      v-if="toggleVis || eyeDown"
      class="tree-eye"
      title="Show/hide · drag across eyes to show or hide many · Alt+click to show only this"
      @pointerdown.stop="onEyeDown"
      @click.stop="onEyeClick"
    >
      <Icon :name="visible === false ? 'hidden' : 'visible'" :size="13" />
    </span>
  </div>
</template>
