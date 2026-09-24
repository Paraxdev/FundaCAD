// How close, how far and how steep the navigator may go.

import { MIN_PERSP_DIST, maxViewHalfHeight, minDistanceFor } from "../clipPlanes";
import { halfTan } from "./pose";

export interface Limits {
  /** Closest the eye may come to what it zooms toward. */
  minDistance: number;
  /** Largest half view height. */
  maxScale: number;
  /** Pitch range in degrees, -90 straight down, +90 straight up. */
  minPitch: number;
  maxPitch: number;
}

export function defaultLimits(): Limits {
  return { minDistance: MIN_PERSP_DIST, maxScale: maxViewHalfHeight(0), minPitch: -90, maxPitch: 90 };
}

/** The limits the content implies: the zoom-out ceiling from its radius and the
 *  closest approach from float32 precision at its coordinates. */
export function contentLimits(base: Limits, radius: number, maxCoord: number, fov: number, heightPx: number): Limits {
  return {
    ...base,
    maxScale: maxViewHalfHeight(radius),
    minDistance: minDistanceFor(maxCoord, fov, heightPx),
  };
}

export function minScaleOf(l: Limits, fov: number): number {
  return l.minDistance * halfTan(fov);
}

export function clampScale(l: Limits, fov: number, s: number): number {
  return Math.min(l.maxScale, Math.max(minScaleOf(l, fov), s));
}

/** The elevation range (radians from straight down) the pitch limits allow. */
export function elevRange(l: Limits): [number, number] {
  const lo = Math.max(0, Math.min(180, l.minPitch + 90));
  const hi = Math.max(lo, Math.min(180, l.maxPitch + 90));
  return [(lo * Math.PI) / 180, (hi * Math.PI) / 180];
}
