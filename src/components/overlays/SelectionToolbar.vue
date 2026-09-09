<script setup lang="ts">
// The toolbar that follows the selection: the tools that can act on what you just
// picked, floating just above it, gone the moment nothing is selected. The list is
// derived from features/toolCapabilities.ts, so a tool that cannot act on this
// selection is never on it and one that can never has to be gone looking for.
//
// Like the drag handle (features/selectionNudge.ts) it is NOT a tool: no busy
// state, no document state, and a button click dispatches the same action the
// ribbon would.
//
// It knows by LOOKING once a frame, not by subscribing: onSelectionChange is a
// single-slot callback already owned by app/viewportWiring.ts, and profile-area
// selection notifies nothing at all. Polling covers the silent paths too, a
// rebuild restoring a selection, a tool clearing one, Escape.
//
// The loop costs nothing when idle: it runs only while a selection exists and
// stops itself on the first empty frame, and it is woken only by the four things
// that can create one (pointer release, key release, document change, build). Per
// frame it reads the cheap accessors only; the triangle-walking
// selectedFacesForPressPull runs only when the selection signature changes.

import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import * as THREE from "three";
import Icon from "../shell/Icon.vue";
import { useEngine } from "../../app/engineKey";
import {
  appearanceOffers, primaryKind, toolbarOffers,
  type AppearanceOffer, type ToolOffer,
} from "../../ui/selectionTools";
import { contextMenu } from "../../ui/menu";
import { materialMenu } from "../../ui/browserTree";
import type { SelectionCounts } from "../../features/toolCapabilities";
import { handlePlacement } from "../../features/edgeNudge";
import { regionAnchor } from "../../features/regionNudge";
import { handleReachPx } from "../../features/manipulator";
import { GIZMO_REACH_PX } from "../../features/moveTool";

type Vec3 = [number, number, number];

const engine = useEngine();

/** Half the bar's own height, px. It is centred on the point computed below
 *  (translate -50%, -50%), so clearing the handle means clearing this too.
 *  Hard-coded rather than measured because happy-dom has no layout and neither
 *  does the frame in which a selection first appears, the same reason HALF_W_PX
 *  below is a constant. One button row, so it does not vary. */
const BAR_HALF_PX = 20;

/** Air between the handle's tip and the bar's bottom edge, px. Small, but not
 *  zero: touching reads as one object, and the point of lifting the bar at all
 *  is that the handle should read as a control standing on the geometry. */
const CLEARANCE_PX = 12;
/** Keeps the bar on screen without measuring it, happy-dom has no layout, and
 *  neither does the frame in which a selection first appears. */
const HALF_W_PX = 110;

const counts = shallowRef<SelectionCounts>({});
const screen = ref<{ x: number; y: number } | null>(null);
const offers = computed(() => toolbarOffers(counts.value));
// The appearance half: Material, Hide, Isolate, for a body selection only. See
// ui/selectionTools.appearanceOffers for why these are not capability rows.
const looks = computed(() => appearanceOffers(counts.value));
const visible = computed(
  () => screen.value !== null && (offers.value.length > 0 || looks.value.length > 0),
);

// --- reading the selection ---------------------------------------------------

/** World point the bar is pinned to. Recomputed only when the selection
 *  changes, then re-projected every frame. */
let anchor: THREE.Vector3 | null = null;
let signature = "";

const camForward = new THREE.Vector3();
const toAnchor = new THREE.Vector3();

/** The whole selection, in the order that decides which kind wins.
 *
 *  The ranking is ui/selectionTools.KIND_RANK, which is itself
 *  app/viewportWiring.ts's drag-handle ranking, one selection gets one answer,
 *  and the arrow standing on the geometry must not disagree with the buttons
 *  floating above it. */
function readSelection(): { counts: SelectionCounts; signature: string; anchor: THREE.Vector3 | null } {
  const edges = engine.viewport.selectedEdgeLines();
  const regions = engine.overlay.selectedRegions();
  const faceIds = engine.viewport.getSelectedFaceIds();
  const bodies = engine.viewport.getSelectedBodies();

  const c: SelectionCounts = {};
  if (edges.length) c.edge = edges.length;
  if (regions.length) c["sketch-region"] = regions.length;
  if (faceIds.length) c.face = faceIds.length;
  if (bodies.length) c.body = bodies.length;

  // Identity, not just size: swapping one selected edge for another has to move
  // the bar, and a count alone would not notice.
  const sig =
    `e${edges.map((e) => e.id).join()}` +
    `|r${regions.map((r) => r.interior3D.x).join()}` +
    `|f${faceIds.join()}` +
    `|b${bodies.join()}`;
  if (sig === signature) return { counts: c, signature: sig, anchor };

  let at: THREE.Vector3 | null = null;
  if (edges.length) {
    // Shared with the drag handle rather than re-derived: the mean of the
    // arc-length midpoints. Two "middle of the selection" calculations that
    // agreed to within a millimetre would still put the bar a hair off the
    // arrow it belongs to.
    const place = handlePlacement(edges.map((e) => e.points as Vec3[]));
    if (place) at = new THREE.Vector3(...place.anchor);
  } else if (regions.length) {
    at = regionAnchor(regions);
  } else if (faceIds.length) {
    // The expensive one, and the reason this whole function is gated on the
    // signature, see the header.
    at = engine.viewport.selectedFacesForPressPull()?.anchor.clone() ?? null;
  } else if (bodies.length) {
    at = engine.viewport.bodiesCentroid(bodies);
  }
  return { counts: c, signature: sig, anchor: at };
}

/** One frame. Returns whether anything is still selected, i.e. whether the
 *  loop has a reason to run again. */
function refresh(): boolean {
  const next = readSelection();
  counts.value = next.counts;
  signature = next.signature;
  anchor = next.anchor;

  // An active tool owns the screen: its own gizmos, its own dimension box, its
  // own meaning for a click. Asked every frame rather than subscribed to,
  // because a tool can start from a shortcut, a menu, the palette or the
  // browser tree, and because this is what puts the bar BACK the instant the
  // tool ends with the selection intact.
  //
  // toolOwnsScreen, NOT toolBusy: picking a body raises the Move gizmo by
  // itself, so toolBusy() is true for as long as a body is selected at all and
  // this bar could never appear over one. That is why body verbs were reachable
  // only from a right-click while every face and edge verb was on the bar. See
  // the note on Engine.toolOwnsScreen.
  if (!anchor || engine.toolOwnsScreen()) {
    screen.value = null;
    return !!anchor;
  }

  const cam = engine.viewport.camera;
  cam.getWorldDirection(camForward);
  toAnchor.copy(anchor).sub(cam.position);
  if (camForward.dot(toAnchor) <= 0) {
    // Behind the camera. project() would still return coordinates, mirrored
    // through the centre of the screen, a bar hovering over empty space on the
    // wrong side of the viewport, offering to fillet something nobody can see.
    screen.value = null;
    return true;
  }

  const p = engine.viewport.projectToScreen(anchor);
  const x = Math.min(Math.max(p.x, HALF_W_PX), Math.max(window.innerWidth - HALF_W_PX, HALF_W_PX));
  // Measured off the handle rather than guessed: it is drawn at a constant
  // SCREEN size only until it would dwarf the model, and from there it shrinks
  // with it, so how much room it needs is not a constant. The old fixed 64 put
  // the bar's bottom edge on the handle's top pixel on a fitted 40mm box.
  const y = p.y - (barLiftPx() + BAR_HALF_PX + CLEARANCE_PX);
  const prev = screen.value;
  // Only on a real change: the viewport renders on demand, and rewriting the
  // style binding every frame of a still camera would keep Vue patching for
  // nothing.
  if (!prev || Math.abs(prev.x - x) > 0.5 || Math.abs(prev.y - y) > 0.5) screen.value = { x, y };
  return true;
}

/** How far the handle standing on the anchor reaches up the screen. Zero when
 *  there is no anchor to measure at, which is also when there is no bar.
 *
 *  WHICH handle depends on the kind. An edge, a face or a profile carries the
 *  drag handle, whose reach varies with the model, it is drawn at a constant
 *  screen size only until it would dwarf the part. A body carries the Move
 *  gizmo instead, which is a fixed screen size and a good deal bigger, and
 *  measuring off the wrong one put the bar inside the rotation rings. */
function barLiftPx(): number {
  if (!anchor) return 0;
  if ((counts.value.body ?? 0) > 0 && primaryKind(counts.value) === "body") return GIZMO_REACH_PX;
  return handleReachPx(
    engine.viewport.modelDiagonal(),
    engine.viewport.pixelWorldSize(anchor),
  );
}

// --- the loop ----------------------------------------------------------------

let raf = 0;

function tick() {
  raf = 0;
  if (refresh()) raf = requestAnimationFrame(tick);
}

/** Something happened that could have changed the selection: look next frame.
 *  Cheap to call spuriously, one frame of four array reads. */
function wake() {
  if (!raf) raf = requestAnimationFrame(tick);
}

let unsubs: (() => void)[] = [];

onMounted(() => {
  // A selection is only ever created by a pointer release (a pick in the
  // viewport, a menu item), a key release (Escape, Del, a shortcut that runs a
  // tool) or the document changing under it. rAF means the wake always lands
  // after every other handler for that event has run, so listener order does
  // not matter anywhere.
  window.addEventListener("pointerup", wake);
  window.addEventListener("keyup", wake);
  unsubs = [engine.store.onDocChange(() => wake()), engine.store.onBuild(() => wake())];
  wake();
});

onUnmounted(() => {
  window.removeEventListener("pointerup", wake);
  window.removeEventListener("keyup", wake);
  for (const off of unsubs) off();
  unsubs = [];
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
});

// --- acting ------------------------------------------------------------------

function title(o: ToolOffer): string {
  return o.hint ? `${o.label} (${o.hint})` : o.label;
}

function run(o: ToolOffer) {
  // The gizmo a body selection raises is not a tool the user started, and
  // every command below would refuse while it is up. See Engine.dropBodyGizmo.
  engine.dropBodyGizmo();
  if (engine.toolBusy()) return;
  // The one tool with no action id is dispatched through the engine, see
  // ui/selectionTools.ACTIONLESS and the note on "delete-face" in
  // features/toolCapabilities.ts.
  if (o.action) engine.handleAction(o.action);
  else if (o.tool === "delete-face") engine.deleteSelectedFace();
}

/** The bodies the appearance verbs act on: whatever is selected right now,
 *  read at click time rather than from `counts`, which carries how many but not
 *  which. */
function selectedBodies(): string[] {
  return engine.viewport.getSelectedBodies();
}

/** Run an appearance verb.
 *
 *  Not routed through handleAction: none of these is a command, each is a
 *  direct write to a display-only overlay, and inventing three action ids so
 *  they could travel through the dispatcher would also enrol them in "Repeat
 *  last command", which repeats modelling, not tidying up.
 *
 *  Material opens the SAME submenu the body's right-click menu and its Browser
 *  row carry, from the same builder, so the library is one list wherever it is
 *  reached from. A dialog would be the wrong shape here, the bar is a place to
 *  make a choice, not to open one. */
function look(o: AppearanceOffer, ev: MouseEvent) {
  // toolOwnsScreen, not toolBusy: see refresh(). None of these three is a
  // command, so the ambient Move gizmo is no reason to refuse one.
  if (engine.toolOwnsScreen()) return;
  const ids = selectedBodies();
  if (!ids.length) return;
  const store = engine.store;
  if (o.id === "material") {
    const first = ids[0];
    // One current material only when the whole selection agrees, otherwise
    // nothing is ticked and every row stays live, which is the honest reading
    // of a mixed selection.
    const current = first !== undefined ? store.bodyMaterialId(first) : undefined;
    const shared = ids.every((id) => store.bodyMaterialId(id) === current) ? current : undefined;
    const item = materialMenu(store.materialLibrary, ids, shared, (m) => store.setBodiesMaterial(ids, m));
    // The submenu's own rows, opened at the button: wrapping them in the
    // "Material" parent again would cost a hover to reach a list that is
    // already the whole reason the button was pressed.
    contextMenu(ev.clientX, ev.clientY, item.children ?? []);
    return;
  }
  if (o.id === "hide") {
    // The gizmo first: it is standing on these bodies, and the line below is
    // about to make them invisible and then let go of them. Left up, it would
    // be a set of arrows floating over nothing, and it would also swallow the
    // selection change (viewportWiring returns early while a tool is busy).
    engine.dropBodyGizmo();
    store.setBodiesVisibility(new Map(ids.map((id) => [id, false])));
    // Drop the selection with it. A hidden body that is still selected leaves
    // this bar floating over nothing, offering to fillet something the user
    // just said they did not want to look at.
    engine.viewport.setSelectedBodies([]);
    return;
  }
  // Isolate: show only these. One batched write, one re-render, and the way
  // back is Show All Bodies (Shift+H), same as the body context menu's.
  const all = store.buildState.result?.bodies ?? [];
  const keep = new Set(ids);
  store.setBodiesVisibility(new Map(all.map((b) => [b.id, keep.has(b.id)])));
}

</script>

<template>
  <Teleport to="body">
    <!-- v-if, never a hidden element: an overlay left in the DOM over the
         viewport steals the picks the geometry behind it should be getting. -->
    <div
      v-if="visible && screen"
      class="seltools"
      role="toolbar"
      aria-label="Tools for the selection"
      :style="{ left: `${screen.x}px`, top: `${screen.y}px` }"
    >
      <button
        v-for="o in offers"
        :key="o.tool"
        type="button"
        class="seltool-btn"
        :data-tool="o.tool"
        :title="title(o)"
        :aria-label="title(o)"
        @click="run(o)"
      >
        <Icon :name="o.iconName" :size="18" />
      </button>
      <!-- A rule, not a gap: the verbs on the right change how the body looks,
           the ones on the left change what it IS, and a bar that ran them
           together would put "hide this" next to "subtract this". -->
      <div v-if="offers.length && looks.length" class="seltool-sep" aria-hidden="true"></div>
      <button
        v-for="o in looks"
        :key="o.id"
        type="button"
        class="seltool-btn"
        :data-look="o.id"
        :title="o.label"
        :aria-label="o.label"
        @click="look(o, $event)"
      >
        <Icon :name="o.iconName" :size="18" />
      </button>
    </div>
  </Teleport>
</template>
