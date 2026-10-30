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
