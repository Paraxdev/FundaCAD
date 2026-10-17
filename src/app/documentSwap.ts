import type { DocumentStore } from "../document/store";

export interface DocumentSwapTarget {
  /** Every armed tool, with its preview, handles and panel, and its listeners
   *  that would commit a held drag into the next document. */
  cancelTools(): void;
  sketch: { active: boolean; cancel(): void };
  dropBodyGizmo(): void;
  overlay: { clearRegionSelection(): void };
  /** The handle offered on the last extrude's top, matched by feature id alone. */
  forgetLastCommit(): void;
  viewport: {
    clearSelection(): void;
    setSelectedBodies(ids: string[]): void;
    clearModel(): void;
  };
}

/** New and Open take the old document off screen in the same call that replaces
 *  it, not when the engine answers for the new one. */
export function wireDocumentSwap(store: Pick<DocumentStore, "onOpen">, e: DocumentSwapTarget) {
  return store.onOpen(() => {
    e.cancelTools();
    if (e.sketch.active) e.sketch.cancel();
    // Left selected, a face is found again by position in the next document's model.
    e.dropBodyGizmo();
    e.viewport.clearSelection();
    e.viewport.setSelectedBodies([]);
    // A world point, so it would preselect a profile drawn in the same spot.
    e.overlay.clearRegionSelection();
    e.forgetLastCommit();
    // Last, the handlers above may still read the old model.
    e.viewport.clearModel();
  });
}
