import { defineStore } from "pinia";
import { computed, markRaw, ref, shallowRef } from "vue";
import type { Freedom } from "../sketch/freedomWords";
import type { RelationRow } from "../sketch/relations";
import { shapeRow } from "../sketch/sketchNames";
import type { ResolvedEntity } from "../sketch/snap";

/** Assigned by SketchMode on sketch entry, late bound like the badge layers' hooks. */
export interface RelationHooks {
  /** remove the constraint at this index; never called for an implied row */
  del(index: number): void;
  /** light these entities up on the drawing while the row is under the cursor */
  hover(entities: string[] | null): void;
  /** put these entities in the sketch selection */
  select(entities: string[]): void;
  /** the Shapes list opened or closed, the freedom probes run only while it is open */
  shapes(open: boolean): void;
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

  const shapeEntities = shallowRef<readonly ResolvedEntity[]>([]);
  /** null while unknown: a conflict, the solver off, or no probe landed yet */
  const freedom = shallowRef<ReadonlyMap<string, Freedom> | null>(null);
  /** No freedom words while constraints conflict, the summary line says why. */
  const shapes = computed(() => {
    const ents = shapeEntities.value as ResolvedEntity[];
    const known = conflict.value ? null : freedom.value;
    return ents.map((e) => shapeRow(ents, e, known?.get(e.id)));
  });

  function setShapes(ents: readonly ResolvedEntity[]) {
    shapeEntities.value = ents.slice();
  }
  function setFreedom(map: ReadonlyMap<string, Freedom> | null) {
    freedom.value = map;
  }

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
    shapeEntities.value = [];
    freedom.value = null;
    hooks.value = null;
  }

  function hover(i: number | null) {
    hovered.value = i;
    const row = i == null ? null : rows.value[i];
    hooks.value?.hover(row ? row.entities : null);
  }

  return {
    rows,
    summary,
    conflict,
    visible,
    hooks,
    hovered,
    shapes,
    freedom,
    show,
    hide,
    hover,
    setShapes,
    setFreedom,
  };
});
