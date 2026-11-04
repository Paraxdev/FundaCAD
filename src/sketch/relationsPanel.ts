// The Relations list facade SketchMode talks to: rows from relations.ts, rendered by SketchPalette.vue from a store.

import { markRaw } from "vue";
import { announce, cancelAnnouncement } from "../ui/announce";
import { DofSpeech } from "./dofSpeech";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { dofSummary, relationRows } from "./relations";
import { FreedomWatch } from "./freedomWatch";
import { useSketchPaletteStore } from "../stores/sketchPalette";
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
    shapes: (open: boolean) => this.probeShapes(open),
  });

  private readonly watch = new FreedomWatch((map) => useSketchRelationsStore().setFreedom(map));
  private latest: { entities: ResolvedEntity[]; constraints: SketchConstraint[] } | null = null;

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
    store.setShapes(entities);
    this.latest = { entities, constraints };
    this.probeShapes(useSketchPaletteStore().shapesOpen);
    const line = this.speech.next(summary, conflict, ready);
    if (line) announce(line.text, line.priority, { key: "sketch-dof", delay: 400 });
  }

  /** Probes only while the list is open and shown, and words never outlive the list. */
  private probeShapes(open: boolean) {
    const store = useSketchRelationsStore();
    if (open && store.visible && this.latest) {
      this.watch.request(this.latest.entities, this.latest.constraints);
      return;
    }
    this.watch.cancel();
    store.setFreedom(null);
  }

  hide() {
    this.watch.cancel();
    this.latest = null;
    this.speech.reset();
    cancelAnnouncement("sketch-dof");
    useSketchRelationsStore().hide();
  }

  /** Follows the palette's Show Constraints toggle, the list says the same as the canvas glyphs. */
  setVisible(on: boolean) {
    useSketchRelationsStore().visible = on;
    this.probeShapes(useSketchPaletteStore().shapesOpen);
  }
}
