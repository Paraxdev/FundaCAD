// Headless re-solve of a CLOSED sketch after a param edit changed a dim value (the open sketch syncs live).
// A failed or conflicting solve keeps the OLD coordinates and reports the sketch id; the edit still lands (plan R2).

import type { Feature, Params, SketchEntity } from "../types";
import { solveKeepingAxes } from "./sketchSolve";
import { resolveRealEntities, toSketchEntity } from "./resolve";

export async function solveSketchFeature(
  sketch: Extract<Feature, { type: "sketch" }>,
  params: Params,
  anchor?: { x: number; y: number },
): Promise<{ entities: SketchEntity[] } | null> {
  try {
    const entities = resolveRealEntities(sketch, params);
    const r = await solveKeepingAxes(entities, sketch.constraints ?? [], anchor);
    if (!r.ok || r.conflicts.length > 0) return null;
    return { entities: r.entities.map(toSketchEntity) };
  } catch {
    return null; // solver unavailable/crashed, keep old coordinates
  }
}
