<script setup lang="ts">
// Guide mode overlay: a ring on what an assistant points at and a caption bubble (manual/docs/ai/guide.md).
// Model outlines are SVG, not three.js, so Clean view and the pick mask never see them.
import * as THREE from "three";
import { computed, nextTick, onUnmounted, ref, shallowRef } from "vue";
import { useEngine } from "../../app/engineKey";
import { labelOf } from "../../ui/controlRefs";
import { resolveControl } from "../../ui/guide/controls";
import type { GuideState, StepState } from "../../ui/guide/guideSession";
import { placeBubble, ringRect, type Placed } from "../../ui/guide/placement";
import { modelShape, type ModelShape } from "../../ui/guide/probe";
import type { Box } from "../../ui/controlRefs";
import Button from "../ui/Button.vue";

const engine = useEngine();
const guide = engine.guide;

const state = shallowRef<GuideState>(guide.state);
const ring = ref<Box | null>(null);
const bubbleAt = ref<Placed | null>(null);
const paths = ref<string[]>([]);
const ref_ = ref("");
const hint = ref("");
/** The target's own corner radius grown by the ring's inset, so the ring hugs its shape. */
const radius = ref<string | null>(null);
const bubble = ref<HTMLElement | null>(null);

const step = computed<StepState | null>(() => {
  const s = state.value.step;
  return s && !s.next ? s : null;
});

let raf = 0;
let frame = 0;
let target: HTMLElement | null = null;
let scrolledFor = -1;
/** A model step's outline in its body's rest frame, read once per build: reading it walks every face of the body.
 *  The body's pose is applied each frame, so the outline follows a Move drag. */
let shapeFor: { seq: number; build: unknown; shape: ModelShape | Error } | null = null;
const RETRY_FRAMES = 30;

const AVOID = ".modal-panel, .cmdk-card";

function sameBox(a: Box | null, b: Box | null): boolean {
  return !!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function locateUi(s: StepState): void {
  const r = resolveControl(s.target.ui ?? "", document);
  target = r.el ?? null;
  const own = target ? parseFloat(getComputedStyle(target).borderTopLeftRadius) : NaN;
  radius.value = Number.isFinite(own) && own > 0 ? `${own + 4}px` : null;
  ref_.value = r.el ? (r.via ?? r.ref) : "";
  hint.value = r.el && r.via ? `Open ${labelOf(r.el) || r.via} first` : r.el ? "" : (r.missing ?? "");
  guide.updateResolution(r.el ? { found: true, via: r.via } : { found: false, missing: r.missing, near: r.near });
  if (target && !r.via && scrolledFor !== s.seq) {
    scrolledFor = s.seq;
    target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }
}

function modelBox(s: StepState): Box | null {
  const canvas = engine.viewport.domElement.getBoundingClientRect();
  if (s.target.region) {
    const g = s.target.region;
    paths.value = [];
    return {
      left: canvas.left + g.x * canvas.width,
      top: canvas.top + g.y * canvas.height,
      width: g.w * canvas.width,
      height: g.h * canvas.height,
    };
  }
  const build = engine.store.buildState;
  // A miss is read again now and then, the mesh can land after the build it belongs to.
  const stale =
    !shapeFor ||
    shapeFor.seq !== s.seq ||
    shapeFor.build !== build ||
    (shapeFor.shape instanceof Error && frame % RETRY_FRAMES === 0);
  if (stale) {
    let shape: ModelShape | Error;
    try {
      shape = modelShape(engine, s.target.model ?? "");
    } catch (err) {
      shape = err instanceof Error ? err : new Error(String(err));
    }
    shapeFor = { seq: s.seq, build, shape };
  }
  const shape = shapeFor!.shape;
  if (shape instanceof Error) {
    paths.value = [];
    hint.value = s.missing ?? shape.message;
    return null;
  }
  ref_.value = shape.name;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const out: string[] = [];
  const pose = shape.body ? engine.viewport.bodyPose(shape.body) : null;
  const at = new THREE.Vector3();
  for (const line of shape.lines) {
    const pts = line
      .map((v) => engine.viewport.projectToScreen(pose ? at.copy(v).applyMatrix4(pose) : v))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length < 2) continue;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    out.push(pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
  }
  paths.value = out;
  return out.length ? { left: minX, top: minY, width: maxX - minX, height: maxY - minY } : null;
}

function follow(s: StepState): void {
  if (s.target.ui !== undefined) {
    if (frame % 15 === 0 || !target?.isConnected) locateUi(s);
  }
  frame++;
  const box = s.target.ui !== undefined ? (target?.isConnected ? target.getBoundingClientRect() : null) : modelBox(s);
  const r = box ? ringRect({ left: box.left, top: box.top, width: box.width, height: box.height }) : null;
  if (!sameBox(r, ring.value)) ring.value = r;
  const el = bubble.value;
  if (el) {
    const size = { width: el.offsetWidth || 280, height: el.offsetHeight || 120 };
    const view = { width: window.innerWidth, height: window.innerHeight };
    const avoid = [...document.querySelectorAll(AVOID)].map((d) => d.getBoundingClientRect());
    const at = box
      ? placeBubble(box, view, size, avoid)
      : { side: "below" as const, left: view.width / 2 - size.width / 2, top: 72, ...size };
    if (!sameBox(at, bubbleAt.value)) bubbleAt.value = at;
  }
}

// The only loop: observe() emits, and the subscriber calls schedule(), so a
// second loop started from in here would double every frame.
function loop(): void {
  raf = 0;
  const s = step.value;
  if (s) follow(s);
  guide.observe();
  schedule();
}

function schedule(): void {
  if (!raf && guide.active) raf = requestAnimationFrame(loop);
}

function restart(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  frame = 0;
  target = null;
  ring.value = null;
  paths.value = [];
  hint.value = "";
  ref_.value = "";
  radius.value = null;
  shapeFor = null;
  void nextTick(schedule);
}

const stopWatching = guide.subscribe((s) => {
  const before = state.value.step;
  state.value = s;
  if (s.step?.seq !== before?.seq || !!s.step?.next !== !!before?.next) restart();
  else schedule();
});
onUnmounted(() => {
  stopWatching();
  if (raf) cancelAnimationFrame(raf);
});

const ringStyle = computed(() => {
  const r = ring.value;
  if (!r) return {};
  const box = { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` };
  return radius.value ? { ...box, borderRadius: radius.value } : box;
});
const bubbleStyle = computed(() => {
  const b = bubbleAt.value;
  return b ? { left: `${b.left}px`, top: `${b.top}px` } : { visibility: "hidden" as const };
});
const counter = computed(() =>
  step.value && step.value.of > 1 ? `Step ${step.value.step} of ${step.value.of}` : "Guide",
);
</script>

<template>
  <Teleport to="body">
    <div v-if="step" class="guide-layer" data-testid="guide-layer" :data-ref="ref_">
      <svg v-if="paths.length" class="guide-model" aria-hidden="true">
        <polyline v-for="(p, i) in paths" :key="i" :points="p" />
      </svg>
      <!-- A model area is its own outline; a box around it would ring empty space. -->
      <div
        v-if="ring && step.target.model === undefined"
        class="guide-ring"
        :class="{ 'guide-region': !!step.target.region }"
        :style="ringStyle"
        aria-hidden="true"
      ></div>
      <div
        ref="bubble"
        class="guide-bubble"
        role="dialog"
        aria-live="polite"
        :aria-label="counter"
        :data-side="bubbleAt?.side"
        :style="bubbleStyle"
      >
        <div class="guide-count">{{ counter }}</div>
        <p class="guide-caption">{{ step.caption }}</p>
        <p v-if="hint" class="guide-hint">{{ hint }}</p>
        <div class="guide-actions">
          <Button id="guide-stop" @click="guide.stop()">Stop</Button>
          <Button id="guide-next" variant="primary" @click="guide.next()">Next</Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
