// "Which plane did I just click?" — one answer, shared by everything that turns
// a face into a plane: cross-section mode aiming its cut, and the datum-plane
// tool creating one you can sketch on.
//
// It is the thin impure shell around planeMath: the raycast, the face's
// triangles, and the rebuild-stable selector that lets the pick be STORED. The
// arithmetic itself (which plane a flat face implies, where a round one's
// tangent plane lands) lives next door where vitest can reach it.
//
// The selector matters as much as the plane. A datum plane that merely froze the
// numbers would stop following the face it was made from the moment anything
// upstream moved — which is the whole difference between a construction plane
// and a note about where a face used to be.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { Plane3, PlaneDef, PlaneSpec, Selector, Vec3 } from "../types";
import { planeFromPickedFace, type FacePlaneKind } from "./planeMath";

export interface FacePlanePick {
  /** the plane itself, ready to sketch on or cut by */
  def: PlaneDef;
  /** flat face → its own plane; round face → the tangent plane at `at` */
  kind: FacePlaneKind;
  /** how the document re-finds this face on a later rebuild */
  selector: Selector;
  faceId: number;
  /** the surface point the user clicked — persisted for a tangent plane, since
   *  a round face has a different one at every point and the pick location is
   *  therefore part of the definition rather than incidental to it */
  at: Vec3;
}

/** The plane of the face under the cursor, or null when the cursor is not over
 *  one (or over a face whose surface is neither flat nor cylindrical — a
 *  fillet's blend, a spline, a cone; better no plane than a plausible-looking
 *  wrong one). */
export function pickFacePlaneAt(
  viewport: Viewport,
  clientX: number,
  clientY: number,
): FacePlanePick | null {
  const hit = viewport.pickFaceForPressPull(clientX, clientY);
  return hit ? facePlaneFromHit(viewport, hit) : null;
}

/** The raycast half of the pick, already done. Split out so a caller that has to
 *  know whether a face was hit AT ALL (as opposed to which plane it implies)
 *  pays for one raycast rather than two — this runs on every pointermove of a
 *  plane pick. */
type FaceHit = NonNullable<ReturnType<Viewport["pickFaceForPressPull"]>>;

function facePlaneFromHit(viewport: Viewport, hit: FaceHit): FacePlanePick | null {
  const tris = viewport.faceTriangles(hit.faceId);
  if (!tris.length) return null;
  const points: Vec3[] = [];
  const normals: Vec3[] = [];
  const n = new THREE.Vector3();
  for (const t of tris) {
    // Vertices, not centroids: a tessellated cylinder's vertices sit exactly on
    // the true surface, which is what lets the radius fit come back exact (see
    // cylinderFromFace).
    points.push([t.a.x, t.a.y, t.a.z], [t.b.x, t.b.y, t.b.z], [t.c.x, t.c.y, t.c.z]);
    t.getNormal(n);
    normals.push([n.x, n.y, n.z]);
  }
  const at: Vec3 = [hit.anchor.x, hit.anchor.y, hit.anchor.z];
  const found = planeFromPickedFace(points, normals, at, [
    hit.normal.x,
    hit.normal.y,
    hit.normal.z,
  ]);
  if (!found) return null;
  return {
    def: found.def,
    kind: found.kind,
    // by:"nearest" on the clicked point, stamped with the body it came from —
    // the same form press/pull stores, and the `body` stamp is what stops it
    // resolving against whichever body happened to be built last.
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

/** What the cursor is over during a "pick a plane" step — the one arbitration
 *  shared by Sketch, Datum Plane, Offset Plane and Split, so hovering and
 *  clicking can never disagree about what the click would take.
 *
 *  `unusable` is the case worth having a name for. A body face is under the
 *  cursor but it implies no plane — a fillet's blend, a sphere, a spline, a cone
 *  — and the construction quads are switched on and sitting BEHIND the model
 *  during this step. Collapsing that to "nothing here" would let the ray sail
 *  through the part and pick the XY quad two hundred millimetres behind the face
 *  the user was aiming at, which is a wrong answer delivered silently. The
 *  caller refuses the click instead. */
export type PlanePickTarget =
  | { kind: "face"; spec: PlaneDef; face: FacePlanePick }
  | { kind: "base"; spec: Plane3 }
  | { kind: "datum"; spec: PlaneDef; id: string }
  | { kind: "unusable" }
  | null;

/** Resolve the plane under the cursor. A body face wins over the construction
 *  quads behind it — the quads are scenery for this step, the part is the thing
 *  the user is looking at.
 *
 *  A DATUM PLANE IS ONE OF THOSE QUADS. It used not to be, and the omission was
 *  the whole of a bug: a plane through three points appeared in the browser,
 *  drew its quad, highlighted on hover in ordinary selection and could be
 *  right-clicked, and could not be clicked to sketch on, because this function
 *  asked only for the three BASE planes and the ray went straight through the
 *  datum to whichever of those was behind it. Every construction the app can
 *  make — three points, midplane, offset from a face — was unreachable the one
 *  way people reach for a plane, and the browser row was the only way in. */
export function pickPlaneTarget(viewport: Viewport, clientX: number, clientY: number): PlanePickTarget {
  const hit = viewport.pickFaceForPressPull(clientX, clientY);
  if (hit) {
    const face = facePlaneFromHit(viewport, hit);
    return face ? { kind: "face", spec: face.def, face } : { kind: "unusable" };
  }
  const c = viewport.pickConstructionAt(clientX, clientY);
  if (!c) return null;
  return c.kind === "datum"
    ? { kind: "datum", spec: c.def, id: c.id }
    : { kind: "base", spec: c.plane };
}

/** The plane spec a target yields, or null when there is nothing to take. Sugar
 *  for the callers that only want the answer and treat "unusable" the same as
 *  "refuse the click". */
export function planeSpecOf(target: PlanePickTarget): PlaneSpec | null {
  if (!target) return null;
  return target.kind === "unusable" ? null : target.spec;
}
