// The Relations list in the Sketch Palette, as the facade SketchMode talks to.
//
// Same split, and for the same reason, as sketchGlyphs.ts: the rows are built
// by a pure function (relations.ts), rendered by a component
// (components/shell/SketchPalette.vue) out of a store
// (stores/sketchRelations.ts), and SketchMode — which has no HTML in it and is
// not about to start — sees only show/hide and a few hook fields.

import { markRaw } from "vue";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { dofSummary, relationRows } from "./relations";
import { useSketchRelationsStore, type RelationHooks } from "../stores/sketchRelations";

export class RelationsPanel {
  /** delete the constraint at this index (wired by SketchMode) */
  onDelete: ((cIndex: number) => void) | null = null;
  /** light these entity ids on the drawing, or null to put them back */
  onHover: ((ids: string[] | null) => void) | null = null;
  /** put these entity ids in the sketch selection */
  onSelect: ((ids: string[]) => void) | null = null;

  /** Assigned by SketchMode AFTER construction, so these read the fields at call
   *  time rather than capturing them. markRaw: they close over this instance,
   *  which closes over SketchMode and the live document. */
  private readonly hooks: RelationHooks = markRaw({
    del: (i: number) => this.onDelete?.(i),
    hover: (ids: string[] | null) => this.onHover?.(ids),
    select: (ids: string[]) => this.onSelect?.(ids),
  });

  show(
    entities: ResolvedEntity[],
    constraints: SketchConstraint[],
    conflicts: Set<number>,
    over: Set<number>,
    dof: number,
    conflict: boolean,
  ) {
    const store = useSketchRelationsStore();
    store.hooks = this.hooks;
    store.show(
      relationRows(entities, constraints, conflicts, over),
      dofSummary(dof, conflict),
      conflict,
    );
  }

  hide() {
    useSketchRelationsStore().hide();
  }

  /** Follows the palette's Show Constraints toggle, which governs the canvas
   *  glyphs: the list is the same information said a second way, and a user who
   *  has turned the badges off has said what they think of it. */
  setVisible(on: boolean) {
    useSketchRelationsStore().visible = on;
  }
}
