<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import Icon from "./Icon.vue";
import IconButton from "../ui/IconButton.vue";
import ListRow from "../ui/ListRow.vue";
import { useSketchRelationsStore } from "../../stores/sketchRelations";
import type { RelationRow } from "../../sketch/relations";

const rel = useSketchRelationsStore();
const summary = ref<HTMLElement | null>(null);
const list = ref<HTMLElement | null>(null);

// An implied relation has no record behind it, so there is nothing to delete.
function rowTip(r: RelationRow): string | undefined {
  if (r.implied) return "Held by position: these endpoints are the same point";
  if (r.state === "conflict") return "Conflicting: the sketch cannot satisfy this";
  if (r.state === "over") return "Redundant: something else already says this";
  return undefined;
}

// Pointer and focus both light a row, leaving one falls back to the other.
let pointerKey: string | null = null;
let focusKey: string | null = null;

function light(key: string | null) {
  const i = key === null ? -1 : rel.rows.findIndex((r) => r.key === key);
  rel.hover(i < 0 ? null : i);
}
function enter(key: string) {
  pointerKey = key;
  light(key);
}
function leave(key: string) {
  if (pointerKey === key) pointerKey = null;
  light(focusKey);
}
function focusIn(key: string) {
  focusKey = key;
  light(key);
}
function focusOut(key: string, e: FocusEvent) {
  if (e.relatedTarget instanceof Node && (e.currentTarget as Node).contains(e.relatedTarget)) return;
  if (focusKey === key) focusKey = null;
  light(pointerKey);
}

// A delete rebuilds the rows, focus goes to whatever now sits at its place, else above it, else the summary.
let after: { at: number; time: number } | null = null;

function remove(index: number | null, at: number) {
  if (index === null) return;
  after = { at, time: performance.now() };
  rel.hooks?.del(index);
}
function onKey(e: KeyboardEvent, index: number | null, at: number) {
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  if (index === null) return;
  e.preventDefault();
  remove(index, at);
}

watch(
  () => rel.rows,
  async (rows) => {
    await nextTick();
    const active = document.activeElement;
    const items = list.value?.querySelectorAll<HTMLElement>(":scope > li");
    const held = items ? [...items].findIndex((li) => active && li.contains(active)) : -1;
    focusKey = held < 0 ? null : (rows[held]?.key ?? null);
    if (pointerKey !== null && !rows.some((r) => r.key === pointerKey)) pointerKey = null;
    if (!after || performance.now() - after.time > 2000) {
      after = null;
      return;
    }
    const { at } = after;
    after = null;
    const target = rows.length
      ? items?.[Math.min(at, rows.length - 1)]?.querySelector<HTMLElement>(".ui-list-row")
      : null;
    (target ?? summary.value)?.focus();
  },
);

watch(
  () => rel.hooks,
  () => {
    pointerKey = null;
    focusKey = null;
    after = null;
  },
);
</script>

<template>
  <div ref="summary" class="rel-summary" :class="{ conflict: rel.conflict }" tabindex="-1">{{ rel.summary }}</div>
  <p v-if="!rel.rows.length" class="rel-empty">
    Nothing is constrained yet. Draw with the grid on, or use the constraint tools, and what holds the sketch appears
    here.
  </p>
  <ul v-else ref="list" class="rel-list" data-keeps-delete aria-description="Delete removes a constraint">
    <li
      v-for="(r, i) in rel.rows"
      :key="r.key"
      class="rel-row"
      :class="{ conflict: r.state === 'conflict', over: r.state === 'over', implied: r.implied }"
      @pointerenter="enter(r.key)"
      @pointerleave="leave(r.key)"
      @focusin="focusIn(r.key)"
      @focusout="focusOut(r.key, $event)"
      @keydown="onKey($event, r.index, i)"
    >
      <ListRow
        :label="r.value ? `${r.name} ${r.value}` : r.name"
        :hint="[r.detail, r.stateWord].filter(Boolean).join(' · ') || undefined"
        :aria-label="r.spoken"
        :tip="rowTip(r)"
        @click="rel.hooks?.select(r.entities)"
      >
        <template #leading><Icon class="rel-sym" :name="r.icon" :size="14" /></template>
      </ListRow>
      <IconButton
        v-if="r.index !== null"
        class="rel-del"
        variant="danger"
        size="sm"
        icon="close"
        :icon-size="12"
        :tip="`Delete ${r.spoken}`"
        @click="remove(r.index, i)"
      />
    </li>
  </ul>
</template>
