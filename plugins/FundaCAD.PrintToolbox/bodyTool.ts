// The body-target counterpart to FaceTool: a verb that acts on the selected
// bodies, or the active one when nothing is selected. An empty selection is a
// legitimate target here (BODIES_TARGET's whenEmpty is "the active body"), so
// unlike a face pick there is nothing to wait for: the feature is added at once.

import type { DocumentStore, Viewport } from "fundacad";
import { bodyFeatureFor, type BuildDir, type PrintTool } from "./printForm";

export class BodyTool {
  active = false;

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
  ) {}

  /** Add the feature now, against whatever bodies are selected. */
  run(tool: PrintTool, onDone: (id: string | null) => void) {
    const ids = this.viewport.getSelectedBodies();
    const dir = this.viewport.draftConfig.dir as BuildDir;
    const feature = bodyFeatureFor(tool, this.store.nextId(), ids, dir);
    this.store.addFeature(feature);
    onDone(feature.id);
  }

  cancel() {
    // Never waits, so there is never anything to cancel out of.
  }
}
