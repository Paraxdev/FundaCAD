// The model's outline on a sketch plane, the shape a profile drawn there is
// actually sitting on. A sketch made on a face routinely runs off it, and the two
// halves are separate regions (region.ts says why), but only if the region
// detector is told where the face ends.
//
// Reads EDGES rather than faces: the viewport already holds every B-rep edge as an
// exact polyline, so "what bounds the face under this sketch" becomes "which of
// those lie IN the sketch plane". No triangle walking, no face id to keep in step
// across a rebuild, nothing extra in the document. A sketch plane is coplanar with
// its face by construction, so the edges passing that test ARE its boundary.
//
// Other geometry flush with the same plane is picked up too, and that is correct:
// the profile can sit on it, and its edge is also where support stops.

import * as THREE from "three";
import { chainLoops, pointInLoop } from "./region";
import type { SketchPlane } from "./plane";

/** The shape of an edge as the viewport stores it (viewport/edgeLines.EdgeRef).
 *  Structural so nothing here depends on the renderer. */
export interface FootprintEdge {
  readonly points: readonly (readonly [number, number, number])[];
}

/** How far off the plane a point may sit and still count as ON it, relative to
 *  the model's own size.
 *
 *  Relative because an absolute figure means different things on a 6mm part and
 *  a 400mm one, and because tessellated points carry error proportional to the
 *  geometry that produced them. Generous enough to survive that, tight enough
 *  that the face 2mm below never qualifies. */
export const PLANE_TOL_FRACTION = 1e-4;

export function planeTolerance(modelScale: number): number {
  const s = Number.isFinite(modelScale) && modelScale > 0 ? modelScale : 0;
  return Math.max(1e-5, s * PLANE_TOL_FRACTION);
}

/** True when every sample of the polyline lies in the plane.
 *
 *  EVERY sample, not the midpoint or the ends: an edge that merely crosses the
 *  plane has both ends off it but passes any single-point test at the crossing,
 *  and admitting one would cut the profile along a line that is not a boundary
 *  of anything. */
export function edgeLiesInPlane(
  e: FootprintEdge,
  plane: SketchPlane,
  tol: number,
): boolean {
  if (e.points.length < 2) return false;
  const p = new THREE.Vector3();
  for (const q of e.points) {
    p.set(q[0], q[1], q[2]);
    if (Math.abs(plane.plane.distanceToPoint(p)) > tol) return false;
  }
  return true;
}

/** The model's edges that lie in this sketch plane, each one still its own 2D
 *  polyline, before they are chained into loops.
 *
 *  Chaining is what the region detector needs and it is also what destroys the
 *  one thing an anchor wants: where one B-rep edge ends and the next begins. A
 *  loop is a bag of points, so "the corners of this face" becomes a guess about
 *  turn angles that a finely tessellated arc can fool; kept as edges, a corner
 *  is simply an endpoint and the middle of a side is simply a midpoint. Both
 *  callers walk the model once, from here. */
export function planeEdgePolys(
  edges: readonly FootprintEdge[],
  plane: SketchPlane,
  modelScale: number,
): THREE.Vector2[][] {
  return planeEdges(edges, plane, modelScale).map((x) => x.poly);
}

/** A model edge lying in the sketch plane, with its 2D polyline. */
export interface PlaneEdge<E extends FootprintEdge = FootprintEdge> {
  readonly edge: E;
  readonly poly: THREE.Vector2[];
}

/** planeEdgePolys keeping each polyline's source edge, for a caller that has to
 *  name the edge back to the kernel (the offset tool projecting a face edge). */
export function planeEdges<E extends FootprintEdge>(
  edges: readonly E[],
  plane: SketchPlane,
  modelScale: number,
): PlaneEdge<E>[] {
  const tol = planeTolerance(modelScale);
  const out: PlaneEdge<E>[] = [];
  const p = new THREE.Vector3();
  for (const e of edges) {
    if (!edgeLiesInPlane(e, plane, tol)) continue;
    const poly: THREE.Vector2[] = [];
    for (const q of e.points) {
      p.set(q[0], q[1], q[2]);
      poly.push(plane.to2D(p, new THREE.Vector2()));
    }
    if (poly.length >= 2) out.push({ edge: e, poly });
  }
  return out;
}

/** The model's outline on this sketch plane, as closed loops in sketch 2D mm,
 *  ready to hand to detectRegions as its footprint.
 *
 *  Empty when the plane has no model in it, which is the ordinary case for a
 *  sketch on a datum plane. Callers must pass an empty result through as
 *  "no footprint" rather than as "an empty face", or every profile on a datum
 *  plane would read as unsupported. */
export function planeFootprint(
  edges: readonly FootprintEdge[],
  plane: SketchPlane,
  modelScale: number,
): THREE.Vector2[][] {
  return loopsFromEdgePolys(planeEdgePolys(edges, plane, modelScale));
}

/** The chaining half on its own, for a caller that already has the edges and
 *  wants both answers out of one walk of the model. */
export function loopsFromEdgePolys(flat: readonly THREE.Vector2[][]): THREE.Vector2[][] {
  if (!flat.length) return [];
  return chainLoops(flat as THREE.Vector2[][]);
}

/** Where the region split gets the model's cut lines from: the engine, which
 *  cuts every consuming feature's profile along the same lines, so an area
 *  highlighted here is the area that builds. */
export interface CutSource {
  /** World polylines, null when the engine could not be asked. */
  cuts(plane: SketchPlane): Promise<readonly (readonly [number, number, number])[][] | null>;
  /** Any value whose IDENTITY changes exactly when the model does, the build
   *  result object itself is the natural one. */
  epoch(): unknown;
  /** An answer for the current model arrived, so whatever split against the
   *  previous one should split again. */
  landed(): void;
}

/** The engine's cut lines on a plane chained into loops, per plane per model.
 *
 *  Keyed on the SketchPlane OBJECT, which the overlay hands out once per plane
 *  spec, so sketches sharing a plane share one request. Until the answer for
 *  the current model lands, the previous model's is served, so a rebuild does
 *  not flash every split profile whole. */
export function profileCutCache(src: CutSource): (plane: SketchPlane) => THREE.Vector2[][] {
  interface Entry { epoch: unknown; loops: THREE.Vector2[][]; asked: unknown }
  const NONE = Symbol("never asked");
  const byPlane = new WeakMap<SketchPlane, Entry>();
  return (plane) => {
    const now = src.epoch();
    let e = byPlane.get(plane);
    if (!e) {
      e = { epoch: NONE, loops: [], asked: NONE };
      byPlane.set(plane, e);
    }
    if (e.epoch !== now && e.asked !== now) {
      e.asked = now;
      const entry = e;
      void src.cuts(plane).then((lines) => {
        if (src.epoch() !== now) return;
        const v = new THREE.Vector3();
        const polys = (lines ?? []).map((l) => l.map((p) => plane.to2D(v.set(p[0], p[1], p[2]), new THREE.Vector2())));
        entry.epoch = now;
        entry.loops = loopsFromEdgePolys(polys);
        src.landed();
      }).catch(() => undefined);
    }
    return e.loops;
  };
}

/** Where the camera should aim when a sketch opens on a face: the centre of the
 *  smallest footprint loop around the clicked point, so a face far from the
 *  world origin is not left off screen. Null when no loop holds the point. */
export function faceFocus(loops: readonly THREE.Vector2[][], at: THREE.Vector2): THREE.Vector2 | null {
  let best: THREE.Box2 | null = null;
  let bestArea = Infinity;
  for (const loop of loops) {
    if (loop.length < 3 || !pointInLoop(at, loop as THREE.Vector2[])) continue;
    const box = new THREE.Box2().setFromPoints(loop as THREE.Vector2[]);
    const size = box.getSize(new THREE.Vector2());
    const area = size.x * size.y;
    if (area < bestArea) { bestArea = area; best = box; }
  }
  return best ? best.getCenter(new THREE.Vector2()) : null;
}
