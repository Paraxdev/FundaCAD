// The instant client-side approximation drawn while a fillet/chamfer radius or
// distance is being dragged, so the handle feels as immediate as Press/Pull's
// ghost (pressPullTool.ts) instead of waiting on an OCCT round trip per pixel.
//
// Geometry, not a picture: at a sample point P along the picked edge, with the
// edge tangent T and the two adjacent faces' outward normals n1, n2 (both
// perpendicular to T), the fillet's inscribed circle has its center at the
// point offset `size` from BOTH face planes on the solid side, i.e. the point x
// (relative to P) solving x·n1 = -size and x·n2 = -size in the plane
// perpendicular to T. That is two linear equations in the two unknowns of that
// plane, solved directly (solve2x2 below), no trig, no iteration. The arc then
// runs between the two points where the circle touches each face, the short way
// round; a chamfer's bevel is the straight line between those same two points,
// offset `size` along each face instead of curving between them.
//
// A degenerate sample (n1 and n2 nearly parallel: a seam, a face that grazes
// the edge almost flat) has no well-posed wedge to fit a circle into, and
// voids the WHOLE edge's ghost rather than draw whatever a near-singular solve
// produces; see the module comment on the caller (viewport/ghosts.ts) for why
// that caller may see this return null per edge but never per sample.

export type Pt3 = readonly [number, number, number];
type Vec3 = [number, number, number];

/** One point along a picked edge with what the ghost needs to bend around it:
 *  the direction along the edge and the outward normal of each adjacent face,
 *  world space. Which face is `normal1` vs `normal2` only has to stay the SAME
 *  physical face across every sample of one edge, not any particular one, see
 *  the ribbon connectivity note on sweepBlendGhost. */
export interface EdgeSample {
  readonly point: Pt3;
  readonly tangent: Pt3;
  readonly normal1: Pt3;
  readonly normal2: Pt3;
}

export type BlendKind = "fillet" | "chamfer";

export interface GhostGeometry {
  /** flat x,y,z triangle soup, ready for a BufferGeometry position attribute */
  readonly positions: number[];
}

/** Segments in one fillet arc cross-section. 8 reads as a smooth quarter-circle
 *  at handle scale without being an unreasonable vertex count per edge sample. */
export const ARC_SEGMENTS = 8;

const EPS = 1e-6;

function sub(a: Pt3, b: Pt3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}
function normalize(a: Vec3): Vec3 | null {
  const l = length(a);
  return l < EPS ? null : scale(a, 1 / l);
}
/** `v` with its component along unit `axis` removed, then renormalized; null
 *  when what's left is too short to mean anything (v was ~parallel to axis). */
function rejectAndNormalize(v: Vec3, axis: Vec3): Vec3 | null {
  return normalize(sub(v, scale(axis, dot(v, axis))));
}

/** `v` rotated 90° in the 2D plane, on whichever of the two perpendicular sides
 *  points away from `other` (dot ≤ 0), the in-face direction a chamfer offsets
 *  along: away from the edge, not back across the other face. */
function perpAwayFrom(v: readonly [number, number], other: readonly [number, number]): [number, number] {
  const r: [number, number] = [-v[1], v[0]];
  return r[0] * other[0] + r[1] * other[1] <= 0 ? r : [-r[0], -r[1]];
}

/** One cross-section across the corner at `sample`: the arc from the tangent
 *  point on face 1 to the tangent point on face 2 (fillet), or just those two
 *  points (chamfer). Null when the two face normals can't bound a real wedge
 *  at this sample (see module comment). */
function crossSection(sample: EdgeSample, size: number, kind: BlendKind): Vec3[] | null {
  const T = normalize(sample.tangent as unknown as Vec3);
  if (!T) return null;
  const n1 = rejectAndNormalize(sample.normal1 as unknown as Vec3, T);
  const n2 = rejectAndNormalize(sample.normal2 as unknown as Vec3, T);
  if (!n1 || !n2) return null;

  // 2D basis of the plane ⟂ T, built FROM n1 so n1 reads as (1, 0) exactly.
  const e1 = n1;
  const e2 = normalize(cross(T, e1));
  if (!e2) return null;
  const n2x = dot(n2, e1);
  const n2y = dot(n2, e2);
  if (Math.abs(n2y) < EPS) return null; // n1 ≈ ±n2: a flat or spike edge, no wedge

  const P = sample.point as unknown as Vec3;
  const at = (x: number, y: number): Vec3 => add(P, add(scale(e1, x), scale(e2, y)));

  if (kind === "chamfer") {
    const u1 = perpAwayFrom([1, 0], [n2x, n2y]);
    const u2 = perpAwayFrom([n2x, n2y], [1, 0]);
    return [at(size * u1[0], size * u1[1]), at(size * u2[0], size * u2[1])];
  }

  // Fillet: circle of radius `size` tangent to both face planes. Solving
  // x·(1,0) = -size and x·(n2x,n2y) = -size (Cramer's rule, det = n2y since
  // n1_2d = (1,0)) gives the center; the arc sweeps from angle 0 (face 1's
  // tangent point) to atan2(n2y, n2x) (face 2's), the short way by construction.
  const cx = -size;
  const cy = (-size * (1 - n2x)) / n2y;
  const theta = Math.atan2(n2y, n2x);
  const pts: Vec3[] = [];
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const a = (theta * i) / ARC_SEGMENTS;
    pts.push(at(cx + size * Math.cos(a), cy + size * Math.sin(a)));
  }
  return pts;
}

/** The ghost mesh for one picked edge: a ribbon lofted between consecutive
 *  samples' cross-sections. `samples` must already agree on which face is
 *  `normal1` across the whole edge (the caller's job, edge topology is what
 *  guarantees only two faces meet it, this module just draws the wedge), or the
 *  ribbon twists. Null when there are fewer than 2 samples, the size is ~0, or
 *  ANY sample is degenerate: one bad sample means the ribbon can't be lofted
 *  past it without a seam, so the whole edge is skipped rather than drawn with
 *  a gap or a twist standing in for "we couldn't tell". */
export function sweepBlendGhost(
  samples: readonly EdgeSample[],
  size: number,
  kind: BlendKind,
): GhostGeometry | null {
  if (size < EPS || samples.length < 2) return null;
  const sections: Vec3[][] = [];
  for (const s of samples) {
    const cs = crossSection(s, size, kind);
    if (!cs) return null;
    sections.push(cs);
  }
  const positions: number[] = [];
  const push3 = (p: Vec3) => positions.push(p[0], p[1], p[2]);
  for (let i = 0; i + 1 < sections.length; i++) {
    const a = sections[i]!;
    const b = sections[i + 1]!;
    for (let j = 0; j + 1 < a.length; j++) {
      const a0 = a[j]!, a1 = a[j + 1]!, b0 = b[j]!, b1 = b[j + 1]!;
      push3(a0); push3(a1); push3(b1);
      push3(a0); push3(b1); push3(b0);
    }
  }
  return positions.length ? { positions } : null;
}
