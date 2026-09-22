<script setup lang="ts">
// The member list for the Fillet / Chamfer tool. While a blend is being sized,
// its member edges show as orange lines in the view you click to drop; this is
// the same set as a list, which is what a blend with a lot of edges needs, and
// the only way to reach the UNRESOLVED members, saved selectors whose edge the
// current geometry no longer draws, so they have no line to click.
//
// It sits at the bottom of the left column, under the Items browser (which
// shrinks to make room) and beside the tool rail, so it is a docked card rather
// than a panel floating over the model. Renders nothing until a blend is being
// edited.
//
// A poll rather than a subscription, the same shape useSelectionOffers uses: the
// tool is plain imperative code that mutates its member array on pointer events,
// and the loop runs only while a blend is being edited.

import { onMounted, onUnmounted, shallowRef } from "vue";
import { useEngine } from "../../app/engineKey";
import Icon from "../shell/Icon.vue";
import type { EdgeMemberRow } from "../../features/edgeFeatureTool";

const engine = useEngine();
const tool = () => engine.tools.edgeFeature;

const active = shallowRef(false);
const kind = shallowRef<"fillet" | "chamfer">("fillet");
const rows = shallowRef<EdgeMemberRow[]>([]);

function refresh(): boolean {
  const t = tool();
  const on = t.editingMembers();
  active.value = on;
  if (on) {
    rows.value = t.memberRows();
    kind.value = t.blendKind();
  } else {
    rows.value = [];
  }
  return on;
}

let raf = 0;
function tick() {
  raf = 0;
  if (refresh()) raf = requestAnimationFrame(tick);
}
function wake() {
  if (!raf) raf = requestAnimationFrame(tick);
}

let unsubs: (() => void)[] = [];
onMounted(() => {
  window.addEventListener("pointerup", wake);
  window.addEventListener("keyup", wake);
  unsubs = [engine.store.onBuild(() => wake()), engine.store.onDocChange(() => wake())];
  wake();
});
onUnmounted(() => {
  window.removeEventListener("pointerup", wake);
  window.removeEventListener("keyup", wake);
  for (const off of unsubs) off();
  unsubs = [];
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
});

function remove(key: string) {
  tool().removeMemberByKey(key);
  refresh();
  wake();
}
function add() {
  tool().promptAddMember();
}

const resolvedCount = () => rows.value.filter((r) => r.resolved).length;
const unresolvedCount = () => rows.value.filter((r) => !r.resolved).length;
</script>

<template>
  <aside v-if="active && rows.length" class="float-card fm-card" role="group" aria-label="Blend edges">
    <div class="float-card-head">
      <span class="float-card-title">{{ kind === "fillet" ? "Fillet" : "Chamfer" }}</span>
      <span class="fm-count">{{ resolvedCount() }} edge{{ resolvedCount() === 1 ? "" : "s" }}</span>
      <span v-if="unresolvedCount()" class="fm-warn-count">{{ unresolvedCount() }} unresolved</span>
    </div>
    <ul class="fm-list">
      <li v-for="r in rows" :key="r.key" class="fm-row" :class="{ unresolved: !r.resolved }">
        <Icon :name="r.resolved ? 'edge' : 'warning'" :size="15" class="fm-mark" />
        <span class="fm-label">{{ r.label }}</span>
        <button
          type="button"
          class="fm-x"
          :title="`Remove ${r.label}`"
          :aria-label="`Remove ${r.label}`"
          @pointerdown.prevent.stop="remove(r.key)"
        >
          <Icon name="close" :size="13" />
        </button>
      </li>
    </ul>
    <div class="fm-foot">
      <button type="button" class="fm-add" @pointerdown.prevent.stop="add()">
        <Icon name="plus" :size="14" /> Add edge
      </button>
    </div>
  </aside>
</template>

<style scoped>
/* A docked card in the left column: sticks to the bottom (margin-top:auto), and
   is capped so a long edge list scrolls rather than pushing the Items browser
   out of the column. */
.fm-card {
  flex: 0 0 auto;
  margin-top: auto;
  /* Stretches to the column's width (the Items pane beside it), usable alone. */
  min-width: 220px;
  max-height: min(46vh, 360px);
  pointer-events: auto;
}
.fm-count {
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 400;
}
.fm-warn-count {
  margin-left: auto;
  color: var(--warn);
  font-size: 11px;
  font-weight: 600;
}
.fm-list {
  list-style: none;
  margin: 0;
  padding: 2px 8px;
  overflow-y: auto;
  min-height: 0;
  font: 12px var(--ui, system-ui, sans-serif);
  color: var(--text);
}
.fm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border-radius: 5px;
}
.fm-row + .fm-row {
  margin-top: 2px;
}
.fm-row:hover {
  background: var(--raised);
}
.fm-mark {
  flex: none;
  color: var(--accent);
}
.fm-row.unresolved .fm-mark {
  color: var(--warn);
}
.fm-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fm-row.unresolved .fm-label {
  color: var(--warn);
}
.fm-x {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: none;
  border: 0;
  border-radius: 4px;
  color: var(--text-mute);
  cursor: pointer;
}
.fm-x:hover {
  background: var(--error-tint);
  color: var(--error);
}
.fm-foot {
  flex: none;
  padding: 6px 8px 8px;
}
.fm-add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 6px;
  background: var(--raised);
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text);
  font: 12px var(--ui, system-ui, sans-serif);
  cursor: pointer;
}
.fm-add:hover {
  border-color: var(--accent);
  color: var(--accent-hot);
}
</style>
