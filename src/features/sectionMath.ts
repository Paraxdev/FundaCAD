// The arithmetic behind cross-section mode: where the cutting plane sits, and
// how faintly the half you cut away is still drawn.
//
// Split out for the reason edgeDragMath.ts was: the tool around it is pointer
// listeners, a Three.js gizmo and a renderer flag, none of which run headless,
// while THIS is the part that decides whether a drag moves the cut the way the
// user pushed it, and whether "hidden" is actually reachable on the ghost dial.

import type { PlaneDef, Vec3 } from "../types";

/** A clipping plane as the renderer wants it: unit normal, plus the plane
 *  constant d in n·x + d = 0. Everything on the +n side of it is KEPT. */
export interface ClipPlane {
  normal: Vec3;
  constant: number;
}

/** The cut for a section defined by `origin`/`normal`, slid `offset` mm along
 *  its own normal and kept on `side` (+1 or −1, what F flips).
 *
 *  Offset is applied along the DEFINING normal, not the kept side's: flipping
 *  which half you keep must not also reverse which way dragging moves the cut,
 *  or the handle would fight the user every time they pressed F. */
export function clipPlaneAt(origin: Vec3, normal: Vec3, offset: number, side: 1 | -1): ClipPlane {
  const len = Math.hypot(normal[0], normal[1], normal[2]);
  const n: Vec3 = len > 1e-12 ? [normal[0] / len, normal[1] / len, normal[2] / len] : [0, 0, 1];
  const at: Vec3 = [
    origin[0] + n[0] * offset,
    origin[1] + n[1] * offset,
    origin[2] + n[2] * offset,
  ];
  const s: Vec3 = [n[0] * side, n[1] * side, n[2] * side];
  return { normal: s, constant: -(s[0] * at[0] + s[1] * at[1] + s[2] * at[2]) };
}

/** The point the gizmo stands on: the section's anchor slid by the offset. */
export function sectionCentre(origin: Vec3, normal: Vec3, offset: number): Vec3 {
  const len = Math.hypot(normal[0], normal[1], normal[2]);
  const n: Vec3 = len > 1e-12 ? [normal[0] / len, normal[1] / len, normal[2] / len] : [0, 0, 1];
  return [origin[0] + n[0] * offset, origin[1] + n[1] * offset, origin[2] + n[2] * offset];
}

/** Where the section's gizmo should stand when the cut comes from a face or a
 *  datum plane: the point OF that plane nearest the model.
 *
 *  A PlaneDef's own origin is the world origin projected onto it, which is the
 *  only stable choice for a plane definition but says nothing about where the
 *  geometry is. On a part modelled far from the world origin that point sits out
 *  in empty space, so the cut would be perfectly visible while its handle was
 *  somewhere off screen. Projecting the model's centre onto the plane puts the
 *  handle on the cut the user is actually looking at, without moving the plane
 *  itself: the result is on the same plane by construction. */
export function sectionAnchor(origin: Vec3, normal: Vec3, modelCentre: Vec3): Vec3 {
  const len = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(len > 1e-12)) return [...origin];
  const n: Vec3 = [normal[0] / len, normal[1] / len, normal[2] / len];
  const d =
    (modelCentre[0] - origin[0]) * n[0] +
    (modelCentre[1] - origin[1]) * n[1] +
    (modelCentre[2] - origin[2]) * n[2];
  return [
    modelCentre[0] - n[0] * d,
    modelCentre[1] - n[1] * d,
    modelCentre[2] - n[2] * d,
  ];
}

/** The plane a datum/face definition cuts along, the section only needs a point
 *  and a direction, and this is the one place that decides which of a PlaneDef's
 *  three vectors those are. */
export function sectionFromPlaneDef(def: PlaneDef): { origin: Vec3; normal: Vec3 } {
  return { origin: [...def.origin], normal: [...def.normal] };
}

// --- the ghost dial ---------------------------------------------------------
//
// The point of the mode: geometry past the cut does not VANISH, it goes faint,
// so an assembly keeps its shape while you look inside it. But how faint has to
// be the user's call, a dense assembly ghosts into fog at an alpha a single
// bracket needs to be legible at, and "no ghost at all" has to stay reachable,
// because a clean uncluttered cut is the right answer often enough that taking
// it away would be a regression on the tool this replaced.

/** The rungs of the dial, in ascending strength. Index 0 is the old behaviour
 *  exactly: alpha 0 means no ghost pass is built at all, so "hidden" costs
 *  nothing rather than costing a fully transparent draw of the whole model. */
export const GHOST_LEVELS = [0, 0.06, 0.14, 0.3] as const;

/** Where the dial starts. Level 2 rather than the faintest: the ghost is the
 *  feature, and a first-run setting so faint the user cannot tell it is on
 *  would just look like the old vanishing cut. */
export const GHOST_DEFAULT = 2;

/** Alpha for a dial position. Out-of-range indices clamp rather than wrap, so a
 *  caller that lost count cannot silently reach through to the other end of the
 *  dial (turning the ghost off when it meant to turn it up). */
export function ghostAlpha(level: number): number {
  const i = Math.max(0, Math.min(GHOST_LEVELS.length - 1, Math.round(level)));
  return GHOST_LEVELS[i] as number;
}

/** Next rung, wrapping back to hidden past the top, the dial is driven by ONE
 *  key press, so it has to be a cycle; a key that stopped dead at the end would
 *  need a second key to come back. */
export function nextGhostLevel(level: number): number {
  const i = Math.max(0, Math.min(GHOST_LEVELS.length - 1, Math.round(level)));
  return (i + 1) % GHOST_LEVELS.length;
}

/** What the prompt line calls the current rung. */
export function ghostLabel(level: number): string {
  const a = ghostAlpha(level);
  if (a === 0) return "hidden";
  if (a <= 0.06) return "faint";
  if (a <= 0.14) return "soft";
  return "strong";
}
