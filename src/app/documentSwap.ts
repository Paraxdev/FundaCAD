import type { DocumentStore } from "../document/store";

export interface DocumentSwapTarget {
  sketch: { active: boolean; cancel(): void };
  dropBodyGizmo(): void;
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
    if (e.sketch.active) e.sketch.cancel();
    // Left selected, a face is found again by position in the next document's model.
    e.dropBodyGizmo();
    e.viewport.clearSelection();
    e.viewport.setSelectedBodies([]);
    // Last, the handlers above may still read the old model.
    e.viewport.clearModel();
  });
}
