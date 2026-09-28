import { openDocument } from "../io/files";
import { choose } from "../ui/choice";
import type { Engine } from "./engine";

/** An open sketch's edits reach the store only when the sketch is finished, so
 *  `store.dirty` alone misses them. */
export function hasUnsavedWork(e: Pick<Engine, "store" | "sketch">): boolean {
  return e.store.dirty || e.sketch.hasUncommittedEdits;
}

/** Whether the user lets unsaved work go, asked only when there is some. */
export async function mayDiscard(e: Pick<Engine, "store" | "sketch">, question: string): Promise<boolean> {
  if (!hasUnsavedWork(e)) return true;
  const pick = await choose(question, [
    { value: "discard", label: "Discard", hint: "lose the unsaved changes" },
    { value: "cancel", label: "Cancel" },
  ]);
  return pick === "discard";
}

export function createDocumentActions(
  e: Engine,
): Pick<Engine, "newDocument" | "openDoc" | "doUndo" | "doRedo"> {
  return {
    async newDocument() {
      if (!(await mayDiscard(e, "Discard unsaved changes and start a new document?"))) return;
      e.store.newDocument();
      e.viewport.resetCamera(false);
    },

    async openDoc() {
      await openDocument(e.store, e.geometry, () => mayDiscard(e, "Discard unsaved changes and open another document?"));
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
