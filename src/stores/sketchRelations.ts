import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import type { RelationRow } from "../sketch/relations";

/** What the list calls back into. Assigned by SketchMode on sketch entry, in
 *  the same late-bound way the two badge layers get theirs. */
export interface RelationHooks {
  /** remove the constraint at this index; never called for an implied row */
  del(index: number): void;
  /** light these entities up on the drawing while the row is under the cursor */
  hover(entities: string[] | null): void;
  /** put these entities in the sketch selection */
  select(entities: string[]): void;
}

/** The relations list in the Sketch Palette: what is holding the open sketch,
 *  and how much freedom is left.
 *
 *  shallowRef + markRaw on the rows for the same reason the annotation store
 *  does it: they are rebuilt wholesale on every constraint change and every
 *  solve, and there is nothing in them a deep Proxy would earn. They are plain
 *  data though — no closures, no THREE objects — so unlike the badge layers
 *  this one has no per-frame path and no rAF loop. Position is not its problem. */
export const useSketchRelationsStore = defineStore("sketchRelations", () => {
  const rows = shallowRef<readonly RelationRow[]>([]);
  /** dofSummary()'s sentence: "Fully defined", "6 degrees of freedom", ... */
  const summary = ref("");
  /** true when the solver could not satisfy the set — colours the summary. */
  const conflict = ref(false);
  /** mirrors the palette's Show Constraints toggle, which governs the canvas
   *  glyphs; the list is the same information and follows the same switch. */
  const visible = ref(true);
  const hooks = shallowRef<RelationHooks | null>(null);
  /** the row the pointer is on, so the highlight can be cleared on leave */
  const hovered = ref<number | null>(null);

  function show(next: RelationRow[], text: string, hasConflict: boolean) {
    rows.value = next.map((r) => markRaw(r));
    summary.value = text;
    conflict.value = hasConflict;
  }

  function hide() {
    rows.value = [];
    summary.value = "";
    conflict.value = false;
    hovered.value = null;
    hooks.value = null;
  }

  function hover(i: number | null) {
    hovered.value = i;
    const row = i == null ? null : rows.value[i];
    hooks.value?.hover(row ? row.entities : null);
  }

  return { rows, summary, conflict, visible, hooks, hovered, show, hide, hover };
});
