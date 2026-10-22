// Where the section's cutting plane sits, and how faintly the half cut away is still drawn.

import type { PlaneDef, Vec3 } from "../types";

/** Unit normal plus d in n·x + d = 0; everything on the +n side is kept. */
export interface ClipPlane {
  normal: Vec3;
  constant: number;
}

/** `side` is +1 or −1, what F flips. The offset runs along the defining normal, so flipping the kept half never
 *  reverses which way a drag moves the cut. */
export function clipPlaneAt(origin: Vec3, normal: Vec3, offset: number, side: 1 | -1): ClipPlane {
  const len = Math.hypot(normal[0], normal[1], normal[2]);
  const n: Vec3 = len > 1e-12 ? [normal[0] / len, normal[1] / len, normal[2] / len] : [0, 0, 1];
  const at: Vec3 = [origin[0] + n[0] * offset, origin[1] + n[1] * offset, origin[2] + n[2] * offset];
  const s: Vec3 = [n[0] * side, n[1] * side, n[2] * side];
  return { normal: s, constant: -(s[0] * at[0] + s[1] * at[1] + s[2] * at[2]) };
}

/** The point the gizmo stands on: the section's anchor slid by the offset. */
export function sectionCentre(origin: Vec3, normal: Vec3, offset: number): Vec3 {
  const len = Math.hypot(normal[0], normal[1], normal[2]);
  const n: Vec3 = len > 1e-12 ? [normal[0] / len, normal[1] / len, normal[2] / len] : [0, 0, 1];
  return [origin[0] + n[0] * offset, origin[1] + n[1] * offset, origin[2] + n[2] * offset];
}

/** The point of the plane nearest the model: a PlaneDef's origin is the world origin projected onto it, which for a
 *  part far from that origin would leave the handle off screen. */
export function sectionAnchor(origin: Vec3, normal: Vec3, modelCentre: Vec3): Vec3 {
  const len = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(len > 1e-12)) return [...origin];
  const n: Vec3 = [normal[0] / len, normal[1] / len, normal[2] / len];
  const d =
    (modelCentre[0] - origin[0]) * n[0] + (modelCentre[1] - origin[1]) * n[1] + (modelCentre[2] - origin[2]) * n[2];
  return [modelCentre[0] - n[0] * d, modelCentre[1] - n[1] * d, modelCentre[2] - n[2] * d];
}

/** The one place that decides which of a PlaneDef's vectors are the section's point and direction. */
export function sectionFromPlaneDef(def: PlaneDef): { origin: Vec3; normal: Vec3 } {
  return { origin: [...def.origin], normal: [...def.normal] };
}

// Past the cut geometry goes faint rather than vanishing, the user picks how faint, and no ghost stays reachable.

/** Ascending. Alpha 0 builds no ghost pass at all, so hidden costs nothing. */
export const GHOST_LEVELS = [0, 0.06, 0.14, 0.3] as const;

/** Level 2, not the faintest: a ghost too faint to see would look like the old vanishing cut. */
export const GHOST_DEFAULT = 2;

/** Out of range clamps rather than wraps, so a caller that lost count never reaches the other end of the dial. */
export function ghostAlpha(level: number): number {
  const i = Math.max(0, Math.min(GHOST_LEVELS.length - 1, Math.round(level)));
  return GHOST_LEVELS[i] as number;
}

/** Wraps to hidden past the top: one key drives the dial, so it has to cycle. */
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
