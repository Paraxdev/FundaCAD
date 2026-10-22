// The plane a picked face implies. The answer is written into the document as {origin, normal, xdir} that nothing
// re-derives, so a future face-following datum would have to reproduce these rules on the engine side.

import type { PlaneDef, Vec3 } from "../types";

/** ~0.8°, above tessellation noise on a planar face and below the facet angle of any curved one. */
export const PLANAR_DOT = 0.9999;

/** A fraction of the radius. A tessellated cylinder's vertices lie on the true surface, so a cone, sphere, torus
 *  or spline fails this and gets no invented tangent plane. */
const FIT_TOLERANCE = 0.02;

/** The pairwise scan is O(n²); a few dozen well spread normals pin the axis as well as hundreds. */
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

/** Null for zero length or a NaN, and callers return null in turn rather than propagate (0,0,0). */
export function unit(v: Vec3): Vec3 | null {
  const n = length(v);
  if (!(n > 1e-12) || !Number.isFinite(n)) return null;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** World +Z projected into the plane, +X when nearly horizontal; it must never change or stored sketches rotate.
 *  Known divergence: sketchView.sketchXdir picks by dominant axis, so a face may open a quarter turn apart by route. */
export function planeXDir(normal: Vec3): Vec3 | null {
  const n = unit(normal);
  if (!n) return null;
  const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return unit(sub(ref, scale(n, dot(ref, n))));
}

/** The origin is the world origin projected onto the plane, not the click, so every sketch on a face shares the
 *  model's snap lattice (the same rule as viewport.pickFacePlane). */
export function planeFromPointNormal(point: Vec3, normal: Vec3): PlaneDef | null {
  const n = unit(normal);
  const x = n && planeXDir(n);
  if (!n || !x) return null;
  const o = scale(n, dot(n, point));
  return { origin: [o[0], o[1], o[2]], normal: [n[0], n[1], n[2]], xdir: [x[0], x[1], x[2]] };
}

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

/** The whole span, not the first k: a cylinder's first triangles are neighbours whose normals barely differ. */
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

/** Null for parallel (flat) or scattered normals. The widest pair seeds the axis, and the rest are flipped onto
 *  its side before folding in, or a sweep over 180° cancels to zero. */
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
  // sin(1°): below this the normals are one direction with noise on it, a flat face.
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

/** Kåsa's linear least-squares fit, with the RMS residual so the caller can tell a circle from something that
 *  merely has a centre. Null when collinear or too few. */
export function fitCircle2D(pts: [number, number][]): { cx: number; cy: number; r: number; rms: number } | null {
  if (pts.length < 3) return null;
  // Kåsa: x²+y² = 2cx·x + 2cy·y + k is linear in (cx, cy, k), so one 3x3 solve.
  let sx = 0,
    sy = 0,
    sxx = 0,
    syy = 0,
    sxy = 0,
    sz = 0,
    sxz = 0,
    syz = 0;
  const n = pts.length;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sx += x;
    sy += y;
    sz += z;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sxz += x * z;
    syz += y * z;
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

export interface Cylinder {
  /** unit direction of the axis */
  axis: Vec3;
  /** any point on the axis */
  point: Vec3;
  radius: number;
}

/** Fits vertices, not facet centres: vertices lie on the true surface, and fitting the chords would sink a tangent
 *  plane by the sagitta. Null for flat faces and for cones, spheres, tori and splines (caught by the residual). */
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

/** Null on the axis itself. */
export function radialAt(cyl: Cylinder, at: Vec3): Vec3 | null {
  const rel = sub(at, cyl.point);
  return unit(sub(rel, scale(cyl.axis, dot(rel, cyl.axis))));
}

/** A fraction of the radius, tight since the vertices lie on the surface: a torus patch must miss. */
const SPHERE_TOLERANCE = 1e-3;
/** cos of how far a facet's normal may lean off the line through the centre. */
const SPHERE_FACET_DOT = 0.95;

/** `points` are triangle corners in order, `normals` one per triangle. A cone meshed as rings lies on a sphere
 *  exactly, so a sphere must also have interior corners in more than one place, which a cone never has. */
export function sphereCentreFromFace(points: readonly Vec3[], normals: readonly Vec3[]): Vec3 | null {
  const p0 = points[0];
  if (!p0 || points.length < 4) return null;
  // |p|² = 2 p·c + k, solved about p0 so large coordinates keep their digits.
  const m = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const b = [0, 0, 0, 0];
  for (const p of points) {
    const q = sub(p, p0);
    const row = [2 * q[0], 2 * q[1], 2 * q[2], 1];
    const rhs = dot(q, q);
    for (let i = 0; i < 4; i++) {
      b[i]! += row[i]! * rhs;
      for (let j = 0; j < 4; j++) m[i]![j]! += row[i]! * row[j]!;
    }
  }
  const scaleOf = Math.max(...m.map((r, i) => Math.abs(r[i]!)));
  for (let c = 0; c < 4; c++) {
    let best = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[best]![c]!)) best = r;
    if (Math.abs(m[best]![c]!) < 1e-9 * scaleOf) return null;
    [m[c], m[best]] = [m[best]!, m[c]!];
    [b[c], b[best]] = [b[best]!, b[c]!];
    for (let r = c + 1; r < 4; r++) {
      const f = m[r]![c]! / m[c]![c]!;
      for (let j = c; j < 4; j++) m[r]![j]! -= f * m[c]![j]!;
      b[r]! -= f * b[c]!;
    }
  }
  const x = [0, 0, 0, 0];
  for (let r = 3; r >= 0; r--) {
    let s = b[r]!;
    for (let j = r + 1; j < 4; j++) s -= m[r]![j]! * x[j]!;
    x[r] = s / m[r]![r]!;
  }
  const local: Vec3 = [x[0]!, x[1]!, x[2]!];
  const radius = Math.sqrt(Math.max(0, x[3]! + dot(local, local)));
  if (!(radius > 0)) return null;
  const off = points.reduce((s, p) => {
    const d = Math.hypot(...sub(sub(p, p0), local)) - radius;
    return s + d * d;
  }, 0);
  if (Math.sqrt(off / points.length) > SPHERE_TOLERANCE * radius) return null;
  const centre = add(p0, local);
  for (let t = 0; t < normals.length; t++) {
    const a = points[3 * t],
      b2 = points[3 * t + 1],
      c = points[3 * t + 2];
    if (!a || !b2 || !c) break;
    const mid = scale(add(a, add(b2, c)), 1 / 3);
    const out = unit(sub(mid, centre));
    const n = normals[t]!;
    // A sliver of no area has no normal to hold against the centre.
    if (dot(n, n) < 0.25) continue;
    if (!out || Math.abs(dot(out, n)) < SPHERE_FACET_DOT) return null;
  }
  return innerCorners(points) > 1 ? centre : null;
}

/** How many distinct corners of a triangle mesh touch no boundary edge. */
function innerCorners(points: readonly Vec3[]): number {
  const key = (p: Vec3) => `${p[0].toFixed(5)},${p[1].toFixed(5)},${p[2].toFixed(5)}`;
  const uses = new Map<string, number>();
  const edges: [string, string][] = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    const k = [key(points[i]!), key(points[i + 1]!), key(points[i + 2]!)];
    for (let e = 0; e < 3; e++) {
      const a = k[e]!,
        b = k[(e + 1) % 3]!;
      if (a === b) continue;
      const id = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!uses.has(id)) edges.push([a, b]);
      uses.set(id, (uses.get(id) ?? 0) + 1);
    }
  }
  const corners = new Set<string>();
  const onBoundary = new Set<string>();
  for (const [a, b] of edges) {
    corners.add(a).add(b);
    if (uses.get(a < b ? `${a}|${b}` : `${b}|${a}`) === 1) onBoundary.add(a).add(b);
  }
  return corners.size - onBoundary.size;
}

/** Short of 2π because a tessellated ring leaves one chord's angle uncovered, and a coarse chord is wide. */
export const FULL_SWEEP = 2 * Math.PI - Math.PI / 4;

/** In radians, 2π less the widest angular gap; 0 with fewer than two points off the axis. */
export function arcSweep(cyl: Cylinder, points: readonly Vec3[]): number {
  return arcOf(cyl, points)?.sweep ?? 0;
}

/** The start angle in the (u, v) frame square to the axis, and how far on it reaches. */
function arcOf(cyl: Cylinder, points: readonly Vec3[]): { u: Vec3; v: Vec3; start: number; sweep: number } | null {
  const u = planeXDir(cyl.axis);
  if (!u) return null;
  const v = cross(cyl.axis, u);
  const angles: number[] = [];
  for (const p of points) {
    const r = radialAt(cyl, p);
    if (r) angles.push(Math.atan2(dot(r, v), dot(r, u)));
  }
  if (angles.length < 2) return null;
  angles.sort((a, b) => a - b);
  let gap = (angles[0] as number) + 2 * Math.PI - (angles[angles.length - 1] as number);
  let start = angles[0] as number;
  for (let i = 1; i < angles.length; i++) {
    const g = (angles[i] as number) - (angles[i - 1] as number);
    if (g > gap) {
      gap = g;
      start = angles[i] as number;
    }
  }
  return { u, v, start, sweep: 2 * Math.PI - gap };
}

/** On the cylinder, not the chords: at the crown of a partial arc, or round a full one at the click's angle (else
 *  `seed`'s). Along the axis level with the click, clamped to the face, or halfway without one. */
export function roundStand(
  cyl: Cylinder,
  points: readonly Vec3[],
  full: boolean,
  click: Vec3 | null,
  seed: Vec3,
): { point: Vec3; radial: Vec3 } | null {
  const arc = arcOf(cyl, points);
  if (!arc) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const t = dot(sub(p, cyl.point), cyl.axis);
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  const t = click ? Math.min(hi, Math.max(lo, dot(sub(click, cyl.point), cyl.axis))) : (lo + hi) / 2;
  let radial: Vec3 | null;
  if (full) {
    radial = radialAt(cyl, click ?? seed);
    if (!radial) return null;
  } else {
    const a = arc.start + arc.sweep / 2;
    radial = add(scale(arc.u, Math.cos(a)), scale(arc.v, Math.sin(a)));
  }
  return { point: add(add(cyl.point, scale(cyl.axis, t)), scale(radial, cyl.radius)), radial };
}

/** On the cylinder within `tol`, and along it no further than `tol` past the face's points. */
export function onRoundFace(cyl: Cylinder, points: readonly Vec3[], p: Vec3, tol: number): boolean {
  const rel = sub(p, cyl.point);
  const t = dot(rel, cyl.axis);
  if (Math.abs(length(sub(rel, scale(cyl.axis, t))) - cyl.radius) > tol) return false;
  let lo = Infinity;
  let hi = -Infinity;
  for (const q of points) {
    const s = dot(sub(q, cyl.point), cyl.axis);
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  return t >= lo - tol && t <= hi + tol;
}

/** Per triangle against its own radial, since the average normal cancels to zero on a closed cylinder. Decides the
 *  sign sent to the kernel. `points` must be three per normal, as facePlanePick collects them, or it is refused. */
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

/** The origin is pushed out to the true surface since `at` sits a sagitta inside, and x is the cylinder axis.
 *  `facing` turns the normal toward the axis on a bore, as the engine reads it off the B-rep. Null on the axis. */
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

/** A round face has a different tangent plane at every point, so a "tangent" pick persists its location. */
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

/** A fraction of the chord, so it means the same on a 2mm rib and a 2m spar. A straight edge tessellates to its
 *  endpoints, while even a 90° arc bulges by 0.29 of its chord. */
export const STRAIGHT_EDGE_FRACTION = 1e-4;

export interface EdgeAxis {
  origin: Vec3;
  dir: Vec3;
}

/** Null for an edge that is not straight, so the refusal comes at pick time, not on the next rebuild. End to end,
 *  not fitted; the sign is arbitrary since the revolve's angle decides the direction of travel. */
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

// Three-point planes and midplanes resolve to the same PlaneDef a face datum does, so the engine needs nothing new.

/** Not tolerance based on purpose: nearly collinear points still name a plane, like three corners along a thin
 *  rib. `unit` refuses the truly degenerate case. */
export function planeThroughPoints(a: Vec3, b: Vec3, c: Vec3): PlaneDef | null {
  return planeFromPointNormal(a, cross(sub(b, a), sub(c, a)));
}

/** cos(0.05°), compared as |dot| since two faces of a plate point away from each other. */
const PARALLEL_DOT = 0.9999996;

/** Equally far out of the material of each face along its outward normal, so normals are used as given. Parallel
 *  planes give the halfway plane; meeting planes the bisector with normal (na - nb), a roof's ridge, not (na + nb). */
export function midPlane(a: PlaneDef, b: PlaneDef): PlaneDef | null {
  const na = unit(a.normal);
  const nb = unit(b.normal);
  if (!na || !nb) return null;

  if (Math.abs(dot(na, nb)) >= PARALLEL_DOT) {
    // Along a's own normal, so b's normal may point either way.
    const gap = dot(na, sub(b.origin, a.origin));
    return planeFromPointNormal(add(a.origin, scale(na, gap / 2)), na);
  }

  const n = unit(sub(na, nb));
  if (!n) return null; // only possible for equal normals, handled above
  // A point on both planes: leave a's origin along the steepest in-plane direction toward b.
  const inA = unit(sub(nb, scale(na, dot(nb, na))));
  if (!inA) return null;
  const t = dot(nb, sub(b.origin, a.origin)) / dot(nb, inA);
  return planeFromPointNormal(add(a.origin, scale(inA, t)), n);
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** The point at fraction `t` of a polyline's length and the unit tangent there. */
export function alongPolyline(points: readonly Vec3[], t: number): { p: Vec3; tangent: Vec3 } | null {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist3(points[i - 1]!, points[i]!);
  if (!(total > 1e-12)) return null;
  let left = Math.min(1, Math.max(0, t)) * total;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = dist3(a, b);
    if (d < 1e-12) continue;
    if (left <= d || i === points.length - 1) {
      const f = Math.min(1, left / d);
      const tangent: Vec3 = [(b[0] - a[0]) / d, (b[1] - a[1]) / d, (b[2] - a[2]) / d];
      return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], tangent };
    }
    left -= d;
  }
  return null;
}

/** The line two planes meet in: its point nearest the first plane's origin. */
export function planesMeet(a: PlaneDef, b: PlaneDef): { origin: Vec3; dir: Vec3 } | null {
  const dir = unit(cross3(a.normal, b.normal));
  if (!dir) return null;
  const na = a.normal;
  const nb = b.normal;
  const da = na[0] * a.origin[0] + na[1] * a.origin[1] + na[2] * a.origin[2];
  const db = nb[0] * b.origin[0] + nb[1] * b.origin[1] + nb[2] * b.origin[2];
  // Point on both planes: p = (da (nb x d) + db (d x na)) / |na x nb|^2 with d = na x nb.
  const d = cross3(na, nb);
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const u = cross3(nb, d);
  const v = cross3(d, na);
  const p: Vec3 = [0, 1, 2].map((i) => (da * u[i]! + db * v[i]!) / dd) as Vec3;
  const k = (a.origin[0] - p[0]) * dir[0] + (a.origin[1] - p[1]) * dir[1] + (a.origin[2] - p[2]) * dir[2];
  return { origin: [p[0] + dir[0] * k, p[1] + dir[1] * k, p[2] + dir[2] * k], dir };
}
