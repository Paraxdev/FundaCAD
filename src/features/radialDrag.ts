// Dragging a round face resizes it. The arithmetic for that: a signed drag along
// the outward radial into a size, the sign the kernel needs, and, on a full
// round, the point past which the answer is "remove this, it is gone".
//
// Grabbing a cylinder used to translate it, which is the one thing a cylindrical
// face cannot do, it has no single direction to move along, and the average of
// its facet normals is zero. What a shaft or a hole actually has is a size, so
// that is what the handle scrubs. A full round reads as a diameter, because a
// diameter is what a drawing, a drill and a caliper all say. A partial arc (a
// slot end, a fillet) has no diameter to measure, so it reads as a radius.
//
// Split from pressPullTool.ts on the house rule: the tool is pointer plumbing
// that cannot run headless, and these are the functions that can be wrong in a
// way a user notices.

import * as THREE from "three";
import { planeXDir, radialAt, unit, type Cylinder } from "./planeMath";
import type { OfferedResize } from "./pressPullAxis";
import type { Vec3 } from "../types";

/** Faces that run smoothly into a round face, as the engine reports them. */
export interface RoundTangent {
  faces: number;
  /** which way of resizing would leave them no longer meeting the face */
  lostWhen: "shrink" | "grow" | null;
  /** a point on each face of the whole tangent run, the picked face included */
  run: Vec3[];
  closed: boolean;
  followable: boolean;
}

/** A selected face that turned out to be a cylinder, and everything a resize
 *  needs to know about it. Built by the viewport (which owns the tessellation)
 *  and read by the handle and the tool from the same call, so the arrow the user
 *  grabs and the drag it arms cannot disagree. */
export interface RoundFace {
  cylinder: Cylinder;
  /** the CURRENT radius, in mm, what the drag is measured from */
  radius: number;
  /** material inside the cylinder (a shaft/boss) rather than outside it (a bore) */
  solidInside: boolean;
  /** unit world direction away from the axis at the handle's anchor */
  radial: THREE.Vector3;
  /** the face goes all the way round, absent reads as full */
  full?: boolean;
  /** null until the engine has answered, the mesh cannot tell */
  tangent?: RoundTangent | null;
  /** Set on a sphere, whose size is measured from this point. `cylinder` is
   *  then a line through it square to `radial`, so a size guide drawn about
   *  that line runs out from the centre. */
  centre?: Vec3;
}

/** The round face the engine describes, standing at `at`: a cylinder about its
 *  exact axis, or a sphere about its centre. Null for a cone or a torus, which
 *  have no one size to read, and for a point on the axis or at the centre. */
export function roundFromResize(r: OfferedResize, axis: { origin: Vec3; dir: Vec3 } | null, at: Vec3): RoundFace | null {
  let cylinder: Cylinder;
  let radial: Vec3 | null;
  if (r.kind === "cylinder" && axis) {
    cylinder = { axis: axis.dir, point: axis.origin, radius: r.radius };
    radial = radialAt(cylinder, at);
  } else if (r.kind === "sphere" && r.centre) {
    const c = r.centre;
    radial = unit([at[0] - c[0], at[1] - c[1], at[2] - c[2]]);
    const across = radial && planeXDir(radial);
    if (!across) return null;
    cylinder = { axis: across, point: c, radius: r.radius };
  } else {
    return null;
  }
  if (!radial) return null;
  return {
    cylinder,
    radius: r.radius,
    solidInside: !r.concave,
    radial: new THREE.Vector3(radial[0], radial[1], radial[2]),
    full: r.full,
    tangent: r.tangent,
    ...(r.kind === "sphere" ? { centre: r.centre } : {}),
  };
}

/** How close to a mesh vertex `at` must lie, as a fraction of the facet's
 *  size, to read the normal of the vertex rather than of the one facet. */
const VERTEX_SNAP = 0.2;

/** The outward normal of the surface where it was picked, the direction a
 *  cone or a torus is offset along. The face's average normal is no use there,
 *  round a full cone it cancels to the axis. Usually the nearest facet's; near
 *  a vertex the angle weighted mean of every facet meeting there, so a pick at
 *  a cone's apex points along its axis rather than along whichever facet of
 *  the fan happened to be nearest. */
export function facetNormalAt(tris: readonly THREE.Triangle[], at: THREE.Vector3): THREE.Vector3 | null {
  const p = new THREE.Vector3();
  let best: THREE.Triangle | null = null;
  let bestD = Infinity;
  for (const t of tris) {
    if (t.getArea() < 1e-12) continue;
    const d = t.closestPointToPoint(at, p).distanceToSquared(at);
    if (d < bestD) { bestD = d; best = t; }
  }
  if (!best) return null;
  const own = best.getNormal(new THREE.Vector3());
  const corner = [best.a, best.b, best.c].reduce((m, v) => (v.distanceToSquared(at) < m.distanceToSquared(at) ? v : m));
  const size = Math.sqrt(best.getArea());
  if (corner.distanceTo(at) > VERTEX_SNAP * size) return own;
  const same = 1e-4 * size;
  const sum = new THREE.Vector3();
  const n = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  for (const t of tris) {
    if (t.getArea() < 1e-12) continue;
    const vs = [t.a, t.b, t.c];
    const i = vs.findIndex((v) => v.distanceTo(corner) <= same);
    if (i < 0) continue;
    e1.subVectors(vs[(i + 1) % 3]!, vs[i]!);
    e2.subVectors(vs[(i + 2) % 3]!, vs[i]!);
    sum.addScaledVector(t.getNormal(n), e1.angleTo(e2));
  }
  return sum.length() > 1e-6 ? sum.normalize() : own;
}

/** Below this fraction of its original radius, a FULL round face is treated as
 *  gone rather than resized.
 *
 *  It is the gesture's floor, not the kernel's: the engine builds any size above
 *  zero and refuses zero itself. A hole dragged nearly shut is a hole being
 *  taken away far more often than a 0.2 mm bore, so the last tenth of the drag
 *  means "remove". A partial arc has no floor here, it has nothing to remove. */
export const COLLAPSE_FRACTION = 0.1;

export type RadialMode = "resize" | "remove";

export interface RadialDrag {
  /** what a release right now would do */
  mode: RadialMode;
  /** the new radius, in mm, 0 once the face is being removed. A partial arc
   *  can read at or below zero, which the engine refuses with the reason. */
  radius: number;
  /** what the readout shows on a full round, in mm, 0 once the face is being removed */
  diameter: number;
  /** the signed press/pull distance for the kernel, in mm. 0 when removing:
   *  removal is a different feature, not a very large push. */
  distance: number;
}

/** Read a drag as a resize.
 *
 *  `delta` is signed millimetres along the OUTWARD radial (away from the axis),
 *  which is the direction the handle points on a bore and a boss alike, pulling
 *  away from the axis always means "bigger", whichever side the material is on.
 *
 *  `solidInside` is what turns that into the kernel's sign. A positive press/pull
 *  distance moves a face along its own outward normal, and that normal points
 *  away from the axis on a shaft but at it on a hole: growing a 10 mm shaft by 1
 *  is +1, growing a 10 mm hole by 1 is −1. Getting this backwards does not
 *  error, it resizes the wrong way.
 *
 *  `full` is whether the face goes all the way round; only then can the drag
 *  remove it. */
export function radialDrag(radius: number, delta: number, solidInside: boolean, full = true): RadialDrag {
  const gone: RadialDrag = { mode: "remove", radius: 0, diameter: 0, distance: 0 };
  if (!(radius > 0) || !Number.isFinite(radius) || !Number.isFinite(delta)) return gone;
  const r = radius + delta;
  if (full && r <= radius * COLLAPSE_FRACTION) return gone;
  return {
    mode: "resize",
    radius: r,
    diameter: 2 * r,
    distance: solidInside ? delta : -delta,
  };
}

/** The drag a typed diameter corresponds to, the inverse of the above, for the
 *  heads-up field. A diameter at or below the collapse floor comes back as the
 *  drag that removes the face, so typing 0 does what dragging to 0 does. */
export function deltaForDiameter(radius: number, diameter: number): number {
  if (!(radius > 0) || !Number.isFinite(radius) || !Number.isFinite(diameter)) return -radius;
  return diameter / 2 - radius;
}

/** The drag a typed radius corresponds to, for a partial arc's field. */
export function deltaForRadius(radius: number, target: number): number {
  if (!(radius > 0) || !Number.isFinite(radius) || !Number.isFinite(target)) return -radius;
  return target - radius;
}

/** The diameter under which a drag removes a full round face, in mm. Shown in
 *  the prompt so the floor is visible before the user hits it rather than after. */
export function collapseDiameter(radius: number): number {
  return 2 * radius * COLLAPSE_FRACTION;
}
