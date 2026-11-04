<script setup lang="ts">
// Reads the tool and calls back: features/targetEditTool owns the set, the selection and the rollback. Subscribed,
// not polled, since every change goes through the tool.

import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import PickList from "./PickList.vue";
import Button from "../ui/Button.vue";
import { useEngine } from "../../app/engineKey";
import { featureMeta } from "../../ui/featureMeta";
import { describeTarget } from "../../features/selectionTargets";

const engine = useEngine();
const tool = engine.tools.targetEdit;

// A clicked row pins its highlight so it stays lit after the pointer leaves, kept by index, cleared by remove or close.
// Hover and focus both preview a row, leaving one falls back to the other, then to the pinned row.
const held = ref<number | null>(null);
const hovered = ref<number | null>(null);
const focused = ref<number | null>(null);
function light() {
  tool.hoverAt(hovered.value ?? focused.value ?? held.value);
}
function hover(i: number | null) {
  hovered.value = i;
  light();
}
function focusRow(i: number | null) {
  focused.value = i;
  light();
}
function pin(i: number) {
  held.value = i;
  tool.hoverAt(i);
}
// The indices shift or vanish, and a removed button gets no blur.
function forget() {
  held.value = null;
  hovered.value = null;
  focused.value = null;
}
function removeRow(i: number) {
  tool.removeAt(i);
  forget();
  tool.hoverAt(null);
}
function clearAll() {
  tool.clear();
  forget();
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
  if (!o) forget();
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
      pickable
      empty="Click geometry to add"
      @clear="clearAll"
      @remove="removeRow"
      @hover="hover"
      @focus="focusRow"
      @pick="pin"
    />

    <div class="tgt-actions">
      <Button class="tgt-done" variant="primary" @click="tool.commit()">Done</Button>
      <Button class="tgt-cancel" @click="tool.cancel()">Cancel</Button>
    </div>
  </aside>
</template>
