// Dragging a round face resizes it, since a cylinder has no single direction to move along. A full round reads as a
// diameter, as a drawing, drill and caliper say it; a partial arc (slot end, fillet) reads as a radius.

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

/** Built by the viewport and read by the handle and the tool from the same call, so the arrow and drag cannot disagree. */
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
  /** On a sphere, whose size is measured from this point; `cylinder` is then a line through it square to `radial`. */
  centre?: Vec3;
}

/** A cylinder about its exact axis or a sphere about its centre. Null for a cone or torus, which have no one
 *  size to read, and for a point on the axis or at the centre. */
export function roundFromResize(
  r: OfferedResize,
  axis: { origin: Vec3; dir: Vec3 } | null,
  at: Vec3,
): RoundFace | null {
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

/** As a fraction of the facet's size, how close `at` must be to a vertex to read the vertex normal. */
const VERTEX_SNAP = 0.2;

/** The direction a cone or torus offsets along; the average normal cancels to the axis round a full cone. Near a
 *  vertex it is the angle weighted mean, so a pick at a cone's apex points along its axis. */
export function facetNormalAt(tris: readonly THREE.Triangle[], at: THREE.Vector3): THREE.Vector3 | null {
  const p = new THREE.Vector3();
  let best: THREE.Triangle | null = null;
  let bestD = Infinity;
  for (const t of tris) {
    if (t.getArea() < 1e-12) continue;
    const d = t.closestPointToPoint(at, p).distanceToSquared(at);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
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

/** The gesture's floor, not the kernel's: a hole dragged nearly shut is far more often being removed than becoming
 *  a 0.2 mm bore. A partial arc has nothing to remove. */
export const COLLAPSE_FRACTION = 0.1;

export type RadialMode = "resize" | "remove";

export interface RadialDrag {
  /** what confirming right now would do */
  mode: RadialMode;
  /** In mm, 0 once removing. A partial arc can read at or below zero, which the engine refuses with the reason. */
  radius: number;
  /** what the readout shows on a full round, in mm, 0 once the face is being removed */
  diameter: number;
  /** In mm. 0 when removing: removal is a different feature, not a very large push. */
  distance: number;
}

/** `delta` is signed mm along the outward radial, so pulling away is always bigger. `solidInside` gives the kernel's
 *  sign: growing a shaft by 1 is +1, a hole −1, and backwards it silently resizes the wrong way. */
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

/** A diameter at or below the collapse floor comes back as the removing drag, so typing 0 does what dragging to 0 does. */
export function deltaForDiameter(radius: number, diameter: number): number {
  if (!(radius > 0) || !Number.isFinite(radius) || !Number.isFinite(diameter)) return -radius;
  return diameter / 2 - radius;
}

/** The drag a typed radius corresponds to, for a partial arc's field. */
export function deltaForRadius(radius: number, target: number): number {
  if (!(radius > 0) || !Number.isFinite(radius) || !Number.isFinite(target)) return -radius;
  return target - radius;
}

/** In mm, shown in the prompt so the floor is visible before the user hits it. */
export function collapseDiameter(radius: number): number {
  return 2 * radius * COLLAPSE_FRACTION;
}
