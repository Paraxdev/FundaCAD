<script setup lang="ts">
import { useEngine } from "../../app/engineKey";
import { useUiStore } from "../../stores/ui";

const engine = useEngine();
const ui = useUiStore();

// Every one of these routes through handleAction rather than calling the
// viewport directly, so the buttons, the keymap and the command palette share
// one dispatch path (and one "Repeat last command" history).
const VIEWS = [
  { view: "iso", title: "Isometric", label: "ISO" },
  { view: "top", title: "Top", label: "Top" },
  { view: "front", title: "Front", label: "Front" },
  { view: "right", title: "Right", label: "Right" },
] as const;
</script>

<template>
  <div id="viewcontrols">
    <button
      v-for="v in VIEWS"
      :key="v.view"
      :data-view="v.view"
      :title="v.title"
      @click="engine.handleAction(v.view)"
    >{{ v.label }}</button>
    <button id="fit" title="Fit to view" @click="engine.handleAction('fit')">Fit</button>
    <button
      id="proj"
      title="Projection: Persp / Ortho / Auto (ortho when viewing straight-on)"
      @click="engine.handleAction('persp')"
    >{{ ui.projLabel }}</button>
    <button
      id="xray"
      title="See through the model, so a selection box reaches what is behind (X)"
      :class="{ active: ui.xray }"
      @click="engine.handleAction('toggle-xray')"
    >X-ray</button>
    <button
      id="selmode"
      title="Toggle selecting Faces / whole Bodies"
      :class="{ active: ui.selMode === 'bodies' }"
      @click="engine.handleAction('selmode')"
    >{{ ui.selMode === "bodies" ? "Bodies" : "Faces" }}</button>
  </div>
</template>
