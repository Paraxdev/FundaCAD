<script setup lang="ts">
// Overhang (Draft Analysis) settings: build direction + support threshold,
// shown while Draft Analysis is active.
//
// No Esc-dismiss, on purpose, it is closed programmatically when Draft
// Analysis is toggled off, so Esc must not leave the analysis running with its
// controls gone. The settings live on the viewport, not the document: they are
// display-only and deliberately not undoable.

import { ref, watch } from "vue";
import { useEngine } from "../../app/engineKey";
import { usePanelsStore } from "../../stores/panels";
import FloatingPanel from "./FloatingPanel.vue";

type BuildDir = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";
const DIRS: BuildDir[] = ["+Z", "-Z", "+X", "-X", "+Y", "-Y"];

const engine = useEngine();
const panels = usePanelsStore();

const dir = ref<BuildDir>("+Z");
const threshold = ref(45);

// Seed from the viewport each time it opens rather than once at mount: Draft
// Analysis can be toggled off and on, and the config may have moved meanwhile.
watch(
  () => panels.overhang,
  (open) => {
    if (!open) return;
    const cfg = engine.viewport.draftConfig;
    dir.value = cfg.dir as BuildDir;
    threshold.value = cfg.threshold;
  },
  { immediate: true },
);

function apply() {
  engine.viewport.setDraftConfig(dir.value, threshold.value);
}
</script>

<template>
  <FloatingPanel :open="panels.overhang">
    <div class="measure-title">Overhang analysis</div>
    <div class="measure-row">
      <span class="measure-k">Build dir</span>
      <select v-model="dir" class="oh-dir" @change="apply()">
        <option v-for="d in DIRS" :key="d" :value="d">{{ d }}</option>
      </select>
    </div>
    <div class="measure-row">
      <span class="measure-k">Threshold</span>
      <span>
        <input
          v-model.number="threshold"
          class="oh-thr"
          type="range"
          min="0"
          max="90"
          step="1"
          style="width: 96px; vertical-align: middle"
          @input="apply()"
        />
        <span class="oh-val">{{ threshold }}°</span>
      </span>
    </div>
    <div class="measure-row">
      <span class="measure-v" style="color: #e24a3b">red = unsupported overhang</span>
    </div>
    <div class="measure-hint">
      Faces past this angle from horizontal need support · toggle Draft to close
    </div>
  </FloatingPanel>
</template>
