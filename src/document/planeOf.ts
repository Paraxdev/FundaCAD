// Where a plane-carrying feature ACTUALLY sits after the last rebuild.
//
// A sketch or datum plane anchored to a body face has its placement re-derived
// by the sidecar every rebuild, and the resolved frames come back keyed by
// feature id. The feature's own `plane` is only the cache written when it was
// last closed, so reading it directly draws the curves at the OLD position while
// the cut lands at the new one — the two halves of the same model disagreeing on
// screen.
//
// One function, imported by every consumer, because the failure mode of having
// two is that one of them keeps reading `f.plane` and nobody notices which.
// READ-ONLY: nothing here is written back into the document.

import type { PlaneDef, PlaneSpec } from "../types";

export function planeOf(
  f: { id: string; plane: PlaneSpec; planeId?: string },
  sketchPlanes: Record<string, PlaneDef> | undefined,
  datumPlanes: Record<string, PlaneDef> | undefined,
): PlaneSpec {
  // The datum lookup is SECOND, and it is not redundant: a sketch made by
  // "Offset plane" carries no `face` of its own (the anchor rides on the DATUM,
  // see featureStarters.offsetPlane), so the sidecar has no entry under this
  // feature's id, while the datum it is bound to does move. The sidecar resolves
  // that link when it BUILDS the sketch, so without this the geometry would
  // follow and only the drawing stay behind — the same split, one indirection
  // further out. A datum's entry already has its offset applied, which is
  // exactly the plane the sketch sits on.
  return (
    sketchPlanes?.[f.id]
    ?? (f.planeId ? datumPlanes?.[f.planeId] : undefined)
    ?? f.plane
  );
}
