// Model edges lying in the sketch plane, picked as if they were sketch curves.
//
// The offset tool takes a face's own boundary without the user projecting it
// first. This is the 2D half of that: which in-plane edge is under the cursor,
// which edges chain with it into one loop, and which edges are exact enough to
// offer at all.

import * as THREE from "three";
import { distToSeg } from "./geom2d";
import { asFeature, type Feature, type RebuildResult } from "../types";

type Vec3 = readonly [number, number, number];

/** Index of the polyline nearest `p` within `tol`, else -1. */
export function pickPlaneEdge(
  polys: readonly (readonly THREE.Vector2[])[],
  p: THREE.Vector2,
  tol: number,
): number {
  let best = -1;
  let bestD = tol;
  polys.forEach((poly, i) => {
    for (let k = 1; k < poly.length; k++) {
      const d = distToSeg(poly[k - 1]!, poly[k]!, p);
      if (d < bestD) { bestD = d; best = i; }
    }
  });
  return best;
}

const isClosed = (poly: readonly THREE.Vector2[], tol: number) =>
  poly.length > 2 && poly[0]!.distanceTo(poly[poly.length - 1]!) <= tol;

/** The edges that chain end to end with edge `index` into one simple path or
 *  loop, `index` first. A closed edge (a whole circle) is its own chain, and a
 *  vertex where three or more edges meet makes the pick ambiguous, so that
 *  answers with the clicked edge alone, the same rule offsetChain uses. */
export function planeEdgeChain(
  polys: readonly (readonly THREE.Vector2[])[],
  index: number,
  tol: number,
): number[] {
  const start = polys[index];
  if (!start || start.length < 2) return [];
  if (isClosed(start, tol)) return [index];
  const ends = (i: number): THREE.Vector2[] => {
    const q = polys[i]!;
    return [q[0]!, q[q.length - 1]!];
  };
  const open = polys.map((_q, i) => i).filter((i) => polys[i]!.length >= 2 && !isClosed(polys[i]!, tol));
  const touching = (at: THREE.Vector2) => open.filter((j) => ends(j).some((e) => e.distanceTo(at) <= tol));
  const chain: number[] = [];
  const seen = new Set<number>();
  const stack = [index];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    chain.push(i);
    for (const end of ends(i)) {
      const at = touching(end);
      if (at.length > 2) return [index];
      for (const j of at) if (!seen.has(j)) stack.push(j);
    }
  }
  return chain;
}

/** A point on the edge that re-finds exactly it by nearest distance: the middle
 *  segment's midpoint. Not the middle vertex, which on a two-point straight edge
 *  is an endpoint, a corner shared with the neighbouring edges. */
export function edgeProbePoint(points: readonly Vec3[]): [number, number, number] | null {
  if (!points.length) return null;
  const k = Math.max(0, Math.ceil(points.length / 2) - 1);
  const a = points[k]!, b = points[Math.min(points.length - 1, k + 1)]!;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

const MESH_FORMATS = new Set(["stl", "3mf", "obj", "glb"]);

/** Bodies carrying faces read in from a mesh file. */
export function meshBodyIds(
  bodies: RebuildResult["bodies"],
  features: readonly Feature[],
): Set<string> {
  const meshImports = new Set<string>();
  for (const f of features) {
    const imp = asFeature(f, "import");
    if (imp && MESH_FORMATS.has(imp.format)) meshImports.add(imp.id);
  }
  const out = new Set<string>();
  if (!meshImports.size) return out;
  for (const b of bodies ?? []) {
    if (b.faceOwners?.some((o) => o != null && meshImports.has(o))) out.add(b.id);
  }
  return out;
}

/** Whether an in-plane edge is an exact curve worth offering as a sketch curve.
 *
 *  A mesh import arrives as planar facets, so every edge it contributes is a
 *  straight two-point segment, a facet side rather than a designed boundary. A
 *  curved edge on the same body can only have come from real modelling (a cut
 *  through it), so that one stays offered. */
export function isExactPlaneEdge(
  edge: { readonly body: string | undefined; readonly points: readonly Vec3[] },
  meshBodies: ReadonlySet<string>,
): boolean {
  if (!edge.body) return false;
  return !meshBodies.has(edge.body) || edge.points.length > 2;
}
