<script setup lang="ts">
import { onMounted, ref, useTemplateRef } from "vue";
import { useEngine } from "../../app/engineKey";
import PromptBanner from "./PromptBanner.vue";
import FpsReadout from "./FpsReadout.vue";
import RoundTripReadout from "./RoundTripReadout.vue";
import SelectionReadout from "./SelectionReadout.vue";
import NormalToSketch from "./NormalToSketch.vue";
import SectionChip from "./SectionChip.vue";
import UpdatingChip from "./UpdatingChip.vue";
import { useClearOfCards } from "../../composables/useClearOfCards";
import { draggingMaterial, dropScopeFor, endMaterialDrag, MATERIAL_MIME, type DropScope } from "../../ui/materialDrag";

const engine = useEngine();
const host = useTemplateRef<HTMLDivElement>("host");
const top = useTemplateRef<HTMLDivElement>("top");
useClearOfCards(top);

// The canvas is made in main.ts before Vue, since every tool must exist before any setup() runs. Reparenting keeps the
// WebGL context, and prepend keeps it under the overlays (.palette, #prompt, #viewcontrols, .gridscale, .fps).
onMounted(() => host.value!.prepend(engine.canvas));

// Material drop: the target is this pane, not the canvas, which is reparented after mount. The face under the cursor
// lights up on every dragover, since a drop has to be aimed.

/** Where the chip sits and what it says, null when no material is over the viewport. Beside the cursor, since the
 *  answer is about what is under it. */
const chip = ref<{
  x: number;
  y: number;
  name: string;
  color: string;
  scope: DropScope;
  hit: boolean;
} | null>(null);

function carrying(e: DragEvent): boolean {
  // The module's record, not dataTransfer, which a browser hides during dragover (ui/materialDrag.ts). The types check
  // keeps a stale in-flight material drag from claiming another drag.
  return !!draggingMaterial() && (e.dataTransfer?.types.includes(MATERIAL_MIME) ?? false);
}

// dragover arrives far faster than frames, and keeps arriving while the cursor is
// still, so the pick runs once per frame and only when the aim actually moved.
let pendingAim: { x: number; y: number; scope: DropScope } | null = null;
let aimFrame = 0;
let lastAim = "";

function onDragOver(e: DragEvent) {
  if (!draggingMaterial() || !carrying(e)) return;
  // Without preventDefault this is not a drop target, the browser shows a no cursor and sends no drop.
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  pendingAim = { x: e.clientX, y: e.clientY, scope: dropScopeFor(e) };
  if (!aimFrame) aimFrame = requestAnimationFrame(aim);
}

function aim() {
  aimFrame = 0;
  const held = draggingMaterial();
  const p = pendingAim;
  pendingAim = null;
  if (!held || !p) return;
  const key = `${p.x},${p.y},${p.scope}`;
  if (key === lastAim) return;
  lastAim = key;
  const target = engine.viewport.dropTargetAt(p.x, p.y, p.scope);
  chip.value = {
    x: p.x,
    y: p.y,
    name: held.name,
    color: held.color,
    scope: p.scope,
    hit: !!target,
  };
}

function stopAiming() {
  if (aimFrame) cancelAnimationFrame(aimFrame);
  aimFrame = 0;
  pendingAim = null;
  lastAim = "";
  chip.value = null;
}

function onDragLeave(e: DragEvent) {
  // dragleave also fires entering a child (the canvas, the view controls), so only a relatedTarget outside the pane is a
  // leave, or the highlight flickers.
  const to = e.relatedTarget as Node | null;
  if (to && host.value?.contains(to)) return;
  stopAiming();
  engine.viewport.clearDropTarget();
}

function onDrop(e: DragEvent) {
  const held = draggingMaterial();
  stopAiming();
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
  const faces = (band?.faces.length ? band.faces : [target.localFace]).map((f) => ({ body: target.bodyId, face: f }));
  engine.store.setFacesMaterial(faces, held.id);
}
</script>

<template>
  <div id="viewport" ref="host" @dragenter="onDragOver" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <PromptBanner />
    <FpsReadout />
    <RoundTripReadout />
    <SelectionReadout />
    <div ref="top" class="vp-top">
      <SectionChip />
      <UpdatingChip />
      <NormalToSketch />
    </div>
  </div>

  <Teleport to="body">
    <div v-if="chip" class="dropchip" :style="{ left: `${chip.x + 16}px`, top: `${chip.y + 18}px` }">
      <span class="dot" :style="{ background: chip.color }"></span>
      <span>{{ chip.name }}</span>
      <span class="scope">{{ chip.hit ? (chip.scope === "body" ? "whole body" : "this face") : "nothing here" }}</span>
      <kbd>Shift</kbd>
    </div>
  </Teleport>
</template>
