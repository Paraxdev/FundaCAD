// Where a circular pattern turns, the three ways the tool can place it.
//
//   "origin"  the world axis through the origin, stored as "X", "Y" or "Z", what
//             every pattern did before and what a bolt circle round a centred
//             part wants.
//   "centre"  the same direction through the middle of the body being patterned,
//             stored as a line. A hole on a part drawn from its corner is almost
//             never meant to orbit the world origin, which is where most of its
//             copies land off the part.
//   "picked"  a line read off an edge or face the user clicked, stored as the
//             line plus `axisRef`, the reference the engine re-resolves every
//             rebuild so the axis follows the part (fundacad-geom
//             features/pattern.rs `referenced_axis`).
//
// Pure, no THREE, so the rules are pinned in vitest.

import type { Axis3, Selector, Vec3 } from "../types";
import { axisVector } from "./patternMath";

export type AxisPlace = "origin" | "centre" | "picked";

export interface AxisLineValue {
  origin: Vec3;
  dir: Vec3;
}

export interface PickedAxis extends AxisLineValue {
  ref: Selector;
}

/** Where a new circular pattern's axis starts. Repeating a feature on a body
 *  means turning about that body, repeating whole bodies means turning them
 *  about the origin, where a copy about its own middle would sit on itself. */
export function defaultAxisPlace(featuresMode: boolean): AxisPlace {
  return featuresMode ? "centre" : "origin";
}

/** The largest component made positive, the engine's `canonical` rule, so the
 *  same edge or face gives the same line on both sides. */
export function canonicalDir(d: Vec3): Vec3 {
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 1e-12)) return [0, 0, 0];
  const u: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
  const a = u.map(Math.abs);
  const k = a[0]! >= a[1]! && a[0]! >= a[2]! ? 0 : a[1]! >= a[2]! ? 1 : 2;
  return u[k]! < 0 ? [-u[0] + 0, -u[1] + 0, -u[2] + 0] : u;
}

/** The `axis` (and `axisRef`) fields a circular pattern is committed with. */
export function circularAxisFields(
  place: AxisPlace,
  named: Axis3,
  centre: Vec3,
  picked: PickedAxis | null,
): { axis: Axis3 | AxisLineValue; axisRef?: Selector } {
  if (place === "picked" && picked) {
    return { axis: { origin: picked.origin, dir: picked.dir }, axisRef: picked.ref };
  }
  if (place === "centre") {
    return { axis: { origin: round6(centre), dir: axisVector(named) } };
  }
  return { axis: named };
}

/** The line the copies turn about, for the ghosts and the drawn axis. */
export function axisLine(
  place: AxisPlace,
  named: Axis3,
  centre: Vec3,
  picked: PickedAxis | null,
): AxisLineValue {
  if (place === "picked" && picked) return { origin: picked.origin, dir: picked.dir };
  return { origin: place === "centre" ? centre : [0, 0, 0], dir: axisVector(named) };
}

/** The pattern's stored axis as words, for the prompt and the properties row. */
export function describeAxis(axis: unknown, axisRef: unknown, datumName?: (id: string) => string | undefined): string {
  if (axisRef) return "picked on the model";
  if (axis === "X" || axis === "Y" || axis === "Z") return `${axis} through the origin`;
  if (typeof axis === "string") return datumName?.(axis) ?? axis;
  const line = axis as Partial<AxisLineValue> | null;
  if (line && Array.isArray(line.origin) && Array.isArray(line.dir)) {
    const o = line.origin.map((v) => +v.toFixed(2)).join(", ");
    return `line through (${o})`;
  }
  return "Z through the origin";
}

function round6(v: Vec3): Vec3 {
  return v.map((x) => Math.round(x * 1e6) / 1e6 + 0) as Vec3;
}
