import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import type { RelationRow } from "../sketch/relations";

/** Assigned by SketchMode on sketch entry, late bound like the badge layers' hooks. */
export interface RelationHooks {
  /** remove the constraint at this index; never called for an implied row */
  del(index: number): void;
  /** light these entities up on the drawing while the row is under the cursor */
  hover(entities: string[] | null): void;
  /** put these entities in the sketch selection */
  select(entities: string[]): void;
}

/** The Sketch Palette's relations list. Rows are rebuilt wholesale on every constraint change and solve, so shallowRef
 *  and markRaw; they are plain data with no per-frame path. */
export const useSketchRelationsStore = defineStore("sketchRelations", () => {
  const rows = shallowRef<readonly RelationRow[]>([]);
  /** dofSummary()'s sentence: "Fully defined", "6 degrees of freedom", ... */
  const summary = ref("");
  /** true when the solver could not satisfy the set, colours the summary. */
  const conflict = ref(false);
  /** Mirrors the palette's Show Constraints toggle, which governs the canvas glyphs this list repeats. */
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
