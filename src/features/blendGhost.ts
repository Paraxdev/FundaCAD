// The instant client-side approximation drawn while a fillet/chamfer radius or
// distance is being dragged, so the handle feels as immediate as Press/Pull's
// ghost (pressPullTool.ts) instead of waiting on an OCCT round trip per pixel.
//
// Each cross-section is solved in the plane across the edge, from the wedge the
// two faces make there: the direction from the edge INTO each face, and how
// much each face bends away from that direction. Not from face normals: a
// normal's sign depends on the face's orientation in the B-rep, which the mesh
// does not reliably carry, and a pair of normals cannot tell a convex corner
// from a concave one. The wedge can. Convex (material inside the wedge) or
// concave (air inside it), the rolling ball sits inside the wedge, `size` off
// both faces. A flat face is a line there and a curved one a circle, so the
// ball's centre is where two offset lines or circles cross.
//
// Neither shape is drawn reaching past the end of a face: a round that big has
// nothing left to sit on, so the section stops growing where the shorter face
// runs out.
//
// A sample with no solution (faces nearly tangent or folded shut, or a ball
// too big for a hollow face) voids the WHOLE edge's ghost rather than draw
// whatever a near-singular solve produces.

export type Pt3 = readonly [number, number, number];
type Vec3 = [number, number, number];
type V2 = [number, number];

/** One point along a picked edge: the direction along the edge and, for each
 *  of the two faces meeting there, the unit direction that leaves the edge
 *  across that face, perpendicular to the edge. `bend` is that face's
 *  curvature across the edge in 1/mm, positive when it curls toward the other
 *  face, 0 or absent for a face that runs straight away from the edge. Which
 *  face is 1 and which is 2 only has to stay the same along one edge, or the
 *  ribbon twists. */
export interface EdgeSample {
  readonly point: Pt3;
  readonly tangent: Pt3;
  readonly into1: Pt3;
  readonly into2: Pt3;
  readonly bend1?: number;
  readonly bend2?: number;
  /** how far each face runs from the edge before it ends, mm */
  readonly reach1?: number;
  readonly reach2?: number;
}

export type BlendKind = "fillet" | "chamfer";

export interface GhostGeometry {
  /** flat x,y,z triangle soup, ready for a BufferGeometry position attribute */
  readonly positions: number[];
}

/** Segments in one fillet arc cross-section. */
export const ARC_SEGMENTS = 8;

const EPS = 1e-6;
/** Wedges closer than this to flat or to folded shut are refused. */
const MIN_WEDGE = (2 * Math.PI) / 180;

function sub(a: Pt3, b: Pt3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: Pt3, b: Pt3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Pt3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot(a: Pt3, b: Pt3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normalize(a: Pt3): Vec3 | null {
  const l = Math.sqrt(dot(a, a));
  return l < EPS ? null : scale(a, 1 / l);
}
function rejectAndNormalize(v: Pt3, axis: Pt3): Vec3 | null {
  return normalize(sub(v, scale(axis, dot(v, axis))));
}

const dot2 = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const add2 = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
const sub2 = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const scale2 = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];
const len2 = (a: V2) => Math.hypot(a[0], a[1]);

/** One face in the cross-section plane, the edge at the origin: it leaves
 *  along `dir`, `side` is the unit normal pointing into the wedge, and `bend`
 *  curls it toward `side`. */
interface Face2 {
  dir: V2;
  side: V2;
  bend: number;
}

/** What a face is to the ball's centre: a line `size` off a flat face, a
 *  circle `size` off a curved one. */
type Offset =
  | { line: true; point: V2; dir: V2 }
  | { line: false; center: V2; radius: number; faceRadius: number };

function offsetOf(f: Face2, size: number): Offset | null {
  if (Math.abs(f.bend * size) < 1e-4) return { line: true, point: scale2(f.side, size), dir: f.dir };
  const faceRadius = 1 / Math.abs(f.bend);
  const center = scale2(f.side, 1 / f.bend);
  const radius = f.bend > 0 ? faceRadius - size : faceRadius + size;
  return radius > EPS ? { line: false, center, radius, faceRadius } : null;
}

function lineLine(a: Offset & { line: true }, b: Offset & { line: true }): V2[] {
  const den = a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0];
  if (Math.abs(den) < EPS) return [];
  const d = sub2(b.point, a.point);
  const t = (d[0] * b.dir[1] - d[1] * b.dir[0]) / den;
  return [add2(a.point, scale2(a.dir, t))];
}

function lineCircle(l: Offset & { line: true }, c: Offset & { line: false }): V2[] {
  const f = sub2(l.point, c.center);
  const bq = dot2(f, l.dir);
  const disc = bq * bq - (dot2(f, f) - c.radius * c.radius);
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [-bq - s, -bq + s].map((t) => add2(l.point, scale2(l.dir, t)));
}

function circleCircle(a: Offset & { line: false }, b: Offset & { line: false }): V2[] {
  const d = sub2(b.center, a.center);
  const dist = len2(d);
  if (dist < EPS || dist > a.radius + b.radius || dist < Math.abs(a.radius - b.radius)) return [];
  const along = (dist * dist + a.radius * a.radius - b.radius * b.radius) / (2 * dist);
  const h = Math.sqrt(Math.max(0, a.radius * a.radius - along * along));
  const u = scale2(d, 1 / dist);
  const mid = add2(a.center, scale2(u, along));
  const perp: V2 = [-u[1], u[0]];
  return [add2(mid, scale2(perp, h)), add2(mid, scale2(perp, -h))];
}

function crossings(a: Offset, b: Offset): V2[] {
  if (a.line && b.line) return lineLine(a, b);
  if (a.line && !b.line) return lineCircle(a, b);
  if (!a.line && b.line) return lineCircle(b, a);
  return circleCircle(a as Offset & { line: false }, b as Offset & { line: false });
}

/** Where the ball touches the face whose offset is `o`. */
function contact(o: Offset, face: Face2, center: V2, size: number): V2 {
  if (o.line) return sub2(center, scale2(face.side, size));
  const out = sub2(center, o.center);
  return add2(o.center, scale2(out, o.faceRadius / len2(out)));
}

/** The ball of radius `size` touching both faces, and where it touches each. */
function rollingBall(f1: Face2, f2: Face2, alpha: number, size: number): { center: V2; touch1: V2; touch2: V2 } | null {
  const o1 = offsetOf(f1, size);
  const o2 = offsetOf(f2, size);
  if (!o1 || !o2) return null;
  // Of the crossings, the ball is the one nearest where flat faces would put it.
  const flat: V2 = [size / Math.tan(alpha / 2), size];
  let center: V2 | null = null;
  for (const c of crossings(o1, o2)) {
    if (!center || len2(sub2(c, flat)) < len2(sub2(center, flat))) center = c;
  }
  if (!center) return null;
  return { center, touch1: contact(o1, f1, center, size), touch2: contact(o2, f2, center, size) };
}

/** The point `s` along a face from the edge, following its bend. */
function alongFace(f: Face2, s: number): V2 {
  if (Math.abs(f.bend * s) < 1e-6) return scale2(f.dir, s);
  const a = f.bend * s;
  return add2(scale2(f.dir, Math.sin(a) / f.bend), scale2(f.side, (1 - Math.cos(a)) / f.bend));
}

/** One cross-section across the corner at `sample`, from face 1's contact
 *  point to face 2's: an arc for a fillet, the two points for a chamfer. */
function crossSection(sample: EdgeSample, wanted: number, kind: BlendKind): Vec3[] | null {
  const T = normalize(sample.tangent);
  if (!T) return null;
  const d1 = rejectAndNormalize(sample.into1, T);
  const d2 = rejectAndNormalize(sample.into2, T);
  if (!d1 || !d2) return null;
  const cosA = Math.max(-1, Math.min(1, dot(d1, d2)));
  const alpha = Math.acos(cosA);
  if (alpha < MIN_WEDGE || alpha > Math.PI - MIN_WEDGE) return null;
  const e2 = rejectAndNormalize(d2, d1);
  if (!e2) return null;
  const sinA = Math.sin(alpha);
  const P = sample.point;
  const room = Math.min(sample.reach1 ?? Infinity, sample.reach2 ?? Infinity);
  const size = Math.min(wanted, kind === "chamfer" ? room : room * Math.tan(alpha / 2));
  if (size < EPS) return null;
  const to3 = (p: V2): Vec3 => add(P, add(scale(d1, p[0]), scale(e2, p[1])));

  const f1: Face2 = { dir: [1, 0], side: [0, 1], bend: sample.bend1 ?? 0 };
  const f2: Face2 = { dir: [cosA, sinA], side: [sinA, -cosA], bend: sample.bend2 ?? 0 };

  if (kind === "chamfer") return [to3(alongFace(f1, size)), to3(alongFace(f2, size))];

  // A curved face the ball cannot sit on (it outgrows the face's own round)
  // still gets the flat-face ghost: the kernel may well build it, on
  // neighbouring faces this sample knows nothing about.
  const ball = rollingBall(f1, f2, alpha, size)
    ?? rollingBall({ ...f1, bend: 0 }, { ...f2, bend: 0 }, alpha, size);
  if (!ball) return null;
  const { center } = ball;
  const u = scale2(sub2(ball.touch1, center), 1 / size);
  const v = scale2(sub2(ball.touch2, center), 1 / size);
  const sweep = Math.acos(Math.max(-1, Math.min(1, dot2(u, v))));
  const sinSweep = Math.sin(sweep);
  const pts: Vec3[] = [];
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const s = i / ARC_SEGMENTS;
    const dir = sinSweep < EPS
      ? u
      : add2(scale2(u, Math.sin((1 - s) * sweep) / sinSweep), scale2(v, Math.sin(s * sweep) / sinSweep));
    pts.push(to3(add2(center, scale2(dir, size))));
  }
  return pts;
}

/** The ghost mesh for one picked edge: a ribbon lofted between consecutive
 *  samples' cross-sections, and from the last back to the first when `closed`.
 *  Null when there are fewer than 2 samples, the size is ~0, or ANY sample has
 *  no solution. */
export function sweepBlendGhost(
  samples: readonly EdgeSample[],
  size: number,
  kind: BlendKind,
  closed = false,
): GhostGeometry | null {
  if (size < EPS || samples.length < 2) return null;
  const sections: Vec3[][] = [];
  for (const s of samples) {
    const cs = crossSection(s, size, kind);
    if (!cs) return null;
    sections.push(cs);
  }
  if (closed && samples.length > 2) sections.push(sections[0]!);
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
