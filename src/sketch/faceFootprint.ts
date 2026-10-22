// The model's outline on a sketch plane, so region detection knows where the face under a sketch ends.
// Read from the B-rep edges lying IN the plane: no triangle walking and no face id to keep across rebuilds.

import * as THREE from "three";
import { chainLoops, pointInLoop, type Box } from "./region";
import type { SketchPlane } from "./plane";

/** An edge as viewport/edgeLines.EdgeRef stores it, structural so nothing here depends on the renderer. */
export interface FootprintEdge {
  readonly points: readonly (readonly [number, number, number])[];
}

/** Off-plane tolerance relative to the model's size: tessellation error scales with the geometry, and the face
 *  2mm below must never qualify. */
export const PLANE_TOL_FRACTION = 1e-4;

export function planeTolerance(modelScale: number): number {
  const s = Number.isFinite(modelScale) && modelScale > 0 ? modelScale : 0;
  return Math.max(1e-5, s * PLANE_TOL_FRACTION);
}

/** EVERY sample, not the ends or midpoint: an edge crossing the plane passes a single-point test at the crossing. */
export function edgeLiesInPlane(e: FootprintEdge, plane: SketchPlane, tol: number): boolean {
  if (e.points.length < 2) return false;
  const p = new THREE.Vector3();
  for (const q of e.points) {
    p.set(q[0], q[1], q[2]);
    if (Math.abs(plane.plane.distanceToPoint(p)) > tol) return false;
  }
  return true;
}

/** Each in-plane edge as its own 2D polyline, before chaining: kept as edges, a corner is an endpoint rather than
 *  a guess about turn angles that a finely tessellated arc can fool. */
export function planeEdgePolys(
  edges: readonly FootprintEdge[],
  plane: SketchPlane,
  modelScale: number,
): THREE.Vector2[][] {
  return planeEdges(edges, plane, modelScale).map((x) => x.poly);
}

export interface PlaneEdge<E extends FootprintEdge = FootprintEdge> {
  readonly edge: E;
  readonly poly: THREE.Vector2[];
}

/** planeEdgePolys keeping each source edge, for a caller that names it back to the kernel (the offset tool). */
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

/** Closed loops in sketch 2D mm for detectRegions. Empty on a datum plane: callers must treat that as no footprint,
 *  not an empty face, or every profile there would read as unsupported. */
export function planeFootprint(
  edges: readonly FootprintEdge[],
  plane: SketchPlane,
  modelScale: number,
): THREE.Vector2[][] {
  return loopsFromEdgePolys(planeEdgePolys(edges, plane, modelScale));
}

/** The chaining half alone, for a caller that already has the edges from one walk of the model. */
export function loopsFromEdgePolys(flat: readonly THREE.Vector2[][]): THREE.Vector2[][] {
  if (!flat.length) return [];
  return chainLoops(flat as THREE.Vector2[][]);
}

/** Cut lines come from the engine, which cuts every consuming feature's profile along them, so a highlighted
 *  area is the area that builds. */
export interface CutSource {
  /** World polylines, null when the engine holds no build yet or could not be asked. Only lines reaching `reach`
   *  (a sketch 2D box) need come back. */
  cuts(plane: SketchPlane, reach: Box): Promise<readonly (readonly [number, number, number])[][] | null>;
  /** Any value whose IDENTITY changes exactly when the model does, such as the build result. */
  epoch(): unknown;
  /** IDENTITY changes when another document opens, so one document's lines never split another's areas. */
  document(): unknown;
  /** An answer for the current model arrived, so anything split against the previous one should split again. */
  landed(): void;
}

const covers = (outer: Box, inner: Box) =>
  outer.minx <= inner.minx && outer.miny <= inner.miny && outer.maxx >= inner.maxx && outer.maxy >= inner.maxy;

/** The box asked for: what is needed, joined to what was already asked for on
 *  this model, with room to draw on before the next ask. */
function askReach(need: Box, had: Box | null): Box {
  const b = had
    ? {
        minx: Math.min(need.minx, had.minx),
        miny: Math.min(need.miny, had.miny),
        maxx: Math.max(need.maxx, had.maxx),
        maxy: Math.max(need.maxy, had.maxy),
      }
    : need;
  const m = Math.max(b.maxx - b.minx, b.maxy - b.miny) * 0.5 + 1;
  return { minx: b.minx - m, miny: b.miny - m, maxx: b.maxx + m, maxy: b.maxy + m };
}

/** Keyed on document and SketchPlane OBJECT (one per plane spec), so sketches on a plane share a request. The old
 *  answer is served until the new one lands, so a rebuild does not flash every split profile whole. */
export interface CutCache {
  (plane: SketchPlane, need: Box | null): THREE.Vector2[][];
  /** The engine had no answer for a model since replaced, so the split is worth asking for again. */
  stale(): boolean;
}

export function profileCutCache(src: CutSource): CutCache {
  interface Entry {
    epoch: unknown;
    reach: Box | null;
    lines: THREE.Vector2[][];
    askedEpoch: unknown;
    asked: Box | null;
  }
  const NONE = Symbol("never asked");
  let doc: unknown = NONE;
  let byPlane = new WeakMap<SketchPlane, Entry>();
  let unanswered: unknown = NONE;
  const cache = (plane: SketchPlane, need: Box | null) => {
    const d = src.document();
    if (d !== doc) {
      doc = d;
      byPlane = new WeakMap();
    }
    let e = byPlane.get(plane);
    if (!e) {
      e = { epoch: NONE, reach: null, lines: [], askedEpoch: NONE, asked: null };
      byPlane.set(plane, e);
    }
    if (!need) return e.lines;
    const now = src.epoch();
    const answered = e.epoch === now && !!e.reach && covers(e.reach, need);
    const inFlight = e.askedEpoch === now && !!e.asked && covers(e.asked, need);
    if (!answered && !inFlight) {
      const reach = askReach(need, e.askedEpoch === now ? e.asked : null);
      e.askedEpoch = now;
      e.asked = reach;
      unanswered = NONE;
      const entry = e;
      const map = byPlane;
      void src
        .cuts(plane, reach)
        .then((lines) => {
          if (byPlane !== map) return;
          if (!lines) {
            if (src.epoch() !== now) src.landed();
            else unanswered = now;
            return;
          }
          if (src.epoch() !== now) return;
          if (entry.epoch === now && entry.reach && covers(entry.reach, reach)) return;
          const v = new THREE.Vector3();
          entry.epoch = now;
          entry.reach = reach;
          entry.lines = lines.map((l) => l.map((p) => plane.to2D(v.set(p[0], p[1], p[2]), new THREE.Vector2())));
          src.landed();
        })
        .catch(() => undefined);
    }
    return e.lines;
  };
  return Object.assign(cache, { stale: () => unanswered !== NONE && unanswered !== src.epoch() });
}

/** Centre of the smallest footprint loop around the clicked point, so a face far from the origin is on screen. */
export function faceFocus(loops: readonly THREE.Vector2[][], at: THREE.Vector2): THREE.Vector2 | null {
  let best: THREE.Box2 | null = null;
  let bestArea = Infinity;
  for (const loop of loops) {
    if (loop.length < 3 || !pointInLoop(at, loop as THREE.Vector2[])) continue;
    const box = new THREE.Box2().setFromPoints(loop as THREE.Vector2[]);
    const size = box.getSize(new THREE.Vector2());
    const area = size.x * size.y;
    if (area < bestArea) {
      bestArea = area;
      best = box;
    }
  }
  return best ? best.getCenter(new THREE.Vector2()) : null;
}
