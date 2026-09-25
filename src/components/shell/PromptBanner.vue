<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, useTemplateRef, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePromptStore } from "../../stores/prompt";
import { keyHint } from "../../input/shortcuts";
import { sketchToolName } from "../../ui/railDefs";
import { runningTool } from "../../ui/runningTool";
import { promptInsets, type Box } from "../../ui/promptPlacement";

const prompt = usePromptStore();
const engine = useEngine();
const el = useTemplateRef<HTMLDivElement>("el");

// Tools set their line when they start or change, so reading the tool state
// alongside the text is enough to keep the title in step.
const title = computed<{ label: string; keys?: string } | null>(() => {
  if (!prompt.text) return null;
  if (engine.sketch.active) return engine.sketch.tool === "select" ? null : sketchToolName(engine.sketch.tool);
  const running = runningTool(engine.tools);
  if (!running) return null;
  const keys = keyHint(running.action);
  return { label: running.label, ...(keys ? { keys } : {}) };
});

// The rail's buttons rather than the rail: its box runs the full height at the
// width of its widest label, which sits at the top.
const LEFT_CARDS = "#float-layer .float-left-stack > *, #float-layer .tool-rail .rail-btn, #float-layer .tool-rail .rail-group";
const RIGHT_CARDS = "#float-layer .float-right > *";
const MIN_WIDTH = 220;

const rects = (sel: string): Box[] => [...document.querySelectorAll(sel)].map((o) => o.getBoundingClientRect());

// The toast stack is fixed to the window's bottom centre, the same place this
// banner sits, so it is told how far up the banner reaches (--prompt-clear) and
// stacks above it.
const root = document.documentElement;
const clearToasts = () => root.style.removeProperty("--prompt-clear");

function place() {
  const me = el.value;
  const area = me?.parentElement;
  if (!me || !area || !prompt.text) return clearToasts();
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--float-gap")) || 12;
  const { left, right } = promptInsets(
    area.getBoundingClientRect(),
    me.getBoundingClientRect(),
    { left: rects(LEFT_CARDS), right: rects(RIGHT_CARDS) },
    gap,
    MIN_WIDTH,
  );
  me.style.setProperty("--prompt-left", `${left}px`);
  me.style.setProperty("--prompt-right", `${right}px`);
  // offsetTop rather than the box: the entry animation slides the banner in.
  const top = (me.offsetParent ?? area).getBoundingClientRect().top + me.offsetTop;
  root.style.setProperty("--prompt-clear", `${Math.max(0, Math.round(window.innerHeight - top + gap))}px`);
}

let frame = 0;
const schedule = () => {
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); });
};
let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver(schedule);
  const watchAll = () => {
    ro!.disconnect();
    for (const n of [el.value, el.value?.parentElement, ...document.querySelectorAll("#float-layer .float-left, #float-layer .float-left-stack, #float-layer .tool-rail, #float-layer .float-right")]) {
      if (n) ro!.observe(n);
    }
  };
  watchAll();
  // The columns' contents come and go (Items closed, History opened), and a
  // card swapped for another of the same size fires no resize.
  watch(() => [prompt.text, title.value], () => nextTick(() => { watchAll(); place(); }));
  schedule();
});
onUnmounted(() => {
  clearToasts();
  ro?.disconnect();
  if (frame) cancelAnimationFrame(frame);
});
</script>

<template>
  <!-- `.hidden` rather than v-if: the element stays in the DOM so the CSS
       transition on .prompt still runs, exactly as when ui/prompt.ts toggled
       the class by hand. -->
  <div ref="el" class="prompt" :class="{ hidden: !prompt.text, titled: !!title }">
    <span v-if="title" class="prompt-title" data-testid="prompt-title">
      {{ title.label }}<kbd v-if="title.keys" class="prompt-key">{{ title.keys }}</kbd>
    </span>
    <span id="prompt" class="prompt-text">{{ prompt.text }}</span>
  </div>
</template>
