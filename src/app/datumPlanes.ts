import type { Engine } from "./engine";
import { asFeature, type Feature, type PlaneDef, type PlaneSpec } from "../types";
import { placeDatum, poseOf, sourceOfPlaced, type DatumPose } from "../document/datumPose";

type Datum = Extract<Feature, { type: "datumPlane" }>;

export function createDatumPlanes(
  e: Engine,
): Pick<Engine, "datumPlaneDef" | "datumSourceOf" | "previewDatumPose" | "syncDatumPlanes"> {
  /** Poses a gizmo is dragging, drawn before they are written so dependent datums move under the hand too. */
  const live = new Map<string, DatumPose>();
  const poseFor = (f: Datum): DatumPose => live.get(f.id) ?? poseOf(f);

  /** Must match the engine: a parent above `f` and built, else the cached `plane`. */
  const parentOf = (f: Datum): Datum | null => {
    if (!f.planeId || f.planeId === f.id) return null;
    const features = e.store.document.features;
    const at = features.findIndex((x) => x.id === f.id);
    const pi = features.findIndex((x) => x.id === f.planeId);
    if (pi < 0 || (at >= 0 && pi >= at) || pi >= e.store.rollbackIndex || e.store.isSuppressed(f.planeId)) return null;
    return asFeature(features[pi], "datumPlane") ?? null;
  };

  /** A datum's reference before its own pose. Parents resolve here so a child moves on the same frame; a face or
   *  `through` reference backs the pose out of the last rebuild, so a drag needs no rebuild. */
  const datumSourceOf = (f: Datum, seen: Set<string> = new Set()): PlaneSpec => {
    seen.add(f.id);
    const parent = parentOf(f);
    if (parent && !seen.has(parent.id)) return datumPlaneDefIn(parent, seen);
    const placed = f.face || f.through ? e.store.buildState.result?.datumPlanes?.[f.id] : undefined;
    return placed ? sourceOfPlaced(placed, poseFor(f)) : f.plane;
  };

  const datumPlaneDefIn = (f: Datum, seen: Set<string>): PlaneDef => placeDatum(datumSourceOf(f, seen), poseFor(f));

  const datumPlaneDef = (f: Datum): PlaneDef => datumPlaneDefIn(f, new Set());

  // Resolved client side, so moving or showing a plane needs no rebuild.
  let lastSynced = "";
  const syncDatumPlanes = () => {
    const planes = e.store.document.features
      .filter((f): f is Extract<Feature, { type: "datumPlane" }> => f.type === "datumPlane")
      .filter((f) => e.store.isPlaneVisible(f.id))
      .map((f) => {
        const def = datumPlaneDef(f);
        // xdir too, so a sketch started from the quad gets the same in plane orientation as one from the browser row.
        return { id: f.id, origin: def.origin, normal: def.normal, xdir: def.xdir };
      });
    // An anchored datum's engine placement in `datumMarks` wins; a baked one falls back to the document coordinate.
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
    // Every build emit lands here, including the per second progress ticks of a long rebuild, which must not repaint.
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
