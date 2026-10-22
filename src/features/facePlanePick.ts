// Which plane a clicked face implies, for cross-section and datum planes: the raycast and rebuild stable selector
// around planeMath. The selector is what lets a datum follow its face when anything upstream moves.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { Plane3, PlaneDef, PlaneSpec, Selector, Vec3 } from "../types";
import { planeFromPickedFace, type FacePlaneKind } from "./planeMath";

export interface FacePlanePick {
  def: PlaneDef;
  /** flat face → its own plane; round face → the tangent plane at `at` */
  kind: FacePlaneKind;
  /** how the document re-finds this face on a later rebuild */
  selector: Selector;
  faceId: number;
  /** part of a tangent plane's definition, since a round face has a different one at every point */
  at: Vec3;
}

/** Null off a face, or over one neither flat nor cylindrical (a fillet's blend, a spline, a cone): better no plane
 *  than a plausible wrong one. */
export function pickFacePlaneAt(viewport: Viewport, clientX: number, clientY: number): FacePlanePick | null {
  const hit = viewport.pickFaceForPressPull(clientX, clientY);
  return hit ? facePlaneFromHit(viewport, hit) : null;
}

/** Split out so a caller that only needs to know whether a face was hit pays one raycast per pointermove. */
type FaceHit = NonNullable<ReturnType<Viewport["pickFaceForPressPull"]>>;

function facePlaneFromHit(viewport: Viewport, hit: FaceHit): FacePlanePick | null {
  const tris = viewport.faceTriangles(hit.faceId);
  if (!tris.length) return null;
  const points: Vec3[] = [];
  const normals: Vec3[] = [];
  const n = new THREE.Vector3();
  for (const t of tris) {
    // Vertices, not centroids: a tessellated cylinder's vertices sit on the true surface, so the radius fit is exact.
    points.push([t.a.x, t.a.y, t.a.z], [t.b.x, t.b.y, t.b.z], [t.c.x, t.c.y, t.c.z]);
    t.getNormal(n);
    normals.push([n.x, n.y, n.z]);
  }
  const at: Vec3 = [hit.anchor.x, hit.anchor.y, hit.anchor.z];
  const found = planeFromPickedFace(points, normals, at, [hit.normal.x, hit.normal.y, hit.normal.z]);
  if (!found) return null;
  return {
    def: found.def,
    kind: found.kind,
    // by:"nearest" on the clicked point like press/pull; the `body` stamp stops it resolving against whichever body
    // was built last.
    selector: {
      kind: "face",
      by: "nearest",
      point: at,
      ...(hit.bodyId ? { body: hit.bodyId } : {}),
    },
    faceId: hit.faceId,
    at,
  };
}

/** One arbitration for Sketch, Datum Plane, Offset Plane and Split, so hover and click agree. `unusable` is a face
 *  that implies no plane: treating it as nothing would let the ray pick a construction quad far behind it, so the
 *  caller refuses the click. */
export type PlanePickTarget =
  | { kind: "face"; spec: PlaneDef; face: FacePlanePick }
  | { kind: "base"; spec: Plane3 }
  | { kind: "datum"; spec: PlaneDef; id: string }
  | { kind: "unusable" }
  | null;

/** While a tool asks for a plane the construction quads draw over the model and win, otherwise a body face wins.
 *  Datum planes count as quads, or a constructed plane could not be clicked to sketch on. */
export function pickPlaneTarget(viewport: Viewport, clientX: number, clientY: number): PlanePickTarget {
  if (viewport.constructionOnTop) {
    const c = viewport.pickConstructionAt(clientX, clientY);
    if (c) return c.kind === "datum" ? { kind: "datum", spec: c.def, id: c.id } : { kind: "base", spec: c.plane };
  }
  const hit = viewport.pickFaceForPressPull(clientX, clientY);
  if (hit) {
    const face = facePlaneFromHit(viewport, hit);
    return face ? { kind: "face", spec: face.def, face } : { kind: "unusable" };
  }
  const c = viewport.pickConstructionAt(clientX, clientY);
  if (!c) return null;
  return c.kind === "datum" ? { kind: "datum", spec: c.def, id: c.id } : { kind: "base", spec: c.plane };
}

/** Null when there is nothing to take, "unusable" included. */
export function planeSpecOf(target: PlanePickTarget): PlaneSpec | null {
  if (!target) return null;
  return target.kind === "unusable" ? null : target.spec;
}
