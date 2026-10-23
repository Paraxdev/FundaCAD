// Where a plane feature sits after the last rebuild, read only. Face-anchored planes are re-derived by the engine and
// `plane` is only the cache from the last close, so every consumer must read through here or curves and cuts disagree.

import type { PlaneDef, PlaneSpec } from "../types";

export function planeOf(
  f: { id: string; plane: PlaneSpec; planeId?: string },
  sketchPlanes: Record<string, PlaneDef> | undefined,
  datumPlanes: Record<string, PlaneDef> | undefined,
): PlaneSpec {
  // The datum lookup is not redundant: an "Offset plane" sketch carries no `face`, its anchor rides on the datum
  // (featureStarters.offsetPlane), whose entry already has the offset applied.
  return sketchPlanes?.[f.id] ?? (f.planeId ? datumPlanes?.[f.planeId] : undefined) ?? f.plane;
}
