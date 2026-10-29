import type { DocumentStore } from "../document/store";
import type { DocumentSession } from "../document/session";
import { setWorkspace } from "../ui/workspace";

export interface DocumentSwapTarget {
  /** Every armed tool, with its preview, handles and panel, and its listeners
   *  that would commit a held drag into the next document. */
  cancelTools(): void;
  sketch: { active: boolean; cancel(): void };
  dropBodyGizmo(): void;
  overlay: { clearRegionSelection(): void; clearTransient(): void };
  /** The handle offered on the last extrude's top, matched by feature id alone. */
  forgetLastCommit(): void;
  viewport: {
    clearSelection(): void;
    setSelectedBodies(ids: string[]): void;
    endDocument(): void;
  };
  browser: { forgetDocumentFolders(): void };
  /** Feature ids of the old document, which the next one may reuse for other things. */
  selectFeature(id: null): void;
}

/** New and Open take the old document off screen while its session ends, in the same call that replaces it, not
 *  when the engine answers for the new one. */
export function wireDocumentSwap(store: Pick<DocumentStore, "sessions">, e: DocumentSwapTarget) {
  const swap = () => {
    e.cancelTools();
    if (e.sketch.active) e.sketch.cancel();
    // Left selected, a face is found again by position in the next document's model.
    e.dropBodyGizmo();
    e.viewport.clearSelection();
    e.viewport.setSelectedBodies([]);
    // A world point, so it would preselect a profile drawn in the same spot.
    e.overlay.clearRegionSelection();
    // Even with no sketch open: a guide or rubber band a session left behind would sit over the next document.
    e.overlay.clearTransient();
    e.forgetLastCommit();
    // Last, the handlers above may still read the old model.
    e.viewport.endDocument();
    e.browser.forgetDocumentFolders();
    e.selectFeature(null);
    // The workspace belongs to the sitting with a document, so the next one starts in Model like the first did.
    setWorkspace("model");
  };
  const own = (s: DocumentSession) => {
    s.own(swap);
  };
  own(store.sessions.current);
  return store.sessions.onBegin(own);
}
