import type { Engine } from "./engine";
import { asFeature, type Feature, type PlaneDef, type PlaneSpec } from "../types";
import { placeDatum, poseOf, sourceOfPlaced, type DatumPose } from "../document/datumPose";

type Datum = Extract<Feature, { type: "datumPlane" }>;

export function createDatumPlanes(
  e: Engine,
): Pick<Engine, "datumPlaneDef" | "datumSourceOf" | "previewDatumPose" | "syncDatumPlanes"> {
  /** Poses a gizmo is dragging, drawn before they are written so the quad and
   *  every datum placed on it move under the hand. */
  const live = new Map<string, DatumPose>();
  const poseFor = (f: Datum): DatumPose => live.get(f.id) ?? poseOf(f);

  /** The parent datum the engine will place `f` on: above it in the timeline and
   *  built, else the engine falls back to the cached `plane` and so does this. */
  const parentOf = (f: Datum): Datum | null => {
    if (!f.planeId || f.planeId === f.id) return null;
    const features = e.store.document.features;
    const at = features.findIndex((x) => x.id === f.id);
    const pi = features.findIndex((x) => x.id === f.planeId);
    if (pi < 0 || (at >= 0 && pi >= at) || pi >= e.store.rollbackIndex || e.store.isSuppressed(f.planeId)) return null;
    return asFeature(features[pi], "datumPlane") ?? null;
  };

  /** Where a datum's REFERENCE is right now, before its own pose.
   *
   *  A parent datum is resolved here, recursively, so moving the parent moves
   *  the child's quad on the same frame. A face is only known to the engine: the
   *  last rebuild's placement has the pose backed out, which keeps the pose a
   *  LOCAL edit, a drag moves the quad without waiting for a rebuild. A plain
   *  reference is the feature's own `plane`. */
  const datumSourceOf = (f: Datum, seen: Set<string> = new Set()): PlaneSpec => {
    seen.add(f.id);
    const parent = parentOf(f);
    if (parent && !seen.has(parent.id)) return datumPlaneDefIn(parent, seen);
    const placed = f.face ? e.store.buildState.result?.datumPlanes?.[f.id] : undefined;
    return placed ? sourceOfPlaced(placed, poseFor(f)) : f.plane;
  };

  const datumPlaneDefIn = (f: Datum, seen: Set<string>): PlaneDef => placeDatum(datumSourceOf(f, seen), poseFor(f));

  /** A datum plane's world placement as a PlaneDef, lets "Sketch on plane" /
   *  "Offset plane" work straight off the quad. */
  const datumPlaneDef = (f: Datum): PlaneDef => datumPlaneDefIn(f, new Set());

  // reflect the document's datum/construction planes as selectable quads in 3D.
  // Resolved client-side (source plane + offset along its normal) so no rebuild is
  // needed just to move/show a plane.
  let lastSynced = "";
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
    // Datum points and axes ride the same visibility gate and the same rebuild
    // pass. An anchored datum (an axis following an edge) resolves in the engine
    // and arrives in the rebuild's `datumMarks`, so that placement IS PREFERRED when
    // present, exactly as a face-following sketch reads its resolved plane; a
    // baked datum has no entry and falls back to the coordinate in the document.
    const marks = e.store.buildState.result?.datumMarks;
    const points = e.store.document.features
      .filter((f): f is Extract<Feature, { type: "datumPoint" }> => f.type === "datumPoint")
      .filter((f) => e.store.isPlaneVisible(f.id))
      .map((f) => {
        const m = marks?.[f.id];
        return { id: f.id, point: m && m.kind === "point" ? m.position : f.point };
      });
    const axes = e.store.document.features
      .filter((f): f is Extract<Feature, { type: "datumAxis" }> => f.type === "datumAxis")
      .filter((f) => e.store.isPlaneVisible(f.id))
      .map((f) => {
        const m = marks?.[f.id];
        return m && m.kind === "axis"
          ? { id: f.id, origin: m.origin, dir: m.dir }
          : { id: f.id, origin: f.origin, dir: f.dir };
      });
    // Every build emit lands here, the once a second progress ticks of a long
    // rebuild included, and each repaint costs full frames. Those change nothing
    // drawn here, so they must not repaint.
    const key = JSON.stringify([planes, points, axes, e.viewport.modelDiagonal(), e.selectedFeature]);
    if (key === lastSynced) return;
    lastSynced = key;
    e.viewport.setDatumPlanes(planes);
    e.viewport.setDatumMarkers(points, axes);
    e.viewport.highlightDatum(e.selectedFeature);
  };

  const previewDatumPose = (id: string, pose: DatumPose | null) => {
    if (pose) live.set(id, pose);
    else live.delete(id);
    syncDatumPlanes();
    e.viewport.requestRender();
  };

  return { datumPlaneDef, datumSourceOf: (f) => datumSourceOf(f), previewDatumPose, syncDatumPlanes };
}
