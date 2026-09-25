import { openDocument } from "../io/files";
import type { Engine } from "./engine";

export function createDocumentActions(
  e: Engine,
): Pick<Engine, "newDocument" | "openDoc" | "doUndo" | "doRedo"> {
  return {
    async newDocument() {
      // window.confirm is a no-op in Tauri's WebKitGTK webview, use the native dialog.
      if (e.store.dirty) {
        const { ask } = await import("@tauri-apps/plugin-dialog");
        const ok = await ask("Discard unsaved changes and start a new document?", {
          title: "New Document",
          kind: "warning",
        });
        if (!ok) return;
      }
      e.store.newDocument();
      e.viewport.resetCamera(false);
    },

    async openDoc() {
      await openDocument(e.store, e.geometry);
    },

    // Undo/redo routing: while a sketch is OPEN its geometry lives in SketchMode and
    // is not in the document yet, so store.undo() can only reach the whole sketch,
    // which is why Ctrl+Z used to vaporise it. Hand the request to the sketch, which
    // swallows it whenever it is active (an empty sketch history says so rather than
    // falling through and eating the sketch).
    // The Move gizmo is put away first, and with it a re-open still waiting for
    // a drag's rebuild: left armed, that re-open landed on the undone model and
    // took focus into its field (FI-2).
    doUndo() { e.tools.move.cancel(); if (!e.sketch.undoEdit()) e.store.undo(); },
    doRedo() { e.tools.move.cancel(); if (!e.sketch.redoEdit()) e.store.redo(); },
  };
}
