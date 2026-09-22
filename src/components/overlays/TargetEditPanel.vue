<script setup lang="ts">
// The open selection editor: the list of things a feature acts on, one row each,
// while the viewport is armed to add and remove them.
//
// The list is the point. Clicking geometry to toggle it is what every picking
// tool in the app already does; what none of them has is a set you can READ,
// point at the third entry and see which edge lights up, take that one off and
// leave the other three. Without it, correcting a four-edge fillet that caught a
// fifth means starting over.
//
// It reads the tool and calls back. No document state, no selection state, no
// geometry: features/targetEditTool owns all of it, including the rollback that
// puts the consumed geometry back on screen.
//
// Subscribed, not polled, unlike the selection toolbar next door, which watches
// a selection nothing notifies it about. Every change here goes through the tool,
// so the tool can say when it happened.

import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../shell/Icon.vue";
import { useEngine } from "../../app/engineKey";
import { featureMeta } from "../../ui/featureMeta";
import { describeTarget } from "../../features/selectionTargets";

const engine = useEngine();
const tool = engine.tools.targetEdit;

// Clicking a row pins the highlight on the geometry it names, so it stays lit
// after the pointer moves on (hover lights it too, but only while hovered). The
// pinned row is kept by index; a remove or a close clears it.
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

/** The feature's own name, so the panel says WHICH fillet is being edited,
 *  there are usually several. */
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
  <!-- Docked in the left column, under the Items browser (which shrinks) and
       beside the tool rail, so the affected-geometry list sits where the
       fillet's edge list does. It is PARKED, not floating: the geometry it names
       is exactly what you are about to click, so a panel that followed the
       geometry would eat the gesture it exists to collect. -->
  <aside v-if="open && field" class="tgt-panel" role="dialog" :aria-label="`${title} selection`">
    <div class="tgt-head">
      <span class="tgt-title">{{ title }}</span>
      <span class="tgt-sub">{{ summary }}</span>
    </div>

    <div class="tgt-fieldrow">
      <span class="tgt-field">{{ field.label }}</span>
      <button
        type="button"
        class="tgt-clear"
        :disabled="rows.length === 0"
        title="Remove every entry"
        @click="tool.clear()"
      >
        Clear all
      </button>
    </div>

    <!-- The list scrolls rather than growing: a face set on an imported mesh
         can be dozens, and a panel taller than the column has no Done button. -->
    <ul class="tgt-list">
      <li
        v-for="(r, i) in rows"
        :key="i"
        class="tgt-item"
        :class="{ 'tgt-unresolved': !r.resolved, 'tgt-held': held === i }"
        @pointerenter="tool.hoverAt(i)"
        @pointerleave="leave()"
        @click="focus(i)"
      >
        <span class="tgt-label">{{ r.label }}</span>
        <button
          type="button"
          class="tgt-remove"
          title="Remove this one"
          :aria-label="`Remove ${r.label}`"
          @click.stop="removeRow(i)"
        >
          <Icon name="minus" :size="14" />
        </button>
      </li>
      <!-- Not an empty box: several targets mean something specific with
           nothing in them, and the row above already says which. -->
      <li v-if="rows.length === 0" class="tgt-none">Click geometry to add</li>
    </ul>

    <div class="tgt-actions">
      <button type="button" class="tgt-done" @click="tool.commit()">Done</button>
      <button type="button" class="tgt-cancel" @click="tool.cancel()">Cancel</button>
    </div>
  </aside>
</template>
