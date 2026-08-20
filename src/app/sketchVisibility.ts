import type { Engine } from "./engine";

/** Sketch visibility, MCAD-style: a sketch consumed by a feature hides by
 *  default so the solid's edges stay clear; toggle from the browser tree. The
 *  explicit overrides live in the store so they persist with the document. */
export function createSketchVisibility(
  e: Engine,
): Pick<Engine, "isSketchConsumed" | "isSketchVisible"> {
  const isSketchConsumed = (id: string): boolean =>
    e.store.document.features.some(
      (f) =>
        (f.type === "extrude" && f.sketch === id) ||
        (f.type === "revolve" && f.sketch === id) ||
        (f.type === "sweep" && (f.profile === id || f.path === id)) ||
        (f.type === "loft" &&
          (!!f.sketches?.includes(id) || !!f.profiles?.some((p) => p.sketch === id))),
    );

  const isSketchVisible = (id: string): boolean => {
    if (e.tools.extrude.forcedSketchId === id) return true; // being edited — regions must exist
    return e.store.sketchVisibilityOverride(id) ?? !isSketchConsumed(id);
  };

  return { isSketchConsumed, isSketchVisible };
}
