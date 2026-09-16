<script setup lang="ts">
import { computed } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePromptStore } from "../../stores/prompt";
import { keyHint } from "../../input/shortcuts";
import { sketchToolName } from "../../ui/railDefs";
import { runningTool } from "../../ui/runningTool";

const prompt = usePromptStore();
const engine = useEngine();

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
</script>

<template>
  <!-- `.hidden` rather than v-if: the element stays in the DOM so the CSS
       transition on .prompt still runs, exactly as when ui/prompt.ts toggled
       the class by hand. -->
  <div class="prompt" :class="{ hidden: !prompt.text, titled: !!title }">
    <span v-if="title" class="prompt-title" data-testid="prompt-title">
      {{ title.label }}<kbd v-if="title.keys" class="prompt-key">{{ title.keys }}</kbd>
    </span>
    <span id="prompt" class="prompt-text">{{ prompt.text }}</span>
  </div>
</template>
