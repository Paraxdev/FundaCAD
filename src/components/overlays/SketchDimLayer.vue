<script setup lang="ts">
// Persistent, editable dimension annotations on committed sketch geometry.
// Replaces the DOM half of sketch/sketchDimensions.ts, which stays as the facade
// SketchMode talks to (its constructor, method names and hook fields are
// unchanged — see that file's header).
//
// The line this component draws, and the reason it is not "just" a v-for:
//
//   STRUCTURE is reactive. Which labels exist, what each reads, its class list,
//   which one is selected, which one is being typed into.
//
//   POSITION is not, and must not be. Every label is projected from sketch mm
//   through the sketch plane and the live camera to screen px, on every frame
//   the camera moves. The loop at the bottom writes style.transform straight
//   onto elements it collected into a PLAIN array — no ref, no reactive(), no
//   scheduler. TimelineBar.vue's rollback drag and RibbonBar.vue's width
//   measurement draw the same line for the same reason.
//
// The label drag, the pointer-capture bookkeeping and the value editor's
// focus/select are imperative here too: they are pointer- and cursor-rate code
// resolved against the plane, not state anybody renders from.

import * as THREE from "three";
import { nextTick, onUnmounted, ref, watch } from "vue";
import { camHash } from "../../viewport/camHash";
import { screenTransform } from "../../sketch/annotationFormat";
import { useSketchAnnotationStore } from "../../stores/sketchAnnotations";
import type { DimItem } from "../../sketch/sketchDimensions";
import { displayValue, isPlainNumber, parseField } from "../../ui/units";

const s = useSketchAnnotationStore();

// --- position: deliberately outside reactivity ----------------------------
const els: (HTMLElement | null)[] = [];
const scratch = new THREE.Vector3();
let lastCamHash = "";
let raf = 0;

function loop() {
  raf = requestAnimationFrame(loop);
  const plane = s.dimPlane;
  const vp = s.dimViewport;
  if (!plane || !vp) return;
  // skip the per-label projection + DOM writes when the camera hasn't moved
  const hash = camHash(vp.camera);
  if (hash === lastCamHash) return;
  lastCamHash = hash;
  const items = s.dimItems;
  for (let i = 0; i < items.length; i++) {
    const el = els[i];
    const l = items[i];
    if (!el || !l) continue;
    plane.to3D(l.anchor.x, l.anchor.y, scratch);
    const p = vp.projectToScreen(scratch);
    el.style.transform = screenTransform(p.x, p.y);
  }
}

function stop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

watch(
  () => s.dimPlane,
  (plane) => {
    if (!plane) stop();
    else if (!raf) loop();
  },
  { immediate: true },
);

watch(
  () => s.dimItems,
  () => {
    // A rebuild replaces the label a drag is riding on — drop the drag so its
    // move/up handlers can't write a placement against stale geometry.
    drag = null;
    // The new set is at the same camera as the old one, so the hash check would
    // otherwise skip it forever.
    lastCamHash = "";
    // A rebuild is also what ends an edit (the class wiped its innerHTML here).
    editing.value = null;
    editError.value = null;
  },
  { flush: "post" },
);

onUnmounted(stop);

// --- selection -----------------------------------------------------------
// Which label the Delete key acts on. Set by a click or a right-click, dropped
// on the next rebuild by showDims() — a selection whose label no longer exists
// must not keep a stale delete armed.
function select(i: number) {
  s.dimSelected = i;
}

// --- label drag (placement) ----------------------------------------------
// A label is a click target first: under DRAG_PX of movement the release must
// still open the value editor. Past it, the label follows the cursor and the
// release freezes the placement. Matches the 4px / `dragMoved` idiom
// SketchMode's body-drag and moveDrag already use.
const DRAG_PX = 4;

interface Drag {
  item: DimItem;
  el: HTMLElement;
  startClient: { x: number; y: number };
  from: THREE.Vector2; // grab point on the plane, in sketch mm
  base: THREE.Vector2; // the label's placement when the drag started
  last: THREE.Vector2 | null; // the last placement that resolved on the plane
  moved: boolean;
}
/** plain, not a ref: read and written at pointer rate, rendered by nobody */
let drag: Drag | null = null;
/** a drag's release must not also open the value editor (the browser still
 *  fires `click` after `pointerup`). Cleared on the next pointerdown, so a
 *  normal click on any label right after a drag still edits. */
let suppressClick = false;

function onDown(e: PointerEvent, i: number, l: DimItem) {
  e.stopPropagation();
  // Primary button only. A badge sits ON the geometry it labels — a line's
  // length badge lands at the midpoint, exactly where a user aims to right-click
  // that line — and overlapPick REPLACES the selection with the single entity
  // under the cursor. So an unguarded right press ate a two-entity selection
  // before its constraint menu was ever built, and rebuilt the badge out from
  // under its own contextmenu handler. A secondary press selects nothing, starts
  // no drag, and leaves this element alive for the menu; middle-drag stays pan.
  if (e.button !== 0) return;
  suppressClick = false;
  l.suppressEdit = s.dimHooks?.overlapPick(e) ?? false;
  // overlapPick rebuilds every label when geometry claims the pick, so the
  // element under the cursor may already have been patched away — never start a
  // drag on top of that.
  if (l.suppressEdit) return;
  select(i);
  beginDrag(l, e.currentTarget as HTMLElement, e);
}

function beginDrag(item: DimItem, el: HTMLElement, e: PointerEvent) {
  if (!item.placeCommit || !item.place) return;
  const from = s.dimHooks?.planePoint(e.clientX, e.clientY) ?? null;
  if (!from) return; // no plane hook, or the cursor ray misses it (grazing view)
  drag = {
    item, el,
    startClient: { x: e.clientX, y: e.clientY },
    from,
    base: item.place.clone(),
    last: null,
    moved: false,
  };
  el.setPointerCapture(e.pointerId);
}

/** the drag's placement at the current cursor: the grab-time placement plus the
 *  cursor delta measured ON THE SKETCH PLANE (never in screen px) */
function placeAt(clientX: number, clientY: number): THREE.Vector2 | null {
  const d = drag;
  const now = d && s.dimHooks?.planePoint(clientX, clientY);
  if (!d || !now) return null;
  return d.base.clone().add(now).sub(d.from);
}

function onDragMove(e: PointerEvent) {
  const d = drag;
  if (!d) return;
  if (!d.moved) {
    const dx = e.clientX - d.startClient.x, dy = e.clientY - d.startClient.y;
    if (dx * dx + dy * dy < DRAG_PX ** 2) return; // still a click
    d.moved = true;
  }
  e.stopPropagation();
  const p = placeAt(e.clientX, e.clientY);
  if (!p) return;
  d.last = p;
  // the host re-lays-out the dim and hands back where its label really goes — a
  // perpendicular-only or radial-only dim tracks the cursor's useful component
  // and ignores the rest, with no jump when the drag ends
  const anchor = d.item.placeCommit!(p.x, p.y, false);
  if (anchor) {
    // anchor is a raw THREE.Vector2 mutated in place; the rAF loop reads it next
    // frame, which is why the camera hash has to be invalidated by hand here
    d.item.anchor.copy(anchor);
    lastCamHash = "";
  }
}

function onDragEnd(e: PointerEvent) {
  const d = drag;
  if (!d) return;
  drag = null;
  if (d.el.hasPointerCapture(e.pointerId)) d.el.releasePointerCapture(e.pointerId);
  if (!d.moved) return; // a plain click: leave it to the click handler
  e.stopPropagation();
  suppressClick = true; // the click that follows this release is not an edit
  // a release whose cursor misses the plane (grazing view) falls back to the
  // last placement that did resolve, so the final rebuild still happens and the
  // labels can't be left showing a half-finished drag
  const p = placeAt(e.clientX, e.clientY) ?? d.last;
  if (p) d.item.placeCommit!(p.x, p.y, true);
}

// --- right-click ---------------------------------------------------------
// The discoverable half of deleting a dimension; the Delete key (handled by
// SketchMode via deleteSelected()) is the shortcut. A dimensional constraint has
// no constraint glyph — glyphs.ts deliberately skips them, since they already
// draw as dimension badges — so without these two there is no way to remove one
// short of deleting the geometry under it. Reported 2026-08-02.
function onContextMenu(e: MouseEvent, i: number, l: DimItem) {
  e.preventDefault();
  e.stopPropagation();
  select(i);
  s.dimHooks?.labelMenu(e, l.onDelete ? () => l.onDelete!() : null);
}

// --- value editor --------------------------------------------------------
const editing = ref<number | null>(null);
const editText = ref("");
const editError = ref<string | null>(null);

function onClick(e: MouseEvent, i: number, l: DimItem) {
  if (l.driven) return; // reference dimension: read-only, but still draggable
  e.stopPropagation();
  if (l.suppressEdit || suppressClick) {
    l.suppressEdit = false;
    suppressClick = false;
    return;
  }
  beginEdit(i, l);
}

// Escape hatch. A label that floats over its own geometry loses every single
// click to the pick underneath (overlapPick), which would leave it permanently
// uneditable — and in the dimension tool an in-progress dimension claims clicks
// too. A double-click is unambiguous, so it edits regardless of who won the
// singles.
function onDblClick(e: MouseEvent, i: number, l: DimItem) {
  if (l.driven) return;
  e.stopPropagation();
  l.suppressEdit = false;
  suppressClick = false;
  beginEdit(i, l);
}

function beginEdit(i: number, l: DimItem) {
  if (editing.value === i) return; // already editing — a dblclick after a click
  editing.value = i;
  editError.value = null;
  // a param-driven dim reopens its EXPRESSION (Fusion behaviour); a plain dim
  // opens its value in display units
  editText.value = l.fx ? l.expr! : String(displayValue(l.valueMm, l.kind));
  void nextTick(() => {
    const input = els[i]?.querySelector("input");
    input?.focus();
    input?.select();
  });
}

function revert() {
  editing.value = null;
  editError.value = null;
}

function onEditKey(e: KeyboardEvent, l: DimItem) {
  // stop, always: typing a dimension must not also reach the global keymap
  e.stopPropagation();
  if (e.key === "Enter") {
    const raw = editText.value.trim();
    if (l.commitExpr && (!isPlainNumber(raw) || l.expr !== undefined)) {
      // formulas — and any edit to an already-bound dim — go through the
      // expression path so the binding stays consistent
      const err = l.commitExpr(raw);
      if (err) editError.value = err;
      return; // success: refreshActive() rebuilds the labels
    }
    const val = parseField(raw, l.kind ?? "length");
    // lengths must be positive; angles may be any finite (signed) value
    const ok = val != null && (l.kind === "angle" ? Number.isFinite(val) : val > 0);
    if (ok) l.commit(val);
    else revert();
  } else if (e.key === "Escape") revert();
}

function onEditBlur() {
  // edit committed -> the rebuild clears this anyway; keep a rejected
  // expression visible only while focused
  if (!editError.value) revert();
}

/** A wheel notch that landed on this layer instead of the canvas.
 *
 *  The badges take pointer events so they can be clicked and dragged, which
 *  also takes the wheel; the viewport's wheel listener is on the canvas, so
 *  a notch over a badge used to do nothing at all. Bound on the CONTAINER
 *  rather than on each badge, so it catches the ones that are `pointer-events:
 *  none` in a drawing tool too, where the label is still drawn over the
 *  geometry and the wheel still has to get through. */
function onWheel(e: WheelEvent) {
  s.dimViewport?.forwardWheel(e);
}
</script>

<template>
  <!-- Teleported to body, where the class appended itself: .sketch-dims is
       `position: fixed; inset: 0` and must not inherit a stacking context. -->
  <Teleport to="body">
    <div
      class="sketch-dims"
      :class="{ 'dims-passive': s.dimsPassive }"
      @wheel="onWheel"
    >
      <div
        v-for="(l, i) in s.dimItems"
        :key="i"
        :ref="(el) => (els[i] = el as HTMLElement | null)"
        :class="[l.cls, { 'is-selected': s.dimSelected === i }]"
        :title="l.title"
        @pointerdown="onDown($event, i, l)"
        @pointermove="onDragMove"
        @pointerup="onDragEnd"
        @pointercancel="onDragEnd"
        @contextmenu="onContextMenu($event, i, l)"
        @click="onClick($event, i, l)"
        @dblclick="onDblClick($event, i, l)"
      >
        <input
          v-if="editing === i"
          v-model="editText"
          type="text"
          :class="{ 'input-error': !!editError }"
          :title="editError ?? ''"
          @input="editError = null"
          @keydown="onEditKey($event, l)"
          @blur="onEditBlur"
        />
        <template v-else>{{ l.text }}</template>
      </div>
    </div>
  </Teleport>
</template>
