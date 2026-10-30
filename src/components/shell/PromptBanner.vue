<script setup lang="ts">
import { fmtKeys } from "../../input/platform";
import { computed, nextTick, onMounted, onUnmounted, useTemplateRef, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePromptStore } from "../../stores/prompt";
import { keyHint } from "../../input/shortcuts";
import { sketchToolName } from "../../ui/railDefs";
import { runningTool } from "../../ui/runningTool";
import { COLUMNS, LEFT_CARDS, RIGHT_CARDS, cardRects, centreShift, promptInsets } from "../../ui/promptPlacement";
import { announce } from "../../ui/announce";

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

const SEP = " · ";
// The dot is drawn but hidden from screen readers, which read it aloud; the announcer says commas instead.
const parts = computed(() => fmtKeys(prompt.text ?? "").split(SEP));

// The tool's name leads the first prompt a tool gives, and a later step says only what changed.
let spokenTitle: string | null = null;
watch(
  () => [title.value?.label ?? null, prompt.text] as const,
  ([label, text]) => {
    if (!text) {
      spokenTitle = null;
      return;
    }
    const fresh = !!label && label !== spokenTitle;
    spokenTitle = label;
    announce(fresh ? `${label}, ${fmtKeys(text)}` : fmtKeys(text), "polite", { key: "prompt", delay: 120 });
  },
  { immediate: true },
);

const MIN_WIDTH = 220;

// The toast stack shares this bottom centre spot, so --prompt-clear tells it how far up the banner reaches.
const root = document.documentElement;
const clearToasts = () => root.style.removeProperty("--prompt-clear");

function place() {
  const me = el.value;
  const area = me?.parentElement;
  if (!me || !area || !prompt.text) return clearToasts();
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--float-gap")) || 12;
  const box = area.getBoundingClientRect();
  const mine = me.getBoundingClientRect();
  const insets = promptInsets(
    box,
    mine,
    { left: cardRects(LEFT_CARDS), right: cardRects(RIGHT_CARDS) },
    gap,
    MIN_WIDTH,
  );
  me.style.setProperty("--prompt-left", `${insets.left}px`);
  me.style.setProperty("--prompt-right", `${insets.right}px`);
  me.style.setProperty("--prompt-shift", `${centreShift(box.width, insets, mine.width)}px`);
  // offsetTop rather than the box: the entry animation slides the banner in.
  const top = (me.offsetParent ?? area).getBoundingClientRect().top + me.offsetTop;
  root.style.setProperty("--prompt-clear", `${Math.max(0, Math.round(window.innerHeight - top + gap))}px`);
}

let frame = 0;
const schedule = () => {
  if (!frame)
    frame = requestAnimationFrame(() => {
      frame = 0;
      place();
    });
};
let ro: ResizeObserver | null = null;
// A rail scrolled by a step shows other labels in the row without resizing anything.
const onScroll = (e: Event) => {
  if (e.target instanceof Element && e.target.closest("#float-layer")) schedule();
};
onMounted(() => {
  ro = new ResizeObserver(schedule);
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  const watchAll = () => {
    ro!.disconnect();
    for (const n of [el.value, el.value?.parentElement, ...document.querySelectorAll(COLUMNS)]) {
      if (n) ro!.observe(n);
    }
  };
  watchAll();
  // The columns' contents come and go (Items closed, History opened), and a
  // card swapped for another of the same size fires no resize.
  watch(
    () => [prompt.text, title.value],
    () =>
      nextTick(() => {
        watchAll();
        place();
      }),
  );
  schedule();
});
onUnmounted(() => {
  clearToasts();
  ro?.disconnect();
  document.removeEventListener("scroll", onScroll, { capture: true });
  if (frame) cancelAnimationFrame(frame);
});
</script>

<template>
  <!-- `.hidden` rather than v-if, so the element stays and the CSS transition on .prompt still runs. -->
  <div ref="el" class="prompt" :class="{ hidden: !prompt.text, titled: !!title }">
    <span v-if="title" class="prompt-title" data-testid="prompt-title">
      {{ title.label }}<kbd v-if="title.keys" class="prompt-key">{{ fmtKeys(title.keys) }}</kbd>
    </span>
    <span id="prompt" class="prompt-text"
      ><template v-for="(part, i) in parts" :key="i"
        ><span v-if="i" class="prompt-sep" aria-hidden="true">{{ SEP }}</span
        >{{ part }}</template
      ></span
    >
  </div>
</template>
