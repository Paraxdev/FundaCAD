// The Relations list facade SketchMode talks to: rows from relations.ts, rendered by SketchPalette.vue from a store.

import { markRaw } from "vue";
import { announce, cancelAnnouncement } from "../ui/announce";
import { DofSpeech } from "./dofSpeech";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { dofSummary, relationRows } from "./relations";
import { useSketchRelationsStore, type RelationHooks } from "../stores/sketchRelations";

export class RelationsPanel {
  onDelete: ((cIndex: number) => void) | null = null;
  /** null clears the highlight */
  onHover: ((ids: string[] | null) => void) | null = null;
  onSelect: ((ids: string[]) => void) | null = null;

  /** Read at call time since SketchMode assigns them after construction, markRaw since they close over the document. */
  private readonly hooks: RelationHooks = markRaw({
    del: (i: number) => this.onDelete?.(i),
    hover: (ids: string[] | null) => this.onHover?.(ids),
    select: (ids: string[]) => this.onSelect?.(ids),
  });

  private readonly speech = new DofSpeech();

  show(
    entities: ResolvedEntity[],
    constraints: SketchConstraint[],
    conflicts: Set<number>,
    over: Set<number>,
    dof: number,
    conflict: boolean,
    ready: boolean,
  ) {
    const store = useSketchRelationsStore();
    const summary = dofSummary(dof, conflict);
    store.hooks = this.hooks;
    store.show(relationRows(entities, constraints, conflicts, over), summary, conflict);
    const line = this.speech.next(summary, conflict, ready);
    if (line) announce(line.text, line.priority, { key: "sketch-dof", delay: 400 });
  }

  hide() {
    this.speech.reset();
    cancelAnnouncement("sketch-dof");
    useSketchRelationsStore().hide();
  }

  /** Follows the palette's Show Constraints toggle, the list says the same as the canvas glyphs. */
  setVisible(on: boolean) {
    useSketchRelationsStore().visible = on;
  }
}
