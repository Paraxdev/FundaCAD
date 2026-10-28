<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import type { SectionPhase } from "../../features/sectionTool";
import Icon from "./Icon.vue";
import Button from "../ui/Button.vue";

const engine = useEngine();
const section = engine.tools.section;
const phase = ref<SectionPhase>(section.phase);

// toolOwnsScreen() publishes no change, so it is read again on the pulse ToolRail uses.
const pulse = ref(0);
let raf = 0;
const bump = () => {
  if (!raf)
    raf = requestAnimationFrame(() => {
      raf = 0;
      pulse.value++;
    });
};
let unsubs: (() => void)[] = [];
onMounted(() => {
  window.addEventListener("pointerup", bump);
  window.addEventListener("keyup", bump);
  unsubs = [
    section.onChange((p) => {
      phase.value = p;
      bump();
    }),
    engine.store.onDocChange(bump),
    engine.store.onBuild(bump),
  ];
});
onUnmounted(() => {
  window.removeEventListener("pointerup", bump);
  window.removeEventListener("keyup", bump);
  for (const off of unsubs) off();
  unsubs = [];
  if (raf) cancelAnimationFrame(raf);
});

const shown = computed(() => phase.value === "on" || phase.value === "editing");
const editing = computed(() => phase.value === "editing");
// A body selection alone (its Move gizmo) does not block Edit, toolOwnsScreen() leaves it out.
const blocked = computed(() => {
  pulse.value;
  return !editing.value && engine.toolOwnsScreen();
});
const editTip = computed(() =>
  editing.value
    ? "Keep the cut and hide the handle (Enter)"
    : blocked.value
      ? "Finish the current tool first"
      : "Move or flip the cut with its handle",
);

function onEdit() {
  if (editing.value) return section.confirm();
  if (engine.toolOwnsScreen()) return;
  engine.dropBodyGizmo();
  section.edit();
}
</script>

<template>
  <div
    v-if="shown"
    class="section-chip"
    role="toolbar"
    aria-label="Section view"
    data-testid="section-chip"
    @mousedown.prevent
  >
    <span class="section-chip-label" title="Section on">
      <Icon name="section" :size="14" />
      <span class="section-chip-text">Section on</span>
    </span>
    <Button size="sm" :pressed="editing" :disabled="blocked" :tip="editTip" data-testid="section-edit" @click="onEdit"
      >Edit</Button
    >
    <Button size="sm" tip="Keep the other side of the cut" data-testid="section-flip" @click="section.flip()"
      >Flip</Button
    >
    <Button size="sm" tip="Turn the section off" data-testid="section-off" @click="section.stop()">Off</Button>
  </div>
</template>
