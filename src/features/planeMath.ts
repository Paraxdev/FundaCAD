// The arithmetic behind "make a plane out of the thing I clicked": the frame a
// picked face implies, and the tangent plane where the cursor lands on a round one.
//
// Isolated because it can be WRONG in a way the user only discovers three
// operations later — a drifted origin moves the snap lattice of every sketch drawn
// on it, and a tangent plane off by a chord's sagitta puts the sketch inside the
// material. Neither raises an error; both show up as a part that does not fit.
//
// And its answer is what gets WRITTEN DOWN: there is no face-referenced plane spec
// on the wire, so a datumPlane carries a resolved {origin, normal, xdir} that the
// sidecar simply rebuilds with. Nothing downstream re-derives or corrects it, and
// a future face-following datum would have to reproduce these rules on the sidecar
// side to stay compatible with planes already saved in people's documents.
//
// Plain tuples throughout: no THREE, no viewport, no camera, so vitest reaches it.

import type { PlaneDef, Vec3 } from "../types";

/** Two normals closer than this (dot product) are the same direction as far as
 *  "is this face flat?" is concerned — ~0.8°, comfortably above tessellation
 *  noise on a planar face (which is exact) and far below the facet angle of any
 *  curved face a kernel would emit. */
export const PLANAR_DOT = 0.9999;

/** How far a fitted circle's points may sit off it, as a fraction of the radius,
 *  before we refuse to call the face cylindrical. A tessellated cylinder's
 *  VERTICES lie exactly on the true surface, so the residual is numerical for a
 *  real cylinder and large for a cone, sphere, torus or spline — this is the
 *  test that stops a tangent plane being invented on a face that has no single
 *  axis. */
const FIT_TOLERANCE = 0.02;

/** Normals sampled for the axis search. The pair-wise scan below is O(n²) and a
 *  tessellated cylinder can carry hundreds of facets; a few dozen well-spread
 *  normals pin the axis exactly as well, because two normals from opposite ends
 *  of the sweep already determine it. */
const AXIS_SAMPLES = 24;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** Unit vector, or null when there is no direction to be had (a zero-length
 *  input, or one carrying a NaN from an upstream degenerate triangle). Callers
 *  return null in turn rather than propagate a silent (0,0,0) "direction". */
export function unit(v: Vec3): Vec3 | null {
  const n = length(v);
  if (!(n > 1e-12) || !Number.isFinite(n)) return null;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** The in-plane x axis a bare normal implies.
 *
 *  A normal supplies no x direction, so an arbitrary choice has to be made and it
 *  has to be the SAME one every time — derived one way at pick time and another
 *  later is a sketch that rotates about its own normal, moving every coordinate
 *  stored in it. viewport.pickFacePlane calls through here rather than carrying a
 *  second copy.
 *
 *  KNOWN DIVERGENCE, recorded rather than fixed: sketchView.sketchXdir answers the
 *  same question by the normal's dominant world axis, serving the "select a face,
 *  press S" route where this serves "press S, click a face". Both are stable and
 *  both are recorded IN the plane they produce, so the only symptom is the same
 *  face opening a quarter turn apart depending on route — never a plane in the
 *  wrong place. Unifying is safe; picking the winner is a decision about feel.
 *
 *  World +Z projected into the plane, or world +X when the plane is nearly
 *  horizontal and +Z has almost nothing to project. */
export function planeXDir(normal: Vec3): Vec3 | null {
  const n = unit(normal);
  if (!n) return null;
  const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return unit(sub(ref, scale(n, dot(ref, n))));
}

/** The plane through `point` with normal `normal`, in the form the document
 *  stores.
 *
 *  The origin is NOT the point you clicked: it is the WORLD origin projected
 *  onto the plane. Grid snapping rounds in plane-local coordinates, so the
 *  origin decides where the snap lattice falls in world space — anchoring it on
 *  the pick would give every sketch-on-face its own lattice, offset from the
 *  model's by wherever the cursor happened to be. (This is the same rule, and
 *  the same bug, documented at viewport.pickFacePlane; two planes parallel to
 *  each other share one lattice because of it.) */
export function planeFromPointNormal(point: Vec3, normal: Vec3): PlaneDef | null {
  const n = unit(normal);
  const x = n && planeXDir(n);
  if (!n || !x) return null;
  const o = scale(n, dot(n, point));
  return { origin: [o[0], o[1], o[2]], normal: [n[0], n[1], n[2]], xdir: [x[0], x[1], x[2]] };
}

/** True when every sampled facet normal points the same way — i.e. the face is
 *  flat and its own normal IS the plane's. */
export function isPlanarFace(normals: Vec3[]): boolean {
  const first = normals.length ? unit(normals[0] as Vec3) : null;
  if (!first) return false;
  for (const raw of normals) {
    const n = unit(raw);
    if (!n) continue;
    if (dot(n, first) < PLANAR_DOT) return false;
  }
  return true;
}

/** Evenly spread sample of at most `k` items — the whole span, not the first k,
 *  because the first k triangles of a tessellated cylinder are a handful of
 *  neighbours whose normals barely differ. */
function sample<T>(items: T[], k: number): T[] {
  if (items.length <= k) return items;
  const stride = items.length / k;
  const out: T[] = [];
  for (let i = 0; i < k; i++) {
    const v = items[Math.floor(i * stride)];
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** The rotation axis a set of surface normals implies, or null when they are all
 *  parallel (a flat face) or too scattered to share one.
 *
 *  On a cylinder every normal is perpendicular to the axis, so any two
 *  NON-parallel normals cross to give it. The widest-separated pair is the
 *  best-conditioned one, so it seeds the answer; the rest are then folded in,
 *  each flipped onto the seed's side first — a cross product's sign depends on
 *  the order of its operands, and averaging without that flip cancels the axis
 *  to zero on any face that sweeps more than 180°. */
export function axisFromNormals(normals: Vec3[]): Vec3 | null {
  const ns = sample(normals, AXIS_SAMPLES)
    .map(unit)
    .filter((n): n is Vec3 => n !== null);
  let seed: Vec3 | null = null;
  let best = 0;
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      const c = cross(ns[i] as Vec3, ns[j] as Vec3);
      const m = length(c);
      if (m > best) {
        best = m;
        seed = c;
      }
    }
  }
  // sin(1°): below this the normals are one direction with noise on it, which
  // is a flat face, not an axis.
  const axis = best > 0.017 ? unit(seed as Vec3) : null;
  if (!axis) return null;
  const acc: Vec3 = [0, 0, 0];
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      const c = cross(ns[i] as Vec3, ns[j] as Vec3);
      if (length(c) < 0.017) continue;
      const s = dot(c, axis) < 0 ? -1 : 1;
      acc[0] += c[0] * s;
      acc[1] += c[1] * s;
      acc[2] += c[2] * s;
    }
  }
  return unit(acc) ?? axis;
}

/** A least-squares circle through 2D points (Kåsa's linear fit), with the RMS
 *  residual so the caller can tell a circle from something that merely has a
 *  centre. Null when the points are collinear (the normal equations go
 *  singular) or too few to determine one. */
export function fitCircle2D(
  pts: [number, number][],
): { cx: number; cy: number; r: number; rms: number } | null {
  if (pts.length < 3) return null;
  // Kåsa: x²+y² = 2cx·x + 2cy·y + (r²−cx²−cy²) is LINEAR in (cx, cy, k), so the
  // fit is one 3x3 normal-equation solve rather than an iterative one.
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
  const n = pts.length;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sx += x; sy += y; sz += z;
    sxx += x * x; syy += y * y; sxy += x * y;
    sxz += x * z; syz += y * z;
  }
  const a11 = 2 * (sxx - (sx * sx) / n);
  const a12 = 2 * (sxy - (sx * sy) / n);
  const a22 = 2 * (syy - (sy * sy) / n);
  const b1 = sxz - (sx * sz) / n;
  const b2 = syz - (sy * sz) / n;
  const det = a11 * a22 - a12 * a12;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null; // collinear
  const cx = (b1 * a22 - b2 * a12) / det;
  const cy = (a11 * b2 - a12 * b1) / det;
  let sr = 0;
  for (const [x, y] of pts) sr += Math.hypot(x - cx, y - cy);
  const r = sr / n;
  if (!(r > 1e-9)) return null;
  let acc = 0;
  for (const [x, y] of pts) {
    const d = Math.hypot(x - cx, y - cy) - r;
    acc += d * d;
  }
  return { cx, cy, r, rms: Math.sqrt(acc / n) };
}

/** A cylindrical face's axis, a point on that axis, and its radius. */
export interface Cylinder {
  /** unit direction of the axis */
  axis: Vec3;
  /** any point on the axis */
  point: Vec3;
  radius: number;
}

/** Recover the cylinder a face lies on from its tessellation: the axis from the
 *  facet normals, the radius and centre from the vertices.
 *
 *  Vertices, not facet centres, because a tessellated cylinder's VERTICES sit
 *  exactly on the true surface while its facets are chords strung inside it. Fit
 *  the chords and you get a radius short by the sagitta, which is precisely the
 *  amount by which a tangent plane would then sink into the material.
 *
 *  Null for anything that is not a cylinder — a flat face (no axis), or a cone /
 *  sphere / torus / spline, which have an axis-ish direction but whose points do
 *  not fall on one circle (caught by the residual). */
export function cylinderFromFace(points: Vec3[], normals: Vec3[]): Cylinder | null {
  const axis = axisFromNormals(normals);
  const p0 = points[0];
  if (!axis || !p0 || points.length < 3) return null;
  const u = planeXDir(axis);
  if (!u) return null;
  const v = cross(axis, u); // unit: axis ⟂ u, both unit
  const flat: [number, number][] = points.map((p) => {
    const q = sub(p, p0);
    return [dot(q, u), dot(q, v)];
  });
  const fit = fitCircle2D(flat);
  if (!fit || fit.rms > FIT_TOLERANCE * fit.r) return null;
  const point = add(p0, add(scale(u, fit.cx), scale(v, fit.cy)));
  return { axis, point, radius: fit.r };
}

/** The unit "away from the axis" direction at a point on (or near) a cylinder.
 *  Null on the axis itself, where radially-outward has no meaning. */
export function radialAt(cyl: Cylinder, at: Vec3): Vec3 | null {
  const rel = sub(at, cyl.point);
  return unit(sub(rel, scale(cyl.axis, dot(rel, cyl.axis))));
}

/** Does the material lie INSIDE this cylindrical face — a shaft or boss — rather
 *  than outside it, as on a bore?
 *
 *  Asked per triangle against that triangle's own radial, and summed. The
 *  face-wide average normal cannot answer this: on a CLOSED cylinder the normals
 *  cancel to zero by symmetry, which is exactly the degeneracy that had a round
 *  face's drag handle pointing at world +Z. Every triangle agrees with its own
 *  radial or opposes it, so the per-triangle test has no cancellation to suffer
 *  and a half-cylinder answers the same as a whole one.
 *
 *  Weighted by nothing: a facet's area says how much of the surface it is, not
 *  how confident it is about which side the material is on, and the vote is
 *  unanimous on any real cylinder. Null when the normals do not agree at all —
 *  a face that is not the cylinder we were told it was.
 *
 *  This is the same asymmetry `tangentPlaneOnCylinder`'s `facing` handles, and it
 *  is what decides the SIGN sent to the kernel: a positive offset moves a face
 *  along its own outward normal, so it grows a boss and shrinks a bore.
 *
 *  `points` must be three-per-normal — the triangles' own corners, as
 *  facePlanePick collects them. Refused outright rather than read loosely: the
 *  other packing a caller might reach for (one point per normal) would index
 *  into the wrong facet and answer plausibly, and the answer is a sign. */
export function solidInsideCylinder(cyl: Cylinder, points: Vec3[], normals: Vec3[]): boolean | null {
  if (points.length !== normals.length * 3) return null;
  let vote = 0;
  for (let i = 0; i < normals.length; i++) {
    const n = normals[i];
    const a = points[i * 3];
    const b = points[i * 3 + 1];
    const c = points[i * 3 + 2];
    if (!n || !a || !b || !c) break;
    const mid = scale(add(add(a, b), c), 1 / 3);
    const r = radialAt(cyl, mid);
    if (!r) continue;
    const d = dot(n, r);
    if (Math.abs(d) < 0.5) continue; // grazing: this facet is not on the wall
    vote += d > 0 ? 1 : -1;
  }
  return vote === 0 ? null : vote > 0;
}

/** The plane that touches a cylinder at the point you clicked.
 *
 *  `at` comes from a raycast against the tessellation, so it sits a sagitta INSIDE
 *  the true surface; the origin is pushed back out to the exact touch point (axis +
 *  radius · radial), or the datum would be buried a hair inside the material.
 *
 *  The x axis is the cylinder's own axis, so a sketch has "along the shaft" as its
 *  horizontal — the only in-plane frame the geometry itself supplies.
 *
 *  `facing` decides which way the normal points: away from the axis on a shaft, but
 *  TOWARD it on a bore, where the face's own normal points into the void. Without
 *  it a datum on a hole wall would face into the material, its offset would run
 *  backwards, and it would disagree with the sidecar, which reads the direction
 *  straight off the B-rep face. Where the plane SITS is unaffected.
 *
 *  Null on the axis itself, where "radially outward" has no meaning. */
export function tangentPlaneOnCylinder(cyl: Cylinder, at: Vec3, facing?: Vec3): PlaneDef | null {
  const rel = sub(at, cyl.point);
  const along = dot(rel, cyl.axis);
  const radial = unit(sub(rel, scale(cyl.axis, along)));
  if (!radial) return null;
  const touch = add(add(cyl.point, scale(cyl.axis, along)), scale(radial, cyl.radius));
  const n = facing && dot(radial, facing) < 0 ? scale(radial, -1) : radial;
  return {
    origin: [touch[0], touch[1], touch[2]],
    normal: [n[0], n[1], n[2]],
    xdir: [cyl.axis[0], cyl.axis[1], cyl.axis[2]],
  };
}

/** What kind of plane a picked face yields, and the definition itself.
 *
 *  `kind` is what the caller shows the user and what decides whether the
 *  document stores a tangent POINT alongside the face reference: a flat face's
 *  plane is the face, but a round face has a different tangent plane at every
 *  point on it, so the pick location is part of the definition and has to be
 *  persisted with it. */
export type FacePlaneKind = "planar" | "tangent";

export function planeFromPickedFace(
  points: Vec3[],
  normals: Vec3[],
  at: Vec3,
  faceNormal: Vec3,
): { kind: FacePlaneKind; def: PlaneDef } | null {
  if (isPlanarFace(normals)) {
    const def = planeFromPointNormal(at, faceNormal);
    return def ? { kind: "planar", def } : null;
  }
  const cyl = cylinderFromFace(points, normals);
  const def = cyl && tangentPlaneOnCylinder(cyl, at, faceNormal);
  return def ? { kind: "tangent", def } : null;
}

/** How far a sample may sit off the chord between an edge's ends, as a fraction
 *  of that chord's length, and still count as a straight edge.
 *
 *  Relative because it has to mean the same thing on a 2mm rib and a 2m spar.
 *  A straight B-rep edge tessellates to its two endpoints and nothing between,
 *  so the residual is numerical for a line and enormous for anything else: even
 *  a 90° arc bulges by 0.29 of its chord. Nothing needs this to be tight. */
export const STRAIGHT_EDGE_FRACTION = 1e-4;

export interface EdgeAxis {
  origin: Vec3;
  dir: Vec3;
}

/** The axis a picked edge stands for, or null when the edge is not a straight
 *  line and therefore is not one.
 *
 *  An axis of revolution is a LINE, so a circle or a spline cannot be one, and
 *  refusing here is the difference between a message at pick time and a feature
 *  that fails on the next rebuild with the kernel's own account of why.
 *
 *  `points` is the edge's tessellated polyline as the viewport holds it. The
 *  direction is end to end rather than fitted, because for a straight edge the
 *  two endpoints ARE the edge and a fit over collinear samples answers the same
 *  thing less directly. Which way it points is arbitrary and does not matter:
 *  the axis of a revolve is a line, not a ray, and the revolve's own angle sign
 *  decides the direction of travel. */
export function axisFromEdge(points: readonly Vec3[]): EdgeAxis | null {
  const a = points[0];
  const b = points[points.length - 1];
  if (!a || !b || points.length < 2) return null;
  const dir = unit(sub(b, a));
  if (!dir) return null;
  const chord = length(sub(b, a));
  const tol = chord * STRAIGHT_EDGE_FRACTION;
  for (const p of points) {
    // distance from p to the infinite line through a along dir
    const v = sub(p, a);
    const off = sub(v, scale(dir, dot(v, dir)));
    if (!(length(off) <= tol)) return null;
  }
  return { origin: a, dir };
}
