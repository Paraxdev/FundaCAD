<script setup lang="ts">
// The error notice in the middle of the title bar. A warning triangle pops in,
// the chip grows to fit the sentence (fast, then settling, the --notice-grow
// curve), the triangle gives way to the red text, and after a while it folds
// away. Clicking it opens the console on the full report.
//
// With animations off (ui/motion.ts) it appears and leaves in one frame.

import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { dismissErrorNotice, errorNotice, onErrorNotice, type ErrorNotice } from "../../ui/errorNotice";
import { revealEntry } from "../../ui/logStore";
import { motionOn } from "../../ui/motion";

type Phase = "hidden" | "icon" | "grow" | "text" | "leave";

const ICON_W = 28;
const POP_MS = 170;
const GROW_MS = 720;
// When the text takes over from the icon, the point the curve has covered most
// of the width.
const SWAP_AT = 0.5;
const LEAVE_MS = 260;

const phase = ref<Phase>("hidden");
const shown = ref<ErrorNotice | null>(null);
const width = ref(ICON_W);
const measure = ref<HTMLElement | null>(null);
const slot = ref<HTMLElement | null>(null);

let timers: number[] = [];
let holdTimer = 0;
let hovered = false;

const later = (ms: number, fn: () => void) => { timers.push(window.setTimeout(fn, ms)); };
function clearTimers() {
  for (const t of timers) clearTimeout(t);
  timers = [];
  clearTimeout(holdTimer);
}

async function fitWidth(): Promise<number> {
  await nextTick();
  const natural = measure.value?.offsetWidth ?? ICON_W;
  const room = slot.value?.clientWidth ?? natural;
  return Math.max(ICON_W, Math.min(natural, room));
}

function hold() {
  clearTimeout(holdTimer);
  const n = shown.value;
  if (!n || hovered) return;
  holdTimer = window.setTimeout(leave, n.holdMs);
}

function leave() {
  if (!motionOn()) {
    finish();
    return;
  }
  phase.value = "leave";
  later(LEAVE_MS, finish);
}

function finish() {
  clearTimers();
  phase.value = "hidden";
  shown.value = null;
  width.value = ICON_W;
  dismissErrorNotice();
}

async function arrive(n: ErrorNotice) {
  const fresh = phase.value === "hidden" || phase.value === "leave";
  shown.value = n;
  if (!fresh) {
    width.value = await fitWidth();
    if (phase.value !== "text") {
      clearTimers();
      phase.value = "text";
    }
    hold();
    return;
  }
  clearTimers();
  if (!motionOn()) {
    phase.value = "text";
    width.value = await fitWidth();
    hold();
    return;
  }
  width.value = ICON_W;
  phase.value = "icon";
  const target = await fitWidth();
  later(POP_MS, () => {
    phase.value = "grow";
    width.value = target;
    later(GROW_MS * SWAP_AT, () => {
      phase.value = "text";
      later(GROW_MS * (1 - SWAP_AT), hold);
    });
  });
}

function openDetails() {
  const n = shown.value;
  if (!n) return;
  revealEntry(n.logId);
  finish();
}

function runAction() {
  const n = shown.value;
  n?.action?.onClick();
  finish();
}

function onEnter() { hovered = true; clearTimeout(holdTimer); }
function onLeave() { hovered = false; if (phase.value === "text") hold(); }

let off: (() => void) | null = null;
onMounted(() => {
  off = onErrorNotice(() => {
    const n = errorNotice();
    if (n && n.seq !== shown.value?.seq) void arrive(n);
  });
});
onUnmounted(() => { off?.(); clearTimers(); });
</script>

<template>
  <div ref="slot" class="notice-slot">
    <div
      v-if="shown && phase !== 'hidden'"
      class="err-notice-wrap"
      role="alert"
      @mouseenter="onEnter"
      @mouseleave="onLeave"
    >
      <button
        id="error-notice"
        type="button"
        class="err-notice"
        :class="`is-${phase}`"
        :style="{ width: `${width}px` }"
        :title="`${shown.message}\nClick for the full report in the console`"
        @click="openDetails"
      >
        <svg class="err-tri" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10.3 3.9a2 2 0 0 1 3.4 0l8.1 14.1A2 2 0 0 1 20.1 21H3.9a2 2 0 0 1-1.7-3l8.1-14.1Z" />
          <path class="err-tri-mark" d="M12 9v5M12 17.2v.1" />
        </svg>
        <span class="err-text">{{ shown.message }}</span>
        <span v-if="shown.count > 1" class="err-count">{{ shown.count }}</span>
      </button>
      <button
        v-if="shown.action && phase === 'text'"
        type="button"
        class="err-action"
        @click="runAction"
      >{{ shown.action.label }}</button>
    </div>
    <!-- The chip's width at rest, measured so the grow has a target. -->
    <span v-if="shown" ref="measure" class="err-notice err-measure" aria-hidden="true">
      <span class="err-text">{{ shown.message }}</span>
      <span v-if="shown.count > 1" class="err-count">{{ shown.count }}</span>
    </span>
  </div>
</template>
