import { SketchPlane } from "../sketch/plane";
import type { Engine } from "./engine";
import type { Feature } from "../types";

export function createDatumPlanes(e: Engine): Pick<Engine, "datumPlaneDef" | "syncDatumPlanes"> {
  /** Where a datum's SOURCE plane is right now, before its own offset.
   *
   *  The feature's `plane` is the placement recorded when the datum was made. For
   *  a datum that follows a face that is a cache, and it goes stale the moment
   *  anything upstream of the face moves: the sketches on the datum are placed by
   *  the sidecar, which re-resolves the face, while the quad drawn here would
   *  still be at the pick-time position. Two planes, one name.
   *
   *  So the last rebuild's answer wins when there is one. It arrives with the
   *  offset already applied, and that is backed out rather than used directly so
   *  the offset stays a LOCAL edit: dragging a plane's offset moves the quad on
   *  the same frame instead of waiting for a rebuild, which is the property this
   *  whole function was written for. Backing it out is exact, since an offset
   *  runs along the plane's own normal and does not turn it. */
  const sourcePlane = (f: Extract<Feature, { type: "datumPlane" }>) => {
    const placed = e.store.buildState.result?.datumPlanes?.[f.id];
    if (!placed) return new SketchPlane(f.plane);
    const off = f.offset ?? 0;
    const [ox, oy, oz] = placed.origin;
    const [nx, ny, nz] = placed.normal;
    return new SketchPlane({
      origin: [ox - nx * off, oy - ny * off, oz - nz * off],
      normal: placed.normal,
      xdir: placed.xdir,
    });
  };

  /** A datum plane's world placement (source spec + offset along its normal) as a
   *  PlaneDef — lets "Sketch on plane" / "Offset plane" work straight off the quad. */
  const datumPlaneDef = (f: Extract<Feature, { type: "datumPlane" }>) => {
    const sp = sourcePlane(f);
    const off = f.offset ?? 0;
    return {
      origin: [sp.origin.x + sp.n.x * off, sp.origin.y + sp.n.y * off, sp.origin.z + sp.n.z * off],
      normal: [sp.n.x, sp.n.y, sp.n.z],
      xdir: [sp.u.x, sp.u.y, sp.u.z],
    } as ReturnType<Engine["datumPlaneDef"]>;
  };

  // reflect the document's datum/construction planes as selectable quads in 3D.
  // Resolved client-side (source plane + offset along its normal) so no rebuild is
  // needed just to move/show a plane.
  const syncDatumPlanes = () => {
    const planes = e.store.document.features
      .filter((f): f is Extract<Feature, { type: "datumPlane" }> => f.type === "datumPlane")
      .filter((f) => e.store.isPlaneVisible(f.id)) // hidden planes: not drawn, not pickable
      .map((f) => {
        const def = datumPlaneDef(f); // one formula for quad, sketch and offset targets
        // xdir goes too, so a click on the quad yields the SAME plane a sketch
        // started from the browser row gets. Without it the viewport had the
        // plane's position and facing but not its in-plane orientation, which is
        // most of what a sketch is placed by.
        return { id: f.id, origin: def.origin, normal: def.normal, xdir: def.xdir };
      });
    e.viewport.setDatumPlanes(planes);
    e.viewport.highlightDatum(e.selectedFeature);
  };

  return { datumPlaneDef, syncDatumPlanes };
}
