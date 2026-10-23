<script setup lang="ts">
// Reads the tool and calls back: features/targetEditTool owns the set, the selection and the rollback. Subscribed,
// not polled, since every change goes through the tool.

import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import PickList from "./PickList.vue";
import { useEngine } from "../../app/engineKey";
import { featureMeta } from "../../ui/featureMeta";
import { describeTarget } from "../../features/selectionTargets";

const engine = useEngine();
const tool = engine.tools.targetEdit;

// A clicked row pins its highlight so it stays lit after the pointer leaves, kept by index, cleared by remove or close.
const held = ref<number | null>(null);
function focus(i: number) {
  held.value = i;
  tool.hoverAt(i);
}
function leave() {
  tool.hoverAt(held.value);
}
function removeRow(i: number) {
  tool.removeAt(i);
  held.value = null;
  tool.hoverAt(null);
}

// One counter, bumped by the tool. The rows are recomputed from it rather than
// held as reactive state, so the panel cannot drift from the set being written.
const tick = ref(0);
let stop: (() => void) | null = null;
onMounted(() => {
  stop = tool.onChange(() => tick.value++);
});
onUnmounted(() => {
  stop?.();
  stop = null;
});

const open = computed(() => {
  tick.value;
  return tool.active;
});

// A closed editor holds no pinned row into the next one it opens.
watch(open, (o) => {
  if (!o) held.value = null;
});

const rows = computed(() => {
  tick.value;
  return tool.rows();
});

const field = computed(() => {
  tick.value;
  return tool.field;
});

/** The feature's own name: there are usually several fillets. */
const title = computed(() => {
  tick.value;
  const id = tool.editingId;
  const f = id ? engine.store.document.features.find((x) => x.id === id) : null;
  if (!f) return "";
  return (f as { name?: string }).name || featureMeta(f).label;
});

const summary = computed(() => {
  const t = field.value;
  return t ? describeTarget(t, rows.value.length) : "";
});
</script>

<template>
  <!-- Parked in the left column, not floating: a panel following the geometry would eat the clicks it collects. -->
  <aside v-if="open && field" class="tgt-panel" role="dialog" :aria-label="`${title} selection`">
    <div class="tgt-head">
      <span class="tgt-title">{{ title }}</span>
      <span class="tgt-sub">{{ summary }}</span>
    </div>

    <PickList
      :label="field.label"
      :rows="rows"
      :held="held"
      empty="Click geometry to add"
      @clear="tool.clear()"
      @remove="removeRow"
      @enter="tool.hoverAt($event)"
      @leave="leave()"
      @pick="focus"
    />

    <div class="tgt-actions">
      <button type="button" class="tgt-done" @click="tool.commit()">Done</button>
      <button type="button" class="tgt-cancel" @click="tool.cancel()">Cancel</button>
    </div>
  </aside>
</template>
