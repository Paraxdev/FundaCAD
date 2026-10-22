<script setup lang="ts">
// Structure is reactive, position is not: the rAF loop projects sketch mm through the plane and live camera to screen
// px and writes style.transform onto a plain array of elements. The drag and the editor's focus are imperative too.

import * as THREE from "three";
import { nextTick, onUnmounted, ref, watch } from "vue";
import { screenTransform } from "../../sketch/annotationFormat";
import { useSketchAnnotationStore } from "../../stores/sketchAnnotations";
import type { DimItem } from "../../sketch/sketchDimensions";
import { displayValue, isPlainNumber, parseField } from "../../ui/units";
import { labelLeader, layoutLabels, type Held, type LabelAt } from "../../ui/labelClamp";
import type { Box } from "../../ui/promptPlacement";

const s = useSketchAnnotationStore();

const els: (HTMLElement | null)[] = [];
const leaders: (SVGGElement | null)[] = [];
const scratch = new THREE.Vector3();
let lastPose = -1;
let raf = 0;
const heldEdges = new Map<number, Held>();

// The floating cards a label must not hide under, the prompt banner's list.
const LEFT_CARDS =
  "#float-layer .float-left-stack > *, #float-layer .tool-rail .rail-btn, #float-layer .tool-rail .rail-group";
const RIGHT_CARDS = "#float-layer .float-right > *";
const LABEL_GAP = 6;
let cards: { left: Box[]; right: Box[] } = { left: [], right: [] };
let cardsKey = "";
let cardsAt = 0;

const rects = (sel: string): Box[] => [...document.querySelectorAll(sel)].map((o) => o.getBoundingClientRect());

/** Re-read the cards a few times a second: they open, close and resize without
 *  the camera moving, which is all the pose check below watches. */
function refreshCards(now: number) {
  if (now - cardsAt < 250) return;
  cardsAt = now;
  const next = { left: rects(LEFT_CARDS), right: rects(RIGHT_CARDS) };
  const key = [...next.left, ...next.right].map((r) => `${r.left},${r.top},${r.right},${r.bottom}`).join(";");
  if (key === cardsKey) return;
  cardsKey = key;
  cards = next;
  lastPose = -1;
}

function loop(now: number = performance.now()) {
  raf = requestAnimationFrame(loop);
  const plane = s.dimPlane;
  const vp = s.dimViewport;
  if (!plane || !vp) return;
  refreshCards(now);
  // skip the per-label projection + DOM writes when the camera hasn't moved
  const pose = vp.rig.poseVersion();
  if (pose === lastPose) return;
  lastPose = pose;
  const area = vp.domElement.getBoundingClientRect();
  const items = s.dimItems;
  const at: LabelAt[] = [];
  const idx: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const el = els[i];
    const l = items[i];
    if (!el || !l) continue;
    plane.to3D(l.anchor.x, l.anchor.y, scratch);
    const p = vp.projectToScreen(scratch);
    at.push({ x: p.x, y: p.y, hw: el.offsetWidth / 2, hh: el.offsetHeight / 2 });
    idx.push(i);
  }
  const placed = layoutLabels(at, area, cards, LABEL_GAP, heldEdges);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k]!;
    const a = at[k]!;
    const c = placed[k]!;
    els[i]!.style.transform = screenTransform(c.x, c.y);
    const g = leaders[i];
    if (g) placeLeader(g, labelLeader(c, a.hw, a.hh, a));
  }
}

function placeLeader(g: SVGGElement, seg: ReturnType<typeof labelLeader>) {
  if (!seg) {
    g.setAttribute("visibility", "hidden");
    return;
  }
  g.removeAttribute("visibility");
  const [line, head, dot] = g.children;
  line?.setAttribute("x1", String(seg.x1));
  line?.setAttribute("y1", String(seg.y1));
  line?.setAttribute("x2", String(seg.x2));
  line?.setAttribute("y2", String(seg.y2));
  dot?.setAttribute("cx", String(seg.x2));
  dot?.setAttribute("cy", String(seg.y2));
  // An arrowhead on the label's border, inside the gap layoutLabels keeps clear,
  // so the way to the dimension reads even where the line runs under a card.
  const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1) || 1;
  const ux = (seg.x2 - seg.x1) / len;
  const uy = (seg.y2 - seg.y1) / len;
  const tip = Math.min(LABEL_GAP - 1, len);
  head?.setAttribute(
    "points",
    `${seg.x1 + ux * tip},${seg.y1 + uy * tip} ${seg.x1 - uy * 3.5},${seg.y1 + ux * 3.5} ${seg.x1 + uy * 3.5},${seg.y1 - ux * 3.5}`,
  );
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
    // A rebuild replaces the label a drag is riding on, drop the drag so its
    // move/up handlers can't write a placement against stale geometry.
    drag = null;
    heldEdges.clear();
    // The new set is at the same camera as the old one, so the pose check would
    // otherwise skip it forever.
    lastPose = -1;
    // A rebuild also ends an edit.
    editing.value = null;
    editError.value = null;
  },
  { flush: "post" },
);

onUnmounted(stop);

// Which label the Delete key acts on, dropped on the next rebuild so a stale delete is never armed.
function select(i: number) {
  s.dimSelected = i;
}

// Under DRAG_PX of movement a release still opens the value editor, past it the label follows the cursor (the same
// 4px idiom as SketchMode's drags).
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
/** A drag's release must not also open the editor, the browser still fires click after pointerup. Cleared on the next
 *  pointerdown. */
let suppressClick = false;

function onDown(e: PointerEvent, i: number, l: DimItem) {
  e.stopPropagation();
  // Primary only: a badge sits where users right-click its line, and a secondary press would let overlapPick replace a
  // two-entity selection and rebuild the badge under its own contextmenu handler. Middle drag stays pan.
  if (e.button !== 0) return;
  suppressClick = false;
  l.suppressEdit = s.dimHooks?.overlapPick(e) ?? false;
  // overlapPick may have rebuilt the label under the cursor, so no drag starts on it, and the layer-wide flag stops the
  // edit the following click would open on the rebuilt item.
  if (l.suppressEdit) {
    suppressClick = true;
    return;
  }
  select(i);
  beginDrag(l, e.currentTarget as HTMLElement, e);
}

function beginDrag(item: DimItem, el: HTMLElement, e: PointerEvent) {
  if (!item.placeCommit || !item.place) return;
  const from = s.dimHooks?.planePoint(e.clientX, e.clientY) ?? null;
  if (!from) return; // no plane hook, or the cursor ray misses it (grazing view)
  drag = {
    item,
    el,
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
    const dx = e.clientX - d.startClient.x,
      dy = e.clientY - d.startClient.y;
    if (dx * dx + dy * dy < DRAG_PX ** 2) return; // still a click
    d.moved = true;
  }
  e.stopPropagation();
  const p = placeAt(e.clientX, e.clientY);
  if (!p) return;
  d.last = p;
  // The host re-lays-out the dim and returns where its label really goes, so a perpendicular-only or radial-only dim
  // tracks only its useful component and does not jump on release.
  const anchor = d.item.placeCommit!(p.x, p.y, false);
  if (anchor) {
    // anchor is a raw THREE.Vector2 mutated in place; the rAF loop reads it next
    // frame, which is why the pose version has to be invalidated by hand here
    d.item.anchor.copy(anchor);
    lastPose = -1;
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
  // A release off the plane (grazing view) falls back to the last resolved placement, so the final rebuild still runs.
  const p = placeAt(e.clientX, e.clientY) ?? d.last;
  if (p) d.item.placeCommit!(p.x, p.y, true);
}

// Dimensional constraints get no glyph (glyphs.ts skips them), so this and the Delete key are the only ways to remove
// one short of deleting its geometry.
function onContextMenu(e: MouseEvent, i: number, l: DimItem) {
  e.preventDefault();
  e.stopPropagation();
  select(i);
  s.dimHooks?.labelMenu(e, l.onDelete ? () => l.onDelete!() : null);
}

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

// Double-click always edits: single clicks on a label over its own geometry go to overlapPick, and the dimension tool
// claims clicks too.
function onDblClick(e: MouseEvent, i: number, l: DimItem) {
  if (l.driven) return;
  e.stopPropagation();
  l.suppressEdit = false;
  suppressClick = false;
  beginEdit(i, l);
}

function beginEdit(i: number, l: DimItem) {
  if (editing.value === i) return; // already editing, a dblclick after a click
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
      // formulas, and any edit to an already-bound dim, go through the
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

/** The badges take pointer events, and so the wheel the canvas listens for. Bound on the container so it also catches
 *  badges that are pointer-events none in a drawing tool. */
function onWheel(e: WheelEvent) {
  s.dimViewport?.forwardWheel(e);
}
</script>

<template>
  <!-- Teleported: .sketch-dims is position fixed, inset 0, and must not inherit a stacking context. -->
  <Teleport to="body">
    <div class="sketch-dims" :class="{ 'dims-passive': s.dimsPassive }" @wheel="onWheel">
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
  <!-- A label kept away from its dimension points back to it. Its own layer under the floating cards, so a leader to
  a dimension behind the Items card goes under the card. -->
  <Teleport to="body">
    <svg v-if="s.dimItems.length" class="sketch-dim-leaders" aria-hidden="true">
      <g
        v-for="(l, i) in s.dimItems"
        :key="i"
        :ref="(el) => (leaders[i] = el as SVGGElement | null)"
        :class="{ driven: l.driven }"
        visibility="hidden"
      >
        <line />
        <polygon />
        <circle r="2" />
      </g>
    </svg>
  </Teleport>
</template>
