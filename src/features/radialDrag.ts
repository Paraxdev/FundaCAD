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

import type * as THREE from "three";
import type { Cylinder } from "./planeMath";
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
