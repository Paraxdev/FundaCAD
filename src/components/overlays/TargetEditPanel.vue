<script setup lang="ts">
// The open selection editor: the list of things a feature acts on, one row each,
// while the viewport is armed to add and remove them.
//
// The list is the point. Clicking geometry to toggle it is what every picking
// tool in the app already does; what none of them has is a set you can READ —
// point at the third entry and see which edge lights up, take that one off and
// leave the other three. Without it, correcting a four-edge fillet that caught a
// fifth means starting over.
//
// It reads the tool and calls back. No document state, no selection state, no
// geometry: features/targetEditTool owns all of it, including the rollback that
// puts the consumed geometry back on screen.
//
// Subscribed, not polled — unlike the selection toolbar next door, which watches
// a selection nothing notifies it about. Every change here goes through the tool,
// so the tool can say when it happened.

import { computed, onMounted, onUnmounted, ref } from "vue";
import Icon from "../shell/Icon.vue";
import { useEngine } from "../../app/engineKey";
import { featureMeta } from "../../ui/featureMeta";
import { describeTarget } from "../../features/selectionTargets";

const engine = useEngine();
const tool = engine.tools.targetEdit;

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

const rows = computed(() => {
  tick.value;
  return tool.rows();
});

const field = computed(() => {
  tick.value;
  return tool.field;
});

/** The feature's own name, so the panel says WHICH fillet is being edited —
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
  <!-- Into #viewport, not the body, so `absolute` places it against the 3D view
       rather than the window: the browser pane, the history strip and the
       ribbon all move between layouts, and a window-anchored panel lands on top
       of one of them in some arrangement of them.
       The v-if is on the TELEPORT so the target is only resolved while the
       editor is open — and so no hidden element is left over the viewport
       stealing the picks this panel exists to collect. -->
  <Teleport v-if="open && field" to="#viewport">
    <div class="tgt-panel" role="dialog" :aria-label="`${title} selection`">
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
           can be dozens, and a panel taller than the window has no Done button. -->
      <ul class="tgt-list">
        <li
          v-for="(r, i) in rows"
          :key="i"
          class="tgt-item"
          :class="{ 'tgt-unresolved': !r.resolved }"
          @pointerenter="tool.hoverAt(i)"
          @pointerleave="tool.hoverAt(null)"
        >
          <span class="tgt-label">{{ r.label }}</span>
          <button
            type="button"
            class="tgt-remove"
            title="Remove this one"
            :aria-label="`Remove ${r.label}`"
            @click="tool.removeAt(i)"
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
    </div>
  </Teleport>
</template>
