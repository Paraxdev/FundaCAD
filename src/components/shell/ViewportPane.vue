<script setup lang="ts">
import { onMounted, ref, useTemplateRef } from "vue";
import { useEngine } from "../../app/engineKey";
import PromptBanner from "./PromptBanner.vue";
import FpsReadout from "./FpsReadout.vue";
import {
  draggingMaterial, dropScopeFor, endMaterialDrag, MATERIAL_MIME, type DropScope,
} from "../../ui/materialDrag";

const engine = useEngine();
const host = useTemplateRef<HTMLDivElement>("host");

// The <canvas> is created imperatively in main.ts and handed to the Viewport
// before Vue exists, because Viewport, DocumentStore, SketchMode and all ten
// tools must be fully constructed before any component's setup() runs. Adopting
// it here is safe on both counts that matter:
//   * reparenting a canvas does not lose its WebGL context;
//   * it is 0x0 while detached, but viewport.ts already observes it with a
//     ResizeObserver, so the size self-corrects on the frame it is inserted.
//
// prepend, not append: #canvas has to be the first child so the absolutely
// positioned overlays below it (.palette, #prompt, #viewcontrols, .gridscale,
// .fps) paint on top.
onMounted(() => host.value!.prepend(engine.canvas));

// --- a material dragged onto the model ------------------------------------
//
// The DROP TARGET is this pane rather than the canvas, because a drag has to be
// accepted by an element with a layout box and the canvas is reparented into
// here after mount; this element is the stable one. The canvas fills it, so
// every coordinate that matters is over the canvas anyway.
//
// What is under the cursor is asked of the viewport on every dragover and shown
// by lighting it up. That is the whole gesture: a dropped material has to be
// aimed, and the only way to aim is to see what is currently in the sights.

/** Where the chip sits and what it says, or null when no material is over the
 *  viewport. Rendered next to the cursor rather than pinned to a corner: the
 *  answer is about the thing under the pointer and reading it means looking
 *  away from the pointer otherwise. */
const chip = ref<{
  x: number; y: number; name: string; color: string; scope: DropScope; hit: boolean;
} | null>(null);

function carrying(e: DragEvent): boolean {
  // The module's own record, not dataTransfer: a browser refuses to reveal the
  // payload during dragover (see ui/materialDrag.ts). The types list is still
  // checked, so a drag that started somewhere else in this window cannot be
  // mistaken for ours just because a material drag was left in flight.
  return !!draggingMaterial() && (e.dataTransfer?.types.includes(MATERIAL_MIME) ?? false);
}

function onDragOver(e: DragEvent) {
  const held = draggingMaterial();
  if (!held || !carrying(e)) return;
  // Accepting the drag is what makes the browser show a copy cursor and send a
  // drop at all. Without the preventDefault this element is not a target and
  // the whole gesture ends in the desktop's "no" cursor.
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  const scope = dropScopeFor(e);
  const target = engine.viewport.dropTargetAt(e.clientX, e.clientY, scope);
  chip.value = {
    x: e.clientX, y: e.clientY, name: held.name, color: held.color,
    scope, hit: !!target,
  };
}

function onDragLeave(e: DragEvent) {
  // dragleave also fires when the pointer crosses into a CHILD of this element
  // (the canvas, the view controls), and clearing then would flicker the
  // highlight off and on all the way across the viewport. Only a relatedTarget
  // outside the pane is actually a leave.
  const to = e.relatedTarget as Node | null;
  if (to && host.value?.contains(to)) return;
  chip.value = null;
  engine.viewport.clearDropTarget();
}

function onDrop(e: DragEvent) {
  const held = draggingMaterial();
  chip.value = null;
  if (!held || !carrying(e)) return;
  e.preventDefault();
  const scope = dropScopeFor(e);
  const target = engine.viewport.dropTargetAt(e.clientX, e.clientY, scope);
  engine.viewport.clearDropTarget();
  // Always, even on a miss: `dragend` fires on the source element, and a drop
  // that landed on nothing still has to end the drag for everybody watching.
  endMaterialDrag();
  if (!target) return;
  if (scope === "body") {
    engine.store.setBodiesMaterial([target.bodyId], held.id);
    return;
  }
  // The whole RUN the pick would have taken, so a cylinder the kernel split in
  // two is dressed as the one face it looks like.
  const band = engine.viewport.localFaceBand(target.faceId);
  const faces = (band?.faces.length ? band.faces : [target.localFace])
    .map((f) => ({ body: target.bodyId, face: f }));
  engine.store.setFacesMaterial(faces, held.id);
}
</script>

<template>
  <div
    id="viewport"
    ref="host"
    @dragenter="onDragOver"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <PromptBanner />
    <FpsReadout />
  </div>

  <Teleport to="body">
    <div
      v-if="chip"
      class="dropchip"
      :style="{ left: `${chip.x + 16}px`, top: `${chip.y + 18}px` }"
    >
      <span class="dot" :style="{ background: chip.color }"></span>
      <span>{{ chip.name }}</span>
      <span class="scope">{{ chip.hit ? (chip.scope === "body" ? "whole body" : "this face") : "nothing here" }}</span>
      <kbd>Shift</kbd>
    </div>
  </Teleport>
</template>
