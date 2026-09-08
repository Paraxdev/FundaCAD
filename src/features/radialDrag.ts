// Dragging a round face resizes it. The arithmetic for that: a signed drag along
// the outward radial into a DIAMETER, the sign the kernel needs, and the point
// past which the answer is "remove this, it is gone".
//
// Grabbing a cylinder used to translate it, which is the one thing a cylindrical
// face cannot do, it has no single direction to move along, and the average of
// its facet normals is zero. What a shaft or a hole actually has is a size, so
// that is what the handle scrubs. The reading is a diameter rather than a radius
// because a diameter is what a drawing, a drill and a caliper all say.
//
// Split from pressPullTool.ts on the house rule: the tool is pointer plumbing
// that cannot run headless, and these are the functions that can be wrong in a
// way a user notices.

import type * as THREE from "three";
import type { Cylinder } from "./planeMath";

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
}

/** Below this fraction of its original radius, the face is treated as gone
 *  rather than resized.
 *
 *  Not a taste threshold, it is the kernel's. The sidecar caps an inward offset
 *  at 90% of the radius (`_clamp_cylinder` in builder.py), because collapsing a
 *  cylinder onto its own axis takes OCCT down rather than failing. So 10% of the
 *  starting radius is the smallest thing that can actually be built, and asking
 *  for less has to mean something other than a smaller cylinder. Keep the two
 *  numbers in step: raising the cap here without raising it there sends the
 *  kernel a distance it silently clamps, and the committed size stops matching
 *  the one the readout promised. */
export const COLLAPSE_FRACTION = 0.1;

export type RadialMode = "resize" | "remove";

export interface RadialDrag {
  /** what a release right now would do */
  mode: RadialMode;
  /** what the readout shows, in mm, 0 once the face is being removed */
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
 *  error, it resizes the wrong way. */
export function radialDrag(radius: number, delta: number, solidInside: boolean): RadialDrag {
  const gone: RadialDrag = { mode: "remove", diameter: 0, distance: 0 };
  if (!(radius > 0) || !Number.isFinite(radius) || !Number.isFinite(delta)) return gone;
  const r = radius + delta;
  if (r <= radius * COLLAPSE_FRACTION) return gone;
  return {
    mode: "resize",
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

/** Smallest diameter that can be built from this one, in mm. Shown in the prompt
 *  so the floor is visible before the user hits it rather than after. */
export function collapseDiameter(radius: number): number {
  return 2 * radius * COLLAPSE_FRACTION;
}
