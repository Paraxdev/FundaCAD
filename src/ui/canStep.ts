import type { DocumentStore } from "../document/store";
import type { SketchMode } from "../sketch/sketchMode";
import { usePanelsStore } from "../stores/panels";

/** An open sketch, then an open Stress panel, keep their own undo in front of the model's. */
export function canStep(e: { sketch: SketchMode; store: DocumentStore }, way: "undo" | "redo"): boolean {
  if (e.sketch.active) return way === "undo" ? e.sketch.canUndoSketch : e.sketch.canRedoSketch;
  const stress = usePanelsStore().stress;
  if (stress) return way === "undo" ? stress.canUndo : stress.canRedo;
  return way === "undo" ? e.store.canUndo : e.store.canRedo;
}

/** The step Undo or Redo would take, in the order `canStep` asks; null when there is none. A sketch has no names for its
 *  steps, so it says what kind of step it is. */
export function stepLabelFor(e: { sketch: SketchMode; store: DocumentStore }, way: "undo" | "redo"): string | null {
  if (e.sketch.active) return canStep(e, way) ? "sketch edit" : null;
  const stress = usePanelsStore().stress;
  if (stress) return way === "undo" ? stress.undoLabel : stress.redoLabel;
  return way === "undo" ? e.store.undoLabel : e.store.redoLabel;
}
