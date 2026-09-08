// Which drawn edges belong to a given B-rep face, the geometry behind "select a
// face, then fillet it", where the face is shorthand for every edge around it.
//
// It has to be geometry, because there is no topology to ask. The rebuild reply
// carries faces (as triangles tagged with a face id) and edges (as polylines)
// side by side and says nothing at all about which edges bound which face; the
// sidecar's own edge->face map (tessellate.edge_polylines_by_body) is used to
// drop coplanar seams and never crosses the wire. So an edge belongs to a face
// when it LIES on it: every sample of its polyline sits on the face's surface.
//
// DOM/three-free, so vitest covers it headlessly, same discipline as
// edgeMatch.ts next door, and for the same reason: this is the part that can be
// wrong in a way the user sees (filleting the wrong ring of edges), while the
// buffer walking that feeds it needs a real model to exist at all.

export type Vec3 = [number, number, number];
/** One world-space triangle of a face's tessellation. */
export type Tri = readonly [Vec3, Vec3, Vec3];

/** A face's triangles plus their bounding box, the box is the cheap reject that
 *  keeps the test near-linear: almost every edge of the body is nowhere near the
 *  face, and answering that costs six comparisons instead of a distance to every
 *  triangle. */
export interface FaceSurface {
  tris: readonly Tri[];
  min: Vec3;
  max: Vec3;
}

export function faceSurface(tris: readonly Tri[]): FaceSurface {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    for (const p of t) {
      for (let i = 0; i < 3; i++) {
        if (p[i]! < min[i]!) min[i] = p[i]!;
        if (p[i]! > max[i]!) max[i] = p[i]!;
      }
    }
  }
  return { tris, min, max };
}

/** How far off a face a point may sit and still count as ON it, for a model of
 *  this bounding-box diagonal.
 *
 *  It is set by the TESSELLATION, not by any modelling intent, and the two sides
 *  of the comparison are meshed to different targets: edge polylines are sampled
 *  to a 0.01mm chord deviation (tessellate._EDGE_DEFLECTION) while surfaces get
 *  OCCT's relative deflection, measured at 0.05-0.15mm on real parts (see the
 *  _VIEWPORT_RELATIVE table in sidecar/server.py). A round edge therefore bulges
 *  OUTSIDE the flat chords of its own face by up to that surface deviation, and
 *  a tolerance tighter than it would reject a cylinder's own rim.
 *
 *  The floor is what makes it safe on small parts, where the relative term
 *  collapses; the relative term is what keeps it from swallowing a neighbouring
 *  feature on a 400mm plate. Between the two failure modes this errs toward
 *  including an edge: every member is click-toggleable inside the edge tool, so
 *  one too many is one click from fixed, while one missing means re-picking. */
export function faceEdgeTol(bboxDiag: number): number {
  if (!Number.isFinite(bboxDiag) || bboxDiag <= 0) return 0.25;
  return Math.max(0.25, 0.004 * bboxDiag);
}

/** Squared distance from `p` to the closest point of triangle (a, b, c),
 *  Ericson's barycentric region test, which needs no square roots until the
 *  caller wants one. */
export function pointTriangleDist2(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return dist2(p, a); // vertex region A

  const bpx = p[0] - b[0], bpy = p[1] - b[1], bpz = p[2] - b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return dist2(p, b); // vertex region B

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3); // edge region AB
    return dist2(p, [a[0] + abx * v, a[1] + aby * v, a[2] + abz * v]);
  }

  const cpx = p[0] - c[0], cpy = p[1] - c[1], cpz = p[2] - c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return dist2(p, c); // vertex region C

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6); // edge region AC
    return dist2(p, [a[0] + acx * w, a[1] + acy * w, a[2] + acz * w]);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); // edge region BC
    return dist2(p, [
      b[0] + (c[0] - b[0]) * w,
      b[1] + (c[1] - b[1]) * w,
      b[2] + (c[2] - b[2]) * w,
    ]);
  }

  // interior: project onto the plane through the barycentric coordinates
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return dist2(p, [
    a[0] + abx * v + acx * w,
    a[1] + aby * v + acy * w,
    a[2] + abz * v + acz * w,
  ]);
}

/** Distance from a point to a face's tessellated surface. Infinity for a face
 *  with no triangles (a body that meshed to nothing). */
export function pointFaceDistance(p: Vec3, face: FaceSurface): number {
  let best = Infinity;
  for (const t of face.tris) {
    const d = pointTriangleDist2(p, t[0], t[1], t[2]);
    if (d < best) best = d;
    if (best === 0) break;
  }
  return Math.sqrt(best);
}

/** Is `p` outside the face's box, padded by `tol`? The cheap reject. */
function outsideBox(p: Vec3, face: FaceSurface, tol: number): boolean {
  for (let i = 0; i < 3; i++) {
    if (p[i]! < face.min[i]! - tol || p[i]! > face.max[i]! + tol) return true;
  }
  return false;
}

/** How many points of an edge polyline are actually tested. A deviation-sampled
 *  arc can carry 500 of them and every one costs a pass over the face's
 *  triangles; a dozen spread along its length settles the question just as well,
 *  because an edge either lies on this face for its whole extent or leaves it
 *  immediately. */
const MAX_SAMPLES = 12;

/** The points to test for one polyline: up to MAX_SAMPLES spread over its
 *  samples, always including both ends.
 *
 *  Straight edges are the reason for the segment midpoints. The sidecar sends a
 *  straight edge as its two ENDPOINTS and nothing else
 *  (tessellate._line_endpoints), so testing "the polyline's points" alone would
 *  ask only about the two corners, and an edge that merely touches this face at
 *  both of its ends, without lying on it anywhere in between, would pass. */
export function edgeSamples(points: readonly Vec3[]): Vec3[] {
  if (points.length < 2) return [...points];
  const out: Vec3[] = [];
  if (points.length <= 4) {
    for (let i = 0; i < points.length; i++) {
      out.push(points[i]!);
      const next = points[i + 1];
      if (next) out.push(midpoint(points[i]!, next));
    }
    return out;
  }
  const step = (points.length - 1) / (MAX_SAMPLES - 1);
  for (let i = 0; i < MAX_SAMPLES; i++) {
    out.push(points[Math.round(i * step)]!);
  }
  return out;
}

/** Does this edge lie on this face? Every sample within `tol` of the surface,
 *  "every", because an edge that shares a corner or a stretch with the face is
 *  not an edge OF it. */
export function edgeLiesOnFace(points: readonly Vec3[], face: FaceSurface, tol: number): boolean {
  if (!face.tris.length || points.length < 2) return false;
  for (const p of edgeSamples(points)) {
    if (outsideBox(p, face, tol)) return false;
    if (pointFaceDistance(p, face) > tol) return false;
  }
  return true;
}

/** Every edge of `edges` that lies on `face`, input order preserved. Generic in
 *  the edge type so the viewport can hand it live EdgeRefs and get the same refs
 *  back, identity is what the selection is keyed on. */
export function edgesOnFace<T extends { points: readonly Vec3[] }>(
  edges: readonly T[],
  face: FaceSurface,
  tol: number,
): T[] {
  return edges.filter((e) => edgeLiesOnFace(e.points, face, tol));
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function dist2(p: Vec3, q: Vec3): number {
  const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
  return dx * dx + dy * dy + dz * dz;
}
